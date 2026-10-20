/**
 * Auto-masters several songs alike in headless Chrome (genre from each name) and writes numbered WAVs in album
 * order, with Edges applied, plus a loudness-consistency summary.
 *
 *   node tools/album.ts <track>... | --all  [--out DIR] [--bits 24|16] [--genre KEY]
 *
 * With no tracks on a terminal, pick them with fzf (tab marks several).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { applyEdges } from "../src/dsp/edges.ts";
import { encodeWav } from "../src/export/wav.ts";
import type { AutoResult } from "../src/main.ts";
import { albumFileName, consistency } from "../src/master/album.ts";
import { GENRES, genreFromName, parseGenre } from "../src/master/genres.ts";
import { score } from "../src/master/score.ts";
import { edgeParams } from "../src/master/settings.ts";
import { pullChannels, startSession } from "./chrome.ts";
import type { Session } from "./chrome.ts";

const USAGE = `Usage: just album <track>... | --all  [--out DIR] [--bits 24|16] [--genre KEY]

Auto-masters each song (the Desk's auto-master: genre from the "[year, genre]" tag in its name) in headless Chrome,
then writes "NN - <song> (master 24-bit).wav" in the order given, with Edges (lead-in, fades, tail) applied,
and prints a loudness-consistency summary.

  <track>...      file names in MUSIC_DIR, in album order; omit them on a terminal to pick with fzf
  --all           every song in MUSIC_DIR, alphabetically
  --out DIR       where the WAVs go (default out/album)
  --bits 24|16    WAV bit depth (16 is TPDF-dithered; default 24)
  --genre KEY     ${GENRES.map((g) => g.key).join(" | ")} for every song (default: from each name)
  --version       print the version`;

/** Per song: two decodes and up to six renders. */
const TIMEOUT_SECONDS = 600;

function version(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function shellQuote(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function allTracks(session: Session): Promise<string[]> {
  const res = await fetch(`${session.base}/api/tracks`);
  return ((await res.json()) as { tracks: string[] }).tracks;
}

/** fzf --multi over MUSIC_DIR (call only on a terminal); empty if fzf is missing or nothing was picked. */
function pick(list: string[]): string[] {
  const res = spawnSync("fzf", ["--multi", "--prompt", "songs for the album (tab marks)> ", "--height", "60%"], { input: list.join("\n"), stdio: ["pipe", "pipe", "inherit"] });
  if (res.error || res.status !== 0) return [];
  return res.stdout.toString().split("\n").filter(Boolean);
}

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "–");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      out: { type: "string" },
      bits: { type: "string" },
      genre: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(`master-kit ${version()}`);
    return 0;
  }
  const bits = values.bits === undefined ? 24 : Number(values.bits);
  if (bits !== 24 && bits !== 16) {
    console.error(`--bits must be 24 or 16, got "${values.bits}"`);
    return 2;
  }
  if (values.genre !== undefined && !parseGenre(values.genre)) {
    console.error(`unknown genre "${values.genre}": use ${GENRES.map((g) => g.key).join(", ")}`);
    return 2;
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (values.help || (positionals.length === 0 && !values.all && !interactive) || (values.all && positionals.length > 0)) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const out = values.out ?? "out/album";
  const session = await startSession();
  try {
    const available = await allTracks(session);
    let tracks = values.all ? available : positionals;
    const picked = tracks.length === 0;
    if (picked) {
      tracks = pick(available);
      if (tracks.length === 0) {
        console.error(USAGE);
        return 2;
      }
    }
    const missing = tracks.filter((t) => !available.includes(t));
    if (missing.length) {
      console.error(`not in MUSIC_DIR: ${missing.join(", ")}`);
      return 2;
    }
    mkdirSync(out, { recursive: true });
    const { cdp } = session;
    const rows: { file: string; genre: string; lufs: number; tp: number; plr: number; score: number }[] = [];
    for (const [i, track] of tracks.entries()) {
      const genre = values.genre ?? genreFromName(track);
      console.error(`${i + 1}/${tracks.length} ${track} (${genre}): auto-mastering…`);
      const q = new URLSearchParams({ auto: "1", track, genre });
      await cdp.send("Page.navigate", { url: `${session.base}/?${q}` });
      await cdp.waitReady(TIMEOUT_SECONDS);
      const r = await cdp.evaluate<AutoResult>("window.__auto");
      const { sampleRate, length } = await cdp.evaluate<{ sampleRate: number; length: number }>("window.__render");
      const master = await pullChannels(cdp, "master", length);
      const file = albumFileName(i, track, bits);
      writeFileSync(join(out, file), Buffer.from(encodeWav(applyEdges(master, sampleRate, edgeParams(r.settings, r.bypass)), sampleRate, bits)));
      rows.push({ file, genre, lufs: r.master.integrated, tp: r.master.truePeak, plr: r.master.plr, score: score(r.original, r.master).total });
    }
    const { spreadLu, outliers } = consistency(rows.map((r) => r.lufs));
    console.log(`\n ${"#".padStart(2)}  ${"LUFS".padStart(6)} ${"dBTP".padStart(5)} ${"PLR".padStart(5)} score  genre       file`);
    rows.forEach((r, i) => {
      const flag = outliers.includes(i) ? " ← stands out" : "";
      console.log(` ${String(i + 1).padStart(2)}  ${f1(r.lufs).padStart(6)} ${f1(r.tp).padStart(5)} ${f1(r.plr).padStart(5)} ${String(r.score).padStart(5)}  ${r.genre.padEnd(10)}  ${r.file}${flag}`);
    });
    console.log(`\nLoudness spread ${spreadLu.toFixed(1)} LU${outliers.length ? `: ${outliers.length} song(s) more than 1 LU from the album's median` : ": even"}. WAVs in ${out}/`);
    if (picked) {
      const args = [...tracks.map(shellQuote), ...(values.out ? ["--out", shellQuote(values.out)] : []), ...(values.bits ? ["--bits", values.bits] : []), ...(values.genre ? ["--genre", values.genre] : [])];
      console.error(`\nRun again with:\n  just album ${args.join(" ")}`);
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
    console.error(`album: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
