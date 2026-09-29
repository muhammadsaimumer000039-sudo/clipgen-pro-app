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
const PORT = 3000;

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const GEMINI_API_KEY = "AQ.Ab8RN6JTsy_HtY8BdoRPSK-trHM0OKIf2C5wA7X1aYRU-HKLZA";
const PEXELS_API_KEY = "xVeI29teYIY9aqf0J8qyKOTsQiCaLm03SjuND5nZulXDS1cyMoUE4WQX";
const PIXABAY_API_KEY = "57509200-37e05488b33dedb0b6eee629a";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const TEMP_DIR = path.join(UPLOAD_DIR, "temp");

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

// Memory Safe Download
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

// Strictly Fetch EXACT HD Footages
async function fetchHDStockVideos(query, format, usedUrlsSet) {
    let urls = [];
    const q = encodeURIComponent(query);
    const orientation = format === "9:16" ? "portrait" : "landscape";

    try {
        const pRes = await fetch(`https://api.pexels.com/videos/search?query=${q}&per_page=40&orientation=${orientation}`, {
            headers: { Authorization: PEXELS_API_KEY }
        });
        const data = await pRes.json();
        if (data.videos) {
            data.videos.forEach(v => {
                if (v.video_files && v.video_files.length > 0) {
                    const hdFiles = v.video_files.filter(f => 
                        f.file_type === 'video/mp4' && 
                        ((format === "16:9" && f.width >= 1920) || (format === "9:16" && f.height >= 1920))
                    );
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

// ---------------------------------------------------------
// STRICT AUDIO-FIRST AI PARSER
// ---------------------------------------------------------
async function analyzeStrictAudio(audioPath, mimeType, duration, customKeywords) {
    let retries = 3; 
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const uploaded = await ai.files.upload({ file: audioPath, config: { mimeType } });
            
            const prompt = `
You are a master video editor. Listen strictly to the provided audio (length: ${duration}s).
IGNORE ANY PREVIOUS TITLES. The client might have provided a wrong title. Focus 100% on the EXACT WORDS spoken in the audio.
Divide the audio into exactly 4-6 second consecutive scenes. 

IMPORTANT RULE: The user has provided these mandatory custom keywords: [${customKeywords.join(', ')}]. 
Whenever you create a scene's search queries, you MUST prioritize using the exact words spoken, and blend them with the provided custom keywords if relevant.

Return JSON ONLY:
{
  "scenes": [
    { "start": 0, "end": 5.5, "narration": "Exact wording...", "searchQueries": ["precise spoken keyword 1", "precise spoken keyword 2"] }
  ]
}
`;
            const response = await ai.models.generateContent({ 
                model: "gemini-3.8-flash", 
                contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType), prompt]) 
            });

            return extractJSON(response.text).scenes;
        } catch (err) {
            if (attempt === retries) return null; 
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

// ---------------------------------------------------------
// MASTER JOB PROCESSOR
// ---------------------------------------------------------
async function runVideoGenerationJob(jobId, audioPath, title, format, mimeType, customKeywordsStr) {
    try {
        activeJobs[jobId].status = "Reading exact audio length...";
        const totalDuration = await getAudioDuration(audioPath);

        // Process user's custom keywords
        const customKeywordsArray = customKeywordsStr ? customKeywordsStr.split(',').map(k => k.trim()).filter(Boolean) : [];

        activeJobs[jobId].progress = 10;
        activeJobs[jobId].status = "AI strictly listening to voiceover wording...";

        let scenes = await analyzeStrictAudio(audioPath, mimeType, totalDuration, customKeywordsArray);
        
        // Smart fallback if AI fails, relying strictly on User's Custom Keywords
        if (!scenes || scenes.length === 0) {
            scenes = [];
            const keywordsToUse = customKeywordsArray.length > 0 ? customKeywordsArray : (title ? title.split(' ') : ["cinematic"]);
            let keywordIdx = 0;
            
            for (let t = 0; t < totalDuration; t += 4.5) {
                let endT = Math.min(totalDuration, t + 4.5);
                scenes.push({ 
                    start: t, end: endT, 
                    searchQueries: [keywordsToUse[keywordIdx % keywordsToUse.length]]
                });
                keywordIdx++;
            }
        }

        activeJobs[jobId].progress = 25;
        activeJobs[jobId].status = `Fetching HD clips exactly matching audio words...`;

        const globalUsedUrls = new Set();
        const { width, height } = format === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
        const processedClips = [];
        const concatTxtPath = path.join(TEMP_DIR, `list-${jobId}.txt`);
        let concatContent = "";

        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const sceneDur = scene.end - scene.start;
            
            let urlsForScene = [];
            
            // Priority 1: User Custom Keywords (If provided, try them first)
            if (customKeywordsArray.length > 0) {
                const userKey = customKeywordsArray[i % customKeywordsArray.length];
                urlsForScene.push(...(await fetchHDStockVideos(userKey, format, globalUsedUrls)));
            }

            // Priority 2: Gemini Exact Wording Queries
            if (urlsForScene.length === 0) {
                for (let q of scene.searchQueries) {
                    const freshUrls = await fetchHDStockVideos(q, format, globalUsedUrls);
                    urlsForScene.push(...freshUrls);
                    if (urlsForScene.length > 0) break;
                }
            }

            // Priority 3: Ultimate Fallback to keep sequence unbroken
            if (urlsForScene.length === 0) {
                urlsForScene.push(...(await fetchHDStockVideos("cinematic background HD", format, globalUsedUrls)));
            }

            const chosenUrl = urlsForScene[0]; 
            globalUsedUrls.add(chosenUrl); // Ensure no repeat

            const rawClip = path.join(TEMP_DIR, `raw-${jobId}-${i}.mp4`);
            const processedClip = path.join(TEMP_DIR, `proc-${jobId}-${i}.mp4`);

            try {
                const downloaded = await downloadVideoToDisk(chosenUrl, rawClip);
                
                if (downloaded && fs.existsSync(rawClip)) {
                    await new Promise((resolve) => {
                        let isDone = false;
                        
                        const cmd = ffmpeg(rawClip)
                            .inputOptions(["-stream_loop -1"])
                            .setDuration(sceneDur)
                            .videoFilters([
                                `scale=${width}:${height}:force_original_aspect_ratio=increase`,
                                `crop=${width}:${height}`,
                                "setsar=1",
                                "fps=30",
                                "format=yuv420p"
                            ])
                            .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p", "-an"])
                            .on("end", () => { isDone = true; resolve(); })
                            .on("error", () => { isDone = true; resolve(); });

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
            activeJobs[jobId].status = `Rendering exact voiceover clip ${i + 1} of ${scenes.length}...`;
        }

        if (processedClips.length === 0) throw new Error("Processing completely failed.");

        activeJobs[jobId].progress = 88;
        activeJobs[jobId].status = "Seamlessly stitching master video...";
        fs.writeFileSync(concatTxtPath, concatContent);

        const silentVideo = path.join(TEMP_DIR, `silent-${jobId}.mp4`);
        const finalFileName = `FINAL-${jobId}.mp4`;
        const finalFilePath = path.join(UPLOAD_DIR, finalFileName);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatTxtPath)
                .inputOptions(["-f concat", "-safe 0"])
                .outputOptions(["-c:v libx264", "-preset ultrafast", "-pix_fmt yuv420p"])
                .on("end", resolve)
                .on("error", reject)
                .save(silentVideo);
        });

        activeJobs[jobId].progress = 95;
        activeJobs[jobId].status = "Locking Audio perfectly...";

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
                    "-shortest",
                    "-movflags +faststart"
                ])
                .on("end", resolve)
                .on("error", reject)
                .save(finalFilePath);
        });

        activeJobs[jobId].progress = 100;
        activeJobs[jobId].status = "Done!";
        activeJobs[jobId].videoUrl = `/uploads/${finalFileName}`;

        try {
            fs.unlinkSync(concatTxtPath);
            fs.unlinkSync(silentVideo);
            processedClips.forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f) });
            fs.unlinkSync(audioPath);
        } catch (e) {}

    } catch (error) {
        console.error("Job Error:", error);
        activeJobs[jobId].status = "Failed: " + error.message;
    }
}

app.post("/generate-exact-video", upload.single("audiofile"), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Audio file missing." });

    const jobId = Date.now().toString();
    activeJobs[jobId] = { progress: 0, status: "Initializing...", videoUrl: null };

    // New Parameter: req.body.customKeywords passed to background job!
    runVideoGenerationJob(jobId, req.file.path, req.body.title || "", req.body.format || "16:9", req.file.mimetype, req.body.customKeywords);

    res.json({ success: true, jobId });
});

app.get("/api/status/:jobId", (req, res) => {
    const job = activeJobs[req.params.jobId];
    if (!job) return res.json({ success: false, status: "Job not found" });
    res.json({ success: true, progress: job.progress, status: job.status, videoUrl: job.videoUrl });
});

app.get("/api/videos", (req, res) => {
    try {
        const files = fs.readdirSync(UPLOAD_DIR);
        const videos = files
            .filter(f => f.startsWith("FINAL-") && f.endsWith(".mp4"))
            .map(f => {
                const stats = fs.statSync(path.join(UPLOAD_DIR, f));
                return { name: f, url: "/uploads/" + f, time: stats.mtime.getTime(), date: stats.mtime.toLocaleString() };
            })
            .sort((a, b) => b.time - a.time);
        res.json({ success: true, videos });
    } catch (e) {
        res.json({ success: false, videos: [] });
    }
});

app.listen(PORT, () => console.log(`\n🚀 EXACT CUSTOM-KEYWORDS SERVER RUNNING ON http://localhost:${PORT}\n`));
