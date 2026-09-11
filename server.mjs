import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/caster.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/caster', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/tv.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

// WebSocket handling
wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    ws.send(JSON.stringify({ type: 'STATUS', message: 'Connected to stream server' }));

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
    });
});

// Broadcast function to send updates to tv.html / caster.html
function broadcast(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(JSON.stringify(data));
        }
    });
}

let ffmpegProcess = null;

// Cast endpoint
app.post('/api/cast', (req, res) => {
    const { url } = req.body;
    console.log(`[Cast Request Received]: ${url}`);

    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
    }

    const ffmpegArgs = [
        '-i', url,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-g', '30',
        '-sc_threshold', '0',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments+omit_endlist',
        'public/stream/index.m3u8'
    ];

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    // Notify connected WebSockets that stream has started
    broadcast({ type: 'STREAM_START', streamUrl: '/stream/index.m3u8' });

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
    });

    res.json({ success: true, message: "Casting started immediately." });
});

app.get('/ping', (req, res) => res.send('OK'));

// IMPORTANT: Listen on 'server', not 'app' so WebSockets work
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
