import { describe, expect, it } from "vitest";
import { BUTTERWORTH_Q_DB, PARAMS, clampParam, colorParams, compressorParams, defaultSettings, edgeParams, tamerParams, eqBands, formatParam, fromFraction, changedParams, limiterParams, multibandParams, noBypass, nudge, parseSettings, stereoParams, toFraction } from "./settings.ts";
import { Compressor } from "../dsp/compressor.ts";
import { NEUTRAL_COLOR } from "../dsp/color.ts";
import { NEUTRAL_EDGES } from "../dsp/edges.ts";
import { NEUTRAL_TAMER } from "../dsp/tamer.ts";
import { Limiter } from "../dsp/limiter.ts";
import { SR, sine } from "../analysis/test-signals.ts";

const NO_BYPASS = noBypass();
const ALL_BYPASS = { eq: true, tame: true, multi: true, comp: true, color: true, limiter: true, edges: true };

describe("settings", () => {
  it("every default sits inside its range", () => {
    for (const p of PARAMS) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
  });

  it("keys are unique", () => {
    expect(new Set(PARAMS.map((p) => p.key)).size).toBe(PARAMS.length);
  });

  it.each([
    ["clamps above max", "eqLowGain", 40, 12],
    ["clamps below min", "limCeiling", -9, -3],
    ["rounds to step", "eqLowGain", 1.26, 1.5],
    ["keeps log params unrounded", "eqPresFreq", 3333.3, 3333.3],
    ["replaces NaN with the default", "compRatio", Number.NaN, 2],
  ] as const)("%s", (_name, key, value, want) => {
    expect(clampParam(key, value)).toBeCloseTo(want, 6);
  });

  it.each([
    ["eqMudQ", 1.2],
    ["compRatio", 2.3],
    ["limDrive", 0.7],
    ["limCeiling", -0.3],
  ] as const)("rounding to the step leaves no float noise: %s %d", (key, value) => {
    expect(clampParam(key, value)).toBe(value);
  });

  it.each([
    ["lin", "eqLowGain", 0, 0.5],
    ["log", "eqLowFreq", Math.sqrt(30 * 300), 0.5],
    ["min", "compAttack", 0.1, 0],
    ["max", "limRelease", 500, 1],
  ] as const)("toFraction maps %s values onto 0..1", (_name, key, value, want) => {
    expect(toFraction(key, value)).toBeCloseTo(want, 9);
    expect(fromFraction(key, want)).toBeCloseTo(value, 6);
  });

  it.each([
    ["lin up one coarse nudge", "eqMudGain", 0, 1, 0.5],
    ["lin down", "eqMudGain", 0, -1, -0.5],
    ["fine nudge still moves one step", "eqMudGain", 0, 0.2, 0.5],
    ["stops at max", "eqMudGain", 12, 1, 12],
    ["ratio moves by 0.2", "compRatio", 2, 1, 2.2],
    ["log params move by a constant factor", "eqPresFreq", 3000, 1, 3000 * (8000 / 1000) ** (1 / 40)],
  ] as const)("nudge: %s", (_name, key, value, steps, want) => {
    expect(nudge(key, value, steps)).toBeCloseTo(want, 6);
  });

  it("formats values with their unit", () => {
    expect(formatParam("eqLowFreq", 99.6)).toBe("100 Hz");
    expect(formatParam("eqAirFreq", 12345)).toBe("12.3 kHz");
    expect(formatParam("eqMudGain", -2)).toBe("-2.0 dB");
    expect(formatParam("eqMudGain", 1.5)).toBe("+1.5 dB");
    expect(formatParam("compRatio", 4)).toBe("4.0:1");
    expect(formatParam("compSidechainHz", 20)).toBe("off");
    expect(formatParam("eqWidth", 120)).toBe("120%");
    expect(formatParam("eqWidth", 0)).toBe("mono");
    expect(formatParam("eqMonoBassHz", 20)).toBe("off");
    expect(formatParam("eqMonoBassHz", 120)).toBe("120 Hz");
    expect(formatParam("compRmsMs", 0)).toBe("peak");
    expect(formatParam("compRmsMs", 30)).toBe("RMS 30 ms");
    expect(formatParam("mbLowThreshold", 0)).toBe("off");
    expect(formatParam("mbLowThreshold", -12)).toBe("-12.0 dB");
    expect(formatParam("edgeLeadMs", 0)).toBe("off");
    expect(formatParam("edgeFadeInMs", 5)).toBe("5.0 ms");
    expect(formatParam("edgeLeadMs", 200)).toBe("200 ms");
    expect(formatParam("edgeFadeOutMs", 2500)).toBe("2.5 s");
  });

  it.each([
    ["peak by default", {}, NO_BYPASS, 0],
    ["RMS window passes through", { compRmsMs: 40 }, NO_BYPASS, 40],
  ])("compressor detector: %s", (_name, over, bypass, want) => {
    expect(compressorParams({ ...defaultSettings(), ...over }, bypass).rmsMs).toBe(want);
  });

  it.each([
    ["non-object", "nope", {}],
    ["unknown keys and bad types", { bogus: 1, eqLowGain: "3", compRatio: 4 }, { compRatio: 4 }],
    ["out-of-range values", { limCeiling: 5 }, { limCeiling: 0 }],
  ])("parseSettings ignores/clamps %s", (_name, input, overrides) => {
    expect(parseSettings(input)).toEqual({ ...defaultSettings(), ...overrides });
  });
});

describe("module parameters", () => {
  it("maps EQ settings to four biquads, flat when bypassed", () => {
    const s = { ...defaultSettings(), eqMudGain: -3, eqAirGain: 2 };
    expect(eqBands(s, NO_BYPASS).map((b) => [b.type, b.gain])).toEqual([
      ["lowshelf", 0],
      ["peaking", -3],
      ["peaking", 0],
      ["highshelf", 2],
    ]);
    expect(eqBands(s, ALL_BYPASS).every((b) => b.gain === 0)).toBe(true);
  });

  it("mono-bass high-pass has no bump above the cutoff (Web Audio Q is in dB for highpass)", () => {
    // Web Audio spec highpass: alpha = sin(w0) / (2 * 10^(Q/20)); RBJ cookbook coefficients.
    const fs = 48000;
    const f0 = 120;
    const w0 = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w0) / (2 * 10 ** (BUTTERWORTH_Q_DB / 20));
    const c = Math.cos(w0);
    const [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    const [a0, a1, a2] = [1 + alpha, -2 * c, 1 - alpha];
    const gainDb = (f: number): number => {
      const w = (2 * Math.PI * f) / fs;
      const num = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), b1 * Math.sin(w) + b2 * Math.sin(2 * w));
      const den = Math.hypot(a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), a1 * Math.sin(w) + a2 * Math.sin(2 * w));
      return 2 * 20 * Math.log10(num / den);
    };
    const peak = Math.max(...Array.from({ length: 400 }, (_, i) => gainDb(20 * 1.02 ** i)));
    expect(peak).toBeLessThanOrEqual(0.01);
    expect(gainDb(f0)).toBeCloseTo(-6.02, 1);
  });

  it.each([
    ["defaults: untouched", {}, NO_BYPASS, { side: 1, monoBassHz: 0, sideAirHz: 10000, sideAirDb: 0 }],
    ["width and mono bass", { eqWidth: 150, eqMonoBassHz: 120 }, NO_BYPASS, { side: 1.5, monoBassHz: 120, sideAirHz: 10000, sideAirDb: 0 }],
    ["mono bass at the bottom of its range is off", { eqMonoBassHz: 20 }, NO_BYPASS, { side: 1, monoBassHz: 0, sideAirHz: 10000, sideAirDb: 0 }],
    ["side air uses the air shelf's frequency", { eqSideAirGain: 3, eqAirFreq: 8000 }, NO_BYPASS, { side: 1, monoBassHz: 0, sideAirHz: 8000, sideAirDb: 3 }],
    ["EQ bypassed: untouched", { eqWidth: 0, eqMonoBassHz: 200, eqSideAirGain: 4 }, ALL_BYPASS, { side: 1, monoBassHz: 0, sideAirHz: 10000, sideAirDb: 0 }],
  ])("stereo params: %s", (_name, over, bypass, want) => {
    expect(stereoParams({ ...defaultSettings(), ...over }, bypass)).toEqual(want);
  });

  it.each([
    ["compressor", (bypass: typeof NO_BYPASS): Float32Array => {
      const out = new Float32Array(SR / 10);
      new Compressor(SR, compressorParams({ ...defaultSettings(), compThreshold: -30, compMakeup: 6 }, bypass)).process([sine(500, 0.1, -6)], [out]);
      return out;
    }],
    ["limiter", (bypass: typeof NO_BYPASS): Float32Array => {
      const limiter = new Limiter(SR, limiterParams({ ...defaultSettings(), limDrive: 12 }, bypass));
      const out = new Float32Array(SR / 10);
      limiter.process([sine(500, 0.1, -6)], [out]);
      return out.subarray(limiter.latency);
    }],
  ])("bypassed %s passes audio unchanged", (_name, render) => {
    const ref = sine(500, 0.1, -6);
    const out = render(ALL_BYPASS);
    for (let i = 0; i < out.length; i += 97) expect(out[i]).toBeCloseTo(ref[i], 6);
    expect(Math.max(...render(NO_BYPASS).map(Math.abs))).not.toBeCloseTo(Math.max(...out.map(Math.abs)), 1);
  });
});

describe("tamerParams", () => {
  it.each([
    ["defaults: off", {}, NO_BYPASS, NEUTRAL_TAMER],
    ["bands and width pass through", { tameFreq1: 3150, tameDepth1: 4, tameFreq2: 400, tameDepth2: 2, tameQ: 6 }, NO_BYPASS, { q: 6, bands: [{ hz: 3150, depthDb: 4 }, { hz: 400, depthDb: 2 }] }],
    ["bypassed: off", { tameDepth1: 4 }, ALL_BYPASS, NEUTRAL_TAMER],
  ])("%s", (_name, over, bypass, want) => {
    const p = tamerParams({ ...defaultSettings(), ...over }, bypass);
    expect(p.bands.map((b) => b.depthDb)).toEqual(want.bands.map((b) => b.depthDb));
    if (want !== NEUTRAL_TAMER) expect(p).toEqual(want);
  });
});

describe("colorParams", () => {
  it.each([
    ["defaults: off", {}, NO_BYPASS, NEUTRAL_COLOR],
    ["warmth in percent", { colorWarmth: 40 }, NO_BYPASS, { warmth: 0.4, clipDb: Infinity }],
    // The limiter's threshold (before its Drive) is ceiling − drive = -1 − 4 = -5 dBFS; clip 2 dB above it.
    ["clip sits above the limiter's threshold", { colorClipDb: 2, limCeiling: -1, limDrive: 4 }, NO_BYPASS, { warmth: 0, clipDb: -3 }],
    ["bypassed: off", { colorWarmth: 40, colorClipDb: 2 }, ALL_BYPASS, NEUTRAL_COLOR],
  ])("%s", (_name, over, bypass, want) => {
    expect(colorParams({ ...defaultSettings(), ...over }, bypass)).toEqual(want);
  });

  it("formats the clip knob's top as off", () => {
    expect(formatParam("colorClipDb", 6)).toBe("off");
    expect(formatParam("colorClipDb", 2)).toBe("+2.0 dB");
  });
});

describe("edgeParams", () => {
  const set = { edgeLeadMs: 200, edgeFadeInMs: 5, edgeFadeOutMs: 1500, edgeTailMs: 1000 };
  it.each([
    ["defaults: untouched", {}, NO_BYPASS, NEUTRAL_EDGES],
    ["milliseconds become seconds", set, NO_BYPASS, { lead: 0.2, fadeIn: 0.005, fadeOut: 1.5, tail: 1 }],
    ["bypassed: untouched", set, ALL_BYPASS, NEUTRAL_EDGES],
  ])("%s", (_name, over, bypass, want) => {
    expect(edgeParams({ ...defaultSettings(), ...over }, bypass)).toEqual(want);
  });
});

describe("changedParams", () => {
  it.each([
    ["identical", {}, []],
    ["one knob", { limDrive: 3 }, ["limDrive"]],
    ["in PARAMS order", { limDrive: 3, eqLowGain: 2 }, ["eqLowGain", "limDrive"]],
  ] as const)("%s", (_name, over, want) => {
    expect(changedParams(defaultSettings(), { ...defaultSettings(), ...over })).toEqual(want);
  });
});

describe("multibandParams", () => {
  const off = { thresholdDb: Infinity, gainDb: 0 };
  it.each([
    ["defaults: every band off", {}, NO_BYPASS, [off, off, off]],
    ["a threshold below 0 compresses that band", { mbLowThreshold: -18, mbHighGain: -1.5 }, NO_BYPASS, [{ thresholdDb: -18, gainDb: 0 }, off, { thresholdDb: Infinity, gainDb: -1.5 }]],
    ["bypassed: every band off", { mbLowThreshold: -18, mbMidGain: 2 }, ALL_BYPASS, [off, off, off]],
  ])("%s", (_name, over, bypass, bands) => {
    const p = multibandParams({ ...defaultSettings(), ...over }, bypass);
    expect(p.bands).toEqual(bands);
    expect(p).toMatchObject({ lowHz: 200, highHz: 4000, ratio: 3, attackMs: 20, releaseMs: 200 });
  });
});
