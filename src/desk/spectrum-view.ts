/**
 * Live spectrum of what you hear vs its comparison (both loudness-matched), with the EQ curve on top.
 * Spectra are tilted +4.5 dB/octave (like most mastering analysers) so a typical mix reads roughly flat,
 * and smoothed over 1/6 octave so tonal balance shows rather than single harmonics.
 */
import { ANALYSER_TILT_DB_PER_OCT } from "../analysis/spectrum.ts";
import { eqCurveDb } from "../dsp/biquad.ts";
import type { EqBand, ParamKey } from "../master/settings.ts";
import { h } from "./dom.ts";
import { bandEdges, dragToKnobs, nearestBand } from "./eq-drag.ts";
import { logFrequencies, smoothColumns, spectrumColumns } from "./freq.ts";

const F_MIN = 20;
const F_MAX = 20000;
const SPECTRUM_RANGE: [number, number] = [-90, -20];
/** Each column is a power average over this many octaves around it. */
const SMOOTHING_OCTAVES = 1 / 6;
const EQ_RANGE_DB = 15;
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const PX_PER_COLUMN = 3;
const GRAB_RADIUS_PX = 14;

export interface Trace {
  bins: Float32Array;
  /** Added to the trace so it sits at the master's loudness. */
  offsetDb: number;
  color: string;
  label: string;
}

export interface SpectrumFrame {
  main: Trace;
  ghost: Trace;
  sampleRate: number;
  bands: EqBand[];
  /** Index into `bands` of the selected knob's band, or -1. */
  selected: number;
  /** The band being soloed, shaded on the plot. */
  solo: { frequency: number; q: number } | null;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

export class SpectrumView {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  /** Dot positions in CSS pixels, from the last draw. */
  private dots: { x: number; y: number }[] = [];
  private dragging = -1;

  /**
   * `onGrab(band)` when a dot is pressed; `onDrag(band, knobs)` while it moves; `onReset(band)` on double-click;
   * `onWheel(band, steps)` for the mouse wheel over a dot (+ = narrower).
   */
  constructor(handlers: {
    onGrab(band: number): void;
    onDrag(band: number, knobs: Partial<Record<ParamKey, number>>): void;
    onReset(band: number): void;
    onWheel(band: number, steps: number): void;
  }) {
    this.canvas = h("canvas");
    this.legend = h("p", "dim legend");
    this.el = h("section", "panel spectrum", h("h2", "", "Spectrum & EQ"), this.legend, h("div", "plot", this.canvas));
    const local = (ev: MouseEvent): { x: number; y: number } => {
      const r = this.canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const hit = (ev: MouseEvent): number => {
      const p = local(ev);
      return nearestBand(this.dots, p.x, p.y, GRAB_RADIUS_PX);
    };
    this.canvas.onpointerdown = (ev): void => {
      const band = hit(ev);
      if (band < 0) return;
      this.dragging = band;
      this.canvas.setPointerCapture(ev.pointerId);
      handlers.onGrab(band);
    };
    this.canvas.onpointermove = (ev): void => {
      if (this.dragging < 0) {
        this.canvas.style.cursor = hit(ev) >= 0 ? "grab" : "";
        return;
      }
      const p = local(ev);
      const r = this.canvas.getBoundingClientRect();
      handlers.onDrag(this.dragging, dragToKnobs(this.dragging, p.x, p.y, { width: r.width, height: r.height, fMin: F_MIN, fMax: F_MAX, rangeDb: EQ_RANGE_DB }));
    };
    this.canvas.onpointerup = (): void => {
      this.dragging = -1;
    };
    this.canvas.ondblclick = (ev): void => {
      const band = hit(ev);
      if (band >= 0) handlers.onReset(band);
    };
    this.canvas.onwheel = (ev): void => {
      const band = hit(ev);
      if (band < 0) return;
      ev.preventDefault();
      handlers.onWheel(band, ev.deltaY < 0 ? 1 : -1);
    };
  }

  draw(frame: SpectrumFrame): void {
    const box = this.canvas.parentElement;
    if (!box) return;
    const dpr = devicePixelRatio;
    const width = Math.round(box.clientWidth * dpr);
    const height = Math.round(box.clientHeight * dpr);
    if (width === 0 || height === 0) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.legend.textContent = `bars: ${frame.main.label} · line: ${frame.ghost.label} (loudness-matched, +${ANALYSER_TILT_DB_PER_OCT} dB/oct tilt) · white: EQ (±${EQ_RANGE_DB} dB): drag dots, wheel = Q, double-click = 0 dB`;
    const g = this.canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, width, height);
    const span = Math.log2(F_MAX / F_MIN);
    const x = (f: number): number => (Math.log2(f / F_MIN) / span) * width;
    const ySpec = (db: number): number => (1 - (db - SPECTRUM_RANGE[0]) / (SPECTRUM_RANGE[1] - SPECTRUM_RANGE[0])) * height;
    const yEq = (db: number): number => (0.5 - db / (2 * EQ_RANGE_DB)) * height;

    g.strokeStyle = cssVar("--line");
    g.fillStyle = cssVar("--dim");
    g.font = `${10 * dpr}px monospace`;
    g.lineWidth = 1;
    for (const f of GRID_HZ) {
      g.beginPath();
      g.moveTo(x(f), 0);
      g.lineTo(x(f), height);
      g.stroke();
      g.fillText(hz(f), x(f) + 2 * dpr, height - 3 * dpr);
    }
    g.beginPath();
    g.moveTo(0, yEq(0));
    g.lineTo(width, yEq(0));
    g.stroke();
    g.fillText(`±${EQ_RANGE_DB} dB`, width - 52 * dpr, 12 * dpr);
    if (frame.solo) {
      const [lo, hi] = bandEdges(frame.solo.frequency, frame.solo.q);
      g.fillStyle = cssVar("--accent");
      g.globalAlpha = 0.12;
      g.fillRect(x(lo), 0, x(hi) - x(lo), height);
      g.globalAlpha = 1;
      g.fillStyle = cssVar("--accent");
      g.fillText("solo", x(lo) + 3 * dpr, 12 * dpr);
    }

    const n = Math.max(8, Math.round(width / (PX_PER_COLUMN * dpr)));
    const freqs = logFrequencies(n, F_MIN, F_MAX);
    const colW = width / n;
    const smoothing = Math.round((n * SMOOTHING_OCTAVES) / 2 / span);
    const columns = (bins: Float32Array): number[] => smoothColumns(spectrumColumns(bins, frame.sampleRate, n, F_MIN, F_MAX, ANALYSER_TILT_DB_PER_OCT), smoothing);
    const main = columns(frame.main.bins);
    g.fillStyle = frame.main.color;
    g.globalAlpha = 0.45;
    main.forEach((db, i) => {
      if (!Number.isFinite(db)) return;
      const top = ySpec(db + frame.main.offsetDb);
      g.fillRect(i * colW, top, Math.max(1, colW - dpr), height - top);
    });
    g.globalAlpha = 1;

    const ghost = columns(frame.ghost.bins);
    g.strokeStyle = frame.ghost.color;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    let pen = false;
    ghost.forEach((db, i) => {
      if (!Number.isFinite(db)) {
        pen = false;
        return;
      }
      const px = (i + 0.5) * colW;
      const py = ySpec(db + frame.ghost.offsetDb);
      if (pen) g.lineTo(px, py);
      else g.moveTo(px, py);
      pen = true;
    });
    g.stroke();

    const curve = eqCurveDb(frame.bands, freqs, frame.sampleRate);
    g.strokeStyle = cssVar("--text");
    g.lineWidth = 2 * dpr;
    g.beginPath();
    curve.forEach((db, i) => (i ? g.lineTo((i + 0.5) * colW, yEq(db)) : g.moveTo(0.5 * colW, yEq(db))));
    g.stroke();
    // Dots sit at each band's own frequency and gain (as in most EQ plugins), so a dragged dot stays under the pointer.
    this.dots = frame.bands.map((b) => ({ x: x(b.frequency) / dpr, y: yEq(b.gain) / dpr }));
    this.dots.forEach((d, i) => {
      const on = i === frame.selected || i === this.dragging;
      g.fillStyle = on ? cssVar("--accent") : cssVar("--text");
      g.beginPath();
      g.arc(d.x * dpr, d.y * dpr, (on ? 6 : 4) * dpr, 0, 2 * Math.PI);
      g.fill();
    });
    g.lineWidth = 1;
  }
}
