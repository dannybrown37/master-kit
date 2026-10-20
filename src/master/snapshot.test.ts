import { describe, expect, it } from "vitest";
import { defaultSettings, noBypass } from "./settings.ts";
import { snapshotDiff } from "./snapshot.ts";

const ON = noBypass();
const knobs = (over: object = {}, bypass: object = {}): { settings: ReturnType<typeof defaultSettings>; bypass: typeof ON } => ({
  settings: { ...defaultSettings(), ...over },
  bypass: { ...ON, ...bypass },
});

describe("snapshotDiff", () => {
  it.each([
    ["identical", knobs(), knobs(), "same as your knobs"],
    ["one knob", knobs({ limDrive: 5 }), knobs({ limDrive: 3 }), "Drive +3.0 dB (yours +5.0 dB)"],
    ["a bypass", knobs(), knobs({}, { comp: true }), "Compressor bypassed (yours on)"],
    [
      "more than three: the rest are counted",
      knobs(),
      knobs({ eqLowGain: 2, eqMudGain: -2, compThreshold: -20, limDrive: 4 }, { eq: true }),
      "EQ bypassed (yours on) · Low shelf gain +2.0 dB (yours 0.0 dB) · Mud gain -2.0 dB (yours 0.0 dB) · and 2 more",
    ],
  ])("%s", (_name, current, snap, want) => {
    expect(snapshotDiff(current, snap)).toBe(want);
  });
});
