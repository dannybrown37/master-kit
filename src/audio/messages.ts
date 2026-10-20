/** Messages between the main thread and the worklets in dynamics.worklet.ts. */
import type { CompressorParams } from "../dsp/compressor.ts";
import type { LimiterParams } from "../dsp/limiter.ts";
import type { MultibandParams } from "../dsp/multiband.ts";

export interface MeterReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  /** Sample peak since the previous reading, dBFS. */
  peak: number;
  /** True peak since the meter was reset, dBTP. */
  truePeak: number;
  /** Stereo image over the last ~0.3 s. */
  correlation: number;
  sideDb: number;
}

export type ToCompressor = { type: "params"; params: CompressorParams };
export type ToLimiter = { type: "params"; params: LimiterParams };
export type ToMultiband = { type: "params"; params: MultibandParams };
export type ToMeter = { type: "reset" };

/** `bands`: the multiband's reduction per band (low, mid, high). */
export type FromDynamics = { type: "reduction"; db: number; bands?: number[] };
export type FromMeter = { type: "meter"; reading: MeterReading };

/** Worklets post readings this often. */
export const REPORT_SECONDS = 0.1;
