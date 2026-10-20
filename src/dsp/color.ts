/**
 * Color: tape-style saturation ("warmth", odd harmonics that grow with level) then a soft clipper that shaves the
 * tallest peaks before the limiter, both 2x oversampled. Always delays by COLOR_LATENCY, so the chain's latency
 * doesn't depend on whether it's on; neutral = that delay, bit for bit. Switching on/off crossfades over FADE_MS.
 * DOM-free: runs in an AudioWorklet and in Node tests.
 */
import { Oversampler } from "./oversample.ts";

export interface ColorParams {
  /** 0..1: how much of the saturated signal is mixed in. */
  warmth: number;
  /** Soft-clip threshold, dBFS; Infinity = off. */
  clipDb: number;
}

export const NEUTRAL_COLOR: ColorParams = { warmth: 0, clipDb: Infinity };
export const COLOR_LATENCY = new Oversampler().latency;

/** tanh drive of the warmth curve: higher bends earlier. */
const DRIVE = 1.5;
/** The clipper's knee starts this far under its threshold (linear fraction, ≈ -3 dB). */
const KNEE = 0.7;
const FADE_MS = 20;

export function isNeutralColor(p: ColorParams): boolean {
  return p.warmth <= 0 && p.clipDb === Infinity;
}

/** Unity gain for small signals; loud ones bend over (odd harmonics only, so no DC). */
function warm(x: number, amount: number): number {
  return x + amount * (Math.tanh(DRIVE * x) / DRIVE - x);
}

/** Linear up to KNEE·T, then a tanh curve with matching slope that approaches T. */
function softClip(x: number, t: number): number {
  const a = KNEE * t;
  const ax = Math.abs(x);
  if (ax <= a) return x;
  const y = a + (t - a) * Math.tanh((ax - a) / (t - a));
  return x < 0 ? -y : y;
}

export class Color {
  /** Most a peak was shaved by the clipper in the last block, dB (positive). */
  reductionDb = 0;
  private params: ColorParams = NEUTRAL_COLOR;
  private threshold = Infinity;
  private active = false;
  private mix = 0;
  private readonly fadeStep: number;
  private readonly oversamplers: Oversampler[] = [];
  /** Dry path delayed by COLOR_LATENCY, per channel (ring buffers). */
  private readonly dry: Float32Array[] = [];
  private dryPos = 0;
  private up = new Float32Array(256);
  private wet = new Float32Array(128);

  constructor(sampleRate: number, params: ColorParams) {
    this.fadeStep = 1000 / (FADE_MS * sampleRate);
    this.setParams(params);
  }

  setParams(p: ColorParams): void {
    const active = !isNeutralColor(p);
    // Waking up: the oversamplers start from silence, not from audio left over from the last time it was on.
    if (active && !this.active && this.mix === 0) for (const o of this.oversamplers) o.reset();
    // Switching off fades out what was playing rather than jumping to neutral settings.
    if (active) {
      this.params = { ...p };
      this.threshold = 10 ** (p.clipDb / 20);
    }
    this.active = active;
  }

  private ensure(channels: number, n: number): void {
    while (this.dry.length < channels) {
      this.dry.push(new Float32Array(COLOR_LATENCY + 1));
      this.oversamplers.push(new Oversampler());
    }
    if (this.wet.length < n) {
      this.wet = new Float32Array(n);
      this.up = new Float32Array(2 * n);
    }
  }

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const n = inputs[0]?.length ?? 0;
    this.ensure(inputs.length, n);
    const size = COLOR_LATENCY + 1;
    const start = this.dryPos;
    const processing = this.active || this.mix > 0;
    let worst = 1;
    let mix = this.mix;
    for (let c = 0; c < inputs.length; c++) {
      const x = inputs[c];
      const out = outputs[c];
      const dry = this.dry[c];
      let pos = start;
      for (let i = 0; i < n; i++) {
        dry[pos] = x[i];
        pos = pos + 1 === size ? 0 : pos + 1;
        out[i] = dry[pos];
      }
      if (!processing) continue;
      const up = this.up.subarray(0, 2 * n);
      const wet = this.wet.subarray(0, n);
      this.oversamplers[c].up(x.subarray(0, n), up);
      const { warmth } = this.params;
      const t = this.threshold;
      for (let i = 0; i < up.length; i++) {
        let v = warmth > 0 ? warm(up[i], warmth) : up[i];
        if (t !== Infinity) {
          const clipped = softClip(v, t);
          if (clipped !== v) worst = Math.max(worst, Math.abs(v) / Math.abs(clipped));
          v = clipped;
        }
        up[i] = v;
      }
      this.oversamplers[c].down(up, wet);
      const target = this.active ? 1 : 0;
      mix = this.mix;
      for (let i = 0; i < n; i++) {
        mix = target > mix ? Math.min(target, mix + this.fadeStep) : Math.max(target, mix - this.fadeStep);
        out[i] = mix === 1 ? wet[i] : out[i] + (wet[i] - out[i]) * mix;
      }
    }
    this.dryPos = (start + n) % size;
    if (processing) this.mix = mix;
    this.reductionDb = 20 * Math.log10(worst);
  }
}
