/** What reaches the speakers: the master, or the original / reference / snapshot turned to the master's loudness. */

/** `snapshot` is a second copy of the chain running saved settings, to compare two candidate masters. */
export type Listen = "master" | "original" | "reference" | "snapshot";
export const LISTENS: readonly Listen[] = ["master", "original", "reference", "snapshot"];

const MIN_LUFS = -50;
const MAX_MATCH_DB = 24;

/** Match gains (dB) that bring each comparison to the master's loudness. */
export type MatchDb = Record<Exclude<Listen, "master">, number>;

export function monitorGains(listen: Listen, match: MatchDb): { wet: number; dry: number; ref: number; snap: number } {
  const gain = (which: Exclude<Listen, "master">): number => (listen === which ? 10 ** (match[which] / 20) : 0);
  return { wet: listen === "master" ? 1 : 0, dry: gain("original"), ref: gain("reference"), snap: gain("snapshot") };
}

/** What the meter panel shows: the bar and the "|" marker. While you hear the reference or snapshot it is compared with the master. */
export function meterPair<T>(
  listen: Listen,
  has: { reference: boolean; snapshot: boolean },
  r: Record<Listen, T>,
): { main: T; ghost: T; labels: [string, string] } {
  if (listen === "reference" && has.reference) return { main: r.reference, ghost: r.master, labels: ["ref", "master"] };
  if (listen === "snapshot" && has.snapshot) return { main: r.snapshot, ghost: r.master, labels: ["snap", "master"] };
  return { main: r.master, ghost: r.original, labels: ["master", "orig"] };
}

/** Gain that brings the reference to the master's integrated loudness (a reference is usually mastered louder). */
export function referenceMatchDb(masterLufs: number, referenceLufs: number): number {
  if (!Number.isFinite(masterLufs) || !Number.isFinite(referenceLufs)) return 0;
  return Math.max(-MAX_MATCH_DB, Math.min(MAX_MATCH_DB, masterLufs - referenceLufs));
}

/**
 * Smoothed master-minus-original loudness, so A/B compares tone and dynamics rather than "louder sounds better".
 * Silence and quiet passages are skipped: their difference says nothing about the processing.
 */
export class LoudnessMatch {
  private readonly timeConstant: number;
  private value = 0;
  private primed = false;

  constructor(timeConstantSeconds = 3) {
    this.timeConstant = timeConstantSeconds;
  }

  get db(): number {
    return this.value;
  }

  update(originalLufs: number, masterLufs: number, dtSeconds: number): number {
    if (!(originalLufs > MIN_LUFS && masterLufs > MIN_LUFS && Number.isFinite(originalLufs) && Number.isFinite(masterLufs))) return this.value;
    const diff = Math.max(-MAX_MATCH_DB, Math.min(MAX_MATCH_DB, masterLufs - originalLufs));
    const a = this.primed ? Math.exp(-dtSeconds / this.timeConstant) : 0;
    this.value = a * this.value + (1 - a) * diff;
    this.primed = true;
    return this.value;
  }

  /** The two sides traded places (snapshot ↔ current knobs). */
  swap(): void {
    this.value = -this.value;
  }

  reset(): void {
    this.value = 0;
    this.primed = false;
  }
}
