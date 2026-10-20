/** Average power spectrum split into mastering bands, for tonal-balance comparison against a reference. */

export interface Band {
  key: string;
  label: string;
  lo: number;
  hi: number;
}

export interface BandEnergy extends Band {
  /** Share of total 20 Hz–20 kHz energy, dB (0 = all of it). */
  db: number;
}

export const BANDS: readonly Band[] = [
  { key: "sub", label: "Sub", lo: 20, hi: 60 },
  { key: "low", label: "Low", lo: 60, hi: 250 },
  { key: "mud", label: "Low-mid (mud)", lo: 250, hi: 500 },
  { key: "mid", label: "Mid", lo: 500, hi: 2000 },
  { key: "presence", label: "Presence", lo: 2000, hi: 6000 },
  { key: "air", label: "Air", lo: 6000, hi: 20000 },
];

/** Mastering analysers tilt the spectrum up this much so a typical mix reads roughly flat. */
export const ANALYSER_TILT_DB_PER_OCT = 4.5;

/**
 * Band shares (dB, like `bandEnergies`) of a spectrum that reads flat on an analyser tilted `tiltDbPerOct`:
 * its power density falls as f^-a with a = tilt / (10·log10 2).
 */
export function tiltedShares(tiltDbPerOct: number): number[] {
  const a = tiltDbPerOct / (10 * Math.log10(2));
  const integral = (lo: number, hi: number): number => (Math.abs(1 - a) < 1e-9 ? Math.log(hi / lo) : (hi ** (1 - a) - lo ** (1 - a)) / (1 - a));
  const power = BANDS.map((b) => integral(b.lo, b.hi));
  const total = power.reduce((x, y) => x + y, 0);
  return power.map((p) => 10 * Math.log10(p / total));
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Each band minus its target, minus the median of those gaps. Bands are shares of total energy, so one heavy band
 * makes every other band read low; removing the median leaves only the bands that really differ (+ = heavier).
 */
export function relativeGaps(bandsDb: readonly number[], targetDb: readonly number[]): number[] {
  const raw = bandsDb.map((db, i) => db - targetDb[i]);
  const offset = median(raw);
  return raw.map((g) => g - offset);
}

const FFT_SIZE = 8192;

const twiddleCache = new Map<number, [Float64Array, Float64Array]>();

function twiddles(n: number): [Float64Array, Float64Array] {
  let t = twiddleCache.get(n);
  if (!t) {
    t = [
      Float64Array.from({ length: n / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / n)),
      Float64Array.from({ length: n / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / n)),
    ];
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0 || im.length !== n) throw new RangeError(`fft size must be a power of two, got ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const [cos, sin] = twiddles(n);
  for (let size = 2; size <= n; size <<= 1) {
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * Welch-averaged power per FFT bin (Hann window, 50% overlap), summed over channels.
 * Channels go through the FFT in pairs as re + i·im; for real inputs a and b,
 * |A[k]|² + |B[k]|² = (|X[k]|² + |X[N-k]|²) / 2, which is all we need.
 */
function powerSpectrum(channels: Float32Array[]): Float64Array {
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let c = 0; c < channels.length; c += 2) {
    const a = channels[c];
    const b = channels[c + 1];
    for (let start = 0; start < a.length; start += FFT_SIZE / 2) {
      re.fill(0);
      im.fill(0);
      const n = Math.min(FFT_SIZE, a.length - start);
      for (let i = 0; i < n; i++) re[i] = a[start + i] * window[i];
      if (b) for (let i = 0; i < n; i++) im[i] = b[start + i] * window[i];
      fft(re, im);
      for (let k = 0; k < power.length; k++) {
        const m = (FFT_SIZE - k) % FFT_SIZE;
        power[k] += (re[k] * re[k] + im[k] * im[k] + re[m] * re[m] + im[m] * im[m]) / 2;
      }
    }
  }
  return power;
}

export function bandEnergies(channels: Float32Array[], sampleRate: number): BandEnergy[] {
  const power = powerSpectrum(channels);
  const binHz = sampleRate / FFT_SIZE;
  const sums = BANDS.map((band) => {
    let sum = 0;
    for (let k = Math.ceil(band.lo / binHz); k < Math.min(band.hi / binHz, power.length); k++) sum += power[k];
    return sum;
  });
  const total = sums.reduce((a, b) => a + b, 0);
  return BANDS.map((band, i) => ({ ...band, db: total > 0 ? 10 * Math.log10(sums[i] / total) : -Infinity }));
}
