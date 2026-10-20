import { describe, expect, it } from "vitest";
import { ANALYSER_TILT_DB_PER_OCT, tiltedShares } from "../analysis/spectrum.ts";
import { rng } from "../analysis/test-signals.ts";
import { planMaster } from "./automaster.ts";
import { GENRES } from "./genres.ts";
import { hints } from "./hints.ts";
import { defaultSettings, noBypass, parseSettings } from "./settings.ts";
import { STYLES, applyTaste, blendSettings, blindOrder, parseTaste, recordPick, styleVariant, tasteLean } from "./shootout.ts";
import type { Style } from "./shootout.ts";
import { report } from "./test-report.ts";

const song = report({ resonances: [{ hz: 5000, prominenceDb: 6 }] }, tiltedShares(ANALYSER_TILT_DB_PER_OCT).map((db, i) => db + (i === 0 ? 5 : 0)));

describe("styleVariant", () => {
  const plan = planMaster({ original: song, genre: "edm" }).settings;

  it("balanced is the plan itself", () => {
    expect(styleVariant(plan, "balanced")).toEqual(plan);
  });

  it("gentle: half the EQ, softer glue, less warmth, no clipping", () => {
    const generic = planMaster({ original: song }).settings;
    const g = styleVariant(generic, "gentle");
    expect(generic.eqLowGain).toBeLessThan(0);
    expect(Math.abs(g.eqLowGain)).toBeLessThan(Math.abs(generic.eqLowGain));
    expect(g.compRatio).toBeLessThanOrEqual(1.5);
    expect(g.compThreshold).toBeGreaterThan(generic.compThreshold);
    const edm = styleVariant(plan, "gentle");
    expect(edm.colorClipDb).toBe(6);
    expect(edm.colorWarmth).toBeLessThan(plan.colorWarmth);
  });

  it("punchy: clips more and adds warmth", () => {
    const p = styleVariant(plan, "punchy");
    expect(p.colorClipDb).toBeLessThan(plan.colorClipDb);
    expect(p.colorWarmth).toBeGreaterThan(plan.colorWarmth);
  });

  it.each(GENRES.flatMap((g) => STYLES.map((s) => [g.key, s] as const)))("%s, %s: legal knobs and no hint warnings", (genre, style) => {
    const v = styleVariant(planMaster({ original: song, genre }).settings, style);
    expect(parseSettings(v)).toEqual(v);
    const warnings = hints({ original: song, master: null, settings: v, bypass: noBypass() }).filter((h) => h.level === "warn" || h.level === "bad");
    expect(warnings).toEqual([]);
  });
});

describe("taste", () => {
  it("no picks: no lean", () => {
    expect(tasteLean(parseTaste(null))).toBe(0);
  });

  it.each([
    ["three punchy picks lean punchy", ["punchy", "punchy", "punchy"], 0.6],
    ["three gentle picks lean gentle", ["gentle", "gentle", "gentle"], -0.6],
    ["mixed picks cancel out", ["gentle", "punchy", "balanced"], 0],
    ["balanced picks pull toward the middle", ["punchy", "balanced", "balanced", "balanced"], 1 / 6],
  ] as const)("%s", (_name, picks, want) => {
    let t = parseTaste(null);
    for (const p of picks) t = recordPick(t, p as Style);
    expect(tasteLean(t)).toBeCloseTo(want, 9);
  });

  it("parseTaste keeps only non-negative whole counts", () => {
    expect(parseTaste({ gentle: 2, balanced: -1, punchy: "x", extra: 9 })).toEqual({ gentle: 2, balanced: 0, punchy: 0 });
  });

  it("applyTaste moves the plan part way toward the leaned style", () => {
    const plan = planMaster({ original: song, genre: "edm" }).settings;
    expect(applyTaste(plan, 0)).toEqual(plan);
    expect(applyTaste(plan, 1)).toEqual(styleVariant(plan, "punchy"));
    expect(applyTaste(plan, -1)).toEqual(styleVariant(plan, "gentle"));
    const half = applyTaste(plan, 0.5);
    expect(half.colorWarmth).toBeGreaterThan(plan.colorWarmth);
    expect(half.colorWarmth).toBeLessThan(styleVariant(plan, "punchy").colorWarmth);
  });
});

describe("blendSettings", () => {
  it("interpolates and snaps to each knob's step", () => {
    const a = { ...defaultSettings(), compRatio: 2, eqLowFreq: 50 };
    const b = { ...defaultSettings(), compRatio: 3, eqLowFreq: 200 };
    const m = blendSettings(a, b, 0.5);
    expect(m.compRatio).toBe(2.5);
    expect(m.eqLowFreq).toBeCloseTo(100, 6);
  });
});

describe("blindOrder", () => {
  it("is a shuffle of the three styles", () => {
    const seen = new Set<string>();
    const r = rng(7);
    for (let i = 0; i < 50; i++) {
      const order = blindOrder(r);
      expect([...order].sort()).toEqual([...STYLES].sort());
      seen.add(order.join());
    }
    expect(seen.size).toBe(6);
  });
});
