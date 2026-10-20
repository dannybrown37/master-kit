/**
 * Undo/redo for desk settings. Changes to the same group (one knob) less than `mergeMs` apart are one step,
 * so a drag or a run of arrow presses undoes in one go.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastGroup: string | null = null;
  private lastAt = -Infinity;
  private readonly limit: number;
  private readonly mergeMs: number;

  constructor(limit = 200, mergeMs = 1500) {
    this.limit = limit;
    this.mergeMs = mergeMs;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Call before a change, with the state it replaces. `group` null = never merge. */
  record(before: T, group: string | null, now: number): void {
    const merge = group !== null && group === this.lastGroup && now - this.lastAt < this.mergeMs;
    if (!merge) {
      this.past.push(before);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
    this.lastGroup = group;
    this.lastAt = now;
  }

  undo(current: T): T | null {
    return this.step(this.past, this.future, current);
  }

  redo(current: T): T | null {
    return this.step(this.future, this.past, current);
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastGroup = null;
  }

  private step(from: T[], to: T[], current: T): T | null {
    const next = from.pop();
    if (next === undefined) return null;
    to.push(current);
    this.lastGroup = null;
    return next;
  }
}
