import { describe, expect, it } from "vitest";
import { contentBounds, edgeStats } from "./edges.ts";
import { SR, concat, noise, sine, stereo } from "./test-signals.ts";

const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SR));
/** -70 dBFS: under the -60 dBFS silence line, like an mp3's noise floor. */
const hiss = (seconds: number): Float32Array => noise(seconds, -70, 3);

describe("contentBounds", () => {
  it.each([
    ["tone from the first sample to the last", [sine(1000, 1, -6, SR, 90)], 0, SR],
    ["0.25 s silence, 1 s tone, 0.5 s silence", [silence(0.25), sine(1000, 1, -6, SR, 90), silence(0.5)], SR / 4, SR / 4 + SR],
    ["noise floor under -60 dBFS counts as silence", [hiss(0.1), sine(1000, 1, -6, SR, 90), hiss(0.2)], SR / 10, SR / 10 + SR],
  ])("%s", (_name, parts, start, end) => {
    expect(contentBounds(stereo(concat(...parts)))).toEqual({ start, end });
  });

  it("sound in either channel counts", () => {
    const left = concat(silence(0.5), sine(1000, 0.5, -6, SR, 90));
    const right = concat(sine(1000, 0.5, -6, SR, 90), silence(0.5));
    expect(contentBounds([left, right])).toEqual({ start: 0, end: SR });
  });

  it("all silence: no content", () => {
    expect(contentBounds(stereo(silence(1)))).toEqual({ start: SR, end: SR });
  });
});

describe("edgeStats", () => {
  it("a song that starts and stops at full level", () => {
    const s = edgeStats(stereo(sine(1000, 2, -1, SR, 90)), SR);
    expect(s.leadSeconds).toBe(0);
    expect(s.tailSeconds).toBe(0);
    expect(s.startDb).toBeCloseTo(-1, 1);
    expect(s.endDb).toBeCloseTo(-1, 1);
  });

  it("a song with quiet edges and silence around it", () => {
    const quietStart = sine(1000, 0.05, -50, SR, 90);
    const quietEnd = sine(1000, 0.05, -55, SR, 90);
    const s = edgeStats(stereo(concat(silence(0.3), quietStart, sine(1000, 1, -3), quietEnd, silence(1.2))), SR);
    expect(s.leadSeconds).toBeCloseTo(0.3, 6);
    expect(s.tailSeconds).toBeCloseTo(1.2, 6);
    expect(s.startDb).toBeCloseTo(-50, 1);
    expect(s.endDb).toBeCloseTo(-55, 1);
  });

  it("all silence: lead and tail are the whole file, levels are -inf", () => {
    expect(edgeStats(stereo(silence(1)), SR)).toEqual({ leadSeconds: 1, tailSeconds: 1, startDb: -Infinity, endDb: -Infinity });
  });
});
