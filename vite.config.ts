import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
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

export default defineConfig({
  plugins: [musicLibrary(process.env.MUSIC_DIR ?? "../deluge-quest/web/public/audio")],
  server: { port: 5174, strictPort: true },
  worker: { format: "es" },
  test: { include: ["src/**/*.test.ts"] },
});
