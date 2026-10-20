import { describe, expect, it } from "vitest";
import { score } from "./score.ts";

const ORIGINAL = { plr: 13.7 };
const GOOD = { integrated: -14, truePeak: -1.2, plr: 12.8 };

function part(name: string, master: typeof GOOD, original = ORIGINAL): number {
  return score(original, master).parts.find((p) => p.name === name)?.points ?? NaN;
}

describe("score", () => {
  it("gives 100 for a master on target with its dynamics intact", () => {
    const s = score(ORIGINAL, GOOD);
    expect(s.total).toBe(100);
    expect(s.parts.every((p) => p.ok)).toBe(true);
  });

  it.each([
    ["inside the ±1 LU window", -13.1, 40],
    ["2.5 LU too loud", -11.5, 20],
    ["2.5 LU too quiet", -16.5, 20],
    ["4 LU off", -10, 0],
    ["way off", -3, 0],
  ])("loudness: %s", (_name, integrated, want) => {
    expect(part("loudness", { ...GOOD, integrated })).toBeCloseTo(want, 6);
  });

  it.each([
    ["under -1 dBTP", -1.5, 30],
    ["at -1 dBTP", -1, 30],
    ["half way to 0", -0.5, 15],
    ["over full scale", 0.4, 0],
  ])("true peak: %s", (_name, truePeak, want) => {
    expect(part("peaks", { ...GOOD, truePeak })).toBeCloseTo(want, 6);
  });

  it.each([
    ["PLR at the needed 9 dB (original 13.7 capped at 11, minus 2)", ORIGINAL, 9, 30],
    ["3 dB squashed past it", ORIGINAL, 6, 15],
    ["6 dB squashed past it", ORIGINAL, 3, 0],
    ["an already squashed original only needs to keep its own PLR − 2", { plr: 7 }, 5, 30],
  ])("dynamics: %s", (_name, original, plr, want) => {
    expect(part("dynamics", { ...GOOD, plr }, original)).toBeCloseTo(want, 6);
  });

  it("scores silence as zero rather than NaN", () => {
    const s = score(ORIGINAL, { integrated: -Infinity, truePeak: -Infinity, plr: NaN });
    expect(s.total).toBe(0);
    expect(s.parts.every((p) => !p.ok)).toBe(true);
  });

  it("rounds the total", () => {
    expect(Number.isInteger(score(ORIGINAL, { ...GOOD, integrated: -11.77 }).total)).toBe(true);
  });
});
