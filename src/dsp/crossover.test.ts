import { describe, expect, it } from "vitest";
import { Crossover } from "./crossover.ts";
import { SR, sine } from "../analysis/test-signals.ts";

function rmsDb(x: Float32Array, skip: number): number {
  let sum = 0;
  for (let i = skip; i < x.length; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / (x.length - skip));
}

/** Splits a 0.5 s sine and returns each band's level and the summed bands' level, relative to the input (dB). */
function split(hz: number): { bands: number[]; sum: number } {
  const x = sine(hz, 0.5, -6);
  const bands = [0, 1, 2].map(() => [new Float32Array(x.length)]);
  new Crossover(SR, 200, 4000).process([x], bands);
  const sum = new Float32Array(x.length);
  for (const [b] of bands) for (let i = 0; i < x.length; i++) sum[i] += b[i];
  const skip = SR / 10;
  const ref = rmsDb(x, skip);
  return { bands: bands.map(([b]) => rmsDb(b, skip) - ref), sum: rmsDb(sum, skip) - ref };
}

describe("Crossover", () => {
  it.each([30, 100, 200, 300, 1000, 4000, 6000, 15000])("bands sum flat at %d Hz", (hz) => {
    expect(split(hz).sum).toBeCloseTo(0, 2);
  });

  it.each([
    [50, 0],
    [1000, 1],
    [12000, 2],
  ])("%d Hz lands in band %d", (hz, band) => {
    const { bands } = split(hz);
    expect(bands[band]).toBeGreaterThan(-0.5);
    for (const [i, db] of bands.entries()) if (i !== band) expect(db).toBeLessThan(-20);
  });

  it.each([200, 4000])("each side of the %d Hz split is -6 dB at the split (Linkwitz-Riley)", (hz) => {
    const { bands } = split(hz);
    const [a, b] = hz === 200 ? [bands[0], bands[1]] : [bands[1], bands[2]];
    expect(a).toBeCloseTo(-6.02, 0);
    expect(b).toBeCloseTo(-6.02, 0);
  });

  it("keeps state per channel", () => {
    const l = sine(100, 0.2, -6);
    const r = new Float32Array(l.length);
    const bands = [0, 1, 2].map(() => [new Float32Array(l.length), new Float32Array(l.length)]);
    new Crossover(SR, 200, 4000).process([l, r], bands);
    expect(Math.max(...bands.flatMap((b) => [...b[1]].map(Math.abs)))).toBe(0);
  });
});
