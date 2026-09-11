import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 10000;
const LIVE_DIR = path.join(__dirname, 'live');

if (!fs.existsSync(LIVE_DIR)) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
}

app.use(cors());
app.use(express.static(__dirname));
app.use('/live', express.static(LIVE_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'caster.html'));
});

let ffmpegProcess = null;

wss.on('connection', (ws) => {
  console.log('Caster connected via WebSocket');

  // Clear previous stream segments on new connection
  if (fs.existsSync(LIVE_DIR)) {
    fs.readdirSync(LIVE_DIR).forEach(file => {
      try { fs.unlinkSync(path.join(LIVE_DIR, file)); } catch (e) {}
    });
  }

  // Spawn FFmpeg in continuous sliding-window HLS mode
  ffmpegProcess = spawn(ffmpegPath, [
    '-loglevel', 'warning',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+omit_endlist+discont_start',
    '-hls_segment_type', 'mpegts',
    path.join(LIVE_DIR, 'stream.m3u8')
  ]);

  ffmpegProcess.stderr.on('data', (data) => {
    console.log(`FFmpeg: ${data}`);
  });

  ws.on('message', (message) => {
    if (ffmpegProcess && ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(message);
    }
  });

  ws.on('close', () => {
    console.log('Caster disconnected');
    if (ffmpegProcess) {
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill('SIGINT');
      ffmpegProcess = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
