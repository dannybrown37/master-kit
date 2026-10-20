/** Pure math for the loudness-over-time plot in the full-song check. */
import { HOP_SECONDS, SHORT_TERM_HOPS } from "../analysis/loudness.ts";

/** Time (s) of each short-term value: the centre of its 3 s window. */
export function shortTermTimes(count: number): number[] {
  const half = (SHORT_TERM_HOPS * HOP_SECONDS) / 2;
  return Array.from({ length: count }, (_, i) => half + i * HOP_SECONDS);
}

/** The loudest value in each of `n` equal time slices of `[0, duration]` (one per pixel column). */
export function columnsByTime(values: readonly number[], times: readonly number[], duration: number, n: number): number[] {
  const out = new Array<number>(n).fill(-Infinity);
  for (let i = 0; i < values.length; i++) {
    const c = Math.min(n - 1, Math.max(0, Math.floor((times[i] / duration) * n)));
    if (values[i] > out[c]) out[c] = values[i];
  }
  return out;
}

export function toY(lufs: number, [lo, hi]: readonly [number, number], height: number): number {
  if (!(lufs > lo)) return height;
  return (1 - Math.min(1, (lufs - lo) / (hi - lo))) * height;
}
