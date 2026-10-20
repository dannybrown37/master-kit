import type { Report } from "./report.ts";

/** Streaming-platform delivery targets (Spotify/YouTube-style normalisation). */
export const TARGETS = { integrated: -14, integratedTolerance: 1, truePeakMax: -1 } as const;

export interface TargetHits {
  loudness: boolean;
  truePeak: boolean;
}

export function checkTargets(report: Pick<Report, "integrated" | "truePeak">): TargetHits {
  return {
    loudness: Math.abs(report.integrated - TARGETS.integrated) <= TARGETS.integratedTolerance,
    truePeak: report.truePeak <= TARGETS.truePeakMax,
  };
}
