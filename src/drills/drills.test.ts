import { describe, expect, it } from "vitest";
import { DRILL_KINDS, LEVELS, STREAK_TO_LEVEL_UP, answer, initialProgress, makeQuestion, matchGains, nextKind, parseProgress } from "./drills.ts";
import type { DrillKind } from "./drills.ts";
import { rng } from "../analysis/test-signals.ts";

const KINDS = DRILL_KINDS;

describe("drill levels", () => {
  it("has EQ, compression, limiting and stereo width drills; t cycles through them all", () => {
    expect([...KINDS]).toEqual(["eq", "comp", "limit", "width"]);
    let k: DrillKind = KINDS[0];
    const seen: DrillKind[] = [k];
    for (let i = 1; i < KINDS.length; i++) seen.push((k = nextKind(k)));
    expect(seen).toEqual([...KINDS]);
    expect(nextKind(k)).toBe(KINDS[0]);
  });

  it.each([
    ["limit", "limit"],
    ["width", "width"],
  ] as const)("%s drills only use none or their own process", (kind, processKind) => {
    for (const level of LEVELS[kind]) for (const c of level.choices) expect(["none", processKind]).toContain(c.process.kind);
  });

  it("limiting depths are positive and widths stay on the knob's 0–200% range", () => {
    for (const c of LEVELS.limit.flatMap((l) => l.choices)) if (c.process.kind === "limit") expect(c.process.depthDb).toBeGreaterThan(0);
    for (const c of LEVELS.width.flatMap((l) => l.choices)) {
      if (c.process.kind === "width") {
        expect(c.process.width).toBeGreaterThanOrEqual(0);
        expect(c.process.width).toBeLessThanOrEqual(200);
        expect(c.process.width).not.toBe(100);
      }
    }
  });

  it.each(KINDS)("%s: every level has 2+ choices with unique labels", (kind) => {
    expect(LEVELS[kind].length).toBeGreaterThanOrEqual(3);
    for (const level of LEVELS[kind]) {
      expect(level.choices.length).toBeGreaterThanOrEqual(2);
      expect(new Set(level.choices.map((c) => c.label)).size).toBe(level.choices.length);
    }
  });

  it("EQ levels get harder: more choices or smaller boosts", () => {
    const eq = LEVELS.eq;
    for (let i = 1; i < eq.length; i++) {
      const smallest = (l: (typeof eq)[number]): number => Math.min(...l.choices.map((c) => (c.process.kind === "eq" ? Math.abs(c.process.gainDb) : Infinity)));
      expect(eq[i].choices.length > eq[i - 1].choices.length || smallest(eq[i]) < smallest(eq[i - 1])).toBe(true);
    }
  });
});

describe("makeQuestion", () => {
  it.each(KINDS)("%s: answer is one of the choices and the clip sits inside the song", (kind) => {
    const r = rng(1);
    for (let level = 0; level < LEVELS[kind].length; level++) {
      for (let n = 0; n < 50; n++) {
        const q = makeQuestion(kind, level, 180, r);
        expect(q.answer).toBeGreaterThanOrEqual(0);
        expect(q.answer).toBeLessThan(LEVELS[kind][level].choices.length);
        expect(q.clipStart).toBeGreaterThanOrEqual(0);
        expect(q.clipStart + q.clipSeconds).toBeLessThanOrEqual(180);
      }
    }
  });

  it("uses every answer over many questions", () => {
    const r = rng(2);
    const seen = new Set(Array.from({ length: 200 }, () => makeQuestion("eq", 0, 180, r).answer));
    expect(seen.size).toBe(LEVELS.eq[0].choices.length);
  });

  it("is deterministic for a seed", () => {
    expect(makeQuestion("comp", 1, 200, rng(5))).toEqual(makeQuestion("comp", 1, 200, rng(5)));
  });

  it("plays the whole song when it is shorter than a clip", () => {
    const q = makeQuestion("eq", 0, 4, rng(1));
    expect(q.clipStart).toBe(0);
    expect(q.clipSeconds).toBe(4);
  });
});

describe("progress", () => {
  it("counts streaks and remembers the best", () => {
    let p = initialProgress();
    p = answer(p, true);
    p = answer(p, true);
    p = answer(p, false);
    p = answer(p, true);
    expect(p).toMatchObject({ streak: 1, best: 2, correct: 3, answered: 4, level: 0 });
  });

  it(`levels up after ${STREAK_TO_LEVEL_UP} right in a row, and the count starts over`, () => {
    let p = initialProgress();
    for (let i = 0; i < STREAK_TO_LEVEL_UP; i++) p = answer(p, true);
    expect(p.level).toBe(1);
    expect(p.levelStreak).toBe(0);
    p = answer(p, true);
    expect(p.level).toBe(1);
  });

  it("does not level past the last level", () => {
    let p = { ...initialProgress(), level: LEVELS.eq.length - 1 };
    for (let i = 0; i < STREAK_TO_LEVEL_UP * 2; i++) p = answer(p, true, LEVELS.eq.length);
    expect(p.level).toBe(LEVELS.eq.length - 1);
  });

  it.each([
    ["garbage", "x", initialProgress()],
    ["negative and fractional numbers", { level: -2, streak: 1.5, best: 3, correct: 3, answered: 2 }, { ...initialProgress(), best: 3, correct: 3, answered: 3 }],
    ["a level past the end", { level: 99 }, { ...initialProgress(), level: 4 }],
  ])("parseProgress cleans %s", (_name, input, want) => {
    expect(parseProgress(input, 5)).toEqual(want);
  });
});

describe("matchGains", () => {
  it.each([
    ["B louder", -14, -10, -1, 2],
    ["B quieter", -14, -20, -1, -6],
    ["equal", -14, -14, -3, -3],
  ])("%s: both play at the same loudness with peaks ≤ -1 dBFS", (_name, aLufs, bLufs, aPeak, bPeak) => {
    const { a, b } = matchGains(aLufs, bLufs, aPeak, bPeak);
    const db = (g: number): number => 20 * Math.log10(g);
    expect(aLufs + db(a)).toBeCloseTo(bLufs + db(b), 6);
    expect(aPeak + db(a)).toBeLessThanOrEqual(-1 + 1e-9);
    expect(bPeak + db(b)).toBeLessThanOrEqual(-1 + 1e-9);
    expect(a).toBeLessThanOrEqual(1);
  });

  it("only turns both down as far as the louder peak needs", () => {
    const { a, b } = matchGains(-14, -20, -1, -6);
    expect(-6 + 20 * Math.log10(b)).toBeCloseTo(-1, 6);
    expect(20 * Math.log10(a)).toBeCloseTo(-1, 6);
  });

  it("never turns a silent clip up to infinity", () => {
    const { a, b } = matchGains(-Infinity, -14, -Infinity, -1);
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
  });
});
