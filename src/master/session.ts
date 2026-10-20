/** A saved session: the knobs as a JSON file you can keep, share or load in another browser. */
import { MODULES, parseSettings } from "./settings.ts";
import type { Bypass, Settings } from "./settings.ts";

const APP = "master-kit";
const VERSION = 1;

export interface Session {
  track: string;
  settings: Settings;
  bypass: Bypass;
}

export function toSession(track: string, settings: Settings, bypass: Bypass): object {
  return { app: APP, version: VERSION, track, settings, bypass };
}

/** Validates a session file (untrusted): null if it isn't one; bad values fall back like stored settings. */
export function parseSession(input: unknown): Session | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  if (o.app !== APP || o.version !== VERSION || typeof o.settings !== "object" || o.settings === null) return null;
  const rawBypass = (typeof o.bypass === "object" && o.bypass !== null ? o.bypass : {}) as Record<string, unknown>;
  const bypass = Object.fromEntries(MODULES.map((m) => [m, rawBypass[m] === true])) as Bypass;
  return { track: typeof o.track === "string" ? o.track : "", settings: parseSettings(o.settings), bypass };
}

/** The song's file name without its extension, safe for a download name. */
export function safeBaseName(track: string): string {
  return track.replace(/\.[^.]+$/, "").replace(/[^\w\-[\]() ,.]+/g, "_") || "song";
}

export function sessionFileName(track: string): string {
  return `${safeBaseName(track)} (session).json`;
}
