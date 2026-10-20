/**
 * 0–100 score for a master: on-target loudness (40), true peak headroom (30), dynamics kept (30).
 * Dynamics are judged by PLR (true peak minus loudness) against the original, so an already loud
 * original isn't asked for dynamics it never had.
 */
import { TARGETS } from "../analysis/targets.ts";

export type ScoreName = "loudness" | "peaks" | "dynamics";

export interface ScorePart {
  name: ScoreName;
  points: number;
  max: number;
  ok: boolean;
  detail: string;
}

export interface Score {
  total: number;
  parts: ScorePart[];
}

/** Loudness points fall to zero this far outside the tolerance window. */
const LOUDNESS_FALLOFF_LU = 3;
/** PLR above this is plenty for streaming; asking more of a dynamic original would be unreachable at -14 / -1. */
const PLR_CAP = 11;
/** How much PLR the master may lose before points drop, and how much more until they're gone. */
const PLR_ALLOWANCE = 2;
const PLR_FALLOFF = 6;

function ramp(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(1) : "-inf";
}

export function score(original: { plr: number }, master: { integrated: number; truePeak: number; plr: number }): Score {
  const audible = Number.isFinite(master.integrated);
  const off = master.integrated - TARGETS.integrated;
  const loudnessShare = audible ? ramp(1 - (Math.abs(off) - TARGETS.integratedTolerance) / LOUDNESS_FALLOFF_LU) : 0;
  // Full points at the target, none at 0 dBTP.
  const peakShare = audible ? ramp(master.truePeak / TARGETS.truePeakMax) : 0;
  const needed = Math.min(original.plr, PLR_CAP) - PLR_ALLOWANCE;
  const dynamicsShare = audible && Number.isFinite(master.plr) ? ramp(1 - (needed - master.plr) / PLR_FALLOFF) : 0;
  const parts: ScorePart[] = [
    {
      name: "loudness",
      points: 40 * loudnessShare,
      max: 40,
      ok: audible && Math.abs(off) <= TARGETS.integratedTolerance,
      detail: `${fmt(master.integrated)} LUFS (target ${TARGETS.integrated} ±${TARGETS.integratedTolerance})`,
    },
    {
      name: "peaks",
      points: 30 * peakShare,
      max: 30,
      ok: audible && master.truePeak <= TARGETS.truePeakMax,
      detail: `${fmt(master.truePeak)} dBTP (max ${TARGETS.truePeakMax})`,
    },
    {
      name: "dynamics",
      points: 30 * dynamicsShare,
      max: 30,
      ok: dynamicsShare === 1,
      detail: `PLR ${fmt(master.plr)} dB (keep ≥ ${fmt(needed)}; original ${fmt(original.plr)})`,
    },
  ];
  return { total: Math.round(parts.reduce((sum, p) => sum + p.points, 0)), parts };
}
