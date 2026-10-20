/** Short-term loudness over the whole song (original vs master), with the target zone and a playhead. Click to seek. */
import type { Report } from "../analysis/report.ts";
import { columnsByTime, shortTermTimes, toY } from "./curve.ts";
import { h } from "./dom.ts";

const RANGE: [number, number] = [-30, -4];
const GRID_LUFS = [-24, -14, -8];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class LoudnessPlot {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly playhead: HTMLElement;
  private drawn: { original: Report | null; master: Report | null; reference: Report | null; width: number } | null = null;
  private duration = 0;
  private readonly zone: [number, number];

  constructor(zone: [number, number], onSeek: (seconds: number) => void) {
    this.zone = zone;
    this.canvas = h("canvas");
    this.playhead = h("div", "playhead");
    this.el = h("div", "plot", this.canvas, this.playhead);
    this.el.title = "Short-term loudness over the song: blue = original, amber = master, violet dashes = reference (integrated). Click to seek.";
    this.el.onclick = (ev): void => {
      const rect = this.el.getBoundingClientRect();
      if (this.duration > 0 && rect.width > 0) onSeek(((ev.clientX - rect.left) / rect.width) * this.duration);
    };
  }

  update(original: Report, master: Report | null, reference: Report | null, position: number): void {
    this.duration = original.durationSeconds;
    this.playhead.style.left = `${Math.min(1, Math.max(0, position / this.duration)) * 100}%`;
    const width = Math.round(this.el.clientWidth * devicePixelRatio);
    const d = this.drawn;
    if (width === 0 || (d && d.original === original && d.master === master && d.reference === reference && d.width === width)) return;
    this.drawn = { original, master, reference, width };
    this.draw(original, master, reference, width);
  }

  private draw(original: Report, master: Report | null, reference: Report | null, width: number): void {
    const height = Math.round(this.el.clientHeight * devicePixelRatio);
    this.canvas.width = width;
    this.canvas.height = height;
    const g = this.canvas.getContext("2d");
    if (!g) return;
    const y = (lufs: number): number => toY(lufs, RANGE, height);
    g.fillStyle = cssVar("--zone");
    g.fillRect(0, y(this.zone[1]), width, y(this.zone[0]) - y(this.zone[1]));
    g.strokeStyle = cssVar("--line");
    g.fillStyle = cssVar("--text-muted");
    g.font = `${10 * devicePixelRatio}px "IBM Plex Mono", monospace`;
    for (const lufs of GRID_LUFS) {
      g.beginPath();
      g.moveTo(0, y(lufs));
      g.lineTo(width, y(lufs));
      g.stroke();
      g.fillText(`${lufs}`, 2 * devicePixelRatio, y(lufs) - 2 * devicePixelRatio);
    }
    if (reference && Number.isFinite(reference.integrated)) {
      g.strokeStyle = cssVar("--series-reference");
      g.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
      g.beginPath();
      g.moveTo(0, y(reference.integrated));
      g.lineTo(width, y(reference.integrated));
      g.stroke();
      g.setLineDash([]);
    }
    const curve = (r: Report, color: string): void => {
      // Never more columns than values, or the line breaks into gaps.
      const n = Math.max(1, Math.min(width, r.shortTerm.length));
      const cols = columnsByTime(r.shortTerm, shortTermTimes(r.shortTerm.length), this.duration, n);
      g.strokeStyle = color;
      g.lineWidth = 1.5 * devicePixelRatio;
      g.beginPath();
      let pen = false;
      cols.forEach((lufs, c) => {
        if (!Number.isFinite(lufs)) {
          pen = false;
          return;
        }
        const x = ((c + 0.5) * width) / n;
        if (pen) g.lineTo(x, y(lufs));
        else g.moveTo(x, y(lufs));
        pen = true;
      });
      g.stroke();
      g.lineWidth = 1;
    };
    curve(original, cssVar("--series-original"));
    if (master) curve(master, cssVar("--series-master"));
  }
}
