/**
 * Magnitude response of the desk's EQ biquads, with the Web Audio spec's coefficients (RBJ cookbook;
 * shelves ignore Q and use slope S = 1). DOM-free so the curve can be tested; matches BiquadFilterNode.
 */
import type { EqBand } from "../master/settings.ts";

type Coefficients = [b0: number, b1: number, b2: number, a0: number, a1: number, a2: number];

function coefficients(band: EqBand, sampleRate: number): Coefficients {
  const A = 10 ** (band.gain / 40);
  const w0 = (2 * Math.PI * band.frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  if (band.type === "peaking") {
    const alpha = sin / (2 * band.q);
    return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  const alpha = (sin / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  if (band.type === "lowshelf") {
    return [
      A * (A + 1 - (A - 1) * cos + k),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - k),
      A + 1 + (A - 1) * cos + k,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - k,
    ];
  }
  return [
    A * (A + 1 + (A - 1) * cos + k),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - k),
    A + 1 - (A - 1) * cos + k,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - k,
  ];
}

export function biquadGainDb(band: EqBand, frequency: number, sampleRate: number): number {
  const [b0, b1, b2, a0, a1, a2] = coefficients(band, sampleRate);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const c1 = Math.cos(w);
  const c2 = Math.cos(2 * w);
  const s1 = Math.sin(w);
  const s2 = Math.sin(2 * w);
  const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
  const den = Math.hypot(a0 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
  return 20 * Math.log10(num / den);
}

/** Total EQ response (dB) at each frequency. */
export function eqCurveDb(bands: readonly EqBand[], frequencies: readonly number[], sampleRate: number): number[] {
  return frequencies.map((f) => bands.reduce((sum, b) => sum + biquadGainDb(b, f, sampleRate), 0));
}
