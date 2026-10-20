import { describe, expect, it } from "vitest";
import { biquadGainDb, eqCurveDb } from "./biquad.ts";
import type { EqBand } from "../master/settings.ts";

const FS = 48000;
const peak = (gain: number, q = 1): EqBand => ({ type: "peaking", frequency: 1000, gain, q });
const low = (gain: number): EqBand => ({ type: "lowshelf", frequency: 100, gain, q: 1 });
const high = (gain: number): EqBand => ({ type: "highshelf", frequency: 10000, gain, q: 1 });

describe("biquadGainDb (Web Audio / RBJ cookbook)", () => {
  it.each([
    ["peaking: full gain at its centre", peak(6), 1000, 6],
    ["peaking: cut at its centre", peak(-4.5), 1000, -4.5],
    ["peaking: nothing far below", peak(6), 20, 0],
    ["peaking: nothing far above", peak(6), 20000, 0],
    ["low shelf: full gain at the bottom", low(6), 10, 6],
    ["low shelf: half gain at its frequency", low(6), 100, 3],
    ["low shelf: nothing at the top", low(6), 15000, 0],
    ["high shelf: full gain at the top", high(-6), 23000, -6],
    ["high shelf: half gain at its frequency", high(-6), 10000, -3],
    ["high shelf: nothing at the bottom", high(-6), 50, 0],
    ["0 dB is flat", peak(0), 1000, 0],
  ] as const)("%s", (_name, band, f, want) => {
    expect(biquadGainDb(band, f, FS)).toBeCloseTo(want, 1);
  });

  it("a narrower Q falls off faster", () => {
    expect(biquadGainDb(peak(6, 4), 1500, FS)).toBeLessThan(biquadGainDb(peak(6, 0.5), 1500, FS));
  });

  it("eqCurveDb sums the bands in dB", () => {
    const bands = [low(3), peak(-2), high(4)];
    const [f] = [1000];
    const sum = bands.reduce((s, b) => s + biquadGainDb(b, f, FS), 0);
    expect(eqCurveDb(bands, [f], FS)[0]).toBeCloseTo(sum, 9);
  });
});
