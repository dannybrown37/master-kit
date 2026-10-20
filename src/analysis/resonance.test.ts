import { describe, expect, it } from "vitest";
import { findResonances } from "./resonance.ts";
import { lowpassed, noise, sine, stereo } from "./test-signals.ts";
import { powerSpectrum } from "./spectrum.ts";

const SR = 44100;
const mix = (...parts: Float32Array[]): Float32Array => parts[0].map((_, i) => parts.reduce((s, p) => s + p[i], 0));
const find = (x: Float32Array): ReturnType<typeof findResonances> => findResonances(powerSpectrum(stereo(x)), SR);

describe("findResonances", () => {
  it("finds a tone sticking out of noise, at its frequency", () => {
    const [r] = find(mix(noise(3, -20, 1, SR), sine(3150, 3, -20, SR)));
    expect(r.hz).toBeGreaterThan(3150 * 2 ** (-1 / 24));
    expect(r.hz).toBeLessThan(3150 * 2 ** (1 / 24));
    expect(r.prominenceDb).toBeGreaterThan(6);
  });

  it("lists several, most prominent first", () => {
    const list = find(mix(noise(3, -20, 2, SR), sine(400, 3, -30, SR), sine(2500, 3, -18, SR)));
    expect(list.map((r) => Math.round(r.hz / 100) * 100)).toEqual([2500, 400]);
  });

  it.each([
    ["white noise", noise(3, -6, 3, SR)],
    ["noise with a smooth top roll-off", lowpassed(noise(3, -6, 4, SR), 6000, SR, 63)],
  ])("%s: nothing", (_name, x) => {
    expect(find(x)).toEqual([]);
  });

  it("ignores tones outside 150 Hz–8 kHz (bass notes, cymbal fizz)", () => {
    expect(find(mix(noise(3, -20, 5, SR), sine(60, 3, -12, SR), sine(12000, 3, -12, SR)))).toEqual([]);
  });
});
