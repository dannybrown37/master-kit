import { describe, expect, it } from "vitest";
import { LoudnessMatch, meterPair, monitorGains, referenceMatchDb } from "./monitor.ts";

describe("meterPair", () => {
  const r = { master: "M", original: "O", reference: "R", snapshot: "S" };
  const both = { reference: true, snapshot: true };
  it.each([
    ["master", both, { main: "M", ghost: "O", labels: ["master", "orig"] }],
    ["original", both, { main: "M", ghost: "O", labels: ["master", "orig"] }],
    ["reference", both, { main: "R", ghost: "M", labels: ["ref", "master"] }],
    ["reference", { reference: false, snapshot: true }, { main: "M", ghost: "O", labels: ["master", "orig"] }],
    ["snapshot", both, { main: "S", ghost: "M", labels: ["snap", "master"] }],
    ["snapshot", { reference: true, snapshot: false }, { main: "M", ghost: "O", labels: ["master", "orig"] }],
  ] as const)("listening to %s (loaded: %o)", (listen, has, want) => {
    expect(meterPair(listen, has, r)).toEqual(want);
  });
});

describe("monitorGains", () => {
  it.each([
    ["master", 6, { wet: 1, dry: 0, ref: 0, snap: 0 }],
    ["original", 6, { wet: 0, dry: 10 ** (6 / 20), ref: 0, snap: 0 }],
    ["original", -3, { wet: 0, dry: 10 ** (-3 / 20), ref: 0, snap: 0 }],
    ["reference", 6, { wet: 0, dry: 0, ref: 10 ** (-4 / 20), snap: 0 }],
    ["snapshot", 6, { wet: 0, dry: 0, ref: 0, snap: 10 ** (2 / 20) }],
  ] as const)("%s with a %d dB match", (listen, matchDb, want) => {
    const g = monitorGains(listen, { original: matchDb, reference: -4, snapshot: 2 });
    expect(g.wet).toBeCloseTo(want.wet, 9);
    expect(g.dry).toBeCloseTo(want.dry, 9);
    expect(g.ref).toBeCloseTo(want.ref, 9);
    expect(g.snap).toBeCloseTo(want.snap, 9);
  });

  it.each([
    ["master", { wet: 10 ** (-5 / 20), dry: 0, ref: 0, snap: 0 }],
    ["original", { wet: 0, dry: 10 ** (-2 / 20), ref: 0, snap: 0 }],
    ["reference", { wet: 0, dry: 0, ref: 10 ** (-8 / 20), snap: 0 }],
    // The snapshot has no full-song loudness of its own: it stays matched to the master, then gets the master's gain.
    ["snapshot", { wet: 0, dry: 0, ref: 0, snap: 10 ** ((2 - 5) / 20) }],
  ] as const)("streaming preview, %s: each plays at the platform's gain for it, not matched", (listen, want) => {
    const g = monitorGains(listen, { original: 6, reference: -4, snapshot: 2 }, { master: -5, original: -2, reference: -8 });
    expect(g.wet).toBeCloseTo(want.wet, 9);
    expect(g.dry).toBeCloseTo(want.dry, 9);
    expect(g.ref).toBeCloseTo(want.ref, 9);
    expect(g.snap).toBeCloseTo(want.snap, 9);
  });

  it.each([
    ["louder reference turned down", -14, -8, -6],
    ["quieter reference turned up", -14, -20, 6],
    ["clamped", -14, -60, 24],
    ["unknown master loudness: no change", -Infinity, -8, 0],
  ])("referenceMatchDb: %s", (_name, masterLufs, refLufs, want) => {
    expect(referenceMatchDb(masterLufs, refLufs)).toBeCloseTo(want, 9);
  });
});

describe("LoudnessMatch", () => {
  it("jumps to the first valid difference", () => {
    const m = new LoudnessMatch();
    expect(m.update(-14, -9, 0.1)).toBeCloseTo(5, 9);
  });

  it("smooths later differences with its time constant", () => {
    const m = new LoudnessMatch(3);
    m.update(-14, -9, 0.1);
    expect(m.update(-14, -11, 3)).toBeCloseTo(3 + 2 * Math.exp(-1), 6);
  });

  it.each([
    ["silent original", -Infinity, -9],
    ["silent master", -14, -Infinity],
    ["quiet intro", -55, -50],
    ["NaN", Number.NaN, -9],
  ])("ignores %s", (_name, original, master) => {
    const m = new LoudnessMatch();
    m.update(-14, -10, 0.1);
    expect(m.update(original, master, 1)).toBeCloseTo(4, 9);
  });

  it("starts at 0 dB and clamps extreme differences", () => {
    const m = new LoudnessMatch();
    expect(m.db).toBe(0);
    expect(m.update(-48, -2, 0.1)).toBe(24);
  });

  it("swapping the two sides negates the match and keeps smoothing from there", () => {
    const m = new LoudnessMatch(3);
    m.update(-14, -9, 0.1);
    m.swap();
    expect(m.db).toBeCloseTo(-5, 9);
    expect(m.update(-9, -14, 3)).toBeCloseTo(-5, 9);
  });

  it("reset returns to 0 dB and re-arms the first jump", () => {
    const m = new LoudnessMatch();
    m.update(-14, -9, 0.1);
    m.reset();
    expect(m.db).toBe(0);
    expect(m.update(-14, -12, 0.1)).toBeCloseTo(2, 9);
  });
});
