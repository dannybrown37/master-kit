/**
 * Feed-forward, stereo-linked peak or RMS compressor with a soft knee and explicit makeup gain.
 * Gain reduction is smoothed in dB with separate attack and release one-pole filters.
 * DOM-free: runs in an AudioWorklet and in Node tests.
 */

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  /** High-pass on the detector only, so bass alone doesn't pump the mix. 0 = off. */
  sidechainHz: number;
  /** 0 = peak detector; otherwise RMS over this window (ms), which follows loudness rather than transients. */
  rmsMs: number;
}

/** RBJ cookbook 2nd-order high-pass (Butterworth Q), normalised so a0 = 1. */
function highpass(hz: number, sampleRate: number): [b0: number, b1: number, b2: number, a1: number, a2: number] {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/** Output level (dB) for a given detector level (dB). */
export function gainComputer(inputDb: number, p: CompressorParams): number {
  const over = inputDb - p.thresholdDb;
  const slope = 1 / p.ratio - 1;
  if (2 * over < -p.kneeDb) return inputDb;
  if (2 * Math.abs(over) <= p.kneeDb && p.kneeDb > 0) return inputDb + (slope * (over + p.kneeDb / 2) ** 2) / (2 * p.kneeDb);
  return p.thresholdDb + over / p.ratio;
}

function coefficient(ms: number, sampleRate: number): number {
  return ms > 0 ? Math.exp(-1000 / (ms * sampleRate)) : 0;
}

export class Compressor {
  private readonly sampleRate: number;
  private params!: CompressorParams;
  private attack = 0;
  private release = 0;
  private makeup = 1;
  private reduction = 0;
  private rms = 0;
  /** Linear detector level where the knee begins; below it nothing is compressed. */
  private kneeStart = 0;
  private meanSquare = 0;
  private filter: ReturnType<typeof highpass> | null = null;
  /** Per channel: x[n-1], x[n-2], y[n-1], y[n-2] of the sidechain filter. */
  private readonly filterState: Float64Array[] = [];
  /** Largest gain reduction in the last processed block, dB (positive). */
  reductionDb = 0;

  constructor(sampleRate: number, params: CompressorParams) {
    this.sampleRate = sampleRate;
    this.setParams(params);
  }

  setParams(params: CompressorParams): void {
    this.params = { ...params };
    this.attack = coefficient(params.attackMs, this.sampleRate);
    this.release = coefficient(params.releaseMs, this.sampleRate);
    this.makeup = 10 ** (params.makeupDb / 20);
    this.rms = params.rmsMs > 0 ? coefficient(params.rmsMs, this.sampleRate) : 0;
    // A hair under the true knee start, so rounding can't skip a level that is inside the knee.
    this.kneeStart = 10 ** ((params.thresholdDb - params.kneeDb / 2) / 20) * (1 - 1e-9);
    this.filter = params.sidechainHz > 0 ? highpass(params.sidechainHz, this.sampleRate) : null;
  }

  private detect(inputs: Float32Array[], i: number): number {
    let level = 0;
    const f = this.filter;
    for (let c = 0; c < inputs.length; c++) {
      const x = inputs[c][i];
      if (!f) {
        level = Math.max(level, Math.abs(x));
        continue;
      }
      while (this.filterState.length <= c) this.filterState.push(new Float64Array(4));
      const s = this.filterState[c];
      const y = f[0] * x + f[1] * s[0] + f[2] * s[1] - f[3] * s[2] - f[4] * s[3];
      s[1] = s[0];
      s[0] = x;
      s[3] = s[2];
      s[2] = y;
      level = Math.max(level, Math.abs(y));
    }
    return level;
  }

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const n = inputs[0]?.length ?? 0;
    let blockMax = 0;
    for (let i = 0; i < n; i++) {
      let level = this.detect(inputs, i);
      if (this.rms > 0) {
        this.meanSquare = this.rms * this.meanSquare + (1 - this.rms) * level * level;
        level = Math.sqrt(this.meanSquare);
      }
      // Below the knee the curve is the identity, so the target is exactly 0 without the log.
      let target = 0;
      if (level >= this.kneeStart) {
        const levelDb = level > 0 ? 20 * Math.log10(level) : -200;
        target = levelDb - gainComputer(levelDb, this.params);
      }
      const a = target > this.reduction ? this.attack : this.release;
      this.reduction = a * this.reduction + (1 - a) * target;
      blockMax = Math.max(blockMax, this.reduction);
      const gain = this.reduction === 0 ? this.makeup : 10 ** (-this.reduction / 20) * this.makeup;
      for (let c = 0; c < inputs.length; c++) outputs[c][i] = inputs[c][i] * gain;
    }
    this.reductionDb = n > 0 ? blockMax : this.reduction;
  }
}
