/** Scrolling gain-reduction history: bars hang down from the top, newest on the right. */
import { h } from "./dom.ts";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class GrTrace {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly maxDb: number;

  constructor(maxDb: number, seconds: number) {
    this.maxDb = maxDb;
    this.canvas = h("canvas");
    this.el = h("div", "gr-trace", this.canvas);
    this.el.title = `gain reduction over the last ${seconds} s of playback (down = more; full height = ${maxDb} dB)`;
  }

  draw(values: readonly number[], slots: number): void {
    const dpr = devicePixelRatio;
    const width = Math.round(this.el.clientWidth * dpr);
    const height = Math.round(this.el.clientHeight * dpr);
    if (width === 0 || height === 0) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const g = this.canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, width, height);
    const w = width / slots;
    const start = slots - values.length;
    values.forEach((db, i) => {
      const depth = Math.min(1, db / this.maxDb) * height;
      if (depth <= 0) return;
      g.fillStyle = db > 6 ? cssVar("--bad") : db > 3 ? cssVar("--warn") : cssVar("--accent");
      g.fillRect((start + i) * w, 0, Math.max(1, w - 0.5 * dpr), depth);
    });
  }
}
