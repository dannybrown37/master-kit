/** A full-song Report for tests: a plausible streaming-ready mix unless overridden. */
import type { Report } from "../analysis/report.ts";
import { BANDS } from "../analysis/spectrum.ts";

export function report(over: Partial<Report> = {}, bands: number[] = [-6, -4, -10, -12, -16, -20]): Report {
  return {
    sampleRate: 44100,
    channels: 2,
    durationSeconds: 180,
    integrated: -14,
    momentaryMax: -10,
    shortTermMax: -12,
    loudnessRange: 5,
    truePeak: -1.2,
    samplePeak: -1.3,
    crest: 12,
    plr: 12.8,
    bands: BANDS.map((b, i) => ({ ...b, db: bands[i] })),
    stereo: { correlation: 0.8, sideDb: -10 },
    shortTerm: [],
    edges: { leadSeconds: 0.2, tailSeconds: 1, startDb: -50, endDb: -60 },
    ...over,
  };
}
