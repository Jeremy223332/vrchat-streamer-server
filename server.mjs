import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import youtubeDl from 'yt-dlp-exec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/caster.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/caster', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/tv.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

let ffmpegProcess = null;

function ensureStreamDir() {
    const streamDir = path.join(__dirname, 'public', 'stream');
    if (!fs.existsSync(streamDir)) {
        fs.mkdirSync(streamDir, { recursive: true });
    }
    return path.join(streamDir, 'index.m3u8');
}

function stopFFmpeg() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }
}

function broadcast(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(JSON.stringify(data));
        }
    });
}

// Low-latency FFmpeg profile tuned for Render hardware & VRChat
const LOW_LATENCY_FFMPEG_FLAGS = [
    '-vf', 'scale=1280:720,fps=30', // Scale to 720p 30fps to reduce CPU/Bandwidth strain
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '1500k',                // Cap video bitrate at 1.5 Mbps
    '-maxrate', '1800k',
    '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-g', '30',                     // 1-second keyframe interval
    '-sc_threshold', '0',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'hls',
    '-hls_time', '1',               // 1-second segment lengths
    '-hls_list_size', '3',          // Keep playlist small
    '-hls_flags', 'delete_segments+omit_endlist'
];

// 1. URL Cast Handler (YouTube / Direct Links)
app.post('/api/cast', async (req, res) => {
    let { url } = req.body;
    console.log(`[Cast Request Received]: ${url}`);

    stopFFmpeg();
    const outputPath = ensureStreamDir();

    try {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log('[yt-dlp] Extracting link...');
            const output = await youtubeDl(url, {
                getUrl: true,
                format: 'best[ext=mp4][height<=720]/best[height<=720]/best'
            });
            url = output.trim().split('\n')[0];
        }

        const args = [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', url,
            ...LOW_LATENCY_FFMPEG_FLAGS,
            outputPath
        ];

        ffmpegProcess = spawn('ffmpeg', args);

        setTimeout(() => {
            broadcast({ type: 'STREAM_START', streamUrl: '/stream/index.m3u8' });
        }, 3000);

        res.json({ success: true, message: "Casting initialized." });

    } catch (err) {
        console.error("Cast Error:", err);
        res.status(500).json({ success: false, message: "Failed to extract stream." });
    }
});

// 2. Direct Screen Share Handler
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        if (typeof message === 'string' || (message instanceof Buffer && message.toString().startsWith('{'))) {
            try {
                const data = JSON.parse(message.toString());

                if (data.type === 'START_SCREEN_CAST') {
                    stopFFmpeg();
                    const outputPath = ensureStreamDir();

                    const args = [
                        '-i', 'pipe:0',
                        ...LOW_LATENCY_FFMPEG_FLAGS,
                        outputPath
                    ];

                    ffmpegProcess = spawn('ffmpeg', args);

                    setTimeout(() => {
                        broadcast({ type: 'STREAM_START', streamUrl: '/stream/index.m3u8' });
                    }, 2000);
                } else if (data.type === 'STOP_SCREEN_CAST') {
                    stopFFmpeg();
                }
            } catch (e) {}
        } else {
            if (ffmpegProcess && ffmpegProcess.stdin.writable) {
                ffmpegProcess.stdin.write(message);
            }
        }
    });
});

app.get('/ping', (req, res) => res.send('OK'));

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
