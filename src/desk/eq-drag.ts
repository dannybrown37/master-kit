/** Pure mapping for dragging EQ dots on the spectrum plot: x = frequency (log), y = gain. */
import type { EqBand, ParamKey } from "../master/settings.ts";

export interface PlotBox {
  width: number;
  height: number;
  fMin: number;
  fMax: number;
  /** Gain at the top edge (and minus it at the bottom), dB. */
  rangeDb: number;
}

/** Knobs behind each dot, in `eqBands` order (shelves have no Q). */
export const EQ_BAND_KNOBS: readonly { freq: ParamKey; gain: ParamKey; q?: ParamKey }[] = [
  { freq: "eqLowFreq", gain: "eqLowGain" },
  { freq: "eqMudFreq", gain: "eqMudGain", q: "eqMudQ" },
  { freq: "eqPresFreq", gain: "eqPresGain", q: "eqPresQ" },
  { freq: "eqAirFreq", gain: "eqAirGain" },
];

/** Bandpass Q when soloing a shelf (which has no Q of its own): about 1.4 octaves wide. */
export const SHELF_SOLO_Q = 1;

/** The band to hear on its own for the selected knob: its centre and Q, or null if the knob isn't an EQ band's. */
export function soloBand(knob: ParamKey, bands: readonly EqBand[]): { frequency: number; q: number } | null {
  const i = EQ_BAND_KNOBS.findIndex((k) => k.freq === knob || k.gain === knob || k.q === knob);
  if (i < 0) return null;
  const b = bands[i];
  return { frequency: b.frequency, q: b.type === "peaking" ? b.q : SHELF_SOLO_Q };
}

/** -3 dB edges of a bandpass at `frequency` with quality `q` (RBJ cookbook bandwidth in octaves). */
export function bandEdges(frequency: number, q: number): [number, number] {
  const octaves = (2 / Math.LN2) * Math.asinh(1 / (2 * q));
  return [frequency / 2 ** (octaves / 2), frequency * 2 ** (octaves / 2)];
}

export function plotX(f: number, b: PlotBox): number {
  return (Math.log2(f / b.fMin) / Math.log2(b.fMax / b.fMin)) * b.width;
}

export function plotFreq(x: number, b: PlotBox): number {
  return b.fMin * (b.fMax / b.fMin) ** (x / b.width);
}

export function plotGain(y: number, b: PlotBox): number {
  return (0.5 - y / b.height) * 2 * b.rangeDb;
}

/** Unclamped knob values for dropping band `band` at (x, y); the caller clamps them through the knob ranges. */
export function dragToKnobs(band: number, x: number, y: number, b: PlotBox): Partial<Record<ParamKey, number>> {
  const k = EQ_BAND_KNOBS[band];
  return { [k.freq]: plotFreq(x, b), [k.gain]: plotGain(y, b) + 0 };
}

/** Index of the dot within `radius` of (x, y), closest first; -1 if none. */
export function nearestBand(dots: readonly { x: number; y: number }[], x: number, y: number, radius: number): number {
  let best = -1;
  let bestD = radius;
  dots.forEach((d, i) => {
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist <= bestD) {
      best = i;
      bestD = dist;
    }
  });
  return best;
}
