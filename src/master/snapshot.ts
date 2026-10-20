/** A saved set of knobs that plays on a second chain, to compare two candidate masters at matched loudness. */
import { MODULES, MODULE_NAMES, PARAMS, changedParams, formatParam } from "./settings.ts";
import type { Bypass, Settings } from "./settings.ts";

export interface Snapshot {
  settings: Settings;
  bypass: Bypass;
}

const LABELS = new Map(PARAMS.map((p) => [p.key as string, p.label]));
const SHOWN = 3;

/** What the snapshot does differently from the current knobs, most important first (bypasses, then PARAMS order). */
export function snapshotDiff(current: Snapshot, snap: Snapshot): string {
  const state = (off: boolean): string => (off ? "bypassed" : "on");
  const parts = [
    ...MODULES.filter((m) => current.bypass[m] !== snap.bypass[m]).map((m) => `${MODULE_NAMES[m]} ${state(snap.bypass[m])} (yours ${state(current.bypass[m])})`),
    ...changedParams(current.settings, snap.settings).map(
      (k) => `${LABELS.get(k)} ${formatParam(k, snap.settings[k])} (yours ${formatParam(k, current.settings[k])})`,
    ),
  ];
  if (parts.length === 0) return "same as your knobs";
  const more = parts.length - SHOWN;
  return [...parts.slice(0, SHOWN), ...(more > 0 ? [`and ${more} more`] : [])].join(" · ");
}
