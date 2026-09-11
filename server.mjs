import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve public files regardless of root file conflicts
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/caster.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/caster', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caster.html')));
app.get('/tv.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

let ffmpegProcess = null;

// Cast endpoint triggered instantly by the button
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

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
    });

    res.json({ success: true, message: "Casting started immediately." });
});

app.get('/ping', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
