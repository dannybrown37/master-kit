import { describe, expect, it } from "vitest";
import { columnsByTime, shortTermTimes, toY } from "./curve.ts";

describe("loudness curve", () => {
  it("places each short-term value at the centre of its 3 s window", () => {
    expect(shortTermTimes(3)).toEqual([1.5, 1.6, 1.7].map((t) => expect.closeTo(t, 9)));
  });

  it.each([
    ["one value per column", [1, 2, 3, 4], [0.5, 1.5, 2.5, 3.5], 4, 4, [1, 2, 3, 4]],
    ["keeps the loudest value in each column", [1, 5, 2, 3], [0.5, 1.5, 2.5, 3.5], 4, 2, [5, 3]],
    ["empty columns are -Infinity", [7], [3.5], 4, 4, [-Infinity, -Infinity, -Infinity, 7]],
    ["values past the end go in the last column", [1, 9], [0.5, 4], 4, 2, [1, 9]],
    ["silence stays -Infinity", [-Infinity, -Infinity], [0.5, 1.5], 2, 2, [-Infinity, -Infinity]],
  ] as const)("columnsByTime: %s", (_name, values, times, duration, n, want) => {
    expect(columnsByTime(values, times, duration, n)).toEqual(want);
  });

  it.each([
    ["top of the range is y 0", 0, 0],
    ["bottom is the height", -36, 100],
    ["middle", -18, 50],
    ["louder than the range clamps to the top", 3, 0],
    ["silence sits on the bottom", -Infinity, 100],
  ])("toY: %s", (_name, lufs, want) => {
    expect(toY(lufs, [-36, 0], 100)).toBeCloseTo(want, 9);
  });
});
