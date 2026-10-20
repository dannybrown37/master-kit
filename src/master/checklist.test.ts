import { describe, expect, it } from "vitest";
import { checklist } from "./checklist.ts";
import type { ChecklistInput } from "./checklist.ts";

const NOTHING: ChecklistInput = {
  hasReference: false,
  heard: { original: false, reference: false, mono: false },
  compGr: [],
  measured: null,
  exported: false,
};
const GOOD_MEASURE = { integrated: -14.2, truePeak: -1.1, dynamicsOk: true };

function done(input: Partial<ChecklistInput>): Record<string, boolean> {
  return Object.fromEntries(checklist({ ...NOTHING, ...input }).map((s) => [s.key, s.done]));
}

describe("checklist", () => {
  it("starts with nothing done, in working order", () => {
    const steps = checklist(NOTHING);
    expect(steps.map((s) => s.key)).toEqual(["reference", "ab", "compress", "loudness", "peaks", "dynamics", "mono", "export"]);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps.every((s) => s.tip.length > 10)).toBe(true);
  });

  it.each([
    ["reference: picked and listened to", { hasReference: true, heard: { original: false, reference: true, mono: false } }, "reference", true],
    ["reference: picked but never heard", { hasReference: true }, "reference", false],
    ["A/B against the original", { heard: { original: true, reference: false, mono: false } }, "ab", true],
    ["mono checked", { heard: { original: false, reference: false, mono: true } }, "mono", true],
    ["exported", { exported: true }, "export", true],
    ["loudness on target", { measured: GOOD_MEASURE }, "loudness", true],
    ["loudness off target", { measured: { ...GOOD_MEASURE, integrated: -16 } }, "loudness", false],
    ["peaks under -1 dBTP", { measured: GOOD_MEASURE }, "peaks", true],
    ["peaks over", { measured: { ...GOOD_MEASURE, truePeak: -0.5 } }, "peaks", false],
    ["dynamics kept", { measured: GOOD_MEASURE }, "dynamics", true],
    ["dynamics lost", { measured: { ...GOOD_MEASURE, dynamicsOk: false } }, "dynamics", false],
  ] as const)("%s", (_name, input, key, want) => {
    expect(done(input)[key]).toBe(want);
  });

  it.each([
    ["no playback yet", [], false],
    ["idle compressor", Array(50).fill(0), false],
    ["gentle: loud moments 1-3 dB", [...Array(30).fill(0.2), ...Array(20).fill(2)], true],
    ["squashing: loud moments 8 dB", [...Array(30).fill(4), ...Array(20).fill(8)], false],
  ])("compression in the sweet spot: %s", (_name, compGr, want) => {
    expect(done({ compGr })["compress"]).toBe(want);
  });

  it("says why compression isn't ticked", () => {
    const step = (gr: number[]): string => checklist({ ...NOTHING, compGr: gr }).find((s) => s.key === "compress")?.status ?? "";
    expect(step(Array(50).fill(0))).toMatch(/idle/);
    expect(step(Array(50).fill(8))).toMatch(/8\.0 dB/);
  });
});
