import { describe, expect, it } from "vitest";
import { hints } from "./hints.ts";
import type { HintInput } from "./hints.ts";
import { defaultSettings, noBypass } from "./settings.ts";
import { report } from "./test-report.ts";

const NO_BYPASS = noBypass();

function input(over: Partial<HintInput> = {}): HintInput {
  return { original: report({ integrated: -12.8, truePeak: 0.8, plr: 13.6 }), master: report(), settings: defaultSettings(), bypass: NO_BYPASS, ...over };
}

function find(list: ReturnType<typeof hints>, text: RegExp): ReturnType<typeof hints>[number] | undefined {
  return list.find((x) => text.test(x.text));
}

describe("hints", () => {
  it("says the master is on target when nothing is wrong", () => {
    const list = hints(input());
    expect(list).toHaveLength(1);
    expect(list[0].level).toBe("good");
  });

  it("asks for a measurement before judging the master", () => {
    const list = hints(input({ master: null }));
    expect(find(list, /press m/i)?.level).toBe("info");
  });

  it.each([
    ["too loud", -10.5, "bad", /3\.5 LU louder/, -3.5],
    ["too quiet", -17, "warn", /3\.0 LU quieter/, 3],
  ] as const)("loudness %s: points at Drive with the size of the move", (_name, integrated, level, text, move) => {
    const h = find(hints(input({ master: report({ integrated }) })), text);
    expect(h?.level).toBe(level);
    expect(h?.knob).toBe("limDrive");
    expect(h?.suggest).toBeCloseTo(move, 6);
  });

  it.each([
    ["limiter on: lower the ceiling", NO_BYPASS, /ceiling/i, "limCeiling"],
    ["limiter bypassed: turn it on", { ...NO_BYPASS, limiter: true }, /bypassed/i, undefined],
  ] as const)("true peak over -1: %s", (_name, bypass, text, knob) => {
    const h = find(hints(input({ master: report({ truePeak: -0.3 }), bypass })), text);
    expect(h?.level).toBe("bad");
    expect(h?.knob).toBe(knob);
  });

  it("warns when PLR fell a lot", () => {
    expect(find(hints(input({ master: report({ plr: 8 }) })), /PLR fell 5\.6 dB/)?.level).toBe("warn");
  });

  describe("compressor ducking the bass", () => {
    const ORIGINAL_BANDS = [-6, -4, -10, -12, -16, -20];
    // Sub 4.5 dB down, everything else 1 dB up: 5.5 dB lost against the rest.
    const DUCKED = [-10.5, -3, -9, -11, -15, -19];
    const COMPRESSING = { ...defaultSettings(), compThreshold: -20, compRatio: 3 };
    const run = (settings: typeof COMPRESSING, masterBands = DUCKED, bypass = NO_BYPASS): ReturnType<typeof find> =>
      find(hints(input({ original: report({}, ORIGINAL_BANDS), master: report({}, masterBands), settings, bypass })), /Sidechain HPF/);

    it("suggests the sidechain high-pass at ~100 Hz", () => {
      const h = run(COMPRESSING);
      expect(h?.level).toBe("warn");
      expect(h?.text).toMatch(/Sub lost 5\.5 dB/);
      expect(h?.knob).toBe("compSidechainHz");
      expect(h?.suggest).toBeCloseTo(100 - 20, 6);
    });

    it.each([
      ["the sidechain filter is already on", { ...COMPRESSING, compSidechainHz: 90 }, DUCKED, NO_BYPASS],
      ["the low shelf cuts the bass on purpose", { ...COMPRESSING, eqLowGain: -3 }, DUCKED, NO_BYPASS],
      ["the compressor is bypassed", COMPRESSING, DUCKED, { ...NO_BYPASS, comp: true }],
      ["the compressor is idle", defaultSettings(), DUCKED, NO_BYPASS],
      ["the sub barely moved", COMPRESSING, [-7, -3.5, -9.5, -11.5, -15.5, -19.5], NO_BYPASS],
    ])("stays quiet when %s", (_name, settings, masterBands, bypass) => {
      expect(run(settings, masterBands, bypass)).toBeUndefined();
    });
  });

  it("warns when the loud/quiet spread collapsed", () => {
    expect(find(hints(input({ original: report({ loudnessRange: 9 }), master: report({ loudnessRange: 4 }) })), /LRA/)?.level).toBe("warn");
  });

  it.each([
    ["an idle compressor", { compThreshold: 0, compRatio: 3 }, /never reaches the threshold/, "compThreshold"],
    ["a high ratio", { compThreshold: -20, compRatio: 8 }, /ratio/i, "compRatio"],
    ["a very fast attack", { compThreshold: -20, compAttack: 0.5 }, /attack/i, "compAttack"],
    ["a big EQ move", { eqPresGain: 7 }, /Presence gain \+7\.0 dB/, "eqPresGain"],
  ] as const)("flags %s", (_name, settings, text, knob) => {
    const h = find(hints(input({ settings: { ...defaultSettings(), ...settings } })), text);
    expect(h?.knob).toBe(knob);
  });

  it("does not flag the idle default compressor (ratio left at default, threshold at 0)", () => {
    expect(find(hints(input()), /threshold/)).toBeUndefined();
  });

  it("compares tonal balance with a reference and suggests half the gap, capped at 3 dB", () => {
    const reference = report({}, [-11, -4, -10, -12, -11, -20]);
    const list = hints(input({ reference }));
    const sub = find(list, /Sub/);
    expect(sub?.knob).toBe("eqLowGain");
    expect(sub?.suggest).toBeCloseTo(-2.5, 6);
    const presence = find(list, /Presence/);
    expect(presence?.knob).toBe("eqPresGain");
    expect(presence?.suggest).toBeCloseTo(2.5, 6);
    expect(find(list, /Mid/)).toBeUndefined();
  });

  it("blames the one band that differs, not the five it pushes down (bands are shares of the total)", () => {
    const reference = report({}, [-11, -0.5, -6, -7.5, -11.5, -15.5]);
    const tone = hints(input({ reference })).filter((x) => /reference/.test(x.text));
    expect(tone.map((x) => x.text.split(":")[0])).toEqual(["Sub"]);
    expect(tone[0].suggest).toBe(-3);
  });

  it("lists at most three tone hints, biggest gap first", () => {
    const reference = report({}, [-9, -10, -10, -7, -16, -17.5]);
    const tone = hints(input({ reference })).filter((x) => /reference/.test(x.text));
    expect(tone).toHaveLength(3);
    expect(tone.map((x) => x.text.split(":")[0])).toEqual(["Low", "Mid", "Sub"]);
  });

  it.each([
    ["from flat: the 3 dB cap", 0, -3],
    ["already cut 4 dB: only as far as -5.5", -4, -1.5],
    ["already at -5.5: no further move, just the knob", -5.5, undefined],
  ])("caps the suggested EQ move %s", (_name, eqLowGain, want) => {
    const reference = report({}, [-20, -4, -10, -12, -16, -20]);
    const h = find(hints(input({ reference, settings: { ...defaultSettings(), eqLowGain } })), /Sub/);
    expect(h?.knob).toBe("eqLowGain");
    expect(h?.suggest).toBe(want);
  });

  it.each([-5, -3, 0, 3, 5])("applying a tone suggestion from %d dB never triggers the big-EQ warning", (eqLowGain) => {
    for (const refBands of [
      [-20, -4, -10, -12, -16, -20],
      [6, -4, -10, -12, -16, -20],
    ]) {
      const settings = { ...defaultSettings(), eqLowGain };
      const h = find(hints(input({ reference: report({}, refBands), settings })), /Sub/);
      const applied = { ...settings, eqLowGain: eqLowGain + (h?.suggest ?? 0) };
      expect(find(hints(input({ settings: applied })), /big move/)).toBeUndefined();
    }
  });

  it.each([
    ["out of phase", -0.2, "bad"],
    ["very wide", 0.1, "info"],
  ] as const)("stereo: %s master → %s, points at width", (_name, correlation, level) => {
    const h = find(hints(input({ master: report({ stereo: { correlation, sideDb: -2 } }) })), /mono/);
    expect(h?.level).toBe(level);
    expect(h?.knob).toBe("eqWidth");
  });

  it("no stereo hint for silence (correlation NaN)", () => {
    expect(find(hints(input({ master: report({ stereo: { correlation: NaN, sideDb: NaN } }) })), /mono/)).toBeUndefined();
  });

  it("flags a width knob far past 100%", () => {
    expect(find(hints(input({ settings: { ...defaultSettings(), eqWidth: 160 } })), /Stereo width 160%/)?.knob).toBe("eqWidth");
  });

  it.each([
    ["narrower", -18, -10, "narrower", 100 * (10 ** (8 / 20) - 1)],
    ["wider", -6, -12, "wider", 100 * (10 ** (-6 / 20) - 1)],
  ])("width vs reference: %s master", (_name, sideDb, refSideDb, word, move) => {
    const reference = report({ stereo: { correlation: 0.8, sideDb: refSideDb } });
    const h = find(hints(input({ master: report({ stereo: { correlation: 0.9, sideDb } }), reference })), /than the reference: side/);
    expect(h?.text).toContain(word);
    expect(h?.knob).toBe("eqWidth");
    // Capped at ±50, and never into the "too wide" zone (≥ 150%): 145% at most from 100%.
    expect(h?.suggest).toBeCloseTo(Math.max(-50, Math.min(45, move)), 6);
  });

  it.each([100, 120, 140, 145])("applying the width suggestion from %d percent never triggers the too-wide warning", (eqWidth) => {
    const reference = report({ stereo: { correlation: 0.8, sideDb: -6 } });
    const settings = { ...defaultSettings(), eqWidth };
    const h = find(hints(input({ master: report({ stereo: { correlation: 0.9, sideDb: -20 } }), reference, settings })), /than the reference: side/);
    const applied = { ...settings, eqWidth: eqWidth + (h?.suggest ?? 0) };
    expect(find(hints(input({ settings: applied })), /is a lot/)).toBeUndefined();
  });

  it("at the width limit, a narrow master points at the mix instead of suggesting more", () => {
    const reference = report({ stereo: { correlation: 0.8, sideDb: -6 } });
    const h = find(hints(input({ master: report({ stereo: { correlation: 0.9, sideDb: -20 } }), reference, settings: { ...defaultSettings(), eqWidth: 145 } })), /narrower/);
    expect(h?.suggest).toBeUndefined();
    expect(h?.text).toMatch(/already 145%.*in the mix/);
  });

  it("no width hint when within 3 dB of the reference", () => {
    const reference = report({ stereo: { correlation: 0.8, sideDb: -12 } });
    expect(find(hints(input({ master: report({ stereo: { correlation: 0.9, sideDb: -10 } }), reference })), /side/)).toBeUndefined();
  });

  it("sorts problems first", () => {
    const list = hints(input({ master: report({ integrated: -9, plr: 7 }), settings: { ...defaultSettings(), eqAirGain: 8 } }));
    const order = { bad: 0, warn: 1, info: 2, good: 3 };
    for (let i = 1; i < list.length; i++) expect(order[list[i].level]).toBeGreaterThanOrEqual(order[list[i - 1].level]);
  });
});
