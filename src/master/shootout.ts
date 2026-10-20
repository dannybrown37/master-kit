/**
 * Blind shootout: three versions of an auto-master plan (gentle, balanced, punchy), heard in a random order at the
 * same loudness; you pick by ear. Picks add up to a taste that leans later auto-masters toward what you chose.
 */
import { COLOR_RULES } from "./hints.ts";
import { CLIP_OFF_DB, MB_OFF_DB, MB_THRESHOLDS, PARAMS, clampParam } from "./settings.ts";
import type { ParamKey, Settings } from "./settings.ts";

export type Style = "gentle" | "balanced" | "punchy";
export const STYLES: readonly Style[] = ["gentle", "balanced", "punchy"];
export const STYLE_INFO: Record<Style, string> = {
  gentle: "half the EQ, softer glue, no clipping: closest to the mix",
  balanced: "the auto-master plan as is",
  punchy: "more clipping and warmth, slower attack: denser, hits harder",
};

export type Taste = Record<Style, number>;

const EQ_GAINS = ["eqLowGain", "eqMudGain", "eqPresGain", "eqAirGain", "eqSideAirGain"] as const;
const PUNCHY_CLIP_DB = 3;
const PUNCHY_MAX_WARMTH = 40;
const PUNCHY_ATTACK_MS = 30;
const PUNCHY_MAX_RATIO = 3;
const GENTLE_RATIO = 1.5;
const EASE_DB = 3;

export function styleVariant(plan: Settings, style: Style): Settings {
  const s = { ...plan };
  const set = (key: ParamKey, value: number): void => {
    s[key] = clampParam(key, value);
  };
  const compressing = plan.compThreshold < 0;
  if (style === "gentle") {
    for (const k of EQ_GAINS) set(k, plan[k] / 2);
    set("eqWidth", 100 + (plan.eqWidth - 100) / 2);
    if (compressing) {
      set("compRatio", Math.min(plan.compRatio, GENTLE_RATIO));
      set("compThreshold", plan.compThreshold + EASE_DB);
    }
    for (const k of MB_THRESHOLDS) if (plan[k] < MB_OFF_DB) set(k, Math.min(MB_OFF_DB, plan[k] + EASE_DB));
    set("colorWarmth", plan.colorWarmth / 2);
    set("colorClipDb", CLIP_OFF_DB);
  } else if (style === "punchy") {
    set("colorClipDb", plan.colorClipDb < CLIP_OFF_DB ? Math.max(COLOR_RULES.minClipDb, plan.colorClipDb - 1) : PUNCHY_CLIP_DB);
    set("colorWarmth", Math.min(PUNCHY_MAX_WARMTH, plan.colorWarmth + 10));
    if (compressing) {
      set("compAttack", Math.max(plan.compAttack, PUNCHY_ATTACK_MS));
      set("compRatio", Math.min(PUNCHY_MAX_RATIO, plan.compRatio + 0.5));
    }
  }
  return s;
}

/** Knob by knob from `a` (t = 0) to `b` (t = 1); log knobs move in octaves. */
export function blendSettings(a: Settings, b: Settings, t: number): Settings {
  if (t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  const out = { ...a };
  for (const p of PARAMS) {
    const x = a[p.key];
    const y = b[p.key];
    if (x === y) continue;
    out[p.key] = clampParam(p.key, p.scale === "log" ? x * (y / x) ** t : x + (y - x) * t);
  }
  return out;
}

/** -1 (always gentle) … 0 … +1 (always punchy). Two phantom picks keep a single pick from swinging it all the way. */
export function tasteLean(t: Taste): number {
  const total = t.gentle + t.balanced + t.punchy;
  return (t.punchy - t.gentle) / (total + 2);
}

export function applyTaste(plan: Settings, lean: number): Settings {
  if (lean === 0) return { ...plan };
  return blendSettings(plan, styleVariant(plan, lean > 0 ? "punchy" : "gentle"), Math.abs(lean));
}

export function recordPick(t: Taste, style: Style): Taste {
  return { ...t, [style]: t[style] + 1 };
}

/** Validates a taste from storage. */
export function parseTaste(input: unknown): Taste {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  return { gentle: count(raw.gentle), balanced: count(raw.balanced), punchy: count(raw.punchy) };
}

/** A random order to play the three versions in (Fisher–Yates). */
export function blindOrder(random: () => number = Math.random): Style[] {
  const order = [...STYLES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
