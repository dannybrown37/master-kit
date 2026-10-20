/** Pure math for the spectrum panel: log-frequency columns from FFT bins. */

const TILT_PIVOT_HZ = 1000;

/** Centres of `n` columns spaced evenly in octaves from `fMin` to `fMax`. */
export function logFrequencies(n: number, fMin: number, fMax: number): number[] {
  const span = Math.log2(fMax / fMin);
  return Array.from({ length: n }, (_, i) => fMin * 2 ** (((i + 0.5) / n) * span));
}

/** Power average of each column with `halfWidth` neighbours on each side (fractional-octave smoothing on log columns). */
export function smoothColumns(db: readonly number[], halfWidth: number): number[] {
  const power = db.map((v) => 10 ** (v / 10));
  return db.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfWidth); j <= Math.min(db.length - 1, i + halfWidth); j++) {
      sum += power[j];
      count++;
    }
    return 10 * Math.log10(sum / count);
  });
}

/**
 * Average power of the FFT bins (dB, as from AnalyserNode.getFloatFrequencyData) in each log column, plus
 * `tiltDbPerOct` around 1 kHz so that a typical mix (falling ~3 dB/octave) reads flat.
 */
export function spectrumColumns(binsDb: Float32Array, sampleRate: number, n: number, fMin: number, fMax: number, tiltDbPerOct: number): number[] {
  const binHz = sampleRate / (2 * binsDb.length);
  const span = Math.log2(fMax / fMin);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = fMin * 2 ** ((i / n) * span);
    const hi = fMin * 2 ** (((i + 1) / n) * span);
    const centre = Math.sqrt(lo * hi);
    const first = Math.ceil(lo / binHz);
    const last = Math.min(binsDb.length - 1, Math.ceil(hi / binHz) - 1);
    let power = 0;
    let count = 0;
    for (let k = first; k <= last; k++) {
      power += 10 ** (binsDb[k] / 10);
      count++;
    }
    if (count === 0) {
      power = 10 ** (binsDb[Math.min(binsDb.length - 1, Math.round(centre / binHz))] / 10);
      count = 1;
    }
    out.push(10 * Math.log10(power / count) + tiltDbPerOct * Math.log2(centre / TILT_PIVOT_HZ));
  }
  return out;
}
