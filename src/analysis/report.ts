import { loudness, loudnessRange } from "./loudness.ts";
import { ampToDb, samplePeak, truePeak } from "./peak.ts";
import { bandEnergies } from "./spectrum.ts";
import type { BandEnergy } from "./spectrum.ts";
import { stereoImage } from "./stereo.ts";
import type { StereoImage } from "./stereo.ts";

export interface Report {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  /** LUFS */
  integrated: number;
  momentaryMax: number;
  shortTermMax: number;
  /** LU */
  loudnessRange: number;
  /** dBTP */
  truePeak: number;
  /** dBFS */
  samplePeak: number;
  /** Sample peak over RMS, dB. */
  crest: number;
  /** Peak-to-loudness ratio: true peak minus integrated loudness, dB. */
  plr: number;
  bands: BandEnergy[];
  stereo: StereoImage;
  /** Short-term loudness every 100 ms (LUFS), for plotting. */
  shortTerm: number[];
}

/** Sample peak over RMS across all channels, dB. */
export function crestFactor(channels: Float32Array[]): number {
  let sumSquares = 0;
  let count = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) sumSquares += x[i] * x[i];
    count += x.length;
  }
  if (sumSquares === 0) return -Infinity;
  return samplePeak(channels) - ampToDb(Math.sqrt(sumSquares / count));
}

function validate(channels: Float32Array[], sampleRate: number): void {
  if (!(sampleRate > 0)) throw new RangeError(`sample rate must be positive, got ${sampleRate}`);
  if (channels.length === 0) throw new RangeError("need at least one channel");
  if (channels.some((c) => c.length !== channels[0].length)) throw new RangeError("channels differ in length");
}

export function analyze(channels: Float32Array[], sampleRate: number): Report {
  validate(channels, sampleRate);
  const l = loudness(channels, sampleRate);
  const tp = truePeak(channels, sampleRate);
  return {
    sampleRate,
    channels: channels.length,
    durationSeconds: channels[0].length / sampleRate,
    integrated: l.integrated,
    momentaryMax: l.momentaryMax,
    shortTermMax: l.shortTermMax,
    loudnessRange: loudnessRange(l.shortTerm),
    truePeak: tp,
    samplePeak: samplePeak(channels),
    crest: crestFactor(channels),
    plr: tp - l.integrated,
    bands: bandEnergies(channels, sampleRate),
    stereo: stereoImage(channels),
    shortTerm: l.shortTerm,
  };
}
