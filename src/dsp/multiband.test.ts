import { describe, expect, it } from "vitest";
import { Multiband, NEUTRAL_BAND, isNeutral } from "./multiband.ts";
import type { MultibandParams } from "./multiband.ts";
import { SR, concat, sine } from "../analysis/test-signals.ts";

const BASE: MultibandParams = { lowHz: 200, highHz: 4000, bands: [NEUTRAL_BAND, NEUTRAL_BAND, NEUTRAL_BAND], ratio: 4, attackMs: 5, releaseMs: 100 };

function withBand(i: number, band: { thresholdDb: number; gainDb: number }, p = BASE): MultibandParams {
  return { ...p, bands: p.bands.map((b, j) => (j === i ? band : b)) };
}

/** Runs `x` through in 128-sample blocks (like a worklet); returns the output and the worst reduction seen per band. */
function run(mb: Multiband, x: Float32Array): { out: Float32Array; bandGr: number[] } {
  const out = new Float32Array(x.length);
  const bandGr = [0, 0, 0];
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i);
    const o = new Float32Array(n);
    mb.process([x.subarray(i, i + n)], [o]);
    out.set(o, i);
    mb.bandReductionDb.forEach((db, b) => (bandGr[b] = Math.max(bandGr[b], db)));
  }
  return { out, bandGr };
}

function peakDb(x: Float32Array, from: number): number {
  let m = 0;
  for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return 20 * Math.log10(m);
}

describe("Multiband", () => {
  it("is neutral by default and passes audio bit for bit", () => {
    expect(isNeutral(BASE)).toBe(true);
    const x = sine(1000, 0.1, -3);
    expect(run(new Multiband(SR, BASE), x).out).toEqual(x);
  });

  it.each([
    ["a band gain", withBand(0, { thresholdDb: Infinity, gainDb: 1 })],
    ["a threshold", withBand(2, { thresholdDb: -20, gainDb: 0 })],
  ])("%s makes it active", (_name, p) => {
    expect(isNeutral(p)).toBe(false);
  });

  it.each([
    ["low gain lifts a 50 Hz tone", 50, 6],
    ["but not a 1 kHz tone", 1000, 0],
  ])("%s", (_name, hz, wantDb) => {
    const x = sine(hz, 0.5, -12);
    const { out } = run(new Multiband(SR, withBand(0, { thresholdDb: Infinity, gainDb: 6 })), x);
    expect(peakDb(out, SR / 4) - -12).toBeCloseTo(wantDb, 0);
  });

  it.each([
    ["compresses a 50 Hz tone", 50, true],
    ["leaves a 1 kHz tone alone", 1000, false],
  ])("a low-band threshold %s", (_name, hz, compressed) => {
    const { bandGr } = run(new Multiband(SR, withBand(0, { thresholdDb: -24, gainDb: 0 })), sine(hz, 0.5, -6));
    if (compressed) expect(bandGr[0]).toBeGreaterThan(6);
    else expect(bandGr[0]).toBe(0);
    expect(bandGr.slice(1)).toEqual([0, 0]);
  });

  it("fades in and out without a click", () => {
    const mb = new Multiband(SR, BASE);
    const x = sine(100, 0.3, -6);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      if (i === 128 * 40) mb.setParams(withBand(0, { thresholdDb: Infinity, gainDb: 6 }));
      if (i === 128 * 80) mb.setParams(BASE);
      const o = new Float32Array(128);
      mb.process([x.subarray(i, i + 128)], [o]);
      out.set(o.subarray(0, Math.min(128, x.length - i)), i);
    }
    // A 100 Hz tone at ×2 moves at most 2π·100/SR·amp per sample; a click would jump far more.
    const maxStep = (2 * Math.PI * 100 * 2 * 10 ** (-6 / 20)) / SR;
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(maxStep * 1.5);
    expect(out.subarray(128 * 120)).toEqual(x.subarray(128 * 120, out.length));
  });

  it("reports the worst band as its reduction", () => {
    const mb = new Multiband(SR, withBand(2, { thresholdDb: -30, gainDb: 0 }));
    run(mb, concat(sine(8000, 0.3, -6)));
    expect(mb.reductionDb).toBe(Math.max(...mb.bandReductionDb));
    expect(mb.bandReductionDb[2]).toBeGreaterThan(6);
  });
});
