/**
 * Auto-masters a song through the real browser chain (headless Chrome): the same planner and Drive loop as the
 * Desk's auto-master button. Prints why each knob moved and a before/after report.
 *
 *   node tools/automaster.ts <track> [--ref <track>] [--wav FILE] [--session FILE] [--json]
 *
 * <track> is a file name in MUSIC_DIR. With no track on a terminal, pick one with fzf.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { AutoResult } from "../src/main.ts";
import { score } from "../src/master/score.ts";
import { toSession } from "../src/master/session.ts";
import { PARAMS, defaultSettings, formatParam } from "../src/master/settings.ts";
import { compare } from "./compare.ts";
import { writeWav } from "./ffmpeg.ts";
import { pullChannels, startSession } from "./chrome.ts";
import type { Session } from "./chrome.ts";

const USAGE = `Usage: just automaster <track> [--ref <track>] [--wav FILE] [--session FILE] [--json]

Plans a master from the song's measurements (and the reference's), sets limiter Drive for -14 LUFS by rendering,
and prints why each knob moved plus a before/after report. Runs the real browser chain in headless Chrome.

  <track>          a file name in MUSIC_DIR (default ../deluge-quest/web/public/audio); omit it on a terminal to pick with fzf
  --ref <track>    reference track (MUSIC_DIR): tone and width are matched to it instead of a generic balance
  --wav FILE       write the master as a 32-bit float WAV (exactly what the chain produced)
  --session FILE   write the knobs as a session file (Desk: session… → load from file)
  --json           print the result as JSON instead of text
  --version        print the version`;

/** Long enough for the slowest case: two decodes, five renders, two easing rounds. */
const TIMEOUT_SECONDS = 600;

function version(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function shellQuote(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function tracks(session: Session): Promise<string[]> {
  const res = await fetch(`${session.base}/api/tracks`);
  return ((await res.json()) as { tracks: string[] }).tracks;
}

/** fzf over MUSIC_DIR (call only on a terminal); null if fzf is missing or nothing was picked. */
function pick(list: string[]): string | null {
  const res = spawnSync("fzf", ["--prompt", "song to auto-master> ", "--height", "40%"], { input: list.join("\n"), stdio: ["pipe", "pipe", "inherit"] });
  if (res.error || res.status !== 0) return null;
  return res.stdout.toString().trim() || null;
}

function knobChanges(r: AutoResult): string[] {
  const d = defaultSettings();
  return PARAMS.filter((p) => r.settings[p.key] !== d[p.key]).map((p) => `${p.label} ${formatParam(p.key, r.settings[p.key])}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      wav: { type: "string" },
      session: { type: "string" },
      json: { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(`master-kit ${version()}`);
    return 0;
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (values.help || positionals.length > 1 || (positionals.length === 0 && !interactive)) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const session = await startSession();
  try {
    let track = positionals[0];
    const picked = !track;
    if (!track) {
      const chosen = pick(await tracks(session));
      if (!chosen) {
        console.error(USAGE);
        return 2;
      }
      track = chosen;
    }
    const q = new URLSearchParams({ auto: "1", track });
    if (values.ref) q.set("ref", values.ref);
    if (!values.json) console.error(`auto-mastering ${track}${values.ref ? ` against ${values.ref}` : ""} (renders the song 2–6 times)…`);
    const { cdp } = session;
    await cdp.send("Page.navigate", { url: `${session.base}/?${q}` });
    await cdp.waitReady(TIMEOUT_SECONDS);
    const r = await cdp.evaluate<AutoResult>("window.__auto");
    const sc = score(r.original, r.master);
    if (values.wav) {
      const { sampleRate, length } = await cdp.evaluate<{ sampleRate: number; length: number }>("window.__render");
      writeWav(values.wav, await pullChannels(cdp, "master", length), sampleRate);
    }
    if (values.session) {
      mkdirSync(dirname(values.session), { recursive: true });
      writeFileSync(values.session, `${JSON.stringify(toSession(track, r.settings, r.bypass), null, 2)}\n`);
    }
    if (values.json) {
      const result = { track, reference: values.ref ?? null, settings: r.settings, bypass: r.bypass, steps: r.steps, score: sc, original: r.original, master: r.master };
      // The 10 Hz loudness curves are for plotting; thousands of numbers would bury the rest.
      console.log(JSON.stringify(result, (key, value: unknown) => (key === "shortTerm" ? undefined : value), 2));
    } else {
      console.log(`\n${r.steps.map((s, i) => `${String(i + 1).padStart(2)}. ${s}`).join("\n")}`);
      console.log(`\nKnobs: ${knobChanges(r).join(" · ") || "all at defaults"}`);
      console.log(`\n${compare(r.original, r.master)}`);
      console.log(`\nScore ${sc.total}/100: ${sc.parts.map((p) => `${p.ok ? "✓" : "✗"} ${p.name} ${p.detail}`).join(" · ")}`);
      if (values.wav) console.log(`wrote ${values.wav}`);
      if (values.session) console.log(`wrote ${values.session} (Desk: session… → load from file)`);
    }
    if (picked) {
      const args = [shellQuote(track), ...(values.ref ? ["--ref", shellQuote(values.ref)] : []), ...(values.wav ? ["--wav", shellQuote(values.wav)] : []), ...(values.session ? ["--session", shellQuote(values.session)] : []), ...(values.json ? ["--json"] : [])];
      console.error(`\nRun again with:\n  just automaster ${args.join(" ")}`);
    }
    return 0;
  } finally {
    await session.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`automaster: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
