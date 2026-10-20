import { describe, expect, it } from "vitest";
import { TAPS_PER_PHASE, TruePeakMeter, samplePeak, truePeak } from "./peak.ts";
import { SR, concat, faded, noise, sine, stereo } from "./test-signals.ts";

describe("true peak (EBU Tech 3341 cases 15–19)", () => {
  it.each([
    ["case 15: fs/4, 0°", SR / 4, -6, 0, -6, -6],
    ["case 16: fs/4, 45°", SR / 4, -6, 45, -6, -6 + 20 * Math.log10(Math.SQRT1_2)],
    ["case 17: fs/6, 60°", SR / 6, -6, 60, -6, -6 + 20 * Math.log10(Math.sin(Math.PI / 3))],
    ["case 18: fs/8, 67.5°", SR / 8, -6, 67.5, -6, -6 + 20 * Math.log10(Math.sin((67.5 * Math.PI) / 180))],
    ["case 19: fs/4, 45°, +3 dBFS", SR / 4, 3, 45, 3, 3 + 20 * Math.log10(Math.SQRT1_2)],
  ])("%s", (_name, freq, db, phase, wantTrue, wantSample) => {
    const channels = stereo(faded(sine(freq, 1, db, SR, phase)));
    const tp = truePeak(channels, SR);
    expect(tp).toBeGreaterThanOrEqual(wantTrue - 0.4);
    expect(tp).toBeLessThanOrEqual(wantTrue + 0.2);
    expect(samplePeak(channels)).toBeCloseTo(wantSample, 2);
  });

  it.each([44100, 96000])("finds an inter-sample peak at %d Hz", (sr) => {
    const tp = truePeak([faded(sine(sr / 4, 1, -6, sr, 45), 0.01, sr)], sr);
    expect(Math.abs(tp - -6)).toBeLessThanOrEqual(0.4);
  });

  it.each([
    ["after quiet noise", noise(5, -20)],
    ["after louder sample peaks at a low frequency", faded(sine(100, 5, -7))],
  ])("finds a late inter-sample peak %s", (_name, lead) => {
    const tp = truePeak([concat(lead, faded(sine(SR / 4, 0.2, -6, SR, 45)))], SR);
    expect(Math.abs(tp - -6)).toBeLessThanOrEqual(0.2);
  });

  it("takes the loudest channel", () => {
    expect(truePeak([sine(1000, 1, -20), sine(1000, 1, -3)], SR)).toBeCloseTo(-3, 1);
  });

  it.each([
    ["silence", [new Float32Array(100)]],
    ["no samples", [new Float32Array(0)]],
  ])("is -Infinity for %s", (_name, channels) => {
    expect(truePeak(channels, SR)).toBe(-Infinity);
    expect(samplePeak(channels)).toBe(-Infinity);
  });

  it.each([1, 128, 1000])("TruePeakMeter matches truePeak() when fed %d-frame blocks", (block) => {
    const x = stereo(concat(noise(1, -20), faded(sine(SR / 4, 0.2, -6, SR, 45)), noise(0.5, -9, 3)));
    const meter = new TruePeakMeter(SR);
    for (let s = 0; s < x[0].length; s += block) meter.push(x.map((c) => c.subarray(s, s + block)));
    meter.push(stereo(new Float32Array(TAPS_PER_PHASE)));
    expect(meter.max).toBeCloseTo(truePeak(x, SR), 6);
  });

  it("TruePeakMeter starts over on reset", () => {
    const meter = new TruePeakMeter(SR);
    meter.push([sine(1000, 0.1, -3)]);
    meter.reset();
    expect(meter.max).toBe(-Infinity);
    meter.push([sine(1000, 0.1, -12)]);
    expect(meter.max).toBeCloseTo(-12, 1);
  });

  it("reads negative-going peaks", () => {
    expect(samplePeak([Float32Array.of(0.1, -0.5, 0.2)])).toBeCloseTo(20 * Math.log10(0.5), 6);
  });
});
