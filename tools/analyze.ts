/**
 * Mastering report for one audio file (anything ffmpeg can decode).
 *
 *   node tools/analyze.ts <file> [--json]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "../src/analysis/report.ts";
import type { Report } from "../src/analysis/report.ts";
import { TARGETS, checkTargets } from "../src/analysis/targets.ts";
import { decode } from "./ffmpeg.ts";

const USAGE = `Usage: just analyze <file> [--json]

Prints loudness (LUFS), true peak, dynamics and tonal balance for a song.

Options:
  --json       machine-readable output
  --version    print version
  -h, --help   show this help`;

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function num(x: number, unit: string, signed = true): string {
  const s = !Number.isFinite(x) ? "-inf" : (signed && x > 0 ? "+" : "") + x.toFixed(1);
  return `${s.padStart(6)} ${unit.padEnd(4)}`;
}

function mark(ok: boolean, target: string): string {
  return ok ? `✓ ${target}` : `✗ ${target}`;
}

function bar(db: number): string {
  if (!Number.isFinite(db)) return "";
  return "█".repeat(Math.max(0, Math.round((db + 30) / 1.5)));
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds - m * 60)).padStart(2, "0")}`;
}

function render(file: string, r: Report): string {
  const hits = checkTargets(r);
  const tol = TARGETS.integratedTolerance;
  return [
    `${basename(file)}  ${duration(r.durationSeconds)}  ${(r.sampleRate / 1000).toFixed(1)} kHz  ${r.channels === 2 ? "stereo" : `${r.channels} ch`}`,
    "",
    "Loudness",
    `  Integrated      ${num(r.integrated, "LUFS")}  ${mark(hits.loudness, `target ${TARGETS.integrated} ±${tol}`)}`,
    `  Momentary max   ${num(r.momentaryMax, "LUFS")}`,
    `  Short-term max  ${num(r.shortTermMax, "LUFS")}`,
    `  Range (LRA)     ${num(r.loudnessRange, "LU", false)}`,
    "Peaks",
    `  True peak       ${num(r.truePeak, "dBTP")}  ${mark(hits.truePeak, `target ≤ ${TARGETS.truePeakMax}`)}`,
    `  Sample peak     ${num(r.samplePeak, "dBFS")}`,
    "Dynamics",
    `  Crest factor    ${num(r.crest, "dB", false)}`,
    `  PLR             ${num(r.plr, "dB", false)}`,
    "Stereo",
    `  Correlation     ${Number.isFinite(r.stereo.correlation) ? r.stereo.correlation.toFixed(2).padStart(6) : "     –"}       (+1 mono, 0 wide, < 0 cancels in mono)`,
    `  Side vs mid     ${num(r.stereo.sideDb, "dB")}`,
    "Tonal balance (share of energy)",
    ...r.bands.map((b) => `  ${`${b.label} ${b.lo}–${b.hi} Hz`.padEnd(28)}${num(b.db, "dB")} ${bar(b.db)}`),
  ].join("\n");
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: "boolean" }, version: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.version) {
    console.log(`master-kit ${version()}`);
    return 0;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const [file] = positionals;
  const { channels, sampleRate } = decode(file);
  const report = analyze(channels, sampleRate);
  console.log(values.json ? JSON.stringify({ file, ...report, targets: checkTargets(report) }, null, 2) : render(file, report));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`analyze: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
