/** Per-track settings and drill progress in localStorage. Everything read back goes through a validator. */
import { parseSettings } from "../master/settings.ts";
import type { Settings } from "../master/settings.ts";
import { parseTaste } from "../master/shootout.ts";
import type { Taste } from "../master/shootout.ts";

const PREFIX = "master-kit:v1:";

export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof DOMException) return null;
    throw err;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err: unknown) {
    if (!(err instanceof DOMException)) throw err;
  }
}

export function loadSettings(track: string): Settings | null {
  const raw = readJson(`settings:${track}`);
  return raw === null ? null : parseSettings(raw);
}

export function saveSettings(track: string, settings: Settings): void {
  writeJson(`settings:${track}`, settings);
}

export function loadTaste(): Taste {
  return parseTaste(readJson("taste"));
}

export function saveTaste(taste: Taste): void {
  writeJson("taste", taste);
}

export function lastTrack(): string | null {
  const raw = readJson("track");
  return typeof raw === "string" ? raw : null;
}

export function saveLastTrack(track: string): void {
  writeJson("track", track);
}

export function lastReference(): string | null {
  const raw = readJson("reference");
  return typeof raw === "string" && raw ? raw : null;
}

export function saveLastReference(track: string): void {
  writeJson("reference", track);
}
