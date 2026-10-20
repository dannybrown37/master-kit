import { describe, expect, it } from "vitest";
import { NEUTRAL_TAMER, Tamer } from "./tamer.ts";
import type { TamerParams } from "./tamer.ts";
import { noise, sine } from "../analysis/test-signals.ts";

const SR = 44100;

function run(t: Tamer, x: Float32Array[], block = 128): { out: Float32Array[]; gr: number[] } {
  const out = x.map((c) => new Float32Array(c.length));
  const gr = [0, 0];
  for (let i = 0; i < x[0].length; i += block) {
    const n = Math.min(block, x[0].length - i);
    t.process(
      x.map((c) => c.subarray(i, i + n)),
      out.map((c) => c.subarray(i, i + n)),
    );
    t.bandReductionDb.forEach((db, b) => (gr[b] = Math.max(gr[b], db)));
  }
  return { out, gr };
}

/** Steady-state level of one frequency (dB), Goertzel with a Hann window over the second half. */
function toneDb(x: Float32Array, hz: number): number {
  const from = x.length >> 1;
  const w = (2 * Math.PI * hz) / SR;
  let re = 0;
  let im = 0;
  const n = x.length - from;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re += x[from + i] * win * Math.cos(w * i);
    im -= x[from + i] * win * Math.sin(w * i);
  }
  return 20 * Math.log10((4 * Math.hypot(re, im)) / n);
}

/** Power (dB) of x around `hz` (±1/6 octave), from the second half: one-pole-free brute DFT on a few bins. */
function bandDb(x: Float32Array, lo: number, hi: number): number {
  let sum = 0;
  for (let f = lo; f <= hi; f += (hi - lo) / 8) sum += 10 ** (toneDb(x, f) / 10);
  return 10 * Math.log10(sum);
}

const params = (bands: TamerParams["bands"], q = 4): TamerParams => ({ q, bands });
const mix = (...parts: Float32Array[]): Float32Array => parts[0].map((_, i) => parts.reduce((s, p) => s + p[i], 0));

describe("Tamer", () => {
  it("neutral: passes audio bit for bit", () => {
    const x = [noise(0.2, -6, 1, SR), noise(0.2, -6, 2, SR)];
    const { out, gr } = run(new Tamer(SR, NEUTRAL_TAMER), x);
    expect(out).toEqual(x);
    expect(gr).toEqual([0, 0]);
  });

  it("turns down a resonance that sticks out of the noise around it, and only there", () => {
    const song = mix(noise(2, -20, 3, SR), sine(3000, 2, -12, SR));
    const { out, gr } = run(new Tamer(SR, params([{ hz: 3000, depthDb: 6 }, { hz: 200, depthDb: 0 }])), [song]);
    expect(toneDb(out[0], 3000) - toneDb(song, 3000)).toBeLessThan(-3);
    expect(gr[0]).toBeGreaterThan(3);
    for (const [lo, hi] of [
      [800, 1200],
      [8000, 10000],
    ]) {
      expect(Math.abs(bandDb(out[0], lo, hi) - bandDb(song, lo, hi))).toBeLessThan(0.5);
    }
  });

  it("leaves a smooth spectrum (plain noise) nearly alone", () => {
    const song = noise(2, -6, 4, SR);
    const { gr } = run(new Tamer(SR, params([{ hz: 3000, depthDb: 6 }, { hz: 200, depthDb: 6 }])), [song]);
    expect(Math.max(...gr)).toBeLessThan(1.5);
  });

  it("never cuts more than the depth", () => {
    const song = mix(noise(1, -40, 5, SR), sine(1000, 1, -3, SR));
    const { gr } = run(new Tamer(SR, params([{ hz: 1000, depthDb: 2 }, { hz: 5000, depthDb: 0 }])), [song]);
    expect(gr[0]).toBeLessThanOrEqual(2 + 1e-9);
    expect(gr[0]).toBeGreaterThan(1.5);
  });

  it("turning it off while it is cutting fades out without a click", () => {
    const t = new Tamer(SR, params([{ hz: 1000, depthDb: 6 }, { hz: 5000, depthDb: 0 }]));
    const x = sine(1000, 2, -6, SR);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      if (i === 22016) t.setParams(NEUTRAL_TAMER);
      t.process([x.subarray(i, i + 128)], [out.subarray(i, i + 128)]);
    }
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    expect(jump).toBeLessThan(0.5 * ((2 * Math.PI * 1000) / SR) * 1.2);
    // Fully off again by the end: the input passes bit for bit.
    expect(out.subarray(-128)).toEqual(x.subarray(-128));
  });
});
