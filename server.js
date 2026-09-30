const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const { GoogleGenAI, createUserContent, createPartFromUri } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 8080; 

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6JTsy_HtY8BdoRPSK-trHM0OKIf2C5wA7X1aYRU-HKLZA";
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "xVeI29teYIY9aqf0J8qyKOTsQiCaLm03SjuND5nZulXDS1cyMoUE4WQX";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "57509200-37e05488b33dedb0b6eee629a";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const TEMP_DIR = path.join(UPLOAD_DIR, "temp");
const USERS_FILE = path.join(ROOT, "users.json"); 

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(express.json({ limit: "1gb" }));
app.use(express.urlencoded({ extended: true, limit: "1gb" }));
app.use(express.static(ROOT));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + "-" + crypto.randomBytes(4).toString("hex");
        cb(null, "voice-" + unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const activeJobs = {};
let videoQueue = [];
let isProcessingQueue = false;

function checkDailyLimit(username, password, increment = false) {
    if (!fs.existsSync(USERS_FILE)) return { error: true, message: "System Error: users.json file is missing." };
    
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    
    if (!users[username] || users[username].password !== password) {
        return { error: true, message: "Invalid Username or Password!" };
    }

    let user = users[username];
    let today = new Date().toDateString(); 

    if (user.date !== today) {
        user.used = 0; 
        user.date = today; 
    }

    if (increment) {
        if (user.used >= user.limit) return { error: true, message: `Daily Limit Reached! You have used ${user.limit}/${user.limit} videos today.` };
        user.used += 1;
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    }
    
    return { allowed: true, used: user.used, limit: user.limit };
}

function getAudioDuration(file) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(file, (err, metadata) => {
            if (err || !metadata || !metadata.format) resolve(120);
            else resolve(metadata.format.duration);
        });
    });
}

function extractJSON(text) {
    let cleaned = String(text).replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
}

async function downloadVideoToDisk(url, outputPath) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); 
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("HTTP error");
        
        const fileStream = fs.createWriteStream(outputPath);
        if (res.body.getReader) {
            await pipeline(Readable.fromWeb(res.body), fileStream);
        } else {
            const buffer = await res.arrayBuffer();
            fs.writeFileSync(outputPath, Buffer.from(buffer));
        }
        return true;
    } catch (e) {
        clearTimeout(timeoutId);
        return false;
    }
}

async function fetchHDStockVideos(query, format, usedUrlsSet) {
    let urls = [];
    const q = encodeURIComponent(query);
    const orientation = format === "9:16" ? "portrait" : "landscape";

    try {
        const pRes = await fetch(`https://api.pexels.com/videos/search?query=${q}&per_page=30&orientation=${orientation}`, { headers: { Authorization: PEXELS_API_KEY } });
        const data = await pRes.json();
        if (data.videos) {
            data.videos.forEach(v => {
                if (v.video_files && v.video_files.length > 0) {
                    const hdFiles = v.video_files.filter(f => f.file_type === 'video/mp4' && ((format === "16:9" && f.width >= 1920) || (format === "9:16" && f.height >= 1920)));
                    if (hdFiles.length > 0) {
                        hdFiles.sort((a,b) => b.width - a.width);
                        const link = hdFiles[0].link;
                        if (!usedUrlsSet.has(link)) urls.push(link);
                    }
                }
            });
        }
    } catch (e) {}

    try {
        const pixRes = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${q}&per_page=30`);
        const data = await pixRes.json();
        if (data.hits) {
            data.hits.forEach(v => {
                if (v.videos && v.videos.large) {
                    if ((format === "16:9" && v.videos.large.width >= 1920) || (format === "9:16" && v.videos.large.height >= 1920)) {
                        const link = v.videos.large.url;
                        if (!usedUrlsSet.has(link)) urls.push(link);
                    }
                }
            });
        }
    } catch (e) {}

    return urls;
}

async function analyzeAudioSmart(audioPath, mimeType, duration, title) {
    let retries = 3; 
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const uploaded = await ai.files.upload({ file: audioPath, config: { mimeType } });
            
            const prompt = `
You are an expert AI video producer. Listen carefully to the provided audio (length: ${duration}s, Topic/Title: "${title}").
Break the audio down into consecutive 5 to 7 second scenes.

CRITICAL INSTRUCTIONS FOR 100% RELEVANT VISUAL MATCHING:
1. EXTRACT CORE NOUNS & SUBJECTS: For every scene, analyze what is being spoken right now. Extract exact visual objects, places, animals, science terms, or concepts.
2. ENGLISH SEARCH TERMS ONLY: Short keywords (1 or 2 words maximum, e.g., "galaxy space", "robot hand", "forest aerial").
3. NEVER REPEAT THE SAME WORD BACK TO BACK.

Return JSON ONLY in this exact format:
{
  "scenes": [
    { "start": 0, "end": 6.0, "narration": "Spoken text here...", "searchQueries": ["galaxy", "stars"] }
  ]
}
`;
            const response = await ai.models.generateContent({ model: "gemini-3.8-flash", contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType), prompt]) });
            return extractJSON(response.text).scenes;
        } catch (err) {
            if (attempt === retries) return null; 
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// QUEUE PROCESSOR WORKER
async function processQueue() {
    if (isProcessingQueue || videoQueue.length === 0) return;
    isProcessingQueue = true;

    const job = videoQueue.shift();
    const { jobId, audioPath, title, format, mimeType } = job;

    try {
        activeJobs[jobId].status = "Analyzing audio & topic...";
        const totalDuration = await getAudioDuration(audioPath);
        activeJobs[jobId].progress = 10;
        activeJobs[jobId].status = "AI extracting exact visual matches...";

        let scenes = await analyzeAudioSmart(audioPath, mimeType, totalDuration, title);
        if (!scenes || scenes.length === 0) {
            scenes = [];
            const fallbackWords = title ? title.split(' ') : ["cinematic", "nature"];
            let idx = 0;
            for (let t = 0; t < totalDuration; t += 5.0) {
                scenes.push({ start: t, end: Math.min(totalDuration, t + 5.0), searchQueries: [fallbackWords[idx % fallbackWords.length]] });
                idx++;
            }
        }

        activeJobs[jobId].progress = 25;
        const globalUsedUrls = new Set();
        const { width, height } = format === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
        const processedClips = [];
        const concatTxtPath = path.join(TEMP_DIR, `list-${jobId}.txt`);
        let concatContent = "";

        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const sceneDur = scene.end - scene.start;
            let urlsForScene = [];
            
            for (let q of scene.searchQueries) {
                const freshUrls = await fetchHDStockVideos(q, format, globalUsedUrls);
                urlsForScene.push(...freshUrls);
                if (urlsForScene.length > 0) break;
            }

            if (urlsForScene.length === 0) {
                let generalTerm = title ? title.split(" ")[0] : "cinematic background";
                urlsForScene.push(...(await fetchHDStockVideos(generalTerm, format, globalUsedUrls)));
            }

            const chosenUrl = urlsForScene[0] || "https://images.pexels.com/videos/854132/free-video-854132.mp4"; 
            globalUsedUrls.add(chosenUrl);
            const rawClip = path.join(TEMP_DIR, `raw-${jobId}-${i}.mp4`);
            const processedClip = path.join(TEMP_DIR, `proc-${jobId}-${i}.mp4`);

            try {
                const downloaded = await downloadVideoToDisk(chosenUrl, rawClip);
                if (downloaded && fs.existsSync(rawClip)) {
                    await new Promise((resolve) => {
                        let isDone = false;
                        const cmd = ffmpeg(rawClip).inputOptions(["-stream_loop -1"]).setDuration(sceneDur)
                            .videoFilters([`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, "setsar=1", "fps=30", "format=yuv420p"])
                            .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p", "-an"])
                            .on("end", () => { isDone = true; resolve(); }).on("error", () => { isDone = true; resolve(); });
                        cmd.save(processedClip);
                        setTimeout(() => { if (!isDone) { try { cmd.kill('SIGKILL'); } catch(e){} resolve(); } }, 45000); 
                    });
                    if (fs.existsSync(processedClip)) {
                        processedClips.push(processedClip);
                        concatContent += `file '${processedClip.replace(/\\/g, "/")}'\n`;
                    }
                }
            } catch (err) {}
            try { if (fs.existsSync(rawClip)) fs.unlinkSync(rawClip); } catch(e){}
            
            let currentProg = 25 + Math.floor(((i + 1) / scenes.length) * 60);
            activeJobs[jobId].progress = Math.min(85, currentProg);
            activeJobs[jobId].status = `Rendering scene ${i + 1}/${scenes.length} (Queue: ${videoQueue.length} waiting)...`;
        }

        if (processedClips.length === 0) throw new Error("Processing completely failed.");

        activeJobs[jobId].progress = 88;
        activeJobs[jobId].status = "Compiling master timeline...";
        fs.writeFileSync(concatTxtPath, concatContent);

        const silentVideo = path.join(TEMP_DIR, `silent-${jobId}.mp4`);
        const finalFileName = `FINAL-${jobId}.mp4`;
        const finalFilePath = path.join(UPLOAD_DIR, finalFileName);

        await new Promise((resolve, reject) => {
            ffmpeg().input(concatTxtPath).inputOptions(["-f concat", "-safe 0"])
                .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p"])
                .on("end", resolve).on("error", reject).save(silentVideo);
        });

        activeJobs[jobId].progress = 95;
        activeJobs[jobId].status = "Mastering audio & export...";

        await new Promise((resolve, reject) => {
            ffmpeg().input(silentVideo).input(audioPath)
                .outputOptions(["-map 0:v:0", "-map 1:a:0", "-c:v copy", "-c:a aac", "-b:a 192k", "-shortest", "-movflags +faststart"])
                .on("end", resolve).on("error", reject).save(finalFilePath);
        });

        activeJobs[jobId].progress = 100;
        activeJobs[jobId].status = "Ready!";
        activeJobs[jobId].videoUrl = `/uploads/${finalFileName}`;

        try { fs.unlinkSync(concatTxtPath); fs.unlinkSync(silentVideo); processedClips.forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f) }); fs.unlinkSync(audioPath); } catch (e) {}
    } catch (error) {
        activeJobs[jobId].status = "Failed: " + error.message;
        try { if(fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch(e){}
    }

    isProcessingQueue = false;
    processQueue(); // Process next in queue
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Username and Password required." });
    
    const limitStatus = checkDailyLimit(username, password, false);
    if (limitStatus.error) return res.json({ success: false, message: limitStatus.message });
    
    res.json({ success: true, message: "Login Successful!", used: limitStatus.used, limit: limitStatus.limit });
});

const uploadHandler = upload.single("audiofile");
app.post("/generate-exact-video", (req, res) => {
    uploadHandler(req, res, function (err) {
        if (err) {
            return res.status(400).json({ success: false, message: "Upload error: " + err.message });
        }
        if (!req.file) return res.status(400).json({ success: false, message: "Audio file missing." });

        const { username, password } = req.body; 
        const limitStatus = checkDailyLimit(username, password, true); 
        
        if (limitStatus.error) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.json({ success: false, message: limitStatus.message });
        }

        const jobId = Date.now().toString();
        
        // Calculate queue position
        const queuePosition = videoQueue.length + (isProcessingQueue ? 1 : 0);
        activeJobs[jobId] = { 
            progress: 0, 
            status: queuePosition > 0 ? `Added to queue! Position: ${queuePosition}` : "Initializing...", 
            videoUrl: null 
        };

        // Push to background queue
        videoQueue.push({
            jobId,
            audioPath: req.file.path,
            title: req.body.title || "video",
            format: req.body.format || "16:9",
            mimeType: req.file.mimetype
        });

        // Trigger queue processor
        processQueue();

        res.json({ success: true, jobId, used: limitStatus.used, limit: limitStatus.limit });
    });
});

app.get("/api/status/:jobId", (req, res) => {
    const job = activeJobs[req.params.jobId];
    if (!job) return res.json({ success: false, status: "Job not found" });
    res.json({ success: true, progress: job.progress, status: job.status, videoUrl: job.videoUrl });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`\n🚀 ENTERPRISE QUEUE SERVER RUNNING ON PORT ${PORT}\n`));
server.setTimeout(900000); // 15 minutes timeout
