import { describe, expect, it } from "vitest";
import { SR, concat, sine, stereo } from "../analysis/test-signals.ts";
import { NEUTRAL_EDGES, applyEdges, edgeAutomation, edgeGain } from "./edges.ts";
import type { EdgeParams } from "./edges.ts";

const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SR));
const ones = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SR)).fill(0.5);
const edges = (over: Partial<EdgeParams>): EdgeParams => ({ ...NEUTRAL_EDGES, ...over });

describe("edgeGain", () => {
  const bounds = { start: 1, end: 9 };
  it.each([
    ["no fades: always 1", edges({}), [0, 1, 5, 9, 10], [1, 1, 1, 1, 1]],
    ["fade-in: 0 before the sound, half way up in the middle, 1 after", edges({ fadeIn: 2 }), [0.5, 1, 2, 3, 5], [0, 0, 0.5, 1, 1]],
    ["fade-out: 1 before, half way down in the middle, 0 at the end and after", edges({ fadeOut: 4 }), [4, 5, 7, 9, 9.5], [1, 1, 0.5, 0, 0]],
    ["fades that overlap take the lower gain", edges({ fadeIn: 8, fadeOut: 8 }), [5], [0.5]],
  ])("%s", (_name, p, times, want) => {
    expect(times.map((t) => edgeGain(t, bounds, p))).toEqual(want.map((g) => expect.closeTo(g, 9)));
  });
});

describe("applyEdges", () => {
  it("neutral: returns the same audio, untouched", () => {
    const song = stereo(sine(1000, 0.5, -1, SR, 90));
    expect(applyEdges(song, SR, NEUTRAL_EDGES)).toBe(song);
  });

  it("pads silence before and after up to the requested lead-in and tail", () => {
    const out = applyEdges(stereo(ones(1)), SR, edges({ lead: 0.2, tail: 1 }));
    expect(out[0].length).toBe(Math.round(SR * 2.2));
    expect(out[1].length).toBe(Math.round(SR * 2.2));
    expect(out[0].subarray(0, SR * 0.2).every((x) => x === 0)).toBe(true);
    expect(out[0].subarray(SR * 0.2, SR * 1.2).every((x) => x === 0.5)).toBe(true);
    expect(out[0].subarray(SR * 1.2).every((x) => x === 0)).toBe(true);
  });

  it("existing silence counts toward lead-in and tail: only the difference is added", () => {
    const out = applyEdges(stereo(concat(silence(0.15), ones(1), silence(0.6))), SR, edges({ lead: 0.2, tail: 0.5 }));
    expect(out[0].length).toBe(Math.round(SR * (0.2 + 1 + 0.6)));
    expect(out[0].findIndex((x) => x !== 0)).toBe(SR * 0.2);
  });

  it("fades in from 0 at the first sound and out to 0 at the last, then digital silence", () => {
    const song = stereo(concat(silence(0.1), ones(1), silence(0.1)));
    song[0][2] = 1e-4; // under the -60 dBFS silence line
    const [l] = applyEdges(song, SR, edges({ fadeIn: 0.01, fadeOut: 0.5 }));
    const at = (s: number): number => l[Math.round(s * SR)];
    expect(l[2]).toBe(0);
    expect(at(0.1)).toBe(0);
    expect(at(0.105)).toBeCloseTo(0.25, 6);
    expect(at(0.2)).toBe(0.5);
    expect(at(0.85)).toBeCloseTo(0.25, 6);
    expect(at(1.1 - 1 / SR)).toBeLessThan(1e-4);
    expect(l.subarray(Math.round(1.1 * SR)).every((x) => x === 0)).toBe(true);
  });

  it("all silence: returned as is", () => {
    const song = stereo(silence(1));
    expect(applyEdges(song, SR, edges({ lead: 0.5, fadeIn: 0.01 }))).toBe(song);
  });
});

describe("edgeAutomation (live playback)", () => {
  const bounds = { start: 0, end: 10 };

  it("from the top: starts silent, then one curve per fade", () => {
    const a = edgeAutomation(0, bounds, edges({ fadeIn: 0.005, fadeOut: 2 }));
    expect(a.initial).toBe(0);
    expect(a.curves.map((c) => [c.at, c.duration])).toEqual([
      [0, 0.005],
      [8, 2],
    ]);
    const [fadeIn, fadeOut] = a.curves;
    expect([fadeIn.values[0], fadeIn.values.at(-1)]).toEqual([0, 1]);
    expect(fadeOut.values[0]).toBeCloseTo(1, 9);
    expect(fadeOut.values.at(-1)).toBeCloseTo(0, 9);
  });

  it("from inside the fade-out: the curve starts where playback does", () => {
    const a = edgeAutomation(9, bounds, edges({ fadeIn: 0.005, fadeOut: 2 }));
    expect(a.initial).toBeCloseTo(0.5, 9);
    expect(a.curves.map((c) => [c.at, c.duration])).toEqual([[9, 1]]);
    expect(a.curves[0].values[0]).toBeCloseTo(0.5, 6);
  });

  it("past the end of a fade-out: silent, nothing to schedule", () => {
    expect(edgeAutomation(10.5, bounds, edges({ fadeOut: 2 }))).toEqual({ initial: 0, curves: [] });
  });

  it("fades that overlap become one curve", () => {
    const a = edgeAutomation(0, { start: 0, end: 1 }, edges({ fadeIn: 0.8, fadeOut: 0.8 }));
    expect(a.curves.map((c) => [c.at, c.duration])).toEqual([[0, 1]]);
  });

  it("no fades: gain 1, nothing to schedule", () => {
    expect(edgeAutomation(3, bounds, NEUTRAL_EDGES)).toEqual({ initial: 1, curves: [] });
  });
});
