import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let ffmpegProcess = null;

// Cast endpoint triggered instantly by the button
app.post('/api/cast', (req, res) => {
    const { url } = req.body;
    console.log(`[Cast Request Received]: ${url}`);

    // Stop any previously running stream process
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
    }

    // Zero-latency FFmpeg parameters to prevent buffering lag
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

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
    });

    // Respond instantly to client
    res.json({ success: true, message: "Casting started immediately." });
});

// Ping route to keep Render instance warm
app.get('/ping', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
