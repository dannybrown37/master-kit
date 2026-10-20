/** Plain-language suggestions from the measured master, the settings and (optionally) a reference track. */
import type { Report } from "../analysis/report.ts";
import { relativeGaps } from "../analysis/spectrum.ts";
import { TARGETS } from "../analysis/targets.ts";
import { PARAMS, SIDECHAIN_OFF_HZ, defaultSettings, formatParam } from "./settings.ts";
import type { Bypass, ParamKey, Settings } from "./settings.ts";

export type HintLevel = "bad" | "warn" | "info" | "good";

export interface Hint {
  level: HintLevel;
  text: string;
  knob?: ParamKey;
  /** Suggested change to `knob`, in its unit (dB for gains). */
  suggest?: number;
}

export interface HintInput {
  original: Report;
  /** Full-song measurement of the current settings; null if not measured yet. */
  master: Report | null;
  settings: Settings;
  bypass: Bypass;
  reference?: Report | null;
}

const ORDER: Record<HintLevel, number> = { bad: 0, warn: 1, info: 2, good: 3 };
const PLR_DROP_DB = 3;
const LRA_DROP_LU = 3;
const MAX_RATIO = 4;
const MIN_ATTACK_MS = 3;
const BIG_EQ_DB = 6;
const BAND_GAP_DB = 2;
const BAND_GAP_LOUD_DB = 4;
const MAX_EQ_SUGGESTION_DB = 3;
const MAX_TONE_HINTS = 3;
const WIDE_CORRELATION = 0.2;
const MAX_WIDTH = 150;
const WIDTH_GAP_DB = 4;
const MAX_WIDTH_SUGGESTION = 50;
const WIDTH_STEP = 5;
const EQ_STEP_DB = 0.5;
const SUB_DUCK_DB = 2;
const SIDECHAIN_SUGGEST_HZ = 100;

const BAND_KNOBS: Record<string, { knob: ParamKey; where: string }> = {
  sub: { knob: "eqLowGain", where: "low shelf (freq ~60 Hz)" },
  low: { knob: "eqLowGain", where: "low shelf (freq ~150 Hz)" },
  mud: { knob: "eqMudGain", where: "mud band (freq ~350 Hz)" },
  mid: { knob: "eqPresGain", where: "presence band (freq ~1 kHz)" },
  presence: { knob: "eqPresGain", where: "presence band (freq ~3.5 kHz)" },
  air: { knob: "eqAirGain", where: "air shelf" },
};

const LABELS = new Map<string, string>(PARAMS.map((p) => [p.key, p.label]));
const DEFAULTS = defaultSettings();
const f1 = (x: number): string => x.toFixed(1);

function loudnessHints(m: Report, bypass: Bypass): Hint[] {
  const out: Hint[] = [];
  const off = m.integrated - TARGETS.integrated;
  if (off > TARGETS.integratedTolerance) {
    out.push({
      level: "bad",
      text: `${f1(off)} LU louder than ${TARGETS.integrated} LUFS: streaming will turn it down ${f1(off)} dB anyway, so the extra limiting only costs punch. Lower Drive (l sets it exactly).`,
      knob: "limDrive",
      suggest: -off,
    });
  } else if (off < -TARGETS.integratedTolerance) {
    out.push({
      level: "warn",
      text: `${f1(-off)} LU quieter than ${TARGETS.integrated} LUFS: raise Drive (the limiter catches the peaks; l sets it exactly).`,
      knob: "limDrive",
      suggest: -off,
    });
  }
  if (m.truePeak > TARGETS.truePeakMax) {
    out.push(
      bypass.limiter
        ? { level: "bad", text: `True peak ${f1(m.truePeak)} dBTP is over ${TARGETS.truePeakMax}: the limiter is bypassed, turn it on (b on the limiter).` }
        : { level: "bad", text: `True peak ${f1(m.truePeak)} dBTP is over ${TARGETS.truePeakMax}: lower the ceiling.`, knob: "limCeiling", suggest: TARGETS.truePeakMax - m.truePeak },
    );
  }
  return out;
}

function dynamicsHints(o: Report, m: Report): Hint[] {
  const out: Hint[] = [];
  const plrDrop = o.plr - m.plr;
  if (plrDrop > PLR_DROP_DB) {
    out.push({
      level: "warn",
      text: `PLR fell ${f1(plrDrop)} dB (${f1(o.plr)} → ${f1(m.plr)}): the peaks are being squashed. Back off Drive or the compressor, and A/B for lost punch.`,
      knob: "limDrive",
    });
  }
  const lraDrop = o.loudnessRange - m.loudnessRange;
  if (lraDrop > LRA_DROP_LU) {
    out.push({
      level: "warn",
      text: `LRA fell ${f1(lraDrop)} LU: quiet and loud sections now sit at nearly the same level. Raise the compressor threshold or lower the ratio.`,
      knob: "compThreshold",
    });
  }
  return out;
}

function compressorWorking(o: Report, s: Settings, bypass: Bypass): boolean {
  return !bypass.comp && s.compRatio > 1 && s.compThreshold < o.samplePeak - 1;
}

/** Shift of each band from original to master, minus the median shift (bands are shares of the total). */
function bandShifts(o: Report, m: Report): Map<string, number> {
  const gaps = relativeGaps(m.bands.map((b) => b.db), o.bands.map((b) => b.db));
  return new Map(m.bands.map((band, i) => [band.key, gaps[i]]));
}

/** Kick and bass drive a full-band detector, so the compressor turns the low end down on every hit. */
function duckingHint(o: Report, m: Report, s: Settings, bypass: Bypass): Hint[] {
  if (!compressorWorking(o, s, bypass) || s.compSidechainHz > SIDECHAIN_OFF_HZ || s.eqLowGain < 0) return [];
  const lost = -(bandShifts(o, m).get("sub") ?? 0);
  if (!(lost >= SUB_DUCK_DB)) return [];
  return [
    {
      level: "warn",
      text: `Sub lost ${f1(lost)} dB against the rest of the spectrum: kick and bass drive the compressor, so it ducks them on every hit (pumping). Set Sidechain HPF to ~${SIDECHAIN_SUGGEST_HZ} Hz.`,
      knob: "compSidechainHz",
      suggest: SIDECHAIN_SUGGEST_HZ - s.compSidechainHz,
    },
  ];
}

function settingHints(o: Report, s: Settings, bypass: Bypass): Hint[] {
  const out: Hint[] = [];
  if (!bypass.comp) {
    const touched = (["compRatio", "compKnee", "compAttack", "compRelease", "compMakeup", "compSidechainHz"] as const).some((k) => s[k] !== DEFAULTS[k]);
    if (touched && s.compRatio > 1 && s.compThreshold >= o.samplePeak - 1) {
      out.push({
        level: "info",
        text: `The compressor is idle: the song never reaches the threshold (${f1(s.compThreshold)} dB vs peaks at ${f1(o.samplePeak)} dBFS). Lower it until GR shows 1–3 dB.`,
        knob: "compThreshold",
      });
    }
    if (s.compRatio > MAX_RATIO) {
      out.push({ level: "warn", text: `Ratio ${f1(s.compRatio)}:1 is heavy for a master; 1.5–3:1 keeps it musical.`, knob: "compRatio" });
    }
    if (s.compAttack < MIN_ATTACK_MS) {
      out.push({ level: "warn", text: `Attack ${f1(s.compAttack)} ms flattens drum hits; 10–30 ms lets the transients through.`, knob: "compAttack" });
    }
  }
  if (!bypass.eq) {
    for (const k of ["eqLowGain", "eqMudGain", "eqPresGain", "eqAirGain"] as const) {
      if (Math.abs(s[k]) >= BIG_EQ_DB) {
        out.push({ level: "warn", text: `${LABELS.get(k)} ${formatParam(k, s[k])} is a big move for mastering; ±1–2 dB is usually plenty.`, knob: k });
      }
    }
    if (s.eqWidth >= MAX_WIDTH) {
      out.push({ level: "warn", text: `Stereo width ${formatParam("eqWidth", s.eqWidth)} is a lot: wide masters sound phasey and lose their centre in mono. 100–130% is the safe zone.`, knob: "eqWidth" });
    }
  }
  return out;
}

function stereoHints(m: Report): Hint[] {
  const c = m.stereo.correlation;
  if (!Number.isFinite(c)) return [];
  if (c < 0) {
    return [{ level: "bad", text: `Correlation ${c.toFixed(2)}: left and right are partly out of phase, so parts of the song cancel in mono (phones, club PAs). Listen in mono (o) and narrow it.`, knob: "eqWidth" }];
  }
  if (c < WIDE_CORRELATION) {
    return [{ level: "info", text: `Correlation ${c.toFixed(2)}: very wide. Check that nothing important vanishes in mono (o).`, knob: "eqWidth" }];
  }
  return [];
}

/** Width vs the reference, as a width-knob move: side level scales with the knob, so a gap of g dB is a factor 10^(-g/20). */
function widthHint(m: Report, ref: Report, s: Settings): Hint[] {
  const gap = m.stereo.sideDb - ref.stereo.sideDb;
  if (!Number.isFinite(gap) || Math.abs(gap) < WIDTH_GAP_DB) return [];
  const target = s.eqWidth * 10 ** (-gap / 20);
  // Stop short of the "too wide" warning, so following one hint never triggers another.
  const room = MAX_WIDTH - WIDTH_STEP - s.eqWidth;
  const suggest = Math.max(-MAX_WIDTH_SUGGESTION, Math.min(MAX_WIDTH_SUGGESTION, room, target - s.eqWidth));
  if (gap < 0 && suggest <= 0) {
    return [
      {
        level: "info",
        text: `Stereo: narrower than the reference (side ${f1(m.stereo.sideDb)} dB vs ${f1(ref.stereo.sideDb)} dB), but Stereo width is already ${formatParam("eqWidth", s.eqWidth)}: more would sound phasey. Widen it in the mix instead.`,
        knob: "eqWidth",
      },
    ];
  }
  return [
    {
      level: "info",
      text: `Stereo: ${gap > 0 ? "wider" : "narrower"} than the reference: side ${f1(m.stereo.sideDb)} dB vs ${f1(ref.stereo.sideDb)} dB under the mid. Try Stereo width ${suggest > 0 ? "+" : ""}${Math.round(suggest)}% (and check mono with o).`,
      knob: "eqWidth",
      suggest,
    },
  ];
}

function referenceHints(m: Report, ref: Report, s: Settings): Hint[] {
  const gaps = relativeGaps(m.bands.map((b) => b.db), ref.bands.map((b) => b.db));
  const ranked = m.bands
    .map((band, i) => ({ band, gap: gaps[i] }))
    .filter(({ band, gap }) => BAND_KNOBS[band.key] && Math.abs(gap) >= BAND_GAP_DB)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, MAX_TONE_HINTS);
  const out: Hint[] = [];
  for (const { band, gap } of ranked) {
    const map = BAND_KNOBS[band.key];
    const current = s[map.knob];
    // Stop short of the "big EQ move" warning, so following one hint never triggers another.
    const room = BIG_EQ_DB - EQ_STEP_DB;
    const suggest = Math.max(-MAX_EQ_SUGGESTION_DB, -room - current, Math.min(MAX_EQ_SUGGESTION_DB, room - current, -gap / 2));
    const level = Math.abs(gap) >= BAND_GAP_LOUD_DB ? "warn" : "info";
    const what = `${band.label}: ${f1(Math.abs(gap))} dB ${gap > 0 ? "heavier" : "lighter"} than the reference, relative to the rest of the spectrum.`;
    if (Math.abs(suggest) < EQ_STEP_DB || Math.sign(suggest) !== Math.sign(-gap)) {
      out.push({ level, text: `${what} The ${map.where} is already at ${formatParam(map.knob, current)}: more EQ would sound forced, so fix it in the mix.`, knob: map.knob });
      continue;
    }
    out.push({ level, text: `${what} Try the ${map.where} ${suggest > 0 ? "+" : ""}${f1(suggest)} dB.`, knob: map.knob, suggest });
  }
  return out;
}

export function hints(input: HintInput): Hint[] {
  const { original, master, settings, bypass, reference } = input;
  const out: Hint[] = [...settingHints(original, settings, bypass)];
  if (!master) {
    out.push({ level: "info", text: "Press m to measure the whole song; hints about loudness, peaks and tone need a full-song measurement." });
  } else {
    out.push(...loudnessHints(master, bypass), ...dynamicsHints(original, master), ...duckingHint(original, master, settings, bypass), ...stereoHints(master));
    if (reference) out.push(...referenceHints(master, reference, settings), ...widthHint(master, reference, settings));
    if (!out.some((h) => h.level === "bad" || h.level === "warn")) {
      out.push({
        level: "good",
        text: `On target: ${f1(master.integrated)} LUFS, ${f1(master.truePeak)} dBTP, dynamics kept. Now trust your ears: A/B it${reference ? " and against the reference (r)" : ""}.`,
      });
    }
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
