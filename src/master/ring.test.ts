import { describe, expect, it } from "vitest";
import { Ring } from "./ring.ts";

describe("Ring", () => {
  it.each([
    ["empty", [], []],
    ["fewer than its size: oldest first", [1, 2], [1, 2]],
    ["full", [1, 2, 3], [1, 2, 3]],
    ["wraps, keeping the newest", [1, 2, 3, 4, 5], [3, 4, 5]],
  ])("%s", (_name, pushes, want) => {
    const r = new Ring(3);
    for (const x of pushes) r.push(x);
    expect(r.values()).toEqual(want);
  });

  it("clear empties it", () => {
    const r = new Ring(2);
    r.push(1);
    r.clear();
    expect(r.values()).toEqual([]);
  });
});
