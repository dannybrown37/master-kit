/** The mastering workflow as a checklist that ticks itself from what you've done and measured. */
import { TARGETS } from "../analysis/targets.ts";

export interface ChecklistInput {
  hasReference: boolean;
  /** Whether you've listened to each of these since loading the song. */
  heard: { original: boolean; reference: boolean; mono: boolean };
  /** Recent compressor gain reduction (dB), one value per meter report while playing. */
  compGr: readonly number[];
  /** Full-song measurement of the current settings, or null. */
  measured: { integrated: number; truePeak: number; dynamicsOk: boolean } | null;
  exported: boolean;
}

export interface Step {
  key: string;
  label: string;
  done: boolean;
  tip: string;
  /** What's measured right now, if anything. */
  status?: string;
}

const LOUD_PERCENTILE = 0.9;
const IDLE_GR_DB = 0.5;
const SWEET_GR: [number, number] = [1, 4];
const MIN_GR_SAMPLES = 20;

/** Gain reduction on the loud moments: the 90th percentile of recent values. */
function loudGr(gr: readonly number[]): number {
  const sorted = [...gr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * LOUD_PERCENTILE))];
}

function compressStep(gr: readonly number[]): Step {
  const step = {
    key: "compress",
    label: `Compress gently (${SWEET_GR[0]}–${SWEET_GR[1] - 1} dB GR)`,
    tip: "Lower the compressor threshold while playing until GR reads 1–3 dB on the loud parts. The GR trace shows it over time.",
  };
  if (gr.length < MIN_GR_SAMPLES) return { ...step, done: false, status: "play the song to judge" };
  const loud = loudGr(gr);
  const status = `${loud.toFixed(1)} dB on loud moments`;
  if (loud < IDLE_GR_DB) return { ...step, done: false, status: "idle: lower the threshold" };
  if (loud > SWEET_GR[1]) return { ...step, done: false, status: `${status}: ease off` };
  return { ...step, done: loud >= SWEET_GR[0], status };
}

export function checklist(c: ChecklistInput): Step[] {
  const m = c.measured;
  const off = m ? m.integrated - TARGETS.integrated : NaN;
  return [
    {
      key: "reference",
      label: "Pick a reference and listen (r)",
      done: c.hasReference && c.heard.reference,
      tip: "A professionally mastered song in the same style: the yardstick for tone, width and loudness.",
    },
    { key: "ab", label: "A/B against the original (a)", done: c.heard.original, tip: "Flip often: the original plays at the master's loudness, so you hear only what your processing changed." },
    compressStep(c.compGr),
    {
      key: "loudness",
      label: `Loudness ${TARGETS.integrated} ±${TARGETS.integratedTolerance} LUFS (l)`,
      done: !!m && Math.abs(off) <= TARGETS.integratedTolerance,
      tip: "Measure (m) and set limiter Drive; l does it for you.",
      status: m ? `${m.integrated.toFixed(1)} LUFS` : undefined,
    },
    {
      key: "peaks",
      label: `True peak ≤ ${TARGETS.truePeakMax} dBTP`,
      done: !!m && m.truePeak <= TARGETS.truePeakMax,
      tip: "The limiter ceiling keeps peaks safe for mp3/AAC encoding.",
      status: m ? `${m.truePeak.toFixed(1)} dBTP` : undefined,
    },
    { key: "dynamics", label: "Keep the dynamics", done: !!m && m.dynamicsOk, tip: "PLR shouldn't drop much below the original's: loud but lifeless is worse than a little quieter." },
    { key: "mono", label: "Check in mono (o)", done: c.heard.mono, tip: "Phones and club PAs are often mono: make sure nothing important disappears." },
    { key: "export", label: "Export (e)", done: c.exported, tip: "24-bit WAV for the distributor; 16-bit if they ask for CD quality." },
  ];
}
