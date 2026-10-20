/**
 * Edges: silence before and after the song, and fades at its first and last sound. DOM-free.
 * Fades are raised-cosine (smooth at both ends). Fades start and stop at the sound itself (`contentBounds`), and
 * everything outside a fade becomes digital silence. Lead-in and tail count the silence already in the file.
 */
import { contentBounds } from "../analysis/edges.ts";

/** All in seconds; 0 = leave that edge alone. */
export interface EdgeParams {
  lead: number;
  fadeIn: number;
  fadeOut: number;
  tail: number;
}

export const NEUTRAL_EDGES: EdgeParams = { lead: 0, fadeIn: 0, fadeOut: 0, tail: 0 };

/** Where the sound is, in any unit (seconds, samples); `end` is just past the last sound. */
export interface Bounds {
  start: number;
  end: number;
}

const rise = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, x));

/** Gain at time `t` (same unit as the bounds and fades). */
export function edgeGain(t: number, b: Bounds, p: Pick<EdgeParams, "fadeIn" | "fadeOut">): number {
  let g = 1;
  if (p.fadeIn > 0) g = t < b.start ? 0 : rise((t - b.start) / p.fadeIn);
  if (p.fadeOut > 0) g = Math.min(g, t >= b.end ? 0 : rise((b.end - t) / p.fadeOut));
  return g;
}

function isNeutral(p: EdgeParams): boolean {
  return p.lead <= 0 && p.fadeIn <= 0 && p.fadeOut <= 0 && p.tail <= 0;
}

/** New channels with the edges applied; neutral settings or an all-silent song return `channels` itself. */
export function applyEdges(channels: Float32Array[], sampleRate: number, p: EdgeParams): Float32Array[] {
  if (isNeutral(p)) return channels;
  const n = channels[0].length;
  const b = contentBounds(channels);
  if (b.start === n) return channels;
  const leadPad = Math.max(0, Math.round(p.lead * sampleRate) - b.start);
  const tailPad = Math.max(0, Math.round(p.tail * sampleRate) - (n - b.end));
  const fades = { fadeIn: p.fadeIn * sampleRate, fadeOut: p.fadeOut * sampleRate };
  const gain = Float32Array.from({ length: n }, (_, i) => edgeGain(i, b, fades));
  return channels.map((c) => {
    const out = new Float32Array(leadPad + n + tailPad);
    for (let i = 0; i < n; i++) out[leadPad + i] = c[i] * gain[i];
    return out;
  });
}

/** One `AudioParam.setValueCurveAtTime` call, in song time. */
export interface GainCurve {
  at: number;
  duration: number;
  values: Float32Array;
}

const CURVE_POINTS_PER_SECOND = 1000;

/**
 * The fades as gain automation for live playback from song time `from` (seconds): `initial` right away, then the curves.
 * Each curve ends on its final gain, which holds; overlapping fades merge into one curve (Web Audio forbids overlap).
 */
export function edgeAutomation(from: number, b: Bounds, p: EdgeParams): { initial: number; curves: GainCurve[] } {
  const spans: [number, number][] = [];
  if (p.fadeIn > 0) spans.push([b.start, b.start + p.fadeIn]);
  if (p.fadeOut > 0) {
    const out: [number, number] = [b.end - p.fadeOut, b.end];
    const last = spans.at(-1);
    if (last && last[1] >= out[0]) last[1] = Math.max(last[1], out[1]);
    else spans.push(out);
  }
  const curves = spans
    .map(([s, e]): [number, number] => [Math.max(s, from), e])
    .filter(([s, e]) => e - s > 1e-6)
    .map(([s, e]) => {
      const duration = e - s;
      const points = Math.max(2, Math.ceil(duration * CURVE_POINTS_PER_SECOND) + 1);
      const values = Float32Array.from({ length: points }, (_, i) => edgeGain(s + (duration * i) / (points - 1), b, p));
      return { at: s, duration, values };
    });
  return { initial: edgeGain(from, b, p), curves };
}
