import { describe, expect, it } from "vitest";
import { logFrequencies, smoothColumns, spectrumColumns } from "./freq.ts";

const SR = 48000;
const BINS = 4096;

describe("logFrequencies", () => {
  it("spaces column centres evenly in octaves between the edges", () => {
    const f = logFrequencies(10, 20, 20480);
    expect(f[0]).toBeCloseTo(20 * 2 ** 0.5, 6);
    expect(f[9]).toBeCloseTo(20480 / 2 ** 0.5, 6);
    expect(f[5] / f[4]).toBeCloseTo(2, 9);
  });
});

describe("smoothColumns", () => {
  it.each([
    ["flat stays flat", [-20, -20, -20, -20, -20], 1, [-20, -20, -20, -20, -20]],
    ["a spike spreads over its neighbours (power average)", [-200, -200, 0, -200, -200], 1, [-200, -4.77, -4.77, -4.77, -200]],
    ["edges average only what exists", [0, -200, -200], 1, [-3.01, -4.77, -200]],
    ["width 0 changes nothing", [1, 2, 3], 0, [1, 2, 3]],
  ] as const)("%s", (_name, input, halfWidth, want) => {
    smoothColumns([...input], halfWidth).forEach((v, i) => expect(v).toBeCloseTo(want[i], 1));
  });

  it("silence stays -Infinity", () => {
    expect(smoothColumns([-Infinity, -Infinity], 1)).toEqual([-Infinity, -Infinity]);
  });
});

describe("spectrumColumns", () => {
  const flat = new Float32Array(BINS).fill(-60);

  it("a flat spectrum stays flat without tilt", () => {
    for (const v of spectrumColumns(flat, SR, 40, 20, 20000, 0)) expect(v).toBeCloseTo(-60, 6);
  });

  it("tilt adds dB per octave around 1 kHz", () => {
    const freqs = logFrequencies(40, 20, 20000);
    const cols = spectrumColumns(flat, SR, 40, 20, 20000, 3);
    cols.forEach((v, i) => expect(v).toBeCloseTo(-60 + 3 * Math.log2(freqs[i] / 1000), 6));
  });

  it("averages power, not dB, inside a column", () => {
    const x = new Float32Array(BINS).fill(-200);
    const bin = Math.round(5000 / (SR / (2 * BINS)));
    x[bin] = -10;
    x[bin + 1] = -10;
    const cols = spectrumColumns(x, SR, 10, 20, 20000, 0);
    const freqs = logFrequencies(10, 20, 20000);
    const loud = cols.indexOf(Math.max(...cols));
    expect(freqs[loud]).toBeGreaterThan(3000);
    expect(freqs[loud]).toBeLessThan(8000);
    expect(cols[loud]).toBeLessThan(-10);
    expect(cols[loud]).toBeGreaterThan(-40);
  });

  it("columns narrower than a bin read the nearest bin", () => {
    const x = Float32Array.from({ length: BINS }, (_, k) => -k / 100);
    const cols = spectrumColumns(x, SR, 200, 20, 20000, 0);
    expect(cols.every(Number.isFinite)).toBe(true);
    for (let i = 1; i < cols.length; i++) expect(cols[i]).toBeLessThanOrEqual(cols[i - 1] + 1e-9);
    // First column centre ~20.3 Hz; bins are 48000 / 8192 = 5.86 Hz apart, so bin 3.
    expect(cols[0]).toBeCloseTo(-0.03, 6);
  });

  it("-Infinity bins (silence) give -Infinity", () => {
    const silent = new Float32Array(BINS).fill(-Infinity);
    expect(spectrumColumns(silent, SR, 5, 20, 20000, 3).every((v) => v === -Infinity)).toBe(true);
  });
});
