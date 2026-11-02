import { isVideoName } from "./video.ts";

/** The dev server's /api/tracks body; anything else (a static host's 404 page or index.html) means no library. */
export function parseTrackList(contentType: string | null, body: string): string[] {
  if (!contentType?.includes("application/json")) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const tracks = (raw as { tracks?: unknown } | null)?.tracks;
  return Array.isArray(tracks) ? tracks.filter((t): t is string => typeof t === "string" && t !== "") : [];
}

/** "Barrel Rondo [2026, neoclassical edm].mp3" → "Barrel Rondo": short enough for the header. */
export function songTitle(file: string): string {
  return file.replace(/\.[a-z0-9]+$/i, "").replace(/\s*\[[^\]]*\]\s*$/, "").trim() || file;
}

/** First audio or video file among dropped/picked files (some OSes leave type empty, so fall back to the extension). */
export function pickAudioFile<T extends { name: string; type: string }>(files: readonly T[]): T | null {
  return files.find((f) => f.type.startsWith("audio/") || /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(f.name) || isVideoName(f.name, f.type))?? null;
}
