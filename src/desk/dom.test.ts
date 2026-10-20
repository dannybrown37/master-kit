import { describe, expect, it } from "vitest";
import { db, signed } from "./dom.ts";

describe("number formatting", () => {
  it.each([
    [1.25, 1, "+1.3"],
    [-2, 1, "-2.0"],
    [-0.001, 2, "0.00"],
    [0.004, 2, "0.00"],
    [-0.04, 1, "0.0"],
    [Infinity, 1, ""],
  ])("signed(%d, %i) → %s", (x, digits, want) => {
    expect(signed(x, digits)).toBe(want);
  });

  it.each([
    [-0.01, 1, "0.0"],
    [-3.04, 1, "-3.0"],
    [-Infinity, 1, "-inf"],
  ])("db(%d, %i) → %s", (x, digits, want) => {
    expect(db(x, digits)).toBe(want);
  });
});
