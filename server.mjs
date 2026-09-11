import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, createReadStream, statSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.STREAM_PORT || 3001);
const HLS_ROOT = join(process.cwd(), "hls");
const PUBLIC_ROOT = join(process.cwd(), "public");
const DEFAULT_STREAM_ID = "stream";
const pairs = new Map();
const liveStreams = new Map();

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function cors(res, contentType = "application/json") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  if (contentType) res.setHeader("Content-Type", contentType);
}

function sendJson(res, status, payload) {
  cors(res);
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
  if (ext === ".ts") return "video/mp2t";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function streamFile(res, filePath) {
  if (!existsSync(filePath)) {
    cors(res, "text/plain; charset=utf-8");
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const stat = statSync(filePath);
  cors(res, contentType(filePath));
  res.setHeader("Cache-Control", extname(filePath) === ".m3u8" ? "no-store" : "public, max-age=15");
  res.setHeader("Content-Length", stat.size);
  res.writeHead(200);
  createReadStream(filePath).pipe(res);
}

function publicUrl(req, path) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}${path}`;
}

function startFfmpeg(streamId) {
  ensureDir(HLS_ROOT);
  const streamDir = join(HLS_ROOT, streamId);
  if (existsSync(streamDir)) rmSync(streamDir, { recursive: true, force: true });
  ensureDir(streamDir);

  const playlistPath = join(streamDir, "playlist.m3u8");
  const segmentPattern = join(streamDir, "segment_%05d.ts");

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-r", "30",
    "-g", "60",
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    playlistPath,
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  ffmpeg.stderr.on("data", (chunk) => console.warn(`[ffmpeg:${streamId}] ${chunk.toString().trim()}`));
  ffmpeg.on("exit", (code, signal) => {
    console.log(`[ffmpeg:${streamId}] exited code=${code} signal=${signal}`);
    liveStreams.delete(streamId);
  });

  const live = { ffmpeg, startedAt: Date.now(), streamDir, playlistPath };
  liveStreams.set(streamId, live);
  return live;
}

function stopStream(streamId) {
  const live = liveStreams.get(streamId);
  if (!live) return;
  try { live.ffmpeg.stdin.end(); } catch {}
  try { live.ffmpeg.kill("SIGTERM"); } catch {}
  liveStreams.delete(streamId);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    cors(res, null);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, live: [...liveStreams.keys()] });

  if (url.pathname.startsWith("/api/pair/")) {
    const code = url.pathname.split("/").pop();
    const streamId = pairs.get(code || "");
    if (!streamId || !liveStreams.has(streamId)) return sendJson(res, 200, { connected: false, code });
    return sendJson(res, 200, {
      connected: true,
      code,
      streamId,
      hlsUrl: publicUrl(req, `/live/${streamId}/playlist.m3u8`),
      avproUrl: publicUrl(req, "/live/stream.m3u8"),
    });
  }

  if (url.pathname === "/live/stream.m3u8") {
    return streamFile(res, join(HLS_ROOT, DEFAULT_STREAM_ID, "playlist.m3u8"));
  }

  if (url.pathname.startsWith("/live/")) {
    const safe = url.pathname.replace(/^\/live\//, "").replace(/\.\./g, "");
    return streamFile(res, join(HLS_ROOT, safe));
  }

  if (url.pathname === "/caster.html" || url.pathname === "/tv.html") {
    return streamFile(res, join(PUBLIC_ROOT, url.pathname.slice(1)));
  }

  sendJson(res, 200, {
    name: "Devs.ai VRChat AVPro Live Stream Backend",
    caster: publicUrl(req, "/caster.html"),
    tv: publicUrl(req, "/tv.html"),
    defaultHls: publicUrl(req, "/live/stream.m3u8"),
    websocket: `ws://${req.headers.host}/ingest?code=1234`,
  });
});

const wss = new WebSocketServer({ server, path: "/ingest" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const code = (url.searchParams.get("code") || "").replace(/\D/g, "").slice(0, 4);
  const streamId = DEFAULT_STREAM_ID;
  if (code.length !== 4) {
    ws.close(1008, "A 4-digit pairing code is required");
    return;
  }

  stopStream(streamId);
  pairs.set(code, streamId);
  const live = startFfmpeg(streamId);
  console.log(`[stream:${streamId}] caster connected with TV code ${code}`);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    if (!live.ffmpeg.stdin.destroyed) live.ffmpeg.stdin.write(data);
  });

  ws.on("close", () => {
    console.log(`[stream:${streamId}] caster disconnected`);
    stopStream(streamId);
  });

  ws.on("error", (err) => {
    console.error(`[stream:${streamId}] websocket error`, err);
    stopStream(streamId);
  });

  ws.send(JSON.stringify({
    type: "ready",
    code,
    streamId,
    hlsPath: `/live/${streamId}/playlist.m3u8`,
    avproPath: "/live/stream.m3u8",
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  ensureDir(HLS_ROOT);
  console.log(`Streaming backend listening on http://0.0.0.0:${PORT}`);
  console.log("Requires FFmpeg on PATH. Caster sends WebM chunks to ws://host:3001/ingest?code=1234");
});
