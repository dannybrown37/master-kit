import { describe, expect, it } from "vitest";
import { Transport } from "./transport.ts";

describe("Transport", () => {
  it("advances while playing and holds while paused", () => {
    const t = new Transport(60);
    expect(t.play(10)).toBe(0);
    expect(t.position(15)).toBeCloseTo(5, 9);
    t.pause(15);
    expect(t.playing).toBe(false);
    expect(t.position(100)).toBeCloseTo(5, 9);
    expect(t.play(200)).toBeCloseTo(5, 9);
    expect(t.position(201)).toBeCloseTo(6, 9);
  });

  it.each([
    ["inside", 30, 30],
    ["before start", -5, 0],
    ["past end", 99, 60],
    ["NaN", Number.NaN, 0],
  ])("seek %s clamps to the song", (_name, to, want) => {
    const t = new Transport(60);
    t.seek(to, 0);
    expect(t.position(0)).toBe(want);
  });

  it("seeking while playing keeps playing from the new spot", () => {
    const t = new Transport(60);
    t.play(0);
    expect(t.seek(40, 5)).toBe(40);
    expect(t.playing).toBe(true);
    expect(t.position(7)).toBeCloseTo(42, 9);
  });

  it("stops at the end", () => {
    const t = new Transport(60);
    t.play(0);
    expect(t.position(70)).toBe(60);
    expect(t.ended(70)).toBe(true);
  });

  it("play at the end restarts from the top", () => {
    const t = new Transport(60);
    t.seek(60, 0);
    expect(t.play(1)).toBe(0);
  });
});
