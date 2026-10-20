/** Every knob on the desk: ranges, defaults, and the mapping to each processing module. */
import type { CompressorParams } from "../dsp/compressor.ts";
import { NEUTRAL_EDGES } from "../dsp/edges.ts";
import type { EdgeParams } from "../dsp/edges.ts";
import type { LimiterParams } from "../dsp/limiter.ts";
import { NEUTRAL_BAND } from "../dsp/multiband.ts";
import type { MultibandParams } from "../dsp/multiband.ts";

/** In signal order. */
export type Module = "eq" | "multi" | "comp" | "limiter" | "edges";
export const MODULES: readonly Module[] = ["eq", "multi", "comp", "limiter", "edges"];
export type Bypass = Record<Module, boolean>;
export const MODULE_NAMES: Record<Module, string> = { eq: "EQ", multi: "Multiband", comp: "Compressor", limiter: "Limiter", edges: "Edges" };

export function noBypass(): Bypass {
  return Object.fromEntries(MODULES.map((m) => [m, false])) as Bypass;
}

export interface ParamSpec {
  key: string;
  module: Module;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  scale: "lin" | "log";
  default: number;
}

export const PARAMS = [
  { key: "eqLowFreq", module: "eq", label: "Low shelf freq", unit: "Hz", min: 30, max: 300, step: 1, scale: "log", default: 100 },
  { key: "eqLowGain", module: "eq", label: "Low shelf gain", unit: "dB", min: -12, max: 12, step: 0.5, scale: "lin", default: 0 },
  { key: "eqMudFreq", module: "eq", label: "Mud freq", unit: "Hz", min: 150, max: 800, step: 1, scale: "log", default: 300 },
  { key: "eqMudGain", module: "eq", label: "Mud gain", unit: "dB", min: -12, max: 12, step: 0.5, scale: "lin", default: 0 },
  { key: "eqMudQ", module: "eq", label: "Mud Q", unit: "", min: 0.3, max: 4, step: 0.1, scale: "lin", default: 1 },
  { key: "eqPresFreq", module: "eq", label: "Presence freq", unit: "Hz", min: 1000, max: 8000, step: 1, scale: "log", default: 3000 },
  { key: "eqPresGain", module: "eq", label: "Presence gain", unit: "dB", min: -12, max: 12, step: 0.5, scale: "lin", default: 0 },
  { key: "eqPresQ", module: "eq", label: "Presence Q", unit: "", min: 0.3, max: 4, step: 0.1, scale: "lin", default: 1 },
  { key: "eqAirFreq", module: "eq", label: "Air shelf freq", unit: "Hz", min: 4000, max: 16000, step: 1, scale: "log", default: 10000 },
  { key: "eqAirGain", module: "eq", label: "Air shelf gain", unit: "dB", min: -12, max: 12, step: 0.5, scale: "lin", default: 0 },
  { key: "eqWidth", module: "eq", label: "Stereo width", unit: "%", min: 0, max: 200, step: 5, scale: "lin", default: 100 },
  { key: "eqMonoBassHz", module: "eq", label: "Mono bass below", unit: "Hz", min: 20, max: 300, step: 1, scale: "log", default: 20 },
  { key: "eqSideAirGain", module: "eq", label: "Side air gain", unit: "dB", min: -6, max: 6, step: 0.5, scale: "lin", default: 0 },
  { key: "mbLowThreshold", module: "multi", label: "Low threshold", unit: "dB", min: -40, max: 0, step: 0.5, scale: "lin", default: 0 },
  { key: "mbLowGain", module: "multi", label: "Low gain", unit: "dB", min: -6, max: 6, step: 0.5, scale: "lin", default: 0 },
  { key: "mbMidThreshold", module: "multi", label: "Mid threshold", unit: "dB", min: -40, max: 0, step: 0.5, scale: "lin", default: 0 },
  { key: "mbMidGain", module: "multi", label: "Mid gain", unit: "dB", min: -6, max: 6, step: 0.5, scale: "lin", default: 0 },
  { key: "mbHighThreshold", module: "multi", label: "High threshold", unit: "dB", min: -40, max: 0, step: 0.5, scale: "lin", default: 0 },
  { key: "mbHighGain", module: "multi", label: "High gain", unit: "dB", min: -6, max: 6, step: 0.5, scale: "lin", default: 0 },
  { key: "mbLowHz", module: "multi", label: "Low/mid split", unit: "Hz", min: 60, max: 500, step: 1, scale: "log", default: 200 },
  { key: "mbHighHz", module: "multi", label: "Mid/high split", unit: "Hz", min: 1000, max: 10000, step: 1, scale: "log", default: 4000 },
  { key: "mbRatio", module: "multi", label: "Ratio", unit: ":1", min: 1, max: 8, step: 0.1, scale: "lin", default: 3 },
  { key: "mbAttack", module: "multi", label: "Attack", unit: "ms", min: 1, max: 100, step: 0.1, scale: "log", default: 20 },
  { key: "mbRelease", module: "multi", label: "Release", unit: "ms", min: 20, max: 1000, step: 1, scale: "log", default: 200 },
  { key: "compThreshold", module: "comp", label: "Threshold", unit: "dB", min: -40, max: 0, step: 0.5, scale: "lin", default: 0 },
  { key: "compRatio", module: "comp", label: "Ratio", unit: ":1", min: 1, max: 10, step: 0.1, scale: "lin", default: 2 },
  { key: "compKnee", module: "comp", label: "Knee", unit: "dB", min: 0, max: 12, step: 0.5, scale: "lin", default: 6 },
  { key: "compAttack", module: "comp", label: "Attack", unit: "ms", min: 0.1, max: 100, step: 0.1, scale: "log", default: 10 },
  { key: "compRelease", module: "comp", label: "Release", unit: "ms", min: 10, max: 1000, step: 1, scale: "log", default: 150 },
  { key: "compMakeup", module: "comp", label: "Makeup", unit: "dB", min: 0, max: 12, step: 0.5, scale: "lin", default: 0 },
  { key: "compSidechainHz", module: "comp", label: "Sidechain HPF", unit: "Hz", min: 20, max: 300, step: 1, scale: "log", default: 20 },
  { key: "compRmsMs", module: "comp", label: "Detector", unit: "ms", min: 0, max: 100, step: 5, scale: "lin", default: 0 },
  { key: "limDrive", module: "limiter", label: "Drive", unit: "dB", min: -12, max: 12, step: 0.1, scale: "lin", default: 0 },
  { key: "limCeiling", module: "limiter", label: "Ceiling", unit: "dBTP", min: -3, max: 0, step: 0.1, scale: "lin", default: -1 },
  { key: "limRelease", module: "limiter", label: "Release", unit: "ms", min: 10, max: 500, step: 1, scale: "log", default: 50 },
  { key: "edgeLeadMs", module: "edges", label: "Lead-in", unit: "ms", min: 0, max: 2000, step: 10, scale: "lin", default: 0 },
  { key: "edgeFadeInMs", module: "edges", label: "Fade-in", unit: "ms", min: 0, max: 200, step: 1, scale: "lin", default: 0 },
  { key: "edgeFadeOutMs", module: "edges", label: "Fade-out", unit: "ms", min: 0, max: 10000, step: 10, scale: "lin", default: 0 },
  { key: "edgeTailMs", module: "edges", label: "Tail", unit: "ms", min: 0, max: 5000, step: 10, scale: "lin", default: 0 },
] as const satisfies readonly ParamSpec[];

export type ParamKey = (typeof PARAMS)[number]["key"];
export type Settings = Record<ParamKey, number>;

const SPECS = new Map<string, ParamSpec>(PARAMS.map((p) => [p.key, p]));

export function defaultSettings(): Settings {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.default])) as Settings;
}

export function clampParam(key: ParamKey, value: number): number {
  const p = spec(key);
  if (!Number.isFinite(value)) return p.default;
  const clamped = Math.min(p.max, Math.max(p.min, value));
  if (p.scale === "log") return clamped;
  // toFixed drops the float noise of step multiples (0.1 * 12 = 1.2000000000000002); + 0 turns -0 into 0.
  const decimals = Math.max(0, -Math.floor(Math.log10(p.step)));
  return Number((Math.round(clamped / p.step) * p.step).toFixed(decimals)) + 0;
}

function spec(key: ParamKey): ParamSpec {
  const s = SPECS.get(key);
  if (!s) throw new RangeError(`unknown param ${key}`);
  return s;
}

/** Knob position 0..1 (log params are spread evenly in octaves). */
export function toFraction(key: ParamKey, value: number): number {
  const { min, max, scale } = spec(key);
  return scale === "log" ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
}

export function fromFraction(key: ParamKey, fraction: number): number {
  const { min, max, scale } = spec(key);
  const f = Math.min(1, Math.max(0, fraction));
  return clampParam(key, scale === "log" ? min * (max / min) ** f : min + f * (max - min));
}

/** One knob turn is 1/40 of the range; `steps` may be fractional (fine) and always moves at least one step. */
export const NUDGES_PER_RANGE = 40;

export function nudge(key: ParamKey, value: number, steps: number): number {
  const p = spec(key);
  if (p.scale === "log") return fromFraction(key, toFraction(key, value) + steps / NUDGES_PER_RANGE);
  const next = clampParam(key, value + (steps * (p.max - p.min)) / NUDGES_PER_RANGE);
  return next === clampParam(key, value) && steps !== 0 ? clampParam(key, value + Math.sign(steps) * p.step) : next;
}

/** Sidechain filter and mono bass at or below these are treated as off. */
export const SIDECHAIN_OFF_HZ = 20;
export const MONO_BASS_OFF_HZ = 20;
/** A multiband threshold at the top of its range leaves that band uncompressed. */
export const MB_OFF_DB = 0;
export const MB_THRESHOLDS = ["mbLowThreshold", "mbMidThreshold", "mbHighThreshold"] as const;
export const MB_GAINS = ["mbLowGain", "mbMidGain", "mbHighGain"] as const;
export const EDGE_KEYS = ["edgeLeadMs", "edgeFadeInMs", "edgeFadeOutMs", "edgeTailMs"] as const;
type EdgeKey = (typeof EDGE_KEYS)[number];

export function formatParam(key: ParamKey, value: number): string {
  const { unit, min } = spec(key);
  if (key === "compSidechainHz" && value <= SIDECHAIN_OFF_HZ) return "off";
  if (key === "eqMonoBassHz" && value <= MONO_BASS_OFF_HZ) return "off";
  if ((MB_THRESHOLDS as readonly string[]).includes(key) && value >= MB_OFF_DB) return "off";
  if (key === "compRmsMs") return value <= 0 ? "peak" : `RMS ${Math.round(value)} ms`;
  if (EDGE_KEYS.includes(key as EdgeKey) && value <= 0) return "off";
  if (unit === "%") return value === 0 ? "mono" : `${Math.round(value)}%`;
  if (unit === "Hz") return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
  if (unit === "ms" && value > 1000) return `${(value / 1000).toFixed(1)} s`;
  if (unit === "ms") return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
  const text = value.toFixed(1);
  const signed = min < 0 && value > 0 ? `+${text}` : text;
  return unit === ":1" ? `${signed}:1` : unit ? `${signed} ${unit}` : signed;
}

/** Validates settings from an untrusted source (URL, storage): unknown keys and non-numbers are dropped. */
export function parseSettings(input: unknown): Settings {
  const out = defaultSettings();
  if (typeof input !== "object" || input === null) return out;
  for (const [key, value] of Object.entries(input)) {
    if (SPECS.has(key) && typeof value === "number") out[key as ParamKey] = clampParam(key as ParamKey, value);
  }
  return out;
}

export function changedParams(a: Settings, b: Settings): ParamKey[] {
  return PARAMS.filter((p) => a[p.key] !== b[p.key]).map((p) => p.key);
}

export interface EqBand {
  type: "lowshelf" | "peaking" | "highshelf";
  frequency: number;
  gain: number;
  q: number;
}

export function eqBands(s: Settings, bypass: Bypass): EqBand[] {
  const g = (db: number): number => (bypass.eq ? 0 : db);
  return [
    { type: "lowshelf", frequency: s.eqLowFreq, gain: g(s.eqLowGain), q: 1 },
    { type: "peaking", frequency: s.eqMudFreq, gain: g(s.eqMudGain), q: s.eqMudQ },
    { type: "peaking", frequency: s.eqPresFreq, gain: g(s.eqPresGain), q: s.eqPresQ },
    { type: "highshelf", frequency: s.eqAirFreq, gain: g(s.eqAirGain), q: 1 },
  ];
}

/**
 * Mid/side stage: the side (L−R) is high-passed at `monoBassHz` (0 = off), shelved by `sideAirDb` above `sideAirHz`
 * and scaled by `side`; the mid is untouched.
 */
export interface StereoParams {
  side: number;
  monoBassHz: number;
  sideAirHz: number;
  sideAirDb: number;
}

/** Web Audio takes Q in dB for highpass/lowpass: Butterworth (Q 0.707, no bump at the cutoff) is -3.01 dB. */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

export function stereoParams(s: Settings, bypass: Bypass): StereoParams {
  if (bypass.eq) return { side: 1, monoBassHz: 0, sideAirHz: s.eqAirFreq, sideAirDb: 0 };
  return {
    side: s.eqWidth / 100,
    monoBassHz: s.eqMonoBassHz <= MONO_BASS_OFF_HZ ? 0 : s.eqMonoBassHz,
    sideAirHz: s.eqAirFreq,
    sideAirDb: s.eqSideAirGain,
  };
}

export function compressorParams(s: Settings, bypass: Bypass): CompressorParams {
  return {
    thresholdDb: s.compThreshold,
    ratio: bypass.comp ? 1 : s.compRatio,
    kneeDb: s.compKnee,
    attackMs: s.compAttack,
    releaseMs: s.compRelease,
    makeupDb: bypass.comp ? 0 : s.compMakeup,
    sidechainHz: s.compSidechainHz <= SIDECHAIN_OFF_HZ ? 0 : s.compSidechainHz,
    rmsMs: s.compRmsMs,
  };
}

export function multibandParams(s: Settings, bypass: Bypass): MultibandParams {
  const bands = MB_THRESHOLDS.map((t, i) =>
    bypass.multi ? NEUTRAL_BAND : { thresholdDb: s[t] >= MB_OFF_DB ? Infinity : s[t], gainDb: s[MB_GAINS[i]] },
  );
  return { lowHz: s.mbLowHz, highHz: s.mbHighHz, bands, ratio: s.mbRatio, attackMs: s.mbAttack, releaseMs: s.mbRelease };
}

export function edgeParams(s: Settings, bypass: Bypass): EdgeParams {
  if (bypass.edges) return NEUTRAL_EDGES;
  return { lead: s.edgeLeadMs / 1000, fadeIn: s.edgeFadeInMs / 1000, fadeOut: s.edgeFadeOutMs / 1000, tail: s.edgeTailMs / 1000 };
}

/** A bypassed limiter keeps its delay (so A/B stays time-aligned) but never touches the signal. */
export function limiterParams(s: Settings, bypass: Bypass): LimiterParams {
  return bypass.limiter
    ? { driveDb: 0, ceilingDb: Infinity, releaseMs: s.limRelease }
    : { driveDb: s.limDrive, ceilingDb: s.limCeiling, releaseMs: s.limRelease };
}
