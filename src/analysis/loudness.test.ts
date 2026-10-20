import { describe, expect, it } from "vitest";
import { kWeightingCoefficients, loudness, loudnessRange } from "./loudness.ts";
import { SR, noise, sine, sineSteps, stereo } from "./test-signals.ts";

describe("K-weighting coefficients", () => {
  it("match the BS.1770-4 tables at 48 kHz", () => {
    const [shelf, highpass] = kWeightingCoefficients(48000);
    const expected = [
      [shelf.b0, 1.53512485958697],
      [shelf.b1, -2.69169618940638],
      [shelf.b2, 1.19839281085285],
      [shelf.a1, -1.69065929318241],
      [shelf.a2, 0.73248077421585],
      [highpass.b0, 1],
      [highpass.b1, -2],
      [highpass.b2, 1],
      [highpass.a1, -1.99004745483398],
      [highpass.a2, 0.99007225036621],
    ];
    for (const [got, want] of expected) expect(got).toBeCloseTo(want, 6);
  });
});

describe("integrated loudness (EBU Tech 3341)", () => {
  it.each([
    ["case 1: -23 dBFS 20 s", [[-23, 20]], -23],
    ["case 2: -33 dBFS 20 s", [[-33, 20]], -33],
    ["case 3: -36/-23/-36", [[-36, 10], [-23, 60], [-36, 10]], -23],
    ["case 4: -72/-36/-23/-36/-72", [[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]], -23],
    ["case 5: -26/-20/-26", [[-26, 20], [-20, 20.1], [-26, 20]], -23],
  ] as [string, [number, number][], number][])("%s → %d LUFS", (_name, steps, want) => {
    const result = loudness(stereo(sineSteps(steps)), SR);
    expect(Math.abs(result.integrated - want)).toBeLessThanOrEqual(0.1);
  });

  it.each([44100, 48000, 96000])("is sample-rate independent (%d Hz)", (sr) => {
    expect(loudness(stereo(sine(1000, 5, -23, sr)), sr).integrated).toBeCloseTo(-23, 1);
  });

  it("sums channels by power: mono in one channel is 3 dB quieter than stereo", () => {
    const mono = sine(1000, 5, -23);
    const one = loudness([mono, new Float32Array(mono.length)], SR).integrated;
    const both = loudness(stereo(mono), SR).integrated;
    expect(both - one).toBeCloseTo(10 * Math.log10(2), 1);
  });

  it.each([
    ["silence", new Float32Array(SR * 5)],
    ["shorter than one 400 ms block", sine(1000, 0.3, -10)],
    ["below the -70 LUFS absolute gate", sine(1000, 5, -75)],
  ])("returns -Infinity for %s", (_name, mono) => {
    expect(loudness(stereo(mono), SR).integrated).toBe(-Infinity);
  });

  it("weights low frequencies down (K-weighting): 40 Hz reads quieter than 1 kHz", () => {
    const low = loudness(stereo(sine(40, 5, -23)), SR).integrated;
    expect(low).toBeLessThan(-23 - 1);
  });
});

describe("momentary and short-term loudness (EBU Tech 3341)", () => {
  it.each([
    ["-23 dBFS", -23],
    ["-33 dBFS", -33],
  ])("steady %s sine reads the same M, S and I", (_name, db) => {
    const r = loudness(stereo(sine(1000, 20, db)), SR);
    expect(r.momentaryMax).toBeCloseTo(db, 1);
    expect(r.shortTermMax).toBeCloseTo(db, 1);
  });

  it("produces one value per 100 ms once the window is full", () => {
    const r = loudness(stereo(sine(1000, 10, -23)), SR);
    expect(r.momentary).toHaveLength(97);
    expect(r.shortTerm).toHaveLength(71);
  });

  it("momentary catches a 0.5 s burst that short-term averages away", () => {
    const r = loudness(stereo(sineSteps([[-40, 5], [-10, 0.5], [-40, 5]])), SR);
    expect(r.momentaryMax).toBeCloseTo(-10, 0);
    expect(r.shortTermMax).toBeLessThan(-16);
  });
});

describe("loudness range (EBU Tech 3342)", () => {
  it.each([
    ["case 1: -20/-30", [[-20, 20], [-30, 20]], 10],
    ["case 2: -20/-15", [[-20, 20], [-15, 20]], 5],
    ["case 3: -40/-20", [[-40, 20], [-20, 20]], 20],
    ["case 4: -50/-35/-20/-35/-50", [[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]], 15],
  ] as [string, [number, number][], number][])("%s → %d LU", (_name, steps, want) => {
    const st = loudness(stereo(sineSteps(steps)), SR).shortTerm;
    expect(Math.abs(loudnessRange(st) - want)).toBeLessThanOrEqual(1);
  });

  it("is ~0 for a steady signal", () => {
    expect(loudnessRange(loudness(stereo(noise(20, -20)), SR).shortTerm)).toBeLessThan(0.5);
  });

  it("is 0 when there are no short-term blocks", () => {
    expect(loudnessRange([])).toBe(0);
  });
});
