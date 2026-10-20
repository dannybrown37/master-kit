/**
 * Three-band Linkwitz-Riley (24 dB/oct) crossover. DOM-free.
 *
 *   x ─┬─ LP4(lo) ─► AP(hi) ───────────► low
 *      └─ HP4(lo) ─┬─ LP4(hi) ─────────► mid
 *                  └─ HP4(hi) ─────────► high
 *
 * LP4 + HP4 at one frequency is a 2nd-order allpass (Q = 1/√2), so the low band gets that same allpass at the
 * upper split: the three bands then sum to a flat magnitude (only the phase turns).
 */

type Coefficients = [b0: number, b1: number, b2: number, a1: number, a2: number];

const BUTTERWORTH_Q = Math.SQRT1_2;

/** RBJ cookbook, normalised so a0 = 1. */
function design(type: "lowpass" | "highpass" | "allpass", hz: number, sampleRate: number): Coefficients {
  const w = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  if (type === "lowpass") return [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, a1, a2];
  if (type === "highpass") return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, a1, a2];
  return [a2, a1, 1, a1, a2];
}

/** One biquad per channel: x[n-1], x[n-2], y[n-1], y[n-2]. */
class Biquad {
  c: Coefficients;
  private readonly state: Float64Array[] = [];

  constructor(c: Coefficients) {
    this.c = c;
  }

  /** In place is fine (`out` may be `x`). */
  run(channel: number, x: Float32Array, out: Float32Array, n: number): void {
    while (this.state.length <= channel) this.state.push(new Float64Array(4));
    const s = this.state[channel];
    const [b0, b1, b2, a1, a2] = this.c;
    let x1 = s[0];
    let x2 = s[1];
    let y1 = s[2];
    let y2 = s[3];
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    s[0] = x1;
    s[1] = x2;
    s[2] = y1;
    s[3] = y2;
  }

  reset(): void {
    for (const s of this.state) s.fill(0);
  }
}

export class Crossover {
  private readonly sampleRate: number;
  private readonly lowLp = [new Biquad([1, 0, 0, 0, 0]), new Biquad([1, 0, 0, 0, 0])];
  private readonly lowHp = [new Biquad([1, 0, 0, 0, 0]), new Biquad([1, 0, 0, 0, 0])];
  private readonly highLp = [new Biquad([1, 0, 0, 0, 0]), new Biquad([1, 0, 0, 0, 0])];
  private readonly highHp = [new Biquad([1, 0, 0, 0, 0]), new Biquad([1, 0, 0, 0, 0])];
  private readonly lowAp = new Biquad([1, 0, 0, 0, 0]);
  private lowHz = NaN;
  private highHz = NaN;

  constructor(sampleRate: number, lowHz: number, highHz: number) {
    this.sampleRate = sampleRate;
    this.setFrequencies(lowHz, highHz);
  }

  setFrequencies(lowHz: number, highHz: number): void {
    if (lowHz === this.lowHz && highHz === this.highHz) return;
    this.lowHz = lowHz;
    this.highHz = highHz;
    const sr = this.sampleRate;
    for (const f of this.lowLp) f.c = design("lowpass", lowHz, sr);
    for (const f of this.lowHp) f.c = design("highpass", lowHz, sr);
    for (const f of this.highLp) f.c = design("lowpass", highHz, sr);
    for (const f of this.highHp) f.c = design("highpass", highHz, sr);
    this.lowAp.c = design("allpass", highHz, sr);
  }

  /** `bands[b][c]`: band b (low, mid, high) of channel c; each at least as long as the input. */
  process(inputs: Float32Array[], bands: Float32Array[][]): void {
    const [low, mid, high] = bands;
    for (let c = 0; c < inputs.length; c++) {
      const x = inputs[c];
      const n = x.length;
      this.lowLp[0].run(c, x, low[c], n);
      this.lowLp[1].run(c, low[c], low[c], n);
      this.lowAp.run(c, low[c], low[c], n);
      // The high band doubles as scratch for everything above the low split.
      this.lowHp[0].run(c, x, high[c], n);
      this.lowHp[1].run(c, high[c], high[c], n);
      this.highLp[0].run(c, high[c], mid[c], n);
      this.highLp[1].run(c, mid[c], mid[c], n);
      this.highHp[0].run(c, high[c], high[c], n);
      this.highHp[1].run(c, high[c], high[c], n);
    }
  }

  reset(): void {
    for (const f of [...this.lowLp, ...this.lowHp, ...this.highLp, ...this.highHp, this.lowAp]) f.reset();
  }
}
