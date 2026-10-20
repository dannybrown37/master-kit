import { describe, expect, it } from "vitest";
import { Oversampler } from "./oversample.ts";
import { sine } from "../analysis/test-signals.ts";

const SR = 44100;

function roundTrip(x: Float32Array, block = 128): Float32Array {
  const os = new Oversampler();
  const out = new Float32Array(x.length);
  const up = new Float32Array(block * 2);
  for (let i = 0; i < x.length; i += block) {
    const n = Math.min(block, x.length - i);
    os.up(x.subarray(i, i + n), up);
    os.down(up.subarray(0, 2 * n), out.subarray(i, i + n));
  }
  return out;
}

describe("Oversampler (2x)", () => {
  it("has a whole-sample latency", () => {
    expect(Number.isInteger(new Oversampler().latency)).toBe(true);
  });

  it.each([100, 1000, 10000, 15000])("up then down returns a %d Hz sine, delayed by its latency", (hz) => {
    const x = sine(hz, 0.2, -1, SR);
    const y = roundTrip(x);
    const lat = new Oversampler().latency;
    let err = 0;
    for (let i = 1000; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i - lat]));
    expect(err).toBeLessThan(1e-3);
  });

  it("keeps 20 kHz within 1 dB", () => {
    const x = sine(20000, 0.2, -1, SR);
    const y = roundTrip(x);
    let peak = 0;
    for (let i = 1000; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(20 * Math.log10(peak) + 1).toBeGreaterThan(-1);
  });

  it("block size doesn't change the result", () => {
    const x = sine(3000, 0.05, -3, SR);
    expect(roundTrip(x, 128)).toEqual(roundTrip(x, 37));
  });
});
