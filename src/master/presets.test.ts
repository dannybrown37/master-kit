import { describe, expect, it } from "vitest";
import { PRESETS, applyPreset } from "./presets.ts";
import { defaultSettings, parseSettings } from "./settings.ts";

describe("presets", () => {
  it.each(PRESETS.map((p) => [p.name, p] as const))("%s: every value is a valid knob setting", (_name, preset) => {
    const s = applyPreset(preset);
    expect(parseSettings(s)).toEqual(s);
  });

  it("names are unique and every preset explains itself", () => {
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
    for (const p of PRESETS) expect(p.about.length).toBeGreaterThan(20);
  });

  it("starts from the defaults, so knobs a preset doesn't mention are reset", () => {
    const glue = PRESETS.find((p) => p.name === "Gentle glue");
    expect(glue).toBeDefined();
    if (!glue) return;
    const s = applyPreset(glue);
    expect(s.eqLowGain).toBe(defaultSettings().eqLowGain);
    expect(s.compRatio).toBe(glue.settings.compRatio);
  });

  it.each([
    ["a loud song", -11, -14],
    ["a quiet song", -22, -25],
    ["unknown loudness: the preset's own threshold", NaN, -16],
    ["clamped to the knob's range", -45, -40],
  ])("Gentle glue sets the threshold 3 dB under %s's integrated loudness", (_name, integrated, want) => {
    const glue = PRESETS.find((p) => p.name === "Gentle glue");
    expect(glue && applyPreset(glue, integrated).compThreshold).toBe(want);
  });

  it("'Flat' is the defaults", () => {
    const flat = PRESETS.find((p) => p.name === "Flat (all defaults)");
    expect(flat && applyPreset(flat)).toEqual(defaultSettings());
  });
});
