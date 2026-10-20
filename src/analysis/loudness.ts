/**
 * Loudness per ITU-R BS.1770-4 / EBU R128 (Tech 3341 meters, Tech 3342 loudness range).
 * Channels are summed with weight 1 (mono/stereo); surround weighting is out of scope.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface Loudness {
  /** Gated programme loudness, LUFS. -Infinity when nothing passes the gates. */
  integrated: number;
  /** 400 ms window loudness every 100 ms, LUFS. */
  momentary: number[];
  /** 3 s window loudness every 100 ms, LUFS. */
  shortTerm: number[];
  momentaryMax: number;
  shortTermMax: number;
}

export const HOP_SECONDS = 0.1;
export const MOMENTARY_HOPS = 4;
export const SHORT_TERM_HOPS = 30;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
const LRA_RELATIVE_GATE = -20;
const LRA_LOW_PERCENTILE = 0.1;
const LRA_HIGH_PERCENTILE = 0.95;

/**
 * Pre-filter (high shelf) and RLB high-pass, re-derived for any sample rate from the
 * analog prototype (same constants as libebur128). At 48 kHz they equal the BS.1770 tables.
 */
export function kWeightingCoefficients(sampleRate: number): [Biquad, Biquad] {
  let k = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  let q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  k = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, highpass];
}

export function powerToLufs(meanSquare: number): number {
  return -0.691 + 10 * Math.log10(meanSquare);
}

function lufsToPower(lufs: number): number {
  return 10 ** ((lufs + 0.691) / 10);
}

/** Stateful two-stage K-weighting filter for one channel. */
export class KFilter {
  private readonly f1: Biquad;
  private readonly f2: Biquad;
  private s1a = 0;
  private s1b = 0;
  private s2a = 0;
  private s2b = 0;

  constructor(sampleRate: number) {
    [this.f1, this.f2] = kWeightingCoefficients(sampleRate);
  }

  /** Filters x[start, end) and returns the sum of squared K-weighted samples. */
  energy(x: Float32Array, start: number, end: number): number {
    const { f1, f2 } = this;
    let { s1a, s1b, s2a, s2b } = this;
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = x[i];
      const y1 = f1.b0 * v + s1a;
      s1a = f1.b1 * v - f1.a1 * y1 + s1b;
      s1b = f1.b2 * v - f1.a2 * y1;
      const y2 = f2.b0 * y1 + s2a;
      s2a = f2.b1 * y1 - f2.a1 * y2 + s2b;
      s2b = f2.b2 * y1 - f2.a2 * y2;
      sum += y2 * y2;
    }
    Object.assign(this, { s1a, s1b, s2a, s2b });
    return sum;
  }
}

export function hopLength(sampleRate: number): number {
  return Math.round(HOP_SECONDS * sampleRate);
}

/** Sum of K-weighted squared samples in each 100 ms hop, summed over channels. */
function hopEnergies(channels: Float32Array[], sampleRate: number, hop: number): Float64Array {
  const hops = Math.floor(channels[0].length / hop);
  const energies = new Float64Array(hops);
  for (const x of channels) {
    const filter = new KFilter(sampleRate);
    for (let h = 0; h < hops; h++) energies[h] += filter.energy(x, h * hop, (h + 1) * hop);
  }
  return energies;
}

/** Mean square of each window of `width` hops, sliding by one hop. */
function windowPowers(energies: Float64Array, width: number, hop: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < energies.length; i++) {
    sum += energies[i];
    if (i >= width) sum -= energies[i - width];
    if (i >= width - 1) out.push(Math.max(sum, 0) / (width * hop));
  }
  return out;
}

function gatedMean(powers: number[], relativeGate: number): { mean: number; kept: number[] } {
  const absGated = powers.filter((p) => powerToLufs(p) > ABSOLUTE_GATE);
  if (absGated.length === 0) return { mean: 0, kept: [] };
  const threshold = powerToLufs(absGated.reduce((a, b) => a + b, 0) / absGated.length) + relativeGate;
  const kept = absGated.filter((p) => powerToLufs(p) > threshold);
  return { mean: kept.reduce((a, b) => a + b, 0) / kept.length, kept };
}

/** BS.1770 gated loudness from 400 ms block mean squares, LUFS. */
export function integratedFromBlocks(blockPowers: number[]): number {
  const { mean, kept } = gatedMean(blockPowers, RELATIVE_GATE);
  return kept.length ? powerToLufs(mean) : -Infinity;
}

export function loudness(channels: Float32Array[], sampleRate: number): Loudness {
  const hop = hopLength(sampleRate);
  const energies = hopEnergies(channels, sampleRate, hop);
  const momentaryPowers = windowPowers(energies, MOMENTARY_HOPS, hop);
  const momentary = momentaryPowers.map(powerToLufs);
  const shortTerm = windowPowers(energies, SHORT_TERM_HOPS, hop).map(powerToLufs);
  return {
    integrated: integratedFromBlocks(momentaryPowers),
    momentary,
    shortTerm,
    momentaryMax: momentary.reduce((a, b) => Math.max(a, b), -Infinity),
    shortTermMax: shortTerm.reduce((a, b) => Math.max(a, b), -Infinity),
  };
}

/** EBU Tech 3342 LRA from short-term loudness values (LUFS), in LU. */
export function loudnessRange(shortTerm: number[]): number {
  const { kept } = gatedMean(shortTerm.map(lufsToPower), LRA_RELATIVE_GATE);
  if (kept.length === 0) return 0;
  const sorted = kept.map(powerToLufs).sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.round((sorted.length - 1) * p)];
  return at(LRA_HIGH_PERCENTILE) - at(LRA_LOW_PERCENTILE);
}
