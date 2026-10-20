/**
 * Compares our meters against ffmpeg's ebur128 filter.
 *
 *   node tools/crosscheck.ts              EBU Tech 3341/3342 synthetic cases
 *   node tools/crosscheck.ts <file>...    real files
 *
 * Exits 1 if any metric differs by more than its tolerance.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "../src/analysis/report.ts";
import { SR, faded, sine, sineSteps, stereo } from "../src/analysis/test-signals.ts";
import { decode, ffmpegEbur128 } from "./ffmpeg.ts";
import type { Decoded } from "./ffmpeg.ts";

const TOLERANCE = { integrated: 0.1, loudnessRange: 1, truePeak: 0.3 };

const SYNTHETIC: [string, () => Decoded][] = [
  ["3341-1 sine -23", () => ({ channels: stereo(sineSteps([[-23, 20]])), sampleRate: SR })],
  ["3341-2 sine -33", () => ({ channels: stereo(sineSteps([[-33, 20]])), sampleRate: SR })],
  ["3341-3 -36/-23/-36", () => ({ channels: stereo(sineSteps([[-36, 10], [-23, 60], [-36, 10]])), sampleRate: SR })],
  ["3341-4 gated", () => ({ channels: stereo(sineSteps([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]])), sampleRate: SR })],
  ["3341-5 -26/-20/-26", () => ({ channels: stereo(sineSteps([[-26, 20], [-20, 20.1], [-26, 20]])), sampleRate: SR })],
  ["3341-16 tp fs/4 45°", () => ({ channels: stereo(faded(sine(SR / 4, 5, -6, SR, 45))), sampleRate: SR })],
  ["3341-19 tp +3 dBFS", () => ({ channels: stereo(faded(sine(SR / 4, 5, 3, SR, 45))), sampleRate: SR })],
  ["3342-1 -20/-30", () => ({ channels: stereo(sineSteps([[-20, 20], [-30, 20]])), sampleRate: SR })],
  ["3342-3 -40/-20", () => ({ channels: stereo(sineSteps([[-40, 20], [-20, 20]])), sampleRate: SR })],
  ["3342-4 5 steps", () => ({ channels: stereo(sineSteps([[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]])), sampleRate: SR })],
  ["44.1k sine -14", () => ({ channels: stereo(sine(1000, 20, -14, 44100)), sampleRate: 44100 })],
];

type Metric = keyof typeof TOLERANCE;
const METRICS = Object.keys(TOLERANCE) as Metric[];

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(1).padStart(6) : "  -inf";
}

function check(name: string, load: () => Decoded): boolean {
  const { channels, sampleRate } = load();
  const ours = analyze(channels, sampleRate);
  const ref = ffmpegEbur128(channels, sampleRate);
  let ok = true;
  const cells = METRICS.map((m) => {
    const diff = Math.abs(ours[m] - ref[m]);
    const pass = diff <= TOLERANCE[m] || ours[m] === ref[m];
    ok &&= pass;
    return `${fmt(ours[m])} ${fmt(ref[m])} ${pass ? "✓" : "✗"}`;
  });
  console.log(`${name.slice(0, 24).padEnd(24)} ${cells.join("   ")}`);
  return ok;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
if (values.version) {
  console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
  process.exit(0);
}
if (values.help) {
  console.log("Usage: just crosscheck [files...]\n\nNo files: EBU Tech 3341/3342 synthetic cases. Compares our I / LRA / TP with ffmpeg ebur128.");
  process.exit(0);
}
const cases: [string, () => Decoded][] = positionals.length ? positionals.map((p) => [basename(p), () => decode(p)]) : SYNTHETIC;
console.log(`${"case".padEnd(24)} ${"I ours   ffmpeg".padEnd(17)}   ${"LRA ours ffmpeg".padEnd(17)}   TP ours  ffmpeg`);
const results = cases.map(([name, load]) => check(name, load));
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} of ${results.length} cases outside tolerance ${JSON.stringify(TOLERANCE)}` : `all ${results.length} cases within tolerance`);
process.exitCode = failed ? 1 : 0;
