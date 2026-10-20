/** Deterministic synthetic audio for the analysis tests (EBU Tech 3341/3342 style). */

export const SR = 48000;

export function dbToAmp(db: number): number {
  return 10 ** (db / 20);
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sine(freq: number, seconds: number, peakDb: number, sr = SR, phaseDeg = 0): Float32Array {
  const amp = dbToAmp(peakDb);
  const phase = (phaseDeg * Math.PI) / 180;
  return Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr + phase));
}

/** Raised-cosine fade in and out, so a test tone has no step at its edges. */
export function faded(x: Float32Array, seconds = 0.01, sr = SR): Float32Array {
  const n = Math.min(Math.round(seconds * sr), Math.floor(x.length / 2));
  const out = x.slice();
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    out[i] *= g;
    out[x.length - 1 - i] *= g;
  }
  return out;
}

export function noise(seconds: number, peakDb: number, seed = 1, sr = SR): Float32Array {
  const r = rng(seed);
  const amp = dbToAmp(peakDb);
  return Float32Array.from({ length: Math.round(seconds * sr) }, () => amp * (r() * 2 - 1));
}

/** Windowed-sinc FIR lowpass (zero phase), e.g. to mimic an mp3's ~18 kHz bandwidth. */
export function lowpassed(x: Float32Array, cutoffHz: number, sr = SR, taps = 255): Float32Array {
  const half = (taps - 1) / 2;
  const fc = cutoffHz / sr;
  const h = Float64Array.from({ length: taps }, (_, n) => {
    const t = n - half;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    return sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1)));
  });
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let y = 0;
    for (let k = 0; k < taps; k++) {
      const j = i + half - k;
      if (j >= 0 && j < x.length) y += x[j] * h[k];
    }
    out[i] = y;
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Back-to-back 1 kHz sine segments, e.g. [[-36, 10], [-23, 60]] = 10 s at -36 dBFS then 60 s at -23 dBFS. */
export function sineSteps(steps: [peakDb: number, seconds: number][], sr = SR, freq = 1000): Float32Array {
  return concat(...steps.map(([db, s]) => sine(freq, s, db, sr)));
}

export function stereo(mono: Float32Array): Float32Array[] {
  return [mono, mono.slice()];
}
