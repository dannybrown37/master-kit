/**
 * Puts a mastered WAV back under its video, refusing anything that would move the sound off the picture.
 *
 *   node tools/remux.ts <video> <master.wav> [--out FILE] [--force]
 *
 * Before: the master must line up with the video's own audio (offset ≤ 0.25 ms) and be the same length (± 50 ms
 * of decoder padding, then fitted exactly). After: decoded on the file's timeline (where players put it), the new
 * audio lines up with the old within 0.25 ms; only then is --out written. Video and other streams are copied untouched.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fitLength, shiftStart, syncOffset } from "../src/master/video.ts";
import type { REMUX_EXTENSIONS } from "../src/master/video.ts";
import { audioAt, decode, lagAgainstPicture, run, startTime, streams, writeWav } from "./ffmpeg.ts";

const USAGE = `Usage: just remux <video> <master.wav> [--out FILE] [--force]

Replaces <video>'s audio with <master.wav> (exported from the Desk), after checking it is in sync.
Video and other streams are copied as-is; the audio is encoded per container:
  .mp4 .m4v .mov → AAC 320 kbps    .webm → Opus 256 kbps    .mkv → FLAC (lossless)
Default --out: "<video name> (master).<ext>" next to the video. --force overwrites an existing --out.`;

const CODECS: Record<(typeof REMUX_EXTENSIONS)[number], string[]> & Partial<Record<string, string[]>> = {
  ".mp4": ["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"],
  ".m4v": ["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"],
  ".mov": ["-c:a", "aac", "-b:a", "320k"],
  ".webm": ["-c:a", "libopus", "-b:a", "256k"],
  ".mkv": ["-c:a", "flac"],
};
const MAX_OFFSET_SECONDS = 0.00025;
const MAX_LENGTH_GAP_SECONDS = 0.05;

function checkOffset(what: string, master: Float32Array[], source: Float32Array[], sampleRate: number): void {
  const lag = syncOffset(master, source, sampleRate);
  const ms = ((lag / sampleRate) * 1000).toFixed(2);
  if (Math.abs(lag) > MAX_OFFSET_SECONDS * sampleRate) {
    throw new Error(`${what} is ${Math.abs(Number(ms)).toFixed(2)} ms ${lag > 0 ? "late" : "early"} against the video's audio. Was Lead-in set, or is this the wrong WAV?`);
  }
  console.log(`  ${what}: in sync (${lag} samples, ${ms} ms)`);
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      force: { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
    return 0;
  }
  if (values.help || positionals.length !== 2) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const video = resolve(positionals[0]);
  const wav = resolve(positionals[1]);
  for (const f of [video, wav]) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const ext = extname(video).toLowerCase();
  const out = resolve(values.out ?? join(dirname(video), `${basename(video, extname(video))} (master)${extname(video)}`));
  const codec = CODECS[extname(out).toLowerCase()];
  if (!codec) throw new Error(`can't write ${extname(out) || "that"}: use ${Object.keys(CODECS).join(", ")} (from ${ext})`);
  if (out === video || out === wav) throw new Error("--out would overwrite an input");
  if (existsSync(out) && !values.force) throw new Error(`${out} exists (--force to overwrite)`);

  const audioStreams = streams(video).filter((s) => s.codec_type === "audio").length;
  if (audioStreams !== 1) throw new Error(`the video has ${audioStreams} audio streams; remux handles exactly one`);

  const master = decode(wav);
  const rate = master.sampleRate;
  const source = audioAt(video, rate, master.channels.length);
  const frames = source[0].length;
  const gap = master.channels[0].length - frames;
  console.log(`${basename(video)} ← ${basename(wav)}  (${rate} Hz, ${(frames / rate).toFixed(2)} s)`);
  if (Math.abs(gap) > MAX_LENGTH_GAP_SECONDS * rate) {
    throw new Error(`the master is ${(gap / rate).toFixed(3)} s ${gap > 0 ? "longer" : "shorter"} than the video's audio. Was Tail or Lead-in set, or is this the wrong WAV?`);
  }
  checkOffset("master vs original audio", master.channels, source, rate);

  const tmp = mkdtempSync(join(tmpdir(), "master-kit-remux-"));
  try {
    const muxed = join(tmp, `muxed${extname(out)}`);
    muxInSync(video, master.channels, frames, rate, codec, tmp, muxed);
    copyFileSync(muxed, out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`wrote ${out}`);
  return 0;
}

/**
 * Muxes into a temp file, measures where the new audio landed against the original on the shared timeline
 * (allowing for any shift of the copied video), moves the samples by that error and retries.
 * Codecs place audio differently (AAC priming, Opus pre-skip), so measuring beats predicting; the fix goes in
 * the samples, not `-itsoffset`, because container timestamps round (WebM ticks are 1 ms).
 */
function muxInSync(video: string, master: Float32Array[], frames: number, rate: number, codec: string[], tmp: string, out: string): void {
  const fitted = join(tmp, "master.wav");
  const original = audioAt(video, rate, master.length, true);
  const tolerance = MAX_OFFSET_SECONDS * rate;
  const offset = startTime(video, "audio");
  let earlier = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    writeWav(fitted, shiftStart(fitLength(master, frames), earlier), rate);
    rmSync(out, { force: true });
    run("ffmpeg", [
      "-v", "error", "-n",
      "-i", video, "-itsoffset", offset.toFixed(6), "-i", fitted,
      "-map", "0", "-map", "-0:a", "-map", "1:a",
      "-map_metadata", "0", "-map_metadata:s:a:0", "0:s:a:0",
      "-c", "copy", ...codec, out,
    ]);
    const error = lagAgainstPicture(video, out, rate, master.length, original);
    console.log(`  against the picture, try ${attempt}: ${error} samples (${((error / rate) * 1000).toFixed(2)} ms)`);
    if (Math.abs(error) <= tolerance) return;
    earlier += error;
  }
  throw new Error("couldn't place the new audio within 0.25 ms of the original against the picture; nothing written");
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`remux: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
