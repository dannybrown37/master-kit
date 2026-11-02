import { describe, expect, it } from "vitest";
import { defaultSettings } from "./settings.ts";
import { assertSameLength, fitLength, isVideoName, lockSync, shiftStart, syncOffset } from "./video.ts";

const RATE = 48000;

function noise(seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x / 2 ** 32 - 0.5) * Math.sin((Math.PI * i) / RATE) ** 2;
  }
  return out;
}

/** A master: shifted by `lag` samples (positive = late), one-pole low-passed and turned down, like EQ + gain would. */
function mastered(src: Float32Array, lag: number): Float32Array {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    const j = i - lag;
    y += 0.3 * ((j >= 0 && j < src.length ? src[j] : 0) - y);
    out[i] = 0.5 * y;
  }
  return out;
}

describe("syncOffset", () => {
  const src = noise(20);
  it.each([
    ["in sync", 0],
    ["a 200 ms lead-in", 9600],
    ["1 ms late", 48],
    ["one sample late", 1],
    ["30 ms early", -1440],
  ])("%s → that many samples", (_name, lag) => {
    expect(syncOffset([mastered(src, lag)], [src], RATE)).toBe(lag);
  });

  it("silence can't be checked: throws rather than calling it in sync", () => {
    const quiet = new Float32Array(20 * RATE);
    expect(() => syncOffset([quiet], [quiet], RATE)).toThrow(/silent/);
  });
});

describe("shiftStart", () => {
  it.each([
    ["earlier: drops samples off the front", 2, [3, 4, 0, 0]],
    ["later: adds silence in front", -1, [0, 1, 2, 3]],
    ["zero: unchanged", 0, [1, 2, 3, 4]],
  ])("%s, same length", (_name, by, want) => {
    expect(shiftStart([Float32Array.from([1, 2, 3, 4])], by).map((c) => [...c])).toEqual([want]);
  });
});

describe("fitLength", () => {
  it.each([
    ["trims extra samples off the end", [1, 2, 3, 4], 3, [1, 2, 3]],
    ["pads the end with silence", [1, 2], 4, [1, 2, 0, 0]],
    ["leaves an exact fit alone", [1, 2], 2, [1, 2]],
  ])("%s", (_name, input, frames, want) => {
    expect(fitLength([Float32Array.from(input)], frames).map((c) => [...c])).toEqual([want]);
  });
});

describe("isVideoName", () => {
  it.each([
    ["clip.mp4", true],
    ["Clip.MOV", true],
    ["a.b.webm", true],
    ["take 2.mkv", true],
    ["song.m4a", false],
    ["song.mp3", false],
    ["mp4", false],
    ["", false],
  ])("%s → %s", (name, want) => {
    expect(isVideoName(name)).toBe(want);
  });

  it.each([
    ["holiday.avi", "video/x-msvideo", true],
    ["song.mp3", "audio/mpeg", false],
  ])("%s with type %s → %s", (name, type, want) => {
    expect(isVideoName(name, type)).toBe(want);
  });
});

describe("lockSync", () => {
  it("zeroes lead-in and tail, keeps fades and every other knob", () => {
    const s = { ...defaultSettings(), edgeLeadMs: 200, edgeTailMs: 1000, edgeFadeInMs: 5, edgeFadeOutMs: 100, limDrive: 4 };
    expect(lockSync(s)).toEqual({ ...s, edgeLeadMs: 0, edgeTailMs: 0 });
  });

  it("does not mutate its input", () => {
    const s = { ...defaultSettings(), edgeLeadMs: 200 };
    lockSync(s);
    expect(s.edgeLeadMs).toBe(200);
  });
});

describe("assertSameLength", () => {
  it("passes when the export has exactly the source's frames", () => {
    expect(() => assertSameLength(48000, 48000)).not.toThrow();
  });

  it.each([
    ["one sample longer", 48001],
    ["one sample shorter", 47999],
    ["a 200 ms lead-in longer", 48000 + 9600],
  ])("throws when %s", (_name, exported) => {
    expect(() => assertSameLength(48000, exported)).toThrow(/sync/);
  });
});
