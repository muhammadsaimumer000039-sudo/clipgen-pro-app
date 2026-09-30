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

const app = express();
const PORT = process.env.PORT || 8080; 

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path || ffprobeStatic);

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "xVeI29teYIY9aqf0J8qyKOTsQiCaLm03SjuND5nZulXDS1cyMoUE4WQX";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "57509200-37e05488b33dedb0b6eee629a";

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
            if (err || !metadata || !metadata.format || !metadata.format.duration) {
                try {
                    const stats = fs.statSync(file);
                    const estimatedSecs = Math.max(120, Math.floor(stats.size / 16000));
                    resolve(estimatedSecs);
                } catch(e) {
                    resolve(210);
                }
            } else {
                resolve(parseFloat(metadata.format.duration));
            }
        });
    });
}

async function downloadVideoToDisk(url, outputPath) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); 
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
        const pRes = `https://api.pexels.com/videos/search?query=${q}&per_page=30&orientation=${orientation}`;
        const pFetch = await fetch(pRes, { headers: { Authorization: PEXELS_API_KEY } });
        const data = await pFetch.json();
        if (data.videos) {
            data.videos.forEach(v => {
                if (v.video_files && v.video_files.length > 0) {
                    const hdFiles = v.video_files.filter(f => f.file_type === 'video/mp4' && ((format === "16:9" && f.width >= 1280) || (format === "9:16" && f.height >= 1280)));
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
        const pixRes = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${q}&per_page=30`;
        const pixFetch = await fetch(pixRes);
        const data = await pixFetch.json();
        if (data.hits) {
            data.hits.forEach(v => {
                if (v.videos && v.videos.large) {
                    if ((format === "16:9" && v.videos.large.width >= 1280) || (format === "9:16" && v.videos.large.height >= 1280)) {
                        const link = v.videos.large.url;
                        if (!usedUrlsSet.has(link)) urls.push(link);
                    }
                }
            });
        }
    } catch (e) {}

    try {
        const wikiRes = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url&format=json`;
        const wikiFetch = await fetch(wikiRes);
        const wikiData = await wikiFetch.json();
        if (wikiData.query && wikiData.query.pages) {
            Object.values(wikiData.query.pages).forEach(page => {
                if (page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url) {
                    const url = page.imageinfo[0].url;
                    if (url.endsWith('.webm') || url.endsWith('.mp4')) {
                        if (!usedUrlsSet.has(url)) urls.push(url);
                    }
                }
            });
        }
    } catch (e) {}

    return urls;
}

// BULLETPROOF CONCAT WORKER
async function processQueue() {
    if (isProcessingQueue || videoQueue.length === 0) return;
    isProcessingQueue = true;

    const job = videoQueue.shift();
    const { jobId, audioPath, title, format } = job;

    try {
        activeJobs[jobId].status = "Reading exact audio duration...";
        activeJobs[jobId].progress = 10;
        
        const totalDuration = await getAudioDuration(audioPath);
        activeJobs[jobId].progress = 20;
        activeJobs[jobId].status = `Audio duration: ${Math.floor(totalDuration)}s. Fetching topic clips...`;

        let cleanTitle = title ? title.trim() : "cinematic";
        let titleWords = cleanTitle.split(' ').filter(w => w.length > 2);
        if (titleWords.length === 0) titleWords = [cleanTitle];

        let scenes = [];
        let keywordIdx = 0;
        
        for (let t = 0; t < totalDuration; t += 5.0) {
            let endT = Math.min(totalDuration, t + 5.0);
            let primaryKeyword = titleWords[keywordIdx % titleWords.length];
            scenes.push({
                start: t,
                end: endT,
                searchQueries: [primaryKeyword, cleanTitle]
            });
            keywordIdx++;
        }

        activeJobs[jobId].progress = 30;
        const globalUsedUrls = new Set();
        const { width, height } = format === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
        const processedClips = [];
        const concatTxtPath = path.join(TEMP_DIR, `list-${jobId}.txt`);
        let concatLines = [];

        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const sceneDur = scene.end - scene.start;
            let urlsForScene = [];
            
            for (let q of scene.searchQueries) {
                const freshUrls = await fetchHDStockVideos(q, format, globalUsedUrls);
                urlsForScene.push(...freshUrls);
                if (urlsForScene.length >= 3) break;
            }

            if (urlsForScene.length === 0) {
                const fallbackUrls = await fetchHDStockVideos(cleanTitle, format, new Set());
                if (fallbackUrls.length > 0) {
                    urlsForScene.push(fallbackUrls[i % fallbackUrls.length]);
                } else {
                    urlsForScene.push("https://images.pexels.com/videos/854132/free-video-854132.mp4");
                }
            }

            const chosenUrl = urlsForScene[Math.floor(Math.random() * urlsForScene.length)]; 
            globalUsedUrls.add(chosenUrl);

            const rawClip = path.join(TEMP_DIR, `raw-${jobId}-${i}.mp4`);
            const processedClip = path.join(TEMP_DIR, `proc-${jobId}-${i}.mp4`);

            try {
                const downloaded = await downloadVideoToDisk(chosenUrl, rawClip);
                if (downloaded && fs.existsSync(rawClip)) {
                    await new Promise((resolve) => {
                        let isDone = false;
                        const cmd = ffmpeg(rawClip).inputOptions(["-stream_loop -1"]).setDuration(sceneDur)
                            .videoFilters([`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, "setsar=1", "fps=25", "format=yuv420p"])
                            .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p", "-an"])
                            .on("end", () => { isDone = true; resolve(); }).on("error", () => { isDone = true; resolve(); });
                        cmd.save(processedClip);
                        setTimeout(() => { if (!isDone) { try { cmd.kill('SIGKILL'); } catch(e){} resolve(); } }, 20000); 
                    });
                    if (fs.existsSync(processedClip) && fs.statSync(processedClip).size > 1000) {
                        processedClips.push(processedClip);
                        // Safe absolute path formatting with single quotes escaped or handled safely
                        const absPath = path.resolve(processedClip).replace(/\\/g, "/");
                        concatLines.push(`file '${absPath}'`);
                    }
                }
            } catch (err) {}
            try { if (fs.existsSync(rawClip)) fs.unlinkSync(rawClip); } catch(e){}
            
            let prog = 30 + Math.floor(((i + 1) / scenes.length) * 55);
            activeJobs[jobId].progress = Math.min(85, prog);
            activeJobs[jobId].status = `Rendering topic scene ${i + 1} of ${scenes.length} (${Math.round(((i+1)/scenes.length)*100)}%)...`;
        }

        if (processedClips.length === 0) throw new Error("Processing failed: No clips could be rendered.");

        activeJobs[jobId].progress = 88;
        activeJobs[jobId].status = "Compiling exact topic video timeline...";
        
        // Write file with exact LF line endings and UTF-8 encoding
        fs.writeFileSync(concatTxtPath, concatLines.join("\n"), { encoding: "utf8", flag: "w" });

        const silentVideo = path.join(TEMP_DIR, `silent-${jobId}.mp4`);
        const finalFileName = `FINAL-${jobId}.mp4`;
        const finalFilePath = path.join(UPLOAD_DIR, finalFileName);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatTxtPath)
                .inputOptions(["-f concat", "-safe 0"])
                .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p"])
                .on("end", resolve)
                .on("error", (err) => reject(new Error("Concat failed: " + err.message)))
                .save(silentVideo);
        });

        if (!fs.existsSync(silentVideo) || fs.statSync(silentVideo).size < 1000) {
            throw new Error("Timeline compilation failed.");
        }

        activeJobs[jobId].progress = 95;
        activeJobs[jobId].status = "Merging full audio voiceover...";

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(silentVideo)
                .input(audioPath)
                .outputOptions([
                    "-map 0:v:0", 
                    "-map 1:a:0", 
                    "-c:v copy", 
                    "-c:a aac", 
                    "-b:a 192k", 
                    "-movflags +faststart"
                ])
                .on("end", resolve)
                .on("error", (err) => reject(new Error("Audio merge failed: " + err.message)))
                .save(finalFilePath);
        });

        activeJobs[jobId].progress = 100;
        activeJobs[jobId].status = "Ready!";
        activeJobs[jobId].videoUrl = `/uploads/${finalFileName}`;

        try { 
            if (fs.existsSync(concatTxtPath)) fs.unlinkSync(concatTxtPath); 
            if (fs.existsSync(silentVideo)) fs.unlinkSync(silentVideo); 
            processedClips.forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f) }); 
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); 
        } catch (e) {}
    } catch (error) {
        activeJobs[jobId].status = "Failed: " + error.message;
        try { if(fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch(e){}
    }

    isProcessingQueue = false;
    processQueue();
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
        if (err) return res.status(400).json({ success: false, message: "Upload error." });
        if (!req.file) return res.status(400).json({ success: false, message: "Audio missing." });

        const { username, password } = req.body; 
        const limitStatus = checkDailyLimit(username, password, true); 
        
        if (limitStatus.error) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.json({ success: false, message: limitStatus.message });
        }

        const jobId = Date.now().toString();
        const qPos = videoQueue.length + (isProcessingQueue ? 1 : 0);
        
        activeJobs[jobId] = { 
            progress: 5, 
            status: qPos > 0 ? `In Queue (Position: ${qPos})` : "Initializing...", 
            videoUrl: null 
        };

        videoQueue.push({
            jobId,
            audioPath: req.file.path,
            title: req.body.title || "video",
            format: req.body.format || "16:9",
            mimeType: req.file.mimetype
        });

        processQueue();
        res.json({ success: true, jobId, used: limitStatus.used, limit: limitStatus.limit });
    });
});

app.get("/api/status/:jobId", (req, res) => {
    const job = activeJobs[req.params.jobId];
    if (!job) return res.json({ success: false, status: "Not found" });
    res.json({ success: true, progress: job.progress, status: job.status, videoUrl: job.videoUrl });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 CONCAT 183-FIXED SERVER RUNNING ON PORT ${PORT}`));
server.setTimeout(900000);
