/** Where a song's sound starts and stops, and how hard it starts and stops. DOM-free. */
import { ampToDb } from "./peak.ts";

/** An mp3's noise floor sits well under this; quiet music (a reverb tail, an ambient intro) sits above it. */
export const SILENCE_DB = -60;
/** startDb/endDb look at this much of the first/last sound. */
const WINDOW_SECONDS = 0.01;
const SILENCE = 10 ** (SILENCE_DB / 20);

export interface EdgeStats {
  /** Silence before the first sound (s). */
  leadSeconds: number;
  /** Silence after the last sound (s). */
  tailSeconds: number;
  /** Sample peak of the first 10 ms of sound (dBFS): high = the song starts on a hit. */
  startDb: number;
  /** Sample peak of the last 10 ms of sound (dBFS): high = the song stops on a hard cut. */
  endDb: number;
}

/** First sample above the silence line, and one past the last (both = length if all silent). */
export function contentBounds(channels: Float32Array[]): { start: number; end: number } {
  const n = channels[0].length;
  const loud = (i: number): boolean => channels.some((c) => Math.abs(c[i]) >= SILENCE);
  let start = 0;
  while (start < n && !loud(start)) start++;
  if (start === n) return { start: n, end: n };
  let end = n;
  while (!loud(end - 1)) end--;
  return { start, end };
}

function peakDb(channels: Float32Array[], from: number, to: number): number {
  let peak = 0;
  for (const c of channels) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(c[i]));
  return ampToDb(peak);
}

export function edgeStats(channels: Float32Array[], sampleRate: number): EdgeStats {
  const n = channels[0].length;
  const { start, end } = contentBounds(channels);
  if (start === n) return { leadSeconds: n / sampleRate, tailSeconds: n / sampleRate, startDb: -Infinity, endDb: -Infinity };
  const w = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
  return {
    leadSeconds: start / sampleRate,
    tailSeconds: (n - end) / sampleRate,
    startDb: peakDb(channels, start, Math.min(end, start + w)),
    endDb: peakDb(channels, Math.max(start, end - w), end),
  };
}
