import { describe, expect, it } from "vitest";
import { matchLoudness } from "./autogain.ts";

describe("matchLoudness", () => {
  it.each([
    ["already on target: one render", (d: number) => -14 + d, 0, 1],
    ["linear: one correction", (d: number) => -20 + d, 0, 2],
    ["a limiter gives less than it's asked for: converges in a few steps", (d: number) => -20 + 0.6 * d, 0, 4],
  ])("%s", async (_name, lufsAt, start, maxRenders) => {
    let renders = 0;
    const r = await matchLoudness(
      (drive) => {
        renders++;
        return Promise.resolve(lufsAt(drive));
      },
      start,
      -14,
    );
    expect(Math.abs(r.lufs + 14)).toBeLessThanOrEqual(0.3);
    expect(renders).toBeLessThanOrEqual(maxRenders);
    expect(r.lufs).toBeCloseTo(lufsAt(r.drive), 9);
  });

  it("stops at the end of the Drive range and keeps the closest result", async () => {
    const r = await matchLoudness((d) => Promise.resolve(-30 + 0.1 * d), 0, -14);
    expect(r.drive).toBe(12);
    expect(r.reached).toBe(false);
  });

  it("turns a too-loud song down", async () => {
    const r = await matchLoudness((d) => Promise.resolve(-9 + d), 0, -14);
    expect(r.drive).toBeCloseTo(-5, 6);
    expect(r.reached).toBe(true);
  });

  it("gives up after maxSteps, keeping the closest", async () => {
    let n = 0;
    const r = await matchLoudness(() => Promise.resolve([-20, -16, -15, -14.6][n++] ?? -14.6), 0, -14, { maxSteps: 4 });
    expect(r.lufs).toBe(-14.6);
    expect(r.reached).toBe(false);
  });

  it("stops if a render is cancelled (NaN)", async () => {
    const r = await matchLoudness(() => Promise.resolve(NaN), 0, -14);
    expect(r.reached).toBe(false);
    expect(r.steps).toHaveLength(1);
  });
});
