import { describe, expect, it } from "vitest";
import { ANALYSER_TILT_DB_PER_OCT, tiltedShares } from "../analysis/spectrum.ts";
import type { Report } from "../analysis/report.ts";
import { easeDynamics, planMaster } from "./automaster.ts";
import { GENRES } from "./genres.ts";
import { applyTaste } from "./shootout.ts";
import type { GenreKey } from "./genres.ts";
import { hints } from "./hints.ts";
import { defaultSettings, noBypass, parseSettings } from "./settings.ts";
import { report } from "./test-report.ts";

const BALANCED = tiltedShares(ANALYSER_TILT_DB_PER_OCT);
/** Balanced, plus `extra` dB on some bands (sub, low, mud, mid, presence, air). */
const tilted = (extra: Partial<Record<number, number>> = {}): number[] => BALANCED.map((db, i) => db + (extra[i] ?? 0));

const CASES: [string, Report, Report | null][] = [
  ["balanced, no reference", report({}, tilted()), null],
  ["sub-heavy", report({}, tilted({ 0: 7, 1: 2 })), null],
  ["harsh top", report({}, tilted({ 4: 5, 5: 5 })), null],
  ["no sub (ambient)", report({}, tilted({ 0: -23, 1: 1, 2: 6, 5: -6 })), null],
  ["already dense", report({ plr: 7.5 }, tilted()), null],
  ["out of phase", report({ stereo: { correlation: -0.2, sideDb: -2 } }, tilted()), null],
  ["reference identical to the song", report({}, tilted({ 0: 7 })), report({}, tilted({ 0: 7 }))],
  ["reference much wider", report({}, tilted()), report({ stereo: { correlation: 0.5, sideDb: -4 } }, tilted())],
  ["full level from the first sample to the last", report({ edges: { leadSeconds: 0, tailSeconds: 0, startDb: -1, endDb: -2 } }, tilted()), null],
];

describe("planMaster", () => {
  it("a balanced song gets no EQ, no multiband, gentle glue and mono bass", () => {
    const { settings: s, steps } = planMaster({ original: report({ integrated: -12 }, tilted()) });
    expect([s.eqLowGain, s.eqMudGain, s.eqPresGain, s.eqAirGain]).toEqual([0, 0, 0, 0]);
    expect([s.mbLowThreshold, s.mbHighThreshold, s.mbLowGain]).toEqual([0, 0, 0]);
    expect(s.compThreshold).toBe(-15);
    expect(s.compRatio).toBe(2);
    expect(s.eqMonoBassHz).toBe(100);
    expect(s.limCeiling).toBe(-1);
    expect(steps.length).toBeGreaterThan(3);
  });

  it("a sub-heavy song: a gentle low shelf cut at 60 Hz plus low-band compression", () => {
    const { settings: s } = planMaster({ original: report({}, tilted({ 0: 7, 1: 2 })) });
    expect(s.eqLowGain).toBeLessThan(0);
    expect(s.eqLowGain).toBeGreaterThanOrEqual(-2);
    expect(s.eqLowFreq).toBe(60);
    expect(s.mbLowThreshold).toBeLessThan(0);
    expect(s.mbHighThreshold).toBe(0);
  });

  it("a harsh top: high-band compression, the air shelf cut less than half the gap", () => {
    const { settings: s } = planMaster({ original: report({}, tilted({ 4: 5, 5: 5 })) });
    expect(s.mbHighThreshold).toBeLessThan(0);
    expect(s.eqAirGain).toBeLessThan(0);
    expect(s.eqAirGain).toBeGreaterThan(-2.5);
  });

  it("a song with (almost) no sub gets no bass boost: EQ can't add what isn't there", () => {
    const { settings: s, steps } = planMaster({ original: report({}, tilted({ 0: -23, 1: 1 })) });
    expect(s.eqLowGain).toBe(0);
    expect(steps.join(" ")).toMatch(/Sub.*almost nothing/);
  });

  it("an already dense song keeps the compressor idle", () => {
    expect(planMaster({ original: report({ plr: 7.5 }, tilted()) }).settings.compThreshold).toBe(defaultSettings().compThreshold);
  });

  it("an out-of-phase song is narrowed", () => {
    expect(planMaster({ original: report({ stereo: { correlation: -0.2, sideDb: -2 } }, tilted()) }).settings.eqWidth).toBeLessThan(100);
  });

  it("a reference that matches the song asks for no tonal moves, even where a generic target would", () => {
    const song = report({}, tilted({ 0: 7 }));
    const { settings: s } = planMaster({ original: song, reference: song });
    expect([s.eqLowGain, s.mbLowThreshold, s.eqWidth]).toEqual([0, 0, 100]);
  });

  it("a much wider reference widens, but stays in the safe zone", () => {
    const { settings: s } = planMaster({ original: report({}, tilted()), reference: report({ stereo: { correlation: 0.5, sideDb: -4 } }, tilted()) });
    expect(s.eqWidth).toBeGreaterThan(100);
    expect(s.eqWidth).toBeLessThanOrEqual(130);
  });

  it.each([
    ["clean edges: left alone", { leadSeconds: 0.3, tailSeconds: 1.5, startDb: -45, endDb: -60 }, [0, 0, 0, 0]],
    ["hard start and hard cut: lead-in, declick fades, tail", { leadSeconds: 0, tailSeconds: 0, startDb: -1, endDb: -2 }, [200, 5, 100, 1000]],
    ["quiet start, natural decay, no silence after: only a tail", { leadSeconds: 0, tailSeconds: 0.01, startDb: -45, endDb: -58 }, [0, 0, 0, 1000]],
  ])("edges: %s", (_name, edges, want) => {
    const { settings: s, steps } = planMaster({ original: report({ edges }, tilted()) });
    expect([s.edgeLeadMs, s.edgeFadeInMs, s.edgeFadeOutMs, s.edgeTailMs]).toEqual(want);
    expect(steps.some((x) => x.startsWith("Edges:"))).toBe(want.some((v) => v > 0));
  });

  it("video: declick fades only, never a lead-in or tail (they would shift the audio off the picture)", () => {
    const original = report({ edges: { leadSeconds: 0, tailSeconds: 0, startDb: -1, endDb: -2 } }, tilted());
    const { settings: s, steps } = planMaster({ original, video: true });
    expect([s.edgeLeadMs, s.edgeFadeInMs, s.edgeFadeOutMs, s.edgeTailMs]).toEqual([0, 5, 100, 0]);
    expect(steps.join("\n")).not.toMatch(/silence first|silence after/);
    expect(hints({ original, master: null, settings: s, bypass: noBypass(), video: true }).filter((h) => h.level !== "good" && h.knob?.startsWith("edge"))).toEqual([]);
  });

  const EVERY: [string, Report, Report | null, GenreKey][] = CASES.flatMap(([name, o, ref]) => GENRES.map((g): [string, Report, Report | null, GenreKey] => [`${name} as ${g.key}`, o, ref, g.key]));

  it.each(EVERY)("%s: every value is a legal knob setting", (_name, original, reference, genre) => {
    const { settings } = planMaster({ original, reference, genre });
    expect(parseSettings(settings)).toEqual(settings);
  });

  it.each(EVERY)("%s: the hints have nothing to warn about in the plan's settings", (_name, original, reference, genre) => {
    const { settings, bypass } = planMaster({ original, reference, genre });
    const warnings = hints({ original, master: null, settings, bypass }).filter((h) => h.level === "warn" || h.level === "bad");
    expect(warnings).toEqual([]);
  });

  describe("genres", () => {
    it("EDM: the sub may stay big, kick peaks go to the clipper, bass mono from 120 Hz", () => {
      const song = report({}, tilted({ 0: 5 }));
      expect(planMaster({ original: song }).settings.eqLowGain).toBeLessThan(0);
      const { settings: s, steps } = planMaster({ original: song, genre: "edm" });
      expect(s.eqLowGain).toBe(0);
      expect([s.colorClipDb, s.colorWarmth, s.eqMonoBassHz]).toEqual([2.5, 15, 120]);
      expect(steps[0]).toMatch(/^Genre: EDM/);
    });

    it("lo-fi: a dark top is the style, so a balanced song's air gets trimmed, and warmth goes on", () => {
      const { settings: s } = planMaster({ original: report({}, tilted()), genre: "lofi" });
      expect(s.eqAirGain).toBeLessThan(0);
      expect(s.colorWarmth).toBe(35);
      expect(s.colorClipDb).toBe(6);
    });

    it.each(["cinematic", "ambient", "acoustic"] as const)("%s: no glue compression even with lots of dynamics", (genre) => {
      const { settings: s, steps } = planMaster({ original: report({ plr: 15 }, tilted()), genre });
      expect(s.compThreshold).toBe(defaultSettings().compThreshold);
      expect(steps.join(" ")).toMatch(/Compressor: off/);
    });

    it("a reference beats the genre's tonal target", () => {
      const song = report({}, tilted({ 0: 3 }));
      expect(planMaster({ original: song, reference: song, genre: "lofi" }).settings.eqAirGain).toBe(0);
    });
  });

  it.each([
    [0.6, "punchy"],
    [-0.6, "gentle"],
  ] as const)("taste %d leans the plan toward %s and says so", (taste, style) => {
    const plain = planMaster({ original: report({}, tilted()), genre: "edm" });
    const leaned = planMaster({ original: report({}, tilted()), genre: "edm", taste });
    expect(leaned.settings).toEqual(applyTaste(plain.settings, taste));
    expect(leaned.steps.join(" ")).toMatch(new RegExp(`Taste: .*${style}`));
  });

  describe("tamer", () => {
    it("aims band 1 and 2 at the two harshest resonances", () => {
      const original = report({ resonances: [{ hz: 6700, prominenceDb: 7.7 }, { hz: 2800, prominenceDb: 6 }, { hz: 4000, prominenceDb: 5.5 }] });
      const { settings: s, steps } = planMaster({ original });
      expect([s.tameFreq1, s.tameDepth1, s.tameFreq2, s.tameDepth2]).toEqual([6700, 4, 2800, 4]);
      expect(steps.join(" ")).toMatch(/Tamer: .*6\.7 kHz/);
    });

    it("names low peaks as probable notes and leaves them alone", () => {
      const { settings: s, steps } = planMaster({ original: report({ resonances: [{ hz: 392, prominenceDb: 9 }] }) });
      expect(s.tameDepth1).toBe(0);
      expect(steps.join(" ")).toMatch(/392 Hz \(G4\)/);
    });
  });
});

describe("easeDynamics", () => {
  it("first eases the glue compressor", () => {
    const s = { ...defaultSettings(), compThreshold: -18, compRatio: 2, mbLowThreshold: -20 };
    expect(easeDynamics(s)).toMatchObject({ compThreshold: -15, compRatio: 1.5, mbLowThreshold: -20 });
  });

  it("then the multiband", () => {
    const s = { ...defaultSettings(), mbLowThreshold: -20, mbHighThreshold: -30 };
    expect(easeDynamics(s)).toMatchObject({ mbLowThreshold: -17, mbHighThreshold: -27 });
  });

  it("returns null when nothing compresses", () => {
    expect(easeDynamics(defaultSettings())).toBeNull();
  });
});
