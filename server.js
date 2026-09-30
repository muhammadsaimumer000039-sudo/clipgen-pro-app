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

app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true }));
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
    const timeoutId = setTimeout(() => controller.abort(), 20000); 
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
        const pRes = await fetch(`https://api.pexels.com/videos/search?query=${q}&per_page=40&orientation=${orientation}`, { headers: { Authorization: PEXELS_API_KEY } });
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
        const pixRes = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${q}&per_page=40`);
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

async function analyzeStrictAudio(audioPath, mimeType, duration, customKeywords) {
    let retries = 3; 
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const uploaded = await ai.files.upload({ file: audioPath, config: { mimeType } });
            
            const prompt = `
You are a highly precise video editor. Listen strictly to the provided audio (length: ${duration}s).
Divide the audio into exactly 4-6 second consecutive scenes.

CRITICAL RULES FOR SEARCH QUERIES:
1. FOCUS ON PROPER NOUNS AND MAIN SUBJECTS: If the speaker mentions a specific monument, place, object, or concept, you MUST extract that EXACT word as your primary search query.
2. ONE OR TWO WORDS ONLY: Stock video APIs fail on long sentences.
3. MATCH THE AUDIO EXACTLY: What is spoken must be shown.
4. User provided backup keywords: [${customKeywords.join(', ')}]. Use them as secondary backups, but spoken nouns take #1 priority.

Return JSON ONLY:
{
  "scenes": [
    { "start": 0, "end": 5.5, "narration": "Exact wording spoken...", "searchQueries": ["Planet", "space"] }
  ]
}
`;
            const response = await ai.models.generateContent({ model: "gemini-3.8-flash", contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType), prompt]) });
            return extractJSON(response.text).scenes;
        } catch (err) {
            if (attempt === retries) return null; 
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

async function runVideoGenerationJob(jobId, audioPath, title, format, mimeType, customKeywordsStr) {
    try {
        activeJobs[jobId].status = "Analyzing audio specifics...";
        const totalDuration = await getAudioDuration(audioPath);
        const customKeywordsArray = customKeywordsStr ? customKeywordsStr.split(',').map(k => k.trim()).filter(Boolean) : [];
        activeJobs[jobId].progress = 10;
        activeJobs[jobId].status = "AI extracting exact visual nouns...";

        let scenes = await analyzeStrictAudio(audioPath, mimeType, totalDuration, customKeywordsArray);
        if (!scenes || scenes.length === 0) {
            scenes = [];
            const keywordsToUse = customKeywordsArray.length > 0 ? customKeywordsArray : (title ? title.split(' ') : ["cinematic"]);
            let keywordIdx = 0;
            for (let t = 0; t < totalDuration; t += 4.5) {
                let endT = Math.min(totalDuration, t + 4.5);
                scenes.push({ start: t, end: endT, searchQueries: [keywordsToUse[keywordIdx % keywordsToUse.length]] });
                keywordIdx++;
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

            if (urlsForScene.length === 0 && customKeywordsArray.length > 0) {
                const userKey = customKeywordsArray[i % customKeywordsArray.length];
                urlsForScene.push(...(await fetchHDStockVideos(userKey, format, globalUsedUrls)));
            }

            if (urlsForScene.length === 0) {
                let fallbackTerm = title ? title.split(" ")[0] : "nature";
                urlsForScene.push(...(await fetchHDStockVideos(fallbackTerm, format, globalUsedUrls)));
            }
            
            if (urlsForScene.length === 0) {
                urlsForScene.push(...(await fetchHDStockVideos("cinematic background", format, globalUsedUrls)));
            }

            const chosenUrl = urlsForScene[0]; 
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
                        setTimeout(() => { if (!isDone) { try { cmd.kill('SIGKILL'); } catch(e){} resolve(); } }, 40000); 
                    });
                    if (fs.existsSync(processedClip)) {
                        processedClips.push(processedClip);
                        concatContent += `file '${processedClip.replace(/\\/g, "/")}'\n`;
                    }
                }
            } catch (err) {}
            try { if (fs.existsSync(rawClip)) fs.unlinkSync(rawClip); } catch(e){}
            activeJobs[jobId].progress = 25 + Math.floor(((i + 1) / scenes.length) * 60);
            activeJobs[jobId].status = `Rendering exact matched scene ${i + 1}/${scenes.length}...`;
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
    }
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Username and Password required." });
    
    const limitStatus = checkDailyLimit(username, password, false);
    if (limitStatus.error) return res.json({ success: false, message: limitStatus.message });
    
    res.json({ success: true, message: "Login Successful!", used: limitStatus.used, limit: limitStatus.limit });
});

app.post("/generate-exact-video", upload.single("audiofile"), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Audio file missing." });

    const { username, password } = req.body; 
    const limitStatus = checkDailyLimit(username, password, true); 
    
    if (limitStatus.error) {
        try { fs.unlinkSync(req.file.path); } catch(e) {}
        return res.json({ success: false, message: limitStatus.message });
    }

    const jobId = Date.now().toString();
    activeJobs[jobId] = { progress: 0, status: "Initializing...", videoUrl: null };
    runVideoGenerationJob(jobId, req.file.path, req.body.title || "", req.body.format || "16:9", req.file.mimetype, req.body.customKeywords);

    res.json({ success: true, jobId, used: limitStatus.used, limit: limitStatus.limit });
});

app.get("/api/status/:jobId", (req, res) => {
    const job = activeJobs[req.params.jobId];
    if (!job) return res.json({ success: false, status: "Job not found" });
    res.json({ success: true, progress: job.progress, status: job.status, videoUrl: job.videoUrl });
});

app.listen(PORT, "0.0.0.0", () => console.log(`\n🚀 EXACT NOUN MATCHING SERVER RUNNING ON PORT ${PORT}\n`));
