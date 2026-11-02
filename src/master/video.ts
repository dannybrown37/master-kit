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
