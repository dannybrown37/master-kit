/**
 * Checks an exported video against the one it came from, with ffmpeg (independent of the browser that made it):
 * the picture must be bit-identical and the new sound must sit against it within 0.25 ms of where the old one did.
 *
 *   node tools/synccheck.ts <original video> <exported video>
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decode, videoChecks } from "./ffmpeg.ts";

const USAGE = `Usage: just synccheck <original video> <exported video>

Checks a video exported by Master Kit (in the browser or by just remux) against its original, using ffmpeg:
picture bit-identical, sound within 0.25 ms of where the original's sat against it. Exit 0 = in sync.`;

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (values.version) {
    console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
    return 0;
  }
  if (values.help || positionals.length !== 2) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const [original, exported] = positionals;
  for (const f of [original, exported]) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const { channels, sampleRate } = decode(exported);
  return videoChecks(original, exported, sampleRate, channels.length, console.log) ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`synccheck: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
