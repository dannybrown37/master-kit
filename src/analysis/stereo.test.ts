import { describe, expect, it } from "vitest";
import { LiveStereo, stereoImage } from "./stereo.ts";
import { SR, concat, noise, sine } from "./test-signals.ts";

const neg = (x: Float32Array): Float32Array => x.map((v) => -v);
const mix = (a: Float32Array, b: Float32Array, gb: number): Float32Array => a.map((v, i) => v + gb * b[i]);

describe("stereoImage", () => {
  const a = noise(2, -6, 1);
  const b = noise(2, -6, 2);

  it.each([
    ["mono (L = R)", [a, a], 1, -Infinity],
    ["one channel", [a], 1, -Infinity],
    ["out of phase (L = -R)", [a, neg(a)], -1, Infinity],
    ["unrelated noise", [a, b], 0, 0],
    ["90° phase-shifted sines", [sine(500, 2, -6), sine(500, 2, -6, SR, 90)], 0, 0],
  ])("%s → correlation %d, side/mid %d dB", (_name, channels, correlation, sideDb) => {
    const s = stereoImage(channels);
    expect(s.correlation).toBeCloseTo(correlation, 1);
    if (Number.isFinite(sideDb)) expect(s.sideDb).toBeCloseTo(sideDb, 0);
    else expect(s.sideDb).toBe(sideDb);
  });

  it("a mostly-centred mix: side 20 dB under mid", () => {
    // M = a, S = 0.1 a' → L = M + S, R = M - S.
    const s = stereoImage([mix(a, b, 0.1), mix(a, b, -0.1)]);
    expect(s.sideDb).toBeCloseTo(-20, 0);
    expect(s.correlation).toBeCloseTo(0.98, 2);
  });

  it("silence has no image: correlation and width are NaN", () => {
    const s = stereoImage([new Float32Array(100), new Float32Array(100)]);
    expect(s.correlation).toBeNaN();
    expect(s.sideDb).toBeNaN();
  });
});

describe("LiveStereo", () => {
  it.each([128, 1000])("matches the offline numbers on a steady signal (blocks of %i)", (block) => {
    const a = noise(3, -6, 3);
    const b = noise(3, -6, 4);
    const l = mix(a, b, 0.5);
    const r = mix(a, b, -0.5);
    const live = new LiveStereo(SR);
    for (let i = 0; i < l.length; i += block) live.push([l.subarray(i, i + block), r.subarray(i, i + block)]);
    const offline = stereoImage([l, r]);
    expect(live.correlation).toBeCloseTo(offline.correlation, 1);
    expect(live.sideDb).toBeCloseTo(offline.sideDb, 0);
  });

  it("follows a change within about a second, forgetting the old image", () => {
    const a = noise(4, -6, 5);
    const live = new LiveStereo(SR);
    const l = concat(a.subarray(0, 2 * SR), a.subarray(2 * SR));
    const r = concat(a.subarray(0, 2 * SR), neg(a.subarray(2 * SR)));
    for (let i = 0; i < 2 * SR; i += 128) live.push([l.subarray(i, i + 128), r.subarray(i, i + 128)]);
    expect(live.correlation).toBeCloseTo(1, 2);
    for (let i = 2 * SR; i < 4 * SR; i += 128) live.push([l.subarray(i, i + 128), r.subarray(i, i + 128)]);
    expect(live.correlation).toBeLessThan(-0.95);
  });

  it("reset forgets everything", () => {
    const live = new LiveStereo(SR);
    const a = noise(1, -6, 6);
    live.push([a, a]);
    live.reset();
    expect(live.correlation).toBeNaN();
  });
});
