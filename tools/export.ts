/**
 * Exports a master through the real Desk (presses `e`/`E` in headless Chrome), saves the downloaded WAV,
 * then checks it with ffmpeg: format via ffprobe, loudness and true peak via ebur128.
 *
 *   node tools/export.ts <track> [--set JSON] [--bits 24|16] [--out out/master.wav]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { TARGETS } from "../src/analysis/targets.ts";
import { fileSampleRate } from "../src/audio/sample-rate.ts";
import { sleep, startSession } from "./chrome.ts";
import { decode, ffmpegEbur128 } from "./ffmpeg.ts";

const USAGE = `Usage: just export <track> [--set JSON] [--bits 24|16] [--out FILE]

Exports <track> (a file name in MUSIC_DIR) through the Desk's export button and verifies the WAV with ffmpeg.
Default --out: out/<track> (master).wav`;

async function waitForDownload(dir: string, seconds: number): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const done = readdirSync(dir).find((f) => f.endsWith(".wav"));
    if (done) return join(dir, done);
    await sleep(250);
  }
  throw new Error(`no WAV downloaded after ${seconds} s`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      set: { type: "string" },
      bits: { type: "string", default: "24" },
      out: { type: "string" },
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
  if (values.bits !== "24" && values.bits !== "16") throw new RangeError(`--bits must be 24 or 16, got ${values.bits}`);
  const track = positionals[0];
  const out = resolve(values.out ?? `out/${track.replace(/\.[^.]+$/, "")} (master).wav`);
  const q = new URLSearchParams({ track });
  if (values.set) {
    JSON.parse(values.set);
    q.set("set", values.set);
  }
  const downloads = mkdtempSync(join(tmpdir(), "master-kit-dl-"));
  const session = await startSession();
  try {
    const { cdp } = session;
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await cdp.send("Page.navigate", { url: `${session.base}/?${q}` });
    await cdp.waitReady(60);
    const t0 = Date.now();
    await cdp.key(values.bits === "16" ? "E" : "e");
    const file = await waitForDownload(downloads, 300);
    await sleep(500);
    console.log(`downloaded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${await cdp.evaluate<string>("document.querySelector('.message').textContent")}`);
    mkdirSync(dirname(out), { recursive: true });
    renameSync(file, out);
  } finally {
    await session.close();
  }

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,bits_per_sample,duration", "-of", "default=nw=1", out]);
  if (probe.status !== 0) throw new Error(`ffprobe rejected ${out}: ${probe.stderr.toString()}`);
  console.log(`${out}\n${probe.stdout.toString().trim().replace(/\n/g, "  ")}`);
  const { channels, sampleRate } = decode(out);
  const r = ffmpegEbur128(channels, sampleRate);
  const ok = r.truePeak <= TARGETS.truePeakMax;
  console.log(`ffmpeg ebur128: I ${r.integrated.toFixed(1)} LUFS  LRA ${r.loudnessRange.toFixed(1)} LU  TP ${r.truePeak.toFixed(1)} dBTP ${ok ? "✓" : "✗ over"} ${TARGETS.truePeakMax}`);
  const source = readFileSync(join(process.env.MUSIC_DIR ?? "../deluge-quest/web/public/audio", track));
  const sourceRate = fileSampleRate(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  const rateOk = sourceRate === null || sourceRate === sampleRate;
  console.log(`sample rate: ${sampleRate} Hz, source ${sourceRate ?? "unknown"} Hz ${rateOk ? "✓" : "✗"}`);
  return ok && rateOk ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`export: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
