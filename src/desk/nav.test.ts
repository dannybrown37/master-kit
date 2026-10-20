import { describe, expect, it } from "vitest";
import { initialNav, knobsOf, moveKnob, moveModule, selectKnob, selected } from "./nav.ts";

describe("desk navigation", () => {
  it("starts on the first EQ knob", () => {
    expect(selected(initialNav())).toBe("eqLowFreq");
  });

  it.each([
    ["down one", 1, "eqLowGain"],
    ["up from the top wraps to the bottom", -1, knobsOf("eq").at(-1)],
    ["down past the bottom wraps to the top", knobsOf("eq").length, "eqLowFreq"],
  ] as const)("↑↓ stays inside the module: %s", (_name, delta, want) => {
    expect(selected(moveKnob(initialNav(), delta))).toBe(want);
  });

  it.each([
    ["tab goes to the multiband", 1, "multi"],
    ["two tabs go to the compressor", 2, "comp"],
    ["three tabs go to the limiter", 3, "limiter"],
    ["shift-tab wraps to edges", -1, "edges"],
    ["five tabs come back to EQ", 5, "eq"],
  ] as const)("%s", (_name, delta, want) => {
    expect(moveModule(initialNav(), delta).module).toBe(want);
  });

  it("remembers the knob in each module", () => {
    let nav = moveKnob(initialNav(), 3);
    nav = moveModule(nav, 2);
    nav = moveKnob(nav, 1);
    expect(selected(nav)).toBe("compRatio");
    nav = moveModule(nav, -1);
    expect(selected(nav)).toBe("mbLowThreshold");
    expect(selected(moveModule(nav, -1))).toBe("eqMudGain");
  });

  it("selectKnob jumps to any knob and its module", () => {
    const nav = selectKnob(initialNav(), "limCeiling");
    expect(nav.module).toBe("limiter");
    expect(selected(nav)).toBe("limCeiling");
  });

  it("does not mutate its input", () => {
    const nav = initialNav();
    moveKnob(nav, 1);
    moveModule(nav, 1);
    expect(nav).toEqual(initialNav());
  });
});
