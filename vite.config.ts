import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { parseRemuxUpload } from "./src/master/video.ts";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

/** Dev-only: lists and serves audio from MUSIC_DIR so the app has a library to pick from. */
function musicLibrary(dir: string): Plugin {
  const root = resolve(dir);
  return {
    name: "music-library",
    configureServer(server) {
      server.middlewares.use("/api/tracks", (_req, res) => {
        const tracks = existsSync(root)
          ? readdirSync(root)
              .filter((f) => extname(f).toLowerCase() in MIME)
              .sort((a, b) => a.localeCompare(b))
          : [];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ dir: root, tracks }));
      });
      server.middlewares.use("/tracks/", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0].replace(/^\//, ""));
        const file = resolve(root, name);
        if (!file.startsWith(root + sep) || !(extname(file).toLowerCase() in MIME) || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader("Content-Type", MIME[extname(file).toLowerCase()]);
        res.setHeader("Content-Length", statSync(file).size);
        createReadStream(file).pipe(res);
      });
    },
  };
}

const MAX_UPLOAD_BYTES = 8 * 2 ** 30;

function fail(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function runRemux(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve("tools/remux.ts"), ...args], { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
    child.on("error", (e) => done({ code: 1, stderr: e.message }));
  });
}

/** Dev-only: the Desk's "Export video" posts the video + master WAV; `tools/remux.ts` (with its sync checks) muxes them. */
function videoRemux(): Plugin {
  return {
    name: "video-remux",
    configureServer(server) {
      server.middlewares.use("/api/remux", (req, res) => {
        if (req.method !== "POST") return fail(res, 405, "POST only");
        void (async (): Promise<void> => {
          const body = await readBody(req);
          if (!body) return fail(res, 413, "upload too large");
          let upload;
          try {
            upload = parseRemuxUpload(new URL(req.url ?? "", "http://x").searchParams, body.length);
          } catch (e) {
            return fail(res, 400, e instanceof Error ? e.message : String(e));
          }
          const tmp = mkdtempSync(join(tmpdir(), "master-kit-api-remux-"));
          const clean = (): void => rmSync(tmp, { recursive: true, force: true });
          try {
            const video = join(tmp, `video${upload.inExt}`);
            const wav = join(tmp, "master.wav");
            const out = join(tmp, `out${upload.outExt}`);
            writeFileSync(video, body.subarray(0, upload.videoBytes));
            writeFileSync(wav, body.subarray(upload.videoBytes));
            const { code, stderr } = await runRemux([video, wav, "--out", out]);
            if (code !== 0) {
              clean();
              return fail(res, 422, stderr.split("\n").find((l) => l.startsWith("remux: "))?.slice(7) ?? (stderr.trim() || `remux exited ${code}`));
            }
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Length", statSync(out).size);
            createReadStream(out).pipe(res).on("close", clean);
          } catch (e) {
            clean();
            fail(res, 500, e instanceof Error ? e.message : String(e));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [musicLibrary(process.env.MUSIC_DIR ?? "../deluge-quest/web/public/audio"), videoRemux()],
  server: { port: 5174, strictPort: true },
  worker: { format: "es" },
  test: { include: ["src/**/*.test.ts"] },
});
