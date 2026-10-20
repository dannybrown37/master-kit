/**
 * Auto-master: a first master planned from the song's own measurements (and a reference, if any), with a reason for
 * every move. The plan is deliberately gentle: half of each tonal gap, a little glue, nothing past what the hints
 * warn about. Limiter Drive is left to a render loop (`matchLoudness`), the only way to know the final loudness.
 */
import type { Report } from "../analysis/report.ts";
import { ANALYSER_TILT_DB_PER_OCT, BANDS, relativeGaps, tiltedShares } from "../analysis/spectrum.ts";
import { TARGETS } from "../analysis/targets.ts";
import { genre } from "./genres.ts";
import type { GenreKey } from "./genres.ts";
import { EDGE_RULES, TAME_RULES, harshResonances, hardEdges } from "./hints.ts";
import { GENTLE_GLUE, applyPreset } from "./presets.ts";
import { STYLE_INFO, applyTaste } from "./shootout.ts";
import { CLIP_OFF_DB, MB_OFF_DB, MB_THRESHOLDS, MONO_BASS_OFF_HZ, clampParam, defaultSettings, formatParam, noBypass } from "./settings.ts";
import type { Bypass, ParamKey, Settings } from "./settings.ts";

export interface PlanInput {
  original: Report;
  reference?: Report | null;
  genre?: GenreKey;
  /** Shootout taste, -1 (gentle) … +1 (punchy); see `tasteLean`. */
  taste?: number;
}

export interface Plan {
  settings: Settings;
  bypass: Bypass;
  /** One line per decision: what was set and why. */
  steps: string[];
}

/** A tonal gap smaller than this is taste, not a problem. */
const EQ_ACT_DB = 2;
/** A band this much lighter than the target is treated as absent, not as something to boost. */
const MISSING_DB = 10;
/** From this gap the band's level is also controlled dynamically (multiband), and the EQ does less. */
const MULTIBAND_ACT_DB = 4;
/** Largest EQ move: a reference is a trustworthy target, a generic curve less so. */
const EQ_CAP_REFERENCE_DB = 3;
const EQ_CAP_GENERIC_DB = 2;
/** Below this PLR the mix is already dense: more compression only flattens it. */
const DENSE_PLR_DB = 9;
const WIDTH_GAP_DB = 4;
const WIDTH_RANGE: [number, number] = [70, 130];
const OUT_OF_PHASE_WIDTH = 80;
const MB_RATIO = 2.5;
const MB_HIGH_SPLIT_HZ = 5000;
/** Easing compression for dynamics: the glue drops to this ratio, thresholds rise this much. */
const EASED_RATIO = 1.5;
const EASE_DB = 3;

const f1 = (x: number): string => x.toFixed(1);
const signedDb = (x: number): string => `${x > 0 ? "+" : ""}${f1(x)} dB`;
const heavy = (gap: number): string => `${signedDb(gap)} ${gap > 0 ? "heavy" : "light"}`;

function bandIndex(key: string): number {
  return BANDS.findIndex((b) => b.key === key);
}

/** Power sum of bands, as a share in dB. */
function shareOf(r: Report, keys: string[]): number {
  return 10 * Math.log10(keys.reduce((sum, k) => sum + 10 ** (r.bands[bandIndex(k)].db / 10), 0));
}

export function planMaster(input: PlanInput): Plan {
  const plan = basePlan(input);
  const lean = input.taste ?? 0;
  if (Math.abs(lean) < 0.05) return plan;
  const style = lean > 0 ? "punchy" : "gentle";
  return {
    ...plan,
    settings: applyTaste(plan.settings, lean),
    steps: [...plan.steps, `Taste: your shootout picks lean ${style} (${Math.round(Math.abs(lean) * 100)}%), so this plan moves that far toward ${style}: ${STYLE_INFO[style]}.`],
  };
}

function basePlan({ original: o, reference: ref = null, genre: genreKey = "generic" }: PlanInput): Plan {
  const s = defaultSettings();
  const bypass = noBypass();
  const steps: string[] = [];
  const set = (key: ParamKey, value: number): number => (s[key] = clampParam(key, value));
  const g = genre(genreKey);
  steps.push(`Genre: ${g.label}: ${g.why}.`);

  const target = ref ? ref.bands.map((b) => b.db) : tiltedShares(ANALYSER_TILT_DB_PER_OCT).map((db, i) => db + g.tone[i]);
  const gaps = relativeGaps(
    o.bands.map((b) => b.db),
    target,
  );
  const styled = g.tone.some((x) => x !== 0) ? ` shaped for ${g.label}` : "";
  const against = ref ? "the reference" : `a balanced spectrum${styled} (a reference gives a better target)`;
  const cap = ref ? EQ_CAP_REFERENCE_DB : EQ_CAP_GENERIC_DB;
  steps.push(`Tone vs ${against}: ${o.bands.map((b, i) => `${b.label} ${signedDb(gaps[i])}`).join(", ")}.`);
  // A band this far under the target is (nearly) empty: a boost there only lifts rumble or hiss.
  const missing = new Set(BANDS.filter((_, i) => gaps[i] <= -MISSING_DB).map((b) => b.key));
  for (const b of BANDS.filter((x) => missing.has(x.key))) {
    steps.push(`${b.label}: almost nothing there (${signedDb(gaps[bandIndex(b.key)])}): EQ can't add what isn't in the mix, so it's left alone.`);
  }
  const gap = (key: string): number => (missing.has(key) ? 0 : gaps[bandIndex(key)]);
  const meanGap = (keys: string[]): number => {
    const present = keys.filter((k) => !missing.has(k));
    return present.length ? present.reduce((sum, k) => sum + gap(k), 0) / present.length : 0;
  };
  const lowGap = meanGap(["sub", "low"]);
  const highGap = meanGap(["presence", "air"]);

  // Multiband: a band that's far too heavy usually is so on its loud notes; compressing it there keeps the rest intact.
  // The threshold sits at the band's average level (overall RMS + its share), so only its louder moments are turned down.
  const rms = o.samplePeak - o.crest;
  const multiband = { low: lowGap >= MULTIBAND_ACT_DB, high: highGap >= MULTIBAND_ACT_DB };
  if (multiband.low || multiband.high) {
    set("mbRatio", MB_RATIO);
    if (multiband.high) set("mbHighHz", MB_HIGH_SPLIT_HZ);
  }
  for (const [band, keys, knob, what] of [
    ["low", ["sub", "low"], "mbLowThreshold", "the kick and bass"],
    ["high", ["presence", "air"], "mbHighThreshold", "cymbals and sibilance"],
  ] as const) {
    if (!multiband[band]) continue;
    const t = set(knob, Math.min(MB_OFF_DB - 0.5, rms + shareOf(o, [...keys])));
    const g = band === "low" ? lowGap : highGap;
    steps.push(`Multiband: the ${band} band is ${heavy(g)}, so it's compressed ${formatParam("mbRatio", s.mbRatio)} above ${formatParam(knob, t)} (its average level): ${what} come down on their loudest notes only.`);
  }

  // EQ: half the gap (the rest is taste or the mix's job), less where the multiband already acts.
  const eqMove = (g: number, shared: boolean): number => {
    if (Math.abs(g) < EQ_ACT_DB) return 0;
    const move = Math.max(-cap, Math.min(cap, -g / (shared ? 4 : 2)));
    return Math.round(move * 2) / 2;
  };
  const lowShelfHz = gap("sub") - gap("low") > 3 ? 60 : gap("low") - gap("sub") > 3 ? 150 : 100;
  const moves: { knob: ParamKey; name: string; gap: number; shared: boolean; freq?: [ParamKey, number] }[] = [
    { knob: "eqLowGain", name: "low shelf", gap: lowGap, shared: multiband.low, freq: ["eqLowFreq", lowShelfHz] },
    { knob: "eqMudGain", name: "mud band", gap: gap("mud"), shared: false, freq: ["eqMudFreq", 350] },
    { knob: "eqPresGain", name: "presence band", gap: gap("presence"), shared: multiband.high, freq: ["eqPresFreq", 3500] },
    { knob: "eqAirGain", name: "air shelf", gap: gap("air"), shared: multiband.high },
  ];
  let flat = true;
  for (const { knob, name, gap: g, shared, freq } of moves) {
    const move = eqMove(g, shared);
    if (move === 0) continue;
    flat = false;
    set(knob, move);
    if (freq) set(...freq);
    const at = freq ? ` at ${formatParam(freq[0], s[freq[0]])}` : "";
    const share = shared ? "a quarter of the gap; the multiband does the rest" : `half the gap, at most ${cap} dB: mastering EQ stays gentle`;
    steps.push(`EQ: ${name} ${formatParam(knob, s[knob])}${at} for a ${heavy(g)} range (${share}).`);
  }
  if (flat) steps.push(`EQ: flat. No band is ${EQ_ACT_DB} dB or more off, so the tone is left to the mix.`);

  // Stereo.
  set("eqMonoBassHz", g.monoBassHz);
  steps.push(
    g.monoBassHz > MONO_BASS_OFF_HZ
      ? `Stereo: bass below ${formatParam("eqMonoBassHz", s.eqMonoBassHz)} to mono. Nobody hears direction down there, and it keeps the low end solid on club systems.`
      : `Stereo: bass left in stereo, as recorded (${g.label}).`,
  );
  const sideGap = ref ? o.stereo.sideDb - ref.stereo.sideDb : NaN;
  if (Number.isFinite(sideGap) && Math.abs(sideGap) >= WIDTH_GAP_DB) {
    const width = Math.max(WIDTH_RANGE[0], Math.min(WIDTH_RANGE[1], Math.round((100 * 10 ** (-sideGap / 20)) / 5) * 5));
    set("eqWidth", width);
    steps.push(`Stereo: ${sideGap > 0 ? "wider" : "narrower"} than the reference (side ${f1(o.stereo.sideDb)} vs ${f1(ref?.stereo.sideDb ?? NaN)} dB) → width ${formatParam("eqWidth", s.eqWidth)}.`);
  } else if (!ref && o.stereo.correlation < 0) {
    set("eqWidth", OUT_OF_PHASE_WIDTH);
    steps.push(`Stereo: correlation ${o.stereo.correlation.toFixed(2)} means parts cancel in mono → width ${formatParam("eqWidth", s.eqWidth)}.`);
  }

  // Glue compression.
  if (g.glue === "none") {
    steps.push(`Compressor: off. In ${g.label} the dynamics are the point; the limiter only catches peaks.`);
  } else if (o.plr < DENSE_PLR_DB) {
    steps.push(`Compressor: off. PLR is already ${f1(o.plr)} dB (dense); more compression would only flatten it.`);
  } else {
    const glue = applyPreset(GENTLE_GLUE, o.integrated);
    for (const key of Object.keys(glue) as ParamKey[]) if (key.startsWith("comp")) set(key, glue[key]);
    steps.push(`Compressor: gentle glue (${formatParam("compRatio", s.compRatio)}, RMS, slow attack, sidechain ${formatParam("compSidechainHz", s.compSidechainHz)}), threshold ${formatParam("compThreshold", s.compThreshold)}: 3 dB under the song's loudness, so it rides the loud parts by 1–3 dB.`);
  }

  steps.push(...planTamer(o, set));

  set("colorWarmth", g.warmth);
  set("colorClipDb", g.clipDb);
  if (g.warmth > 0 || g.clipDb < CLIP_OFF_DB) {
    const parts = [g.warmth > 0 ? `warmth ${formatParam("colorWarmth", s.colorWarmth)}` : "", g.clipDb < CLIP_OFF_DB ? `soft clip ${formatParam("colorClipDb", s.colorClipDb)} above the limiter` : ""];
    steps.push(`Color: ${parts.filter(Boolean).join(", ")} (${g.label}).`);
  }

  set("limCeiling", TARGETS.truePeakMax);
  set("limDrive", TARGETS.integrated - o.integrated);
  steps.push(`Limiter: ceiling ${formatParam("limCeiling", s.limCeiling)} (safe for mp3/AAC encoding).`);
  steps.push(...planEdges(o, set));
  return { settings: s, bypass, steps };
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Nearest equal-tempered note (A4 = 440 Hz), e.g. 392 → "G4". */
export function noteName(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function planTamer(o: Report, set: (key: ParamKey, value: number) => number): string[] {
  const steps: string[] = [];
  const harsh = harshResonances(o).slice(0, 2);
  harsh.forEach((r, i) => {
    set(i === 0 ? "tameFreq1" : "tameFreq2", r.hz);
    set(i === 0 ? "tameDepth1" : "tameDepth2", TAME_RULES.depthDb);
  });
  if (harsh.length) {
    const list = harsh.map((r) => `${formatParam("tameFreq1", r.hz)} (+${f1(r.prominenceDb)} dB)`).join(" and ");
    const one = harsh.length === 1;
    steps.push(`Tamer: ${list} ${one ? "rings" : "ring"} out of the spectrum around ${one ? "it" : "them"} → up to ${TAME_RULES.depthDb} dB cut, only while ${one ? "it sticks" : "they stick"} out.`);
  }
  const notes = o.resonances.filter((r) => r.hz < TAME_RULES.loHz && r.prominenceDb >= TAME_RULES.minProminenceDb);
  if (notes.length) {
    steps.push(`Tamer: peaks at ${notes.map((r) => `${Math.round(r.hz)} Hz (${noteName(r.hz)})`).join(", ")} are most likely the song's own notes, so they're left alone.`);
  }
  return steps;
}

function planEdges(o: Report, set: (key: ParamKey, value: number) => number): string[] {
  const r = EDGE_RULES;
  const hard = hardEdges(o);
  const steps: string[] = [];
  if (hard.start) {
    if (o.edges.leadSeconds < r.minLeadSeconds) set("edgeLeadMs", r.leadMs);
    set("edgeFadeInMs", r.fadeInMs);
    steps.push(`Edges: the song hits ${f1(o.edges.startDb)} dBFS right away → ${r.fadeInMs} ms fade-in (no click)${o.edges.leadSeconds < r.minLeadSeconds ? ` and ${r.leadMs} ms of silence first, so a player waking up can't swallow the first hit` : ""}.`);
  }
  if (hard.end) {
    set("edgeFadeOutMs", r.fadeOutMs);
    steps.push(`Edges: it stops on a hard cut (${f1(o.edges.endDb)} dBFS) → ${r.fadeOutMs} ms fade-out, so the ending stays abrupt but doesn't click. For a fade to silence, set Fade-out to a few seconds.`);
  }
  if (o.edges.tailSeconds < r.minTailSeconds) {
    set("edgeTailMs", r.tailMs);
    steps.push(`Edges: ${formatParam("edgeTailMs", r.tailMs)} of silence after the last sound, so the next track doesn't crash in.`);
  }
  return steps;
}

/** Softer dynamics for when the master lost too much PLR: the glue compressor first, then the multiband. Null: nothing left to ease. */
export function easeDynamics(s: Settings): Settings | null {
  if (s.compRatio > EASED_RATIO && s.compThreshold < 0) {
    return { ...s, compRatio: EASED_RATIO, compThreshold: clampParam("compThreshold", s.compThreshold + EASE_DB) };
  }
  if (MB_THRESHOLDS.some((k) => s[k] < MB_OFF_DB)) {
    const out = { ...s };
    for (const k of MB_THRESHOLDS) if (s[k] < MB_OFF_DB) out[k] = clampParam(k, Math.min(MB_OFF_DB, s[k] + EASE_DB));
    return out;
  }
  return null;
}
