/** Album mode: several songs mastered alike, exported in order, with the joins between them previewed. */
import { NEUTRAL_EDGES } from "../dsp/edges.ts";
import type { EdgeParams } from "../dsp/edges.ts";
import { median } from "../analysis/spectrum.ts";
import { safeBaseName } from "./session.ts";

/** Songs further than this from the album's median loudness stand out when played in a row. */
const OUTLIER_LU = 1;

export function albumFileName(index: number, track: string, bits: number): string {
  return `${String(index + 1).padStart(2, "0")} - ${safeBaseName(track)} (master ${bits}-bit).wav`;
}

/** A copy with item `i` moved by `delta` places (clamped to the list). */
export function moveItem<T>(list: readonly T[], i: number, delta: number): T[] {
  const out = [...list];
  const j = Math.min(out.length - 1, Math.max(0, i + delta));
  const [item] = out.splice(i, 1);
  out.splice(j, 0, item);
  return out;
}

/** Loudness spread across the album (LU) and the indexes that stand out; NaN = not measured yet. */
export function consistency(lufs: readonly number[]): { spreadLu: number; outliers: number[] } {
  const known = lufs.filter(Number.isFinite);
  if (known.length === 0) return { spreadLu: 0, outliers: [] };
  const mid = median(known);
  return {
    spreadLu: Math.max(...known) - Math.min(...known),
    outliers: lufs.flatMap((x, i) => (Number.isFinite(x) && Math.abs(x - mid) > OUTLIER_LU ? [i] : [])),
  };
}

/**
 * Edges for a transition preview, which renders only A's last seconds and B's first: each clip keeps the edge it
 * actually has (a fade-in on A's last seconds would be wrong, the clip starts mid-song).
 */
export function transitionEdges(p: EdgeParams): { ending: EdgeParams; opening: EdgeParams } {
  return { ending: { ...NEUTRAL_EDGES, fadeOut: p.fadeOut, tail: p.tail }, opening: { ...NEUTRAL_EDGES, lead: p.lead, fadeIn: p.fadeIn } };
}
