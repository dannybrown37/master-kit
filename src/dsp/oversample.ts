/**
 * 2x oversampling for nonlinear stages (saturation, clipping): distortion above the original Nyquist is filtered out
 * before going back down instead of folding into the audible band. DOM-free.
 * One linear-phase Kaiser half-band FIR (95 taps, ~80 dB stopband, flat to ~19.5 kHz at 44.1 kHz) does both
 * directions; up + down delay the signal by exactly `latency` samples. One instance per channel.
 *
 * Half-band: every odd tap is zero except the centre (h[47] = ½). So
 *   up:   y[2n]   = Σ_j 2·h[2j]·x[n−j]          y[2n+1] = x[n−23]
 *   down: z[n]    = Σ_j h[2j]·y[2(n−j)]  +  ½·y[2(n−24)+1]
 * which are plain dot products over the last 48 input / even samples.
 */

const TAPS = 95;
const BETA = 8;
const EVEN = (TAPS + 1) / 2;
const CENTRE = (TAPS - 1) / 2;
/** History length; buffers hold it twice so every window is contiguous. */
const HIST = 64;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Lowpass at a quarter of the oversampled rate (the original Nyquist). */
function halfband(): Float64Array {
  const m = CENTRE;
  return Float64Array.from({ length: TAPS }, (_, k) => {
    const t = k - m;
    const sinc = t === 0 ? 0.5 : Math.sin((Math.PI * t) / 2) / (Math.PI * t);
    return sinc * (besselI0(BETA * Math.sqrt(1 - (t / m) ** 2)) / besselI0(BETA));
  });
}

const H = halfband();
/** h[2j], j = 0..47. */
const H_EVEN = Float64Array.from({ length: EVEN }, (_, j) => H[2 * j]);
const H_EVEN_X2 = H_EVEN.map((c) => 2 * c);
/** The single non-zero odd tap sits CENTRE samples in, i.e. this many base samples back. */
const ODD_DELAY_UP = (CENTRE - 1) / 2;
const ODD_DELAY_DOWN = (CENTRE + 1) / 2;

/** A history where the newest `HIST` values are always contiguous: write twice, read one window. */
class History {
  private readonly buf = new Float64Array(2 * HIST);
  private pos = 0;

  push(v: number): void {
    this.pos = this.pos === 0 ? HIST - 1 : this.pos - 1;
    this.buf[this.pos] = v;
    this.buf[this.pos + HIST] = v;
  }

  /** Σ c[j]·(value j pushes ago). */
  dot(c: Float64Array): number {
    let acc = 0;
    const b = this.buf;
    const p = this.pos;
    for (let j = 0; j < c.length; j++) acc += c[j] * b[p + j];
    return acc;
  }

  ago(j: number): number {
    return this.buf[this.pos + j];
  }

  reset(): void {
    this.buf.fill(0);
  }
}

export class Oversampler {
  /** Base-rate samples from input to output of `up` then `down`. */
  /** Half the filter's length on the way up plus half on the way down, at twice the rate. */
  readonly latency = CENTRE;
  private readonly x = new History();
  private readonly even = new History();
  private readonly odd = new History();

  /** `out` gets 2·x.length samples. */
  up(x: Float32Array, out: Float32Array): void {
    for (let i = 0; i < x.length; i++) {
      this.x.push(x[i]);
      out[2 * i] = this.x.dot(H_EVEN_X2);
      out[2 * i + 1] = this.x.ago(ODD_DELAY_UP);
    }
  }

  /** `y` holds 2·out.length oversampled samples. */
  down(y: Float32Array, out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      this.even.push(y[2 * i]);
      out[i] = this.even.dot(H_EVEN) + 0.5 * this.odd.ago(ODD_DELAY_DOWN - 1);
      this.odd.push(y[2 * i + 1]);
    }
  }

  reset(): void {
    this.x.reset();
    this.even.reset();
    this.odd.reset();
  }
}
