import { describe, expect, it } from "vitest";
import { COLOR_LATENCY, Color, NEUTRAL_COLOR } from "./color.ts";
import type { ColorParams } from "./color.ts";
import { concat, sine } from "../analysis/test-signals.ts";

const SR = 44100;

function run(color: Color, x: Float32Array, block = 128): { out: Float32Array; gr: number } {
  const out = new Float32Array(x.length);
  let gr = 0;
  for (let i = 0; i < x.length; i += block) {
    const n = Math.min(block, x.length - i);
    color.process([x.subarray(i, i + n)], [out.subarray(i, i + n)]);
    gr = Math.max(gr, color.reductionDb);
  }
  return { out, gr };
}

/** Level (dB re full scale sine) of one frequency, Goertzel over the steady part. */
function toneDb(x: Float32Array, hz: number, from: number): number {
  const w = (2 * Math.PI * hz) / SR;
  let re = 0;
  let im = 0;
  let n = 0;
  for (let i = from; i < x.length; i++, n++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (x.length - from));
    re += x[i] * win * Math.cos(w * n);
    im -= x[i] * win * Math.sin(w * n);
  }
  return 20 * Math.log10((4 * Math.hypot(re, im)) / n);
}

const params = (over: Partial<ColorParams>): ColorParams => ({ ...NEUTRAL_COLOR, ...over });

describe("Color", () => {
  it("neutral: the input exactly, delayed by COLOR_LATENCY", () => {
    const x = sine(1000, 0.1, -1, SR);
    const { out } = run(new Color(SR, NEUTRAL_COLOR), x);
    for (let i = COLOR_LATENCY; i < x.length; i++) expect(out[i]).toBe(x[i - COLOR_LATENCY]);
    expect(out.subarray(0, COLOR_LATENCY).every((v) => v === 0)).toBe(true);
  });

  it("warmth adds odd harmonics to loud parts, leaves quiet ones nearly untouched", () => {
    const loud = run(new Color(SR, params({ warmth: 1 })), sine(1000, 0.5, -1, SR)).out;
    const third = toneDb(loud, 3000, 4000) - toneDb(loud, 1000, 4000);
    expect(third).toBeGreaterThan(-40);
    expect(third).toBeLessThan(-10);
    expect(toneDb(loud, 2000, 4000) - toneDb(loud, 1000, 4000)).toBeLessThan(-80);
    const quiet = run(new Color(SR, params({ warmth: 1 })), sine(1000, 0.5, -40, SR)).out;
    expect(toneDb(quiet, 1000, 4000)).toBeCloseTo(-40, 1);
  });

  it("soft clip holds peaks at its threshold and reports how much it shaved", () => {
    const thresholdDb = -6;
    const { out, gr } = run(new Color(SR, params({ clipDb: thresholdDb })), sine(1000, 0.5, 0, SR));
    let peak = 0;
    for (let i = 4000; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(20 * Math.log10(peak)).toBeLessThan(thresholdDb + 0.3);
    expect(gr).toBeGreaterThan(4);
    expect(gr).toBeLessThan(6.5);
  });

  it("soft clip leaves audio under its knee alone", () => {
    const x = sine(1000, 0.2, -12, SR);
    const { out, gr } = run(new Color(SR, params({ clipDb: -6 })), x);
    for (let i = 2000; i < x.length; i++) expect(Math.abs(out[i] - x[i - COLOR_LATENCY])).toBeLessThan(1e-3);
    expect(gr).toBe(0);
  });

  it("oversampling keeps clipping distortion from folding back below the tone", () => {
    // Without oversampling, the 5th harmonic of 7 kHz (35 kHz) would alias to 9.1 kHz at 44.1 kHz.
    const { out } = run(new Color(SR, params({ clipDb: -12 })), sine(7000, 0.5, 0, SR));
    expect(toneDb(out, 9100, 4000) - toneDb(out, 7000, 4000)).toBeLessThan(-60);
  });

  it("turning it on mid-song crossfades without a click", () => {
    const color = new Color(SR, NEUTRAL_COLOR);
    const x = sine(100, 0.4, -6, SR);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      if (i === 8192) color.setParams(params({ warmth: 1, clipDb: -12 }));
      color.process([x.subarray(i, i + 128)], [out.subarray(i, i + 128)]);
    }
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    const sineStep = 0.5 * ((2 * Math.PI * 100) / SR);
    expect(jump).toBeLessThan(sineStep * 3);
  });

  it("is stereo-linked: both channels get the same processing", () => {
    const x = concat(sine(1000, 0.1, 0, SR));
    const color = new Color(SR, params({ warmth: 0.5, clipDb: -6 }));
    const l = new Float32Array(x.length);
    const r = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) color.process([x.subarray(i, i + 128), x.subarray(i, i + 128)], [l.subarray(i, i + 128), r.subarray(i, i + 128)]);
    expect(r).toEqual(l);
  });
});
