/**
 * Video sound: the master goes back under the picture, so it must keep the source's exact length and start.
 * Lead-in and Tail add silence (shifting or stretching the audio), so they're locked at 0; fades don't move anything.
 */
import type { Settings } from "./settings.ts";

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv"] as const;

export function isVideoName(name: string, mimeType = ""): boolean {
  const lower = name.toLowerCase();
  return mimeType.startsWith("video/") || VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/** Containers `just remux` writes; any other video comes back as MKV. */
export const REMUX_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv"] as const;
const WAV_HEADER_BYTES = 44;

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function remuxExtension(ext: string): string {
  return (REMUX_EXTENSIONS as readonly string[]).includes(ext.toLowerCase()) ? ext : ".mkv";
}

export function videoExportName(track: string): string {
  const ext = extension(track);
  return `${ext ? track.slice(0, -ext.length) : track} (master)${remuxExtension(ext)}`;
}

export interface RemuxUpload {
  videoBytes: number;
  inExt: string;
  outExt: string;
}

/**
 * The dev server's /api/remux request: body = the video's bytes, then the master WAV's. Only the name's
 * extension is used (files are written under fixed names in a temp dir), so a hostile name can't pick a path.
 */
export function parseRemuxUpload(query: URLSearchParams, bodyBytes: number): RemuxUpload {
  const name = query.get("name") ?? "";
  const raw = query.get("videoBytes") ?? "";
  const videoBytes = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const inExt = extension(name.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name || !/^\.[a-z0-9]{1,5}$/.test(inExt)) throw new RangeError("name needs a video file extension");
  if (!(videoBytes > 0) || videoBytes > bodyBytes - WAV_HEADER_BYTES) throw new RangeError("videoBytes must split the body into a video and a WAV");
  return { videoBytes, inExt, outExt: remuxExtension(inExt) };
}

export type MuxContainer = "mp4" | "mov" | "webm" | "mkv";

/** In-browser mux: the output container (from the video's name) and its audio codecs, best first; the browser picks the first it can encode. */
export function muxPlan(track: string): { container: MuxContainer; codecs: string[] } {
  const ext = extension(track).toLowerCase();
  // No Opus fallback: Chrome's encoder delay (648) != the dOps pre-skip (312) and no edit list trims it, so players disagree.
  if (ext === ".mp4" || ext === ".m4v") return { container: "mp4", codecs: ["aac"] };
  if (ext === ".mov") return { container: "mov", codecs: ["aac", "pcm-s24"] };
  if (ext === ".webm") return { container: "webm", codecs: ["opus"] };
  return { container: "mkv", codecs: ["flac", "pcm-s24"] };
}

/** Decoded chunks laid on a timeline: `frames` samples from `from` seconds, each chunk at its timestamp, silence between. */
export function placeOnTimeline(chunks: Iterable<{ timestamp: number; channels: Float32Array[] }>, from: number, frames: number, sampleRate: number, channels: number): Float32Array[] {
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (const chunk of chunks) {
    const at = Math.round((chunk.timestamp - from) * sampleRate);
    const start = Math.max(at, 0);
    const skip = start - at;
    const n = Math.min(chunk.channels[0].length - skip, frames - start);
    if (n <= 0) continue;
    for (let c = 0; c < channels; c++) out[c].set(chunk.channels[Math.min(c, chunk.channels.length - 1)].subarray(skip, skip + n), start);
  }
  return out;
}

function indexOf(b: Uint8Array, needle: readonly number[], end: number): number {
  outer: for (let i = 0; i + needle.length <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const CODEC_DELAY_ID = [0x56, 0xaa];
const OPUS_HEAD = [...new TextEncoder().encode("OpusHead")];

/**
 * Matroska/WebM Opus: makes the OpusHead pre-skip equal CodecDelay, in place. Chrome's encoder via mediabunny writes
 * CodecDelay = its real delay (13.5 ms) but pre-skip = 312 (6.5 ms); ffmpeg-based players trust pre-skip and play the
 * sound 7 ms late. Searches only the header (before the first Cluster). Returns the pre-skip, or null if not Opus/no delay.
 */
export function alignOpusPreSkip(b: Uint8Array): number | null {
  const cluster = indexOf(b, CLUSTER_ID, b.length);
  const end = cluster < 0 ? b.length : cluster;
  const head = indexOf(b, OPUS_HEAD, end);
  const delayAt = indexOf(b, CODEC_DELAY_ID, end);
  if (head < 0 || delayAt < 0 || head + 12 > end) return null;
  const sizeByte = b[delayAt + 2];
  const sizeLen = sizeByte >= 0x80 ? sizeByte & 0x7f : -1;
  if (sizeLen < 1 || sizeLen > 8 || delayAt + 3 + sizeLen > end) return null;
  let ns = 0;
  for (let i = 0; i < sizeLen; i++) ns = ns * 256 + b[delayAt + 3 + i];
  const preSkip = Math.round((ns * 48000) / 1e9);
  if (preSkip > 0xffff) return null;
  b[head + 10] = preSkip & 0xff;
  b[head + 11] = preSkip >> 8;
  return preSkip;
}

/** Every /api/remux response carries this, so a static host's 404/405/index.html is never mistaken for it. */
export const REMUX_HEADER = "X-Master-Kit-Remux";

/** `status` null = the request itself failed. */
export function remuxOutcome(status: number | null, fromRemux: boolean): "video" | "refused" | "unavailable" {
  if (status === null || !fromRemux) return "unavailable";
  return status >= 200 && status < 300 ? "video" : "refused";
}

export const SYNC_LOCKED_KEYS = ["edgeLeadMs", "edgeTailMs"] as const;

export function lockSync(s: Settings): Settings {
  const out = { ...s };
  for (const key of SYNC_LOCKED_KEYS) out[key] = 0;
  return out;
}

const WINDOW_SECONDS = 10;
const SEARCH_SECONDS = 2;
const SILENT_RMS = 1e-4;

function mono(channels: Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i];
  return out;
}

/** Mean |x| per block, mean removed: cheap enough to search seconds of lag. */
function envelope(x: Float32Array, block: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / block));
  let total = 0;
  for (let b = 0; b < out.length; b++) {
    let s = 0;
    for (let i = b * block; i < (b + 1) * block; i++) s += Math.abs(x[i]);
    out[b] = s / block;
    total += out[b];
  }
  const mean = total / (out.length || 1);
  for (let b = 0; b < out.length; b++) out[b] -= mean;
  return out;
}

function bestLag(a: Float32Array, b: Float32Array, from: number, to: number, lo: number, hi: number): number {
  let best = -Infinity;
  let at = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = Math.max(from, lag); i < Math.min(to, b.length + lag); i++) s += a[i] * b[i - lag];
    if (s > best) [best, at] = [s, lag];
  }
  return at;
}

/**
 * Samples the master sits late (+) or early (−) against the source's audio, within ±2 s: a coarse pass on
 * 1 ms envelopes, then a sample-exact pass on the waveform around it. Both are compared in the middle 10 s.
 */
export function syncOffset(master: Float32Array[], source: Float32Array[], sampleRate: number): number {
  const m = mono(master);
  const s = mono(source);
  const half = Math.min(m.length, s.length, WINDOW_SECONDS * sampleRate) >> 1;
  const mid = Math.min(m.length, s.length) >> 1;
  let energy = 0;
  for (let i = mid - half; i < mid + half; i++) energy += s[i] * s[i];
  if (Math.sqrt(energy / (2 * half || 1)) < SILENT_RMS) throw new Error("the source is silent in the middle, so sync can't be checked");
  const block = Math.max(1, Math.round(sampleRate / 1000));
  const reach = Math.round((SEARCH_SECONDS * sampleRate) / block);
  const coarse = bestLag(envelope(m, block), envelope(s, block), Math.floor((mid - half) / block), Math.floor((mid + half) / block), -reach, reach) * block;
  return bestLag(m, s, mid - half, mid + half, coarse - 2 * block, coarse + 2 * block);
}

/** Moves the sound `by` samples earlier (negative: later, padding silence in front); the length stays the same. */
export function shiftStart(channels: Float32Array[], by: number): Float32Array[] {
  if (by === 0) return channels;
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    if (by > 0) out.set(c.subarray(by));
    else out.set(c.subarray(0, c.length + by), -by);
    return out;
  });
}

/** Pads with silence or trims at the end only, so sample 0 stays where it was. */
export function fitLength(channels: Float32Array[], frames: number): Float32Array[] {
  return channels.map((c) => {
    if (c.length === frames) return c;
    const out = new Float32Array(frames);
    out.set(c.subarray(0, frames));
    return out;
  });
}

export function assertSameLength(sourceFrames: number, exportedFrames: number): void {
  if (sourceFrames !== exportedFrames) {
    throw new Error(`export would break video sync: ${exportedFrames} frames vs the source's ${sourceFrames}`);
  }
}
