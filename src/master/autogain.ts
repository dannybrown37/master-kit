/** Finds the limiter Drive that brings the full-song master to a loudness target, by rendering and correcting. */
import { clampParam } from "./settings.ts";

export interface MatchResult {
  drive: number;
  lufs: number;
  reached: boolean;
  steps: { drive: number; lufs: number }[];
}

const TOLERANCE_LU = 0.3;

const MIN_SLOPE = 0.1;
const MAX_SLOPE = 1.5;

/** LU gained per dB of Drive, from the last two renders (secant); 1 until there are two. */
function slope(steps: readonly { drive: number; lufs: number }[]): number {
  if (steps.length < 2) return 1;
  const [a, b] = steps.slice(-2);
  const s = (b.lufs - a.lufs) / (b.drive - a.drive);
  return Number.isFinite(s) ? Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, s)) : 1;
}

/**
 * `measure(drive)` renders the song with that Drive and returns its integrated loudness (NaN = cancelled).
 * A limiter gives back less loudness than the Drive it's given, so steps after the first use the measured slope.
 */
export async function matchLoudness(
  measure: (drive: number) => Promise<number>,
  start: number,
  target: number,
  { maxSteps = 4, tolerance = TOLERANCE_LU } = {},
): Promise<MatchResult> {
  const steps: { drive: number; lufs: number }[] = [];
  let drive = clampParam("limDrive", start);
  for (let i = 0; i < maxSteps; i++) {
    const lufs = await measure(drive);
    steps.push({ drive, lufs });
    if (!Number.isFinite(lufs) || Math.abs(target - lufs) <= tolerance) break;
    const next = clampParam("limDrive", drive + (target - lufs) / slope(steps));
    if (next === drive) break;
    drive = next;
  }
  const best = steps.reduce((a, b) => (Math.abs(target - b.lufs) < Math.abs(target - a.lufs) ? b : a));
  return { ...best, reached: Math.abs(target - best.lufs) <= tolerance, steps };
}
