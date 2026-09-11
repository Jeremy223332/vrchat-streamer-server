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

// 1. URL-Based Cast Endpoint (YouTube & Direct Video Links)
app.post('/api/cast', async (req, res) => {
    let { url } = req.body;
    console.log(`[Cast Request Received]: ${url}`);

    stopFFmpeg();
    const outputPath = ensureStreamDir();

    try {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log('[yt-dlp] Resolving YouTube URL...');
            const output = await youtubeDl(url, {
                getUrl: true,
                format: 'best[ext=mp4]/best'
            });
            url = output.trim().split('\n')[0];
            console.log('[yt-dlp] Resolved stream link successfully!');
        }

        const ffmpegArgs = [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', url,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-g', '30',
            '-sc_threshold', '0',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-f', 'hls',
            '-hls_time', '1',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments+omit_endlist',
            outputPath
        ];

        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.stderr.on('data', (d) => {
            console.log(`FFmpeg: ${d}`);
        });

        // Give FFmpeg 4 seconds to write the initial HLS segments before notifying receivers
        setTimeout(() => {
            broadcast({ type: 'STREAM_START', streamUrl: '/stream/index.m3u8' });
        }, 4000);

        res.json({ success: true, message: "Casting initialized." });

    } catch (err) {
        console.error("Failed to process link:", err);
        res.status(500).json({ success: false, message: "Failed to extract stream." });
    }
});

// 2. Direct WebScreen Sharing via WebSockets
wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    ws.send(JSON.stringify({ type: 'STATUS', message: 'Connected to stream server' }));

    ws.on('message', (message) => {
        if (typeof message === 'string' || (message instanceof Buffer && message.toString().startsWith('{'))) {
            try {
                const data = JSON.parse(message.toString());

                if (data.type === 'START_SCREEN_CAST') {
                    console.log('[Cast] Starting direct screen capture process...');
                    stopFFmpeg();

                    const outputPath = ensureStreamDir();

                    ffmpegProcess = spawn('ffmpeg', [
                        '-i', 'pipe:0',
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-tune', 'zerolatency',
                        '-c:a', 'aac',
                        '-ar', '44100',
                        '-ac', '2',
                        '-g', '30',
                        '-sc_threshold', '0',
                        '-fflags', 'nobuffer',
                        '-flags', 'low_delay',
                        '-f', 'hls',
                        '-hls_time', '1',
                        '-hls_list_size', '3',
                        '-hls_flags', 'delete_segments+omit_endlist',
                        outputPath
                    ]);

                    ffmpegProcess.stderr.on('data', (d) => console.log(`FFmpeg: ${d}`));

                    setTimeout(() => {
                        broadcast({ type: 'STREAM_START', streamUrl: '/stream/index.m3u8' });
                    }, 3000);
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

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
    });
});

app.get('/ping', (req, res) => res.send('OK'));

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
