import { describe, expect, it } from "vitest";
import { History } from "./history.ts";

/** Applies changes [group, value, time] to a number, recording each in a History. */
function play(changes: [string | null, number, number][]): { h: History<number>; value: number } {
  const h = new History<number>();
  let value = 0;
  for (const [group, next, at] of changes) {
    h.record(value, group, at);
    value = next;
  }
  return { h, value };
}

describe("History", () => {
  it("undoes and redoes single changes", () => {
    const { h, value } = play([
      ["a", 1, 0],
      ["b", 2, 100],
    ]);
    expect(h.undo(value)).toBe(1);
    expect(h.undo(1)).toBe(0);
    expect(h.undo(0)).toBeNull();
    expect(h.redo(0)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBeNull();
  });

  it.each([
    ["same knob in quick succession: one step", [["a", 1, 0], ["a", 2, 500], ["a", 3, 1000]], [0]],
    ["a long drag keeps merging while the gaps stay short", [["a", 1, 0], ["a", 2, 1400], ["a", 3, 2800]], [0]],
    ["a pause starts a new step", [["a", 1, 0], ["a", 2, 2000]], [1, 0]],
    ["another knob starts a new step", [["a", 1, 0], ["b", 2, 100]], [1, 0]],
    ["no group never merges (reset, hint)", [[null, 1, 0], [null, 2, 100]], [1, 0]],
  ] as const)("%s", (_name, changes, wantUndos) => {
    const { h, value } = play(changes.map((c) => [...c]));
    const undos: number[] = [];
    let current = value;
    for (let prev = h.undo(current); prev !== null; prev = h.undo(current)) {
      undos.push(prev);
      current = prev;
    }
    expect(undos).toEqual(wantUndos);
  });

  it("a new change after undo drops the redo branch", () => {
    const { h, value } = play([["a", 1, 0], ["b", 2, 100]]);
    const back = h.undo(value);
    h.record(back ?? 0, "c", 200);
    expect(h.redo(5)).toBeNull();
  });

  it("does not merge into a change made before an undo", () => {
    const { h, value } = play([["a", 1, 0], ["a", 2, 100]]);
    expect(h.undo(value)).toBe(0);
    h.record(0, "a", 200);
    h.record(7, "a", 300);
    expect(h.undo(8)).toBe(0);
    expect(h.undo(0)).toBeNull();
  });

  it("keeps at most `limit` steps", () => {
    const h = new History<number>(3);
    for (let i = 0; i < 10; i++) h.record(i, null, i * 10);
    expect([h.undo(10), h.undo(9), h.undo(8), h.undo(7)]).toEqual([9, 8, 7, null]);
  });

  it("clear forgets everything", () => {
    const { h, value } = play([["a", 1, 0]]);
    h.clear();
    expect(h.undo(value)).toBeNull();
    expect(h.canUndo).toBe(false);
  });
});
