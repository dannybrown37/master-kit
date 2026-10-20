import { describe, expect, it } from "vitest";
import { analyze, crestFactor } from "./report.ts";
import { TARGETS, checkTargets } from "./targets.ts";
import { SR, concat, sine, sineSteps, stereo } from "./test-signals.ts";

function square(seconds: number, amp: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => (Math.floor(i / 24) % 2 ? amp : -amp));
}

describe("crest factor", () => {
  it.each([
    ["sine", sine(1000, 1, -6), 10 * Math.log10(2)],
    ["square", square(1, 0.5), 0],
    ["one spike in silence", concat(new Float32Array(999), Float32Array.of(1)), 30],
  ])("%s → %d dB", (_name, mono, want) => {
    expect(crestFactor([mono])).toBeCloseTo(want, 2);
  });

  it("is -Infinity for silence", () => {
    expect(crestFactor([new Float32Array(10)])).toBe(-Infinity);
  });
});

describe("analyze", () => {
  it("reports every metric for a -23 LUFS sine", () => {
    const r = analyze(stereo(sine(1000, 10, -23)), SR);
    expect(r.durationSeconds).toBeCloseTo(10, 6);
    expect(r.integrated).toBeCloseTo(-23, 1);
    expect(r.momentaryMax).toBeCloseTo(-23, 1);
    expect(r.shortTermMax).toBeCloseTo(-23, 1);
    expect(r.loudnessRange).toBeCloseTo(0, 1);
    expect(r.truePeak).toBeCloseTo(-23, 1);
    expect(r.samplePeak).toBeCloseTo(-23, 1);
    expect(r.crest).toBeCloseTo(3.01, 1);
    expect(r.plr).toBeCloseTo(0, 1);
    expect(r.bands.find((b) => b.key === "mid")?.db).toBeGreaterThan(-0.5);
  });

  it("rejects channels of different lengths", () => {
    expect(() => analyze([new Float32Array(10), new Float32Array(11)], SR)).toThrow(RangeError);
  });

  it.each([0, -1, Number.NaN])("rejects sample rate %d", (sr) => {
    expect(() => analyze([new Float32Array(10)], sr)).toThrow(RangeError);
  });

  it("rejects no channels", () => {
    expect(() => analyze([], SR)).toThrow(RangeError);
  });
});

describe("streaming targets", () => {
  const base = analyze(stereo(sineSteps([[-14, 10]])), SR);

  it.each([
    ["-14 LUFS, -14 dBTP", { integrated: -14, truePeak: -14 }, { loudness: true, truePeak: true }],
    ["-14.9 LUFS edge", { integrated: -14.9, truePeak: -3 }, { loudness: true, truePeak: true }],
    ["too quiet", { integrated: -16, truePeak: -3 }, { loudness: false, truePeak: true }],
    ["too loud and clipping", { integrated: -8, truePeak: 0.3 }, { loudness: false, truePeak: false }],
    ["true peak exactly -1", { integrated: -14, truePeak: -1 }, { loudness: true, truePeak: true }],
  ])("%s", (_name, overrides, want) => {
    expect(checkTargets({ ...base, ...overrides })).toEqual(want);
  });

  it("accepts exactly the edge of the loudness window", () => {
    const edge = TARGETS.integrated - TARGETS.integratedTolerance;
    expect(checkTargets({ ...base, integrated: edge }).loudness).toBe(true);
    expect(checkTargets({ ...base, integrated: edge - 0.01 }).loudness).toBe(false);
  });
});
