/**
 *   /?track=<name>[&set={json}][&autoplay]                 the Desk
 *   /?render=1&track=<name>[&set=..&from=..&seconds=..]   offline render for tools/render.ts
 *   /?auto=1&track=<name>[&ref=<name>][&genre=<key>]      auto-master for tools/automaster.ts (genre: from the name)
 */
import type { Report } from "./analysis/report.ts";
import { autoMaster } from "./audio/auto.ts";
import { Engine } from "./audio/engine.ts";
import { measure } from "./audio/measure.ts";
import { decodeAt, decodeNative, renderMaster } from "./audio/render.ts";
import { fetchTrack } from "./audio/tracks.ts";
import { parseTrackList } from "./master/library.ts";
import { Desk, channelsOf } from "./desk/desk.ts";
import "./desk/desk.css";
import type { Rendered } from "./audio/render.ts";
import { genreFromName, parseGenre } from "./master/genres.ts";
import { MODULES, parseSettings } from "./master/settings.ts";
import type { Bypass, Module, Settings } from "./master/settings.ts";

/** What tools/automaster.ts reads back from the page. */
export interface AutoResult {
  settings: Settings;
  bypass: Bypass;
  steps: string[];
  original: Report;
  master: Report;
}

/** Only used when a file's header doesn't say its rate. */
const FALLBACK_RATE = 44100;

declare global {
  interface Window {
    __engine?: Engine;
    __render?: { sampleRate: number; length: number };
    __auto?: AutoResult;
    __renderChunk?: (which: "master" | "original", channel: number, start: number, count: number) => string;
  }
}

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function settingsFromUrl(): ReturnType<typeof parseSettings> {
  const raw = params.get("set");
  if (!raw) return parseSettings({});
  try {
    return parseSettings(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof SyntaxError) throw new SyntaxError(`?set= is not valid JSON: ${err.message}`, { cause: err });
    throw err;
  }
}

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function renderMode(): Promise<void> {
  const track = params.get("track");
  if (!track) throw new Error("render mode needs ?track=");
  const buffer = await decodeAt(await fetchTrack(track), Number(params.get("rate") ?? 44100));
  const t0 = performance.now();
  const bypass = Object.fromEntries(MODULES.map((m) => [m, (params.get("bypass") ?? "").split(",").includes(m)])) as Record<Module, boolean>;
  const r: Rendered = await renderMaster(buffer, settingsFromUrl(), bypass, Number(params.get("from") ?? 0), Number(params.get("seconds") ?? Infinity));
  console.log(`rendered ${(r.master[0].length / r.sampleRate).toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  window.__render = { sampleRate: r.sampleRate, length: r.master[0].length };
  window.__renderChunk = (which, channel, start, count): string => toBase64(r[which][channel].subarray(start, start + count));
}

async function decodeTrack(name: string): Promise<AudioBuffer> {
  return decodeNative(await fetchTrack(name), FALLBACK_RATE);
}

/** Auto-master for tools/automaster.ts: the same planner and render loop as the Desk's auto-master button. */
async function autoMode(): Promise<void> {
  const track = params.get("track");
  if (!track) throw new Error("auto mode needs ?track=");
  const buffer = await decodeTrack(track);
  const original = await measure(channelsOf(buffer), buffer.sampleRate);
  const refName = params.get("ref");
  const refBuffer = refName ? await decodeTrack(refName) : null;
  const reference = refBuffer ? await measure(channelsOf(refBuffer), refBuffer.sampleRate) : null;
  const t0 = performance.now();
  const genre = parseGenre(params.get("genre")) ?? genreFromName(track);
  const auto = await autoMaster(buffer, original, { reference, genre }, (text) => console.log(text));
  if (!auto) throw new Error("auto-master stopped before it finished");
  console.log(`auto-master took ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const { settings, bypass, steps, report, audio } = auto;
  window.__auto = { settings, bypass, steps, original, master: report };
  window.__render = { sampleRate: audio.sampleRate, length: audio.master[0].length };
  window.__renderChunk = (which, channel, start, count): string => toBase64((which === "master" ? audio.master : channelsOf(buffer))[channel].subarray(start, start + count));
}

async function deskMode(): Promise<void> {
  const engine = await Engine.create();
  window.__engine = engine;
  const res = await fetch(`${import.meta.env.BASE_URL}api/tracks`).catch(() => null);
  const tracks = res?.ok ? parseTrackList(res.headers.get("Content-Type"), await res.text()) : [];
  const desk = new Desk($("app"), engine, tracks);
  await desk.start(params.get("track"), params.has("set") ? settingsFromUrl() : null, params.get("ref"));
  if (params.has("drills")) desk.setMode("drills");
  if (params.has("autoplay")) await engine.play();
}

function report(err: unknown): void {
  console.error(err);
  $("app").textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  document.title = "error";
}

(params.has("render") ? renderMode() : params.has("auto") ? autoMode() : deskMode()).then(() => {
  document.title = "ready";
}, report);
