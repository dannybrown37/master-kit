import { describe, expect, it } from "vitest";
import { Limiter } from "./limiter.ts";
import type { LimiterParams } from "./limiter.ts";
import { samplePeak, truePeak } from "../analysis/peak.ts";
import { SR, concat, faded, lowpassed, noise, sine, stereo } from "../analysis/test-signals.ts";

const BASE: LimiterParams = { driveDb: 0, ceilingDb: -1, releaseMs: 50 };

function run(limiter: Limiter, channels: Float32Array[], block = 128): Float32Array[] {
  const out = channels.map((c) => new Float32Array(c.length));
  for (let s = 0; s < channels[0].length; s += block) {
    const e = Math.min(s + block, channels[0].length);
    limiter.process(
      channels.map((c) => c.subarray(s, e)),
      out.map((c) => c.subarray(s, e)),
    );
  }
  return out;
}

function kick(): Float32Array {
  return Float32Array.from({ length: Math.round(0.3 * SR) }, (_, i) => Math.sin(2 * Math.PI * 55 * (i / SR)) * Math.exp(-i / (0.08 * SR)));
}

describe("Limiter", () => {
  it.each([
    ["mp3-bandwidth noise", stereo(lowpassed(noise(2, 0), 18000)), 9, SR],
    ["mp3-bandwidth noise at 44.1 kHz", stereo(lowpassed(noise(2, 0, 9, 44100), 18000, 44100)), 9, 44100],
    ["inter-sample peaks (fs/4 at 45°)", stereo(faded(sine(SR / 4, 1, 0, SR, 45))), 6, SR],
    ["a kick after silence", stereo(concat(new Float32Array(SR / 2), kick(), new Float32Array(SR / 2))), 12, SR],
    ["a 1 kHz sine pushed hard", stereo(faded(sine(1000, 1, -3))), 18, SR],
  ])("keeps %s under the ceiling, even measured at 16x", (_name, channels, driveDb, sr) => {
    const out = run(new Limiter(sr, { ...BASE, driveDb }), channels);
    expect(truePeak(out, sr, 16)).toBeLessThanOrEqual(BASE.ceilingDb);
    expect(truePeak(out, sr)).toBeLessThanOrEqual(BASE.ceilingDb);
    expect(samplePeak(out)).toBeLessThanOrEqual(BASE.ceilingDb);
  });

  it("keeps full-band white noise under the ceiling on the BS.1770 meter, within 0.1 dB at 16x", () => {
    const out = run(new Limiter(SR, { ...BASE, driveDb: 9 }), stereo(noise(2, 0)));
    expect(truePeak(out, SR)).toBeLessThanOrEqual(BASE.ceilingDb);
    expect(truePeak(out, SR, 16)).toBeLessThanOrEqual(BASE.ceilingDb + 0.1);
  });

  it("passes quiet material untouched, delayed by its reported latency", () => {
    const limiter = new Limiter(SR, BASE);
    const x = faded(sine(440, 0.5, -12));
    const [out] = run(limiter, [x]);
    const d = limiter.latency;
    expect(d).toBeGreaterThan(0);
    for (let i = 0; i < x.length - d; i++) expect(out[i + d]).toBeCloseTo(x[i], 6);
    expect(limiter.reductionDb).toBe(0);
  });

  it("drive raises level until the ceiling", () => {
    const [out] = run(new Limiter(SR, { ...BASE, driveDb: 6 }), [faded(sine(440, 0.5, -20))]);
    expect(samplePeak([out])).toBeCloseTo(-14, 1);
  });

  it("reports gain reduction while limiting", () => {
    const limiter = new Limiter(SR, { ...BASE, driveDb: 6 });
    run(limiter, stereo(faded(sine(1000, 0.5, -3))));
    expect(limiter.reductionDb).toBeCloseTo(3 - (BASE.ceilingDb - 0.1), 1);
  });

  it("recovers with the release time constant once the hold has passed", () => {
    const limiter = new Limiter(SR, BASE);
    run(limiter, [sine(1000, 0.3, 5)]);
    run(limiter, [new Float32Array(3 * limiter.latency)], 1);
    const before = limiter.reductionDb;
    run(limiter, [new Float32Array(Math.round((BASE.releaseMs / 1000) * SR))], 1);
    expect(before).toBeGreaterThan(1);
    expect(limiter.reductionDb / before).toBeCloseTo(Math.exp(-1), 2);
  });

  it("gives the same output for any block size", () => {
    const input = stereo(noise(0.5, 3));
    expect(run(new Limiter(SR, BASE), input, 1000)).toEqual(run(new Limiter(SR, BASE), input, 128));
  });
});
