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

// ADVANCED DAILY LIMIT SYSTEM (USERNAME + PASSWORD)
function checkDailyLimit(username, password, increment = false) {
    if (!fs.existsSync(USERS_FILE)) return { error: true, message: "System Error: users.json file is missing." };
    
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    
    // Check if user exists and password matches
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
    let cleaned = String(text).replace(/^```json\s*/i, "").replace(/
