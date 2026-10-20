/** Tiny DOM helpers for the desk. */

export type Child = Node | string;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.append(...children);
  return el;
}

export function button(label: string, onClick: () => void, title = ""): HTMLButtonElement {
  const b = h("button", "", label);
  b.type = "button";
  b.title = title;
  b.onclick = onClick;
  return b;
}

/** Saves `blob` through the browser's download (same path a click on a link takes). */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** toFixed without "-0.0" for values that round to zero. */
function fixed(x: number, digits: number): string {
  const text = x.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

export function db(x: number, digits = 1): string {
  return Number.isFinite(x) ? fixed(x, digits) : "-inf";
}

export function signed(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "";
  const text = fixed(x, digits);
  return Number(text) > 0 ? `+${text}` : text;
}

export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
}

function frac(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0;
}

/** A horizontal meter bar from `lo` to `hi` (dB), with an optional target zone, limit line and ghost marker. */
export class MeterBar {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly ghost: HTMLElement;
  private readonly lo: number;
  private readonly hi: number;

  constructor(lo: number, hi: number, opts: { zone?: [number, number]; line?: number } = {}) {
    this.lo = lo;
    this.hi = hi;
    this.fill = h("div", "fill");
    this.ghost = h("div", "ghost");
    this.el = h("div", "bar");
    if (opts.zone) {
      const z = h("div", "zone");
      z.style.left = `${frac(opts.zone[0], lo, hi) * 100}%`;
      z.style.width = `${(frac(opts.zone[1], lo, hi) - frac(opts.zone[0], lo, hi)) * 100}%`;
      this.el.append(z);
    }
    this.el.append(this.fill);
    if (opts.line !== undefined) {
      const l = h("div", "line");
      l.style.left = `${frac(opts.line, lo, hi) * 100}%`;
      this.el.append(l);
    }
    this.el.append(this.ghost);
  }

  set(value: number, tone: "" | "good" | "warn" | "bad" = "", ghost = -Infinity): void {
    this.fill.style.left = "0";
    this.fill.style.width = `${frac(value, this.lo, this.hi) * 100}%`;
    this.fill.className = `fill ${tone}`;
    this.ghost.style.display = Number.isFinite(ghost) ? "" : "none";
    this.ghost.style.left = `${frac(ghost, this.lo, this.hi) * 100}%`;
  }

  /** Fill between two fractions (for bipolar knobs and meters that grow out of their centre). */
  span(from: number, to: number, tone: "" | "good" | "warn" | "bad" = "", ghost = NaN): void {
    this.fill.style.left = `${Math.min(from, to) * 100}%`;
    this.fill.style.width = `${Math.max(Math.abs(to - from) * 100, 0.8)}%`;
    this.fill.className = `fill ${tone}`;
    this.ghost.style.display = Number.isFinite(ghost) ? "" : "none";
    this.ghost.style.left = `${Math.min(1, Math.max(0, ghost)) * 100}%`;
  }
}
