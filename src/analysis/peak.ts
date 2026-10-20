/** Sample peak and BS.1770-4 Annex 2 true peak (oversampled), both in dB relative to full scale. */

export const TAPS_PER_PHASE = 16;
const KAISER_BETA = 7;

export function ampToDb(amp: number): number {
  return 20 * Math.log10(amp);
}

export function samplePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  return ampToDb(peak);
}

/** BS.1770 asks for ≥192 kHz after oversampling. */
export function oversamplingFactor(sampleRate: number): number {
  return sampleRate < 96000 ? 4 : sampleRate < 192000 ? 2 : 1;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** Kaiser-windowed sinc interpolator split into polyphase branches, each normalised to unity DC gain. */
export function polyphaseFilter(factor: number): Float64Array[] {
  const length = factor * TAPS_PER_PHASE;
  const centre = length / 2;
  const phases = Array.from({ length: factor }, () => new Float64Array(TAPS_PER_PHASE));
  for (let n = 0; n < length; n++) {
    const t = (n - centre) / factor;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (n - centre) / centre;
    phases[n % factor][Math.floor(n / factor)] = sinc * (besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / besselI0(KAISER_BETA));
  }
  for (const p of phases) {
    const sum = p.reduce((a, b) => a + b, 0);
    for (let k = 0; k < p.length; k++) p[k] /= sum;
  }
  return phases;
}

/** Streaming true peak (max since reset), fed one block at a time; same numbers as `truePeak()`. */
export class TruePeakMeter {
  private readonly branches: Float64Array[];
  private readonly history: Float32Array[] = [];
  private pos = 0;
  private peak = 0;

  constructor(sampleRate: number) {
    this.branches = polyphaseFilter(oversamplingFactor(sampleRate)).slice(1);
  }

  /** dBTP since the last reset. */
  get max(): number {
    return ampToDb(this.peak);
  }

  push(channels: Float32Array[]): void {
    while (this.history.length < channels.length) this.history.push(new Float32Array(TAPS_PER_PHASE));
    const T = TAPS_PER_PHASE;
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const newest = (this.pos + i) % T;
      for (let c = 0; c < channels.length; c++) {
        const h = this.history[c];
        const x = channels[c][i];
        h[newest] = x;
        if (Math.abs(x) > this.peak) this.peak = Math.abs(x);
        for (const b of this.branches) {
          let y = 0;
          for (let k = 0; k < T; k++) y += h[(newest - k + T) % T] * b[k];
          if (Math.abs(y) > this.peak) this.peak = Math.abs(y);
        }
      }
    }
    this.pos = (this.pos + n) % T;
  }

  reset(): void {
    for (const h of this.history) h.fill(0);
    this.pos = 0;
    this.peak = 0;
  }
}

/** `factor` defaults to the BS.1770 rate; pass a higher one for a stricter check. */
export function truePeak(channels: Float32Array[], sampleRate: number, factor = oversamplingFactor(sampleRate)): number {
  if (factor === 1) return samplePeak(channels);
  const phases = polyphaseFilter(factor);
  // Phase 0 is the identity (integer-centred sinc), so the sample peak covers it.
  const branches = phases.slice(1);
  const gain = Math.max(...branches.map((h) => h.reduce((a, b) => a + Math.abs(b), 0)));
  let peak = 10 ** (samplePeak(channels) / 20);
  const T = TAPS_PER_PHASE;
  for (const x of channels) {
    const padded = new Float32Array(x.length + T * 2);
    padded.set(x, T);
    const blockMax = new Float32Array(Math.ceil(padded.length / T));
    for (let i = 0; i < padded.length; i++) {
      const b = (i / T) | 0;
      blockMax[b] = Math.max(blockMax[b], Math.abs(padded[i]));
    }
    for (let newest = T; newest < x.length + 2 * T; newest++) {
      const windowMax = Math.max(blockMax[((newest - T + 1) / T) | 0], blockMax[(newest / T) | 0]);
      // No interpolated value in this window can exceed windowMax · Σ|h|, so most windows are skipped.
      if (windowMax * gain <= peak) continue;
      for (const h of branches) {
        let y = 0;
        for (let k = 0; k < T; k++) y += padded[newest - k] * h[k];
        if (Math.abs(y) > peak) peak = Math.abs(y);
      }
    }
  }
  return ampToDb(peak);
}
