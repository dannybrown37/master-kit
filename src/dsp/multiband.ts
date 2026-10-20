/**
 * Three-band compressor: a Linkwitz-Riley crossover, one stereo-linked Compressor per band, then the bands summed.
 * With every band off and at 0 dB it is skipped entirely (bit-exact pass-through); turning it on or off
 * crossfades over FADE_MS so there is no click. DOM-free: runs in an AudioWorklet and in Node tests.
 */
import { Compressor } from "./compressor.ts";
import type { CompressorParams } from "./compressor.ts";
import { Crossover } from "./crossover.ts";

export interface MultibandBand {
  /** Infinity = this band isn't compressed. */
  thresholdDb: number;
  gainDb: number;
}

export interface MultibandParams {
  lowHz: number;
  highHz: number;
  /** Low, mid, high. */
  bands: MultibandBand[];
  ratio: number;
  attackMs: number;
  releaseMs: number;
}

export const NEUTRAL_BAND: MultibandBand = { thresholdDb: Infinity, gainDb: 0 };
const KNEE_DB = 6;
const FADE_MS = 20;

export function isNeutral(p: MultibandParams): boolean {
  return p.bands.every((b) => b.thresholdDb === Infinity && b.gainDb === 0);
}

function bandParams(p: MultibandParams, b: MultibandBand): CompressorParams {
  return { thresholdDb: b.thresholdDb, ratio: p.ratio, kneeDb: KNEE_DB, attackMs: p.attackMs, releaseMs: p.releaseMs, makeupDb: b.gainDb, sidechainHz: 0, rmsMs: 0 };
}

export class Multiband {
  /** Largest gain reduction of any band in the last block, dB (positive). */
  reductionDb = 0;
  readonly bandReductionDb = [0, 0, 0];

  private readonly crossover: Crossover;
  private readonly compressors: Compressor[];
  private readonly fadeStep: number;
  private active = false;
  /** 0 = dry input, 1 = the processed bands. */
  private mix = 0;
  private buffers: Float32Array[][] = [];

  constructor(sampleRate: number, params: MultibandParams) {
    this.crossover = new Crossover(sampleRate, params.lowHz, params.highHz);
    this.compressors = params.bands.map((b) => new Compressor(sampleRate, bandParams(params, b)));
    this.fadeStep = 1000 / (FADE_MS * sampleRate);
    this.setParams(params);
  }

  setParams(p: MultibandParams): void {
    this.crossover.setFrequencies(p.lowHz, p.highHz);
    const active = !isNeutral(p);
    // Switching off fades out what was playing, rather than jumping to the neutral gains first.
    if (active) p.bands.forEach((b, i) => this.compressors[i].setParams(bandParams(p, b)));
    // Filters wake from silence rather than from stale state left when it was switched off.
    if (active && !this.active && this.mix === 0) this.crossover.reset();
    this.active = active;
  }

  private bands(channels: number, n: number): Float32Array[][] {
    if (this.buffers[0]?.length !== channels || this.buffers[0][0].length < n) {
      this.buffers = [0, 1, 2].map(() => Array.from({ length: channels }, () => new Float32Array(n)));
    }
    return this.buffers.map((band) => band.map((x) => x.subarray(0, n)));
  }

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const n = inputs[0]?.length ?? 0;
    if (!this.active && this.mix === 0) {
      for (let c = 0; c < inputs.length; c++) outputs[c].set(inputs[c].subarray(0, n));
      this.reductionDb = 0;
      this.bandReductionDb.fill(0);
      return;
    }
    const bands = this.bands(inputs.length, n);
    this.crossover.process(inputs, bands);
    this.compressors.forEach((comp, b) => {
      comp.process(bands[b], bands[b]);
      this.bandReductionDb[b] = comp.reductionDb;
    });
    this.reductionDb = Math.max(...this.bandReductionDb);
    const target = this.active ? 1 : 0;
    let mix = this.mix;
    for (let i = 0; i < n; i++) {
      mix = target > mix ? Math.min(target, mix + this.fadeStep) : Math.max(target, mix - this.fadeStep);
      for (let c = 0; c < inputs.length; c++) {
        const wet = bands[0][c][i] + bands[1][c][i] + bands[2][c][i];
        outputs[c][i] = mix === 1 ? wet : inputs[c][i] + (wet - inputs[c][i]) * mix;
      }
    }
    this.mix = mix;
  }
}
