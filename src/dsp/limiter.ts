/**
 * Lookahead brickwall limiter with true-peak (4x interpolated) detection. DOM-free.
 *
 * The needed gain for each sample (ceiling / peak) goes through a sliding minimum over
 * L+2 samples and then a box average over L samples. Every value inside the average is at
 * or below the needed gain of the sample being output, so the smooth gain curve can never
 * overshoot. Audio is delayed to line up; release only lets the gain rise more slowly.
 */
import { TAPS_PER_PHASE, oversamplingFactor, polyphaseFilter } from "../analysis/peak.ts";

export interface LimiterParams {
  driveDb: number;
  ceilingDb: number;
  releaseMs: number;
}

const LOOKAHEAD_MS = 5;
const CENTRE = TAPS_PER_PHASE / 2;
/**
 * Detection runs at twice the meter's oversampling, and aims slightly under the ceiling, so the
 * output stays under it on any meter (ffmpeg, 16x) rather than only on our own 4x one.
 */
const DETECTION_OVERSAMPLING = 2;
const SAFETY_DB = 0.1;

function lookaheadSamples(sampleRate: number): number {
  return Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));
}

/** Input-to-output delay in samples, known before any audio arrives (e.g. to delay a dry path). */
export function limiterLatency(sampleRate: number): number {
  return lookaheadSamples(sampleRate) + CENTRE;
}

export class Limiter {
  /** Input-to-output delay in samples. */
  readonly latency: number;
  /** Largest gain reduction in the last processed block, dB (positive). */
  reductionDb = 0;

  private readonly sampleRate: number;
  private readonly lookahead: number;
  private readonly hold: number;
  private readonly branches: Float64Array[];
  private drive = 1;
  private ceiling = 1;
  private release = 0;

  /** Largest sum of |taps| over the branches: no interpolated sample exceeds (window max) × this. */
  private readonly gainBound: number;
  /** Per channel, the last TAPS_PER_PHASE inputs written twice (at i and i + T) so every window is contiguous. */
  private readonly history: Float32Array[] = [];
  private readonly delay: Float32Array[] = [];
  private pos = 0;

  private readonly minValues: Float64Array;
  private readonly minIndices: Float64Array;
  private minHead = 0;
  private minCount = 0;

  private readonly box: Float64Array;
  private boxSum: number;
  private boxPos = 0;
  private reduction = 0;

  constructor(sampleRate: number, params: LimiterParams) {
    this.sampleRate = sampleRate;
    this.lookahead = lookaheadSamples(sampleRate);
    this.hold = this.lookahead + 2;
    this.latency = limiterLatency(sampleRate);
    this.branches = polyphaseFilter(oversamplingFactor(sampleRate) * DETECTION_OVERSAMPLING).slice(1);
    // A hair over the exact bound, so float rounding in the filter sums can never slip past it.
    this.gainBound = Math.max(1, ...this.branches.map((b) => b.reduce((s, x) => s + Math.abs(x), 0))) * (1 + 1e-9);
    this.minValues = new Float64Array(this.hold + 1);
    this.minIndices = new Float64Array(this.hold + 1);
    this.box = new Float64Array(this.lookahead).fill(1);
    this.boxSum = this.lookahead;
    this.setParams(params);
  }

  setParams(params: LimiterParams): void {
    this.drive = 10 ** (params.driveDb / 20);
    this.ceiling = 10 ** ((params.ceilingDb - SAFETY_DB) / 20);
    this.release = Math.exp(-1000 / (params.releaseMs * this.sampleRate));
  }

  private ensureChannels(count: number): void {
    while (this.history.length < count) {
      this.history.push(new Float32Array(2 * TAPS_PER_PHASE));
      this.delay.push(new Float32Array(this.latency + 1));
    }
  }

  /** Sliding minimum over the last `hold` values (monotonic deque in a ring). */
  private pushMin(value: number): number {
    const cap = this.minValues.length;
    while (this.minCount > 0 && this.minValues[(this.minHead + this.minCount - 1) % cap] >= value) this.minCount--;
    const slot = (this.minHead + this.minCount) % cap;
    this.minValues[slot] = value;
    this.minIndices[slot] = this.pos;
    this.minCount++;
    while (this.minIndices[this.minHead] <= this.pos - this.hold) {
      this.minHead = (this.minHead + 1) % cap;
      this.minCount--;
    }
    return this.minValues[this.minHead];
  }

  /**
   * Gain needed so the interpolated peak around the centre sample stays under the ceiling (1 = none).
   * Skips the filters when even the worst case (window max × gainBound) can't reach the ceiling:
   * the answer is then exactly 1 either way, so this is bit-identical to always filtering.
   */
  private neededGain(channels: number): number {
    const T = TAPS_PER_PHASE;
    const top = (this.pos % T) + T;
    let windowMax = 0;
    for (let c = 0; c < channels; c++) {
      const h = this.history[c];
      for (let k = top - T + 1; k <= top; k++) {
        const a = Math.abs(h[k]);
        if (a > windowMax) windowMax = a;
      }
    }
    if (windowMax * this.gainBound <= this.ceiling) return 1;
    let peak = 0;
    const branches = this.branches;
    for (let c = 0; c < channels; c++) {
      const h = this.history[c];
      peak = Math.max(peak, Math.abs(h[top - CENTRE]));
      for (let j = 0; j < branches.length; j++) {
        const b = branches[j];
        let y = 0;
        for (let k = 0; k < T; k++) y += h[top - k] * b[k];
        peak = Math.max(peak, Math.abs(y));
      }
    }
    return peak > this.ceiling ? this.ceiling / peak : 1;
  }

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const channels = inputs.length;
    this.ensureChannels(channels);
    const n = inputs[0]?.length ?? 0;
    const size = this.latency + 1;
    let blockMax = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const v = inputs[c][i] * this.drive;
        const slot = this.pos % TAPS_PER_PHASE;
        this.history[c][slot] = v;
        this.history[c][slot + TAPS_PER_PHASE] = v;
        this.delay[c][this.pos % size] = v;
      }
      const held = this.pushMin(this.neededGain(channels));
      this.boxSum += held - this.box[this.boxPos];
      this.box[this.boxPos] = held;
      this.boxPos = (this.boxPos + 1) % this.lookahead;
      const average = this.boxSum / this.lookahead;
      const target = average >= 1 ? 0 : -20 * Math.log10(average);
      this.reduction = target >= this.reduction ? target : this.release * this.reduction + (1 - this.release) * target;
      blockMax = Math.max(blockMax, this.reduction);
      const gain = this.reduction === 0 ? 1 : 10 ** (-this.reduction / 20);
      const read = (this.pos + 1) % size;
      for (let c = 0; c < channels; c++) {
        const y = this.delay[c][read] * gain;
        outputs[c][i] = Math.max(-this.ceiling, Math.min(this.ceiling, y));
      }
      this.pos++;
    }
    this.reductionDb = n > 0 ? blockMax : this.reduction;
  }
}
