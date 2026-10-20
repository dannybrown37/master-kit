import { describe, expect, it } from "vitest";
import { NEUTRAL_EDGES } from "../dsp/edges.ts";
import { albumFileName, consistency, moveItem, transitionEdges } from "./album.ts";

describe("albumFileName", () => {
  it.each([
    [0, "First in Line [2025, edm].mp3", 24, "01 - First in Line [2025, edm] (master 24-bit).wav"],
    [11, "Cruisin' [2020, arcade].mp3", 16, "12 - Cruisin_ [2020, arcade] (master 16-bit).wav"],
  ] as const)("track %d", (i, name, bits, want) => {
    expect(albumFileName(i, name, bits)).toBe(want);
  });
});

describe("moveItem", () => {
  it.each([
    ["up", 2, -1, ["a", "c", "b", "d"]],
    ["down", 0, 1, ["b", "a", "c", "d"]],
    ["past the top: no change", 0, -1, ["a", "b", "c", "d"]],
    ["past the bottom: no change", 3, 1, ["a", "b", "c", "d"]],
  ] as const)("%s", (_name, i, delta, want) => {
    const list = ["a", "b", "c", "d"];
    expect(moveItem(list, i, delta)).toEqual(want);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });
});

describe("consistency", () => {
  it("an even album: small spread, no outliers", () => {
    expect(consistency([-14.1, -13.9, -14.0, -14.3])).toEqual({ spreadLu: expect.closeTo(0.4, 9), outliers: [] });
  });

  it("flags songs more than 1 LU off the album's median", () => {
    expect(consistency([-14, -14.2, -11.8, -14.1, -16]).outliers).toEqual([2, 4]);
  });

  it("ignores songs that aren't measured yet", () => {
    expect(consistency([NaN, -14, -14.5]).spreadLu).toBeCloseTo(0.5, 9);
  });

  it("nothing measured: no spread", () => {
    expect(consistency([NaN])).toEqual({ spreadLu: 0, outliers: [] });
  });
});

describe("transitionEdges", () => {
  it("the end of A keeps its fade-out and tail, the start of B its lead-in and fade-in", () => {
    const p = { lead: 0.2, fadeIn: 0.005, fadeOut: 3, tail: 1 };
    expect(transitionEdges(p)).toEqual({ ending: { ...NEUTRAL_EDGES, fadeOut: 3, tail: 1 }, opening: { ...NEUTRAL_EDGES, lead: 0.2, fadeIn: 0.005 } });
  });
});
