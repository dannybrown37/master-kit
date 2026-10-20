/**
 * Resonance finder: narrow humps in the long-term spectrum that stick out of the spectrum on both sides of them
 * (a ringing room mode, a harsh synth partial, a boxy drum). DOM-free.
 * Each 1/12-octave slice is compared with the louder of its neighbours 1/6–1/2 octave below and above, so a
 * slope or a roll-off never reads as a peak: only something higher than both sides does.
 */
import { FFT_SIZE } from "./spectrum.ts";

export interface Resonance {
  hz: number;
  /** dB above the louder side. */
  prominenceDb: number;
}

const LO_HZ = 150;
const HI_HZ = 8000;
const MIN_PROMINENCE_DB = 3;
const MAX_FOUND = 4;
/** Peaks closer than this (octaves) count as one. */
const MIN_SPACING_OCT = 1 / 3;
const STEP_OCT = 1 / 48;

/** `power` = per-bin power from `powerSpectrum` (FFT_SIZE). Most prominent first. */
export function findResonances(power: Float64Array, sampleRate: number): Resonance[] {
  const binHz = sampleRate / FFT_SIZE;
  const cumulative = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k++) cumulative[k + 1] = cumulative[k] + power[k];
  /** Mean power in dB between two frequencies. */
  const level = (lo: number, hi: number): number => {
    const a = Math.max(0, Math.floor(lo / binHz));
    const b = Math.min(power.length, Math.max(a + 1, Math.ceil(hi / binHz)));
    const mean = (cumulative[b] - cumulative[a]) / (b - a);
    return mean > 0 ? 10 * Math.log10(mean) : -Infinity;
  };
  const oct = (hz: number, o: number): number => hz * 2 ** o;
  const candidates: Resonance[] = [];
  for (let o = Math.log2(LO_HZ); o <= Math.log2(HI_HZ); o += STEP_OCT) {
    const hz = 2 ** o;
    const centre = level(oct(hz, -1 / 24), oct(hz, 1 / 24));
    const below = level(oct(hz, -1 / 2), oct(hz, -1 / 6));
    const above = level(oct(hz, 1 / 6), oct(hz, 1 / 2));
    const prominenceDb = centre - Math.max(below, above);
    if (Number.isFinite(prominenceDb)) candidates.push({ hz, prominenceDb });
  }
  const peaks = candidates.filter((c, i) => c.prominenceDb >= MIN_PROMINENCE_DB && c.prominenceDb >= (candidates[i - 1]?.prominenceDb ?? -Infinity) && c.prominenceDb >= (candidates[i + 1]?.prominenceDb ?? -Infinity));
  /** The window around a peak is flat-topped; the power-weighted centre of its bins is where the hump really is. */
  const centre = (hz: number): number => {
    let sum = 0;
    let weighted = 0;
    for (let k = Math.floor(oct(hz, -1 / 24) / binHz); k <= Math.ceil(oct(hz, 1 / 24) / binHz) && k < power.length; k++) {
      sum += power[k];
      weighted += power[k] * k * binHz;
    }
    return sum > 0 ? weighted / sum : hz;
  };
  const found: Resonance[] = [];
  for (const p of peaks.sort((a, b) => b.prominenceDb - a.prominenceDb)) {
    if (found.length >= MAX_FOUND) break;
    const hz = centre(p.hz);
    if (found.every((f) => Math.abs(Math.log2(f.hz / hz)) >= MIN_SPACING_OCT)) found.push({ hz: Math.round(hz), prominenceDb: p.prominenceDb });
  }
  return found;
}
