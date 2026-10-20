/**
 * Stereo image: correlation (+1 mono, 0 unrelated, -1 out of phase: cancels when summed to mono)
 * and width as side-over-mid energy in dB (M = (L+R)/2, S = (L-R)/2). Both come from three sums.
 */

export interface StereoImage {
  correlation: number;
  /** Side energy over mid energy, dB: -Infinity for mono, 0 for unrelated channels. */
  sideDb: number;
}

interface Sums {
  ll: number;
  rr: number;
  lr: number;
}

/** Window of the live meter: about what a hardware correlation meter shows. */
const LIVE_SECONDS = 0.3;

function fromSums({ ll, rr, lr }: Sums): StereoImage {
  if (ll === 0 && rr === 0) return { correlation: NaN, sideDb: NaN };
  const mid = ll + rr + 2 * lr;
  const side = ll + rr - 2 * lr;
  const correlation = ll > 0 && rr > 0 ? Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr))) : 0;
  const sideDb = side <= 0 ? -Infinity : mid <= 0 ? Infinity : 10 * Math.log10(side / mid);
  return { correlation, sideDb };
}

function addSums(s: Sums, l: Float32Array, r: Float32Array, scale = 1): void {
  let ll = 0;
  let rr = 0;
  let lr = 0;
  for (let i = 0; i < l.length; i++) {
    ll += l[i] * l[i];
    rr += r[i] * r[i];
    lr += l[i] * r[i];
  }
  s.ll = s.ll * scale + ll;
  s.rr = s.rr * scale + rr;
  s.lr = s.lr * scale + lr;
}

export function stereoImage(channels: Float32Array[]): StereoImage {
  const l = channels[0];
  const r = channels[1] ?? l;
  const sums = { ll: 0, rr: 0, lr: 0 };
  addSums(sums, l, r);
  return fromSums(sums);
}

/** Streaming version over the last ~0.3 s (exponential window, per pushed block). */
export class LiveStereo {
  private readonly sampleRate: number;
  private readonly sums: Sums = { ll: 0, rr: 0, lr: 0 };

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  push(channels: Float32Array[]): void {
    const l = channels[0];
    if (!l) return;
    addSums(this.sums, l, channels[1] ?? l, Math.exp(-l.length / (LIVE_SECONDS * this.sampleRate)));
  }

  get image(): StereoImage {
    return fromSums(this.sums);
  }

  get correlation(): number {
    return this.image.correlation;
  }

  get sideDb(): number {
    return this.image.sideDb;
  }

  reset(): void {
    this.sums.ll = 0;
    this.sums.rr = 0;
    this.sums.lr = 0;
  }
}
