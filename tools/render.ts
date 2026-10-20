/**
 * Runs a song through the real browser mastering chain (headless Chrome) and reports before/after.
 *
 *   node tools/render.ts <track> [--set '{"limDrive":4}'] [--bypass eq,comp] [--from 30] [--seconds 20] [--wav out/x.wav]
 *   node tools/render.ts <track> --live 8        realtime engine: play, A/B, read the meters
 *
 * <track> is a file name inside MUSIC_DIR (default ../deluge-quest/web/public/audio).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { analyze } from "../src/analysis/report.ts";
import type { EngineState } from "../src/audio/engine.ts";
import { MODULES } from "../src/master/settings.ts";
import { compare } from "./compare.ts";
import { writeWav } from "./ffmpeg.ts";
import { pullChannels, sleep, startSession } from "./chrome.ts";
import type { Cdp } from "./chrome.ts";

const USAGE = `Usage: just render <track> [--set JSON] [--bypass eq,tame,multi,comp,color,limiter] [--from S] [--seconds S] [--wav FILE]
       just render <track> --live SECONDS

<track> is a file name in MUSIC_DIR (default ../deluge-quest/web/public/audio).`;

async function offline(cdp: Cdp, base: string, track: string, q: URLSearchParams, wav?: string): Promise<void> {
  q.set("render", "1");
  q.set("track", track);
  await cdp.send("Page.navigate", { url: `${base}/?${q}` });
  await cdp.waitReady(600);
  const { sampleRate, length } = await cdp.evaluate<{ sampleRate: number; length: number }>("window.__render");
  const master = await pullChannels(cdp, "master", length);
  const original = await pullChannels(cdp, "original", length);
  console.log(cdp.logs.join("\n"));
  console.log(`${track}  (${(length / sampleRate).toFixed(1)} s at ${sampleRate} Hz)\n${compare(analyze(original, sampleRate), analyze(master, sampleRate))}`);
  let residual = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) residual = Math.max(residual, Math.abs(master[c][i] - original[c][i]));
  console.log(`  null test: largest master − original difference ${(20 * Math.log10(residual)).toFixed(1)} dBFS`);
  if (wav) {
    writeWav(wav, master, sampleRate);
    console.log(`wrote ${wav}`);
  }
}

async function live(cdp: Cdp, base: string, track: string, q: URLSearchParams, seconds: number): Promise<void> {
  q.set("track", track);
  q.set("autoplay", "1");
  await cdp.send("Page.navigate", { url: `${base}/?${q}` });
  await cdp.waitReady(60);
  const snap = async (label: string): Promise<EngineState> => {
    const s = await cdp.evaluate<EngineState>("window.__engine.state");
    const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "-inf");
    console.log(
      `${label.padEnd(22)} t=${f(s.position)} ${s.listen.padEnd(8)} match ${f(s.matchDb)} dB  orig S ${f(s.original.shortTerm)}  master S ${f(s.master.shortTerm)}  peak ${f(s.master.peak)}  GR comp ${f(s.reduction.comp)} lim ${f(s.reduction.limiter)}`,
    );
    return s;
  };
  await sleep(seconds * 1000);
  await snap("playing master");
  await cdp.key("a");
  await sleep(1500);
  await snap("after a (original)");
  await cdp.key("a");
  const tabs = MODULES.indexOf("limiter");
  for (const key of [...Array<string>(tabs).fill("Tab"), "b"]) await cdp.key(key);
  await sleep(1500);
  const bypassed = await snap("limiter bypassed");
  if (!bypassed.bypass.limiter) throw new Error(`tab ×${tabs} then b did not bypass the limiter`);
  await cdp.key("ArrowRight");
  await sleep(300);
  const nudged = await snap("→ on limiter drive");
  if (!(nudged.settings.limDrive > 0)) throw new Error("→ did not raise the limiter drive");
  // Snapshot = limiter bypassed; then the knobs get the limiter back, pushed 3 dB harder.
  await cdp.key("c");
  for (const key of ["b", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "x"]) await cdp.key(key);
  await sleep(4000);
  const vs = await snap("x (snapshot)");
  const gap = vs.master.shortTerm - vs.snapshot.shortTerm;
  console.log(`${"".padEnd(22)} snapshot S ${vs.snapshot.shortTerm.toFixed(1)}  match ${vs.snapshotDb.toFixed(1)} dB  (master − snapshot ${gap.toFixed(1)} dB)`);
  if (vs.listen !== "snapshot" || !vs.snapshotKnobs?.bypass.limiter) throw new Error("c then x did not play the saved (limiter-bypassed) snapshot");
  if (!(Math.abs(vs.snapshotDb - gap) < 1.5)) throw new Error(`snapshot not loudness-matched: gain ${vs.snapshotDb} dB vs gap ${gap} dB`);
  await cdp.key("X");
  await sleep(300);
  const swapped = await snap("X (swapped)");
  if (swapped.listen !== "master" || !swapped.bypass.limiter || swapped.snapshotKnobs?.bypass.limiter !== false) throw new Error("X did not swap snapshot and knobs");
  await cdp.key(" ");
  await sleep(500);
  const paused = await snap("after space (paused)");
  if (paused.playing) throw new Error("space did not pause");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      set: { type: "string" },
      bypass: { type: "string" },
      from: { type: "string" },
      seconds: { type: "string" },
      wav: { type: "string" },
      live: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
    return 0;
  }
  if (values.help || positionals.length !== 1) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const q = new URLSearchParams();
  if (values.set) {
    JSON.parse(values.set);
    q.set("set", values.set);
  }
  for (const key of ["bypass", "from", "seconds"] as const) if (values[key]) q.set(key, values[key]);
  const session = await startSession();
  try {
    if (values.live) await live(session.cdp, session.base, positionals[0], q, Number(values.live));
    else await offline(session.cdp, session.base, positionals[0], q, values.wav);
  } finally {
    await session.close();
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`render: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
