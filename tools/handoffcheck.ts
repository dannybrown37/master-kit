/**
 * Proves "Open in Music Shader" sends the master, not the original: loads a video into the real Desk (:5174) with
 * loud knobs, clicks the button, and a stand-in shader (served through a proxy, so music-shader's :5173 stays free)
 * hands back what it received. The WAV must be byte-identical to the Desk's own "Export WAV 24-bit", the same length
 * as the original's audio but clearly louder, and the video byte-identical to the file loaded.
 *
 *   node tools/handoffcheck.ts <video> [--set JSON]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer as createVite } from "vite";
import type { ViteDevServer } from "vite";
import { sleep, startSession } from "./chrome.ts";
import { decode, ffmpegEbur128, run } from "./ffmpeg.ts";

const USAGE = `Usage: just handoffcheck <video> [--set JSON]

Checks that "Open in Music Shader" sends the mastered audio. Uses the dev server on :5174 (starts one if none),
loads <video> with --set knobs (default: +12 dB Drive, +12 dB low shelf), clicks the button, and compares what a
stand-in shader receives with the Desk's own WAV export (byte for byte) and with the original audio (must be louder).`;

const DESK = "http://127.0.0.1:5174";
const SHADER_HOST = "127.0.0.1:5173";
const LOUDER_LU = 3;

const STAND_IN = `<!doctype html><script>
window.onmessage = async (e) => {
  const d = e.data;
  await fetch("/received/audio", { method: "POST", body: d.audio });
  await fetch("/received/video", { method: "POST", body: d.video });
  await fetch("/received/meta", { method: "POST", body: JSON.stringify({ origin: e.origin, type: d.type, v: d.v, name: d.name, audioType: d.audio.type, videoType: d.video.type }) });
};
opener.postMessage({ type: "music-shader:ready", v: 1 }, "*");
</script>`;

/**
 * The audio track's length as MP4/MOV state it, exactly (ffmpeg's decode keeps AAC's end padding, browsers trim it).
 * Matroska states none and times packets in whole ms, so AAC there ends somewhere in its last ms: allow 1 ms.
 */
function expectedFrames(path: string, rate: number, decoded: number): { frames: number; slack: number } {
  const { stdout } = run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts,time_base", "-of", "json", path]);
  const s = (JSON.parse(stdout.toString()) as { streams: { duration_ts?: number; time_base?: string }[] }).streams[0];
  const [num, den] = (s.time_base ?? "").split("/").map(Number);
  return s.duration_ts && num && den ? { frames: Math.round((s.duration_ts * num * rate) / den), slack: 0 } : { frames: decoded, slack: Math.ceil(rate / 1000) };
}

const sha =(b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

async function deskServer(): Promise<ViteDevServer | null> {
  try {
    await fetch(DESK);
    console.log(`using the dev server already on ${DESK}`);
    return null;
  } catch {
    const vite = await createVite({ server: { port: 5174, strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
    await vite.listen();
    return vite;
  }
}

async function waitFor<T>(what: string, seconds: number, get: () => T | null | Promise<T | null>): Promise<T> {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(500)) {
    const v = await get();
    if (v !== null) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { set: { type: "string" }, version: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.version) {
    console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
    return 0;
  }
  if (values.help || positionals.length !== 1) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const video = resolve(positionals[0]);
  if (!existsSync(video)) throw new Error(`not found: ${video}`);
  const knobs = JSON.parse(values.set ?? '{"limDrive":12,"eqLowGain":12}') as unknown;

  const received = new Map<string, Buffer>();
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.host !== SHADER_HOST) return void res.writeHead(502).end();
    if (req.method !== "POST") return void res.writeHead(200, { "Content-Type": "text/html" }).end(STAND_IN);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => (received.set(url.pathname, Buffer.concat(chunks)), res.end()));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => proxy.once("listening", r));
  const proxyPort = (proxy.address() as AddressInfo).port;

  const vite = await deskServer();
  const downloads = mkdtempSync(join(tmpdir(), "master-kit-dl-"));
  const session = await startSession(1000, 700, [`--proxy-server=http://127.0.0.1:${proxyPort}`, `--proxy-bypass-list=<-loopback>;127.0.0.1:5174`]);
  let wav: Buffer;
  try {
    const { cdp } = session;
    const message = (): Promise<string> => cdp.evaluate<string>("document.querySelector('.message')?.textContent ?? ''");
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await cdp.send("Page.navigate", { url: `${DESK}/` });
    await cdp.waitReady(60);
    await cdp.evaluate(`localStorage.setItem(${JSON.stringify(`master-kit:v1:settings:${basename(video)}`)}, ${JSON.stringify(JSON.stringify(knobs))})`);
    const doc = (await cdp.send("DOM.getDocument")) as { root: { nodeId: number } };
    const input = (await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" })) as { nodeId: number };
    await cdp.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [video] });
    const btn = "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Music Shader'))";
    await waitFor("the Music Shader button", 60, async () => ((await cdp.evaluate<boolean>(`!!${btn} && !${btn}.hidden && !${btn}.disabled`)) ? true : null));
    const t0 = Date.now();
    await cdp.send("Runtime.evaluate", { expression: `${btn}.click()`, userGesture: true });
    await waitFor("the stand-in shader to receive the handoff", 60, async () => {
      if (/not sent|blocked/.test(await message())) throw new Error(`Desk: ${await message()}`);
      return received.has("/received/meta") ? true : null;
    });
    console.log(`handoff received after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await cdp.send("Page.bringToFront");
    await cdp.key("/");
    await cdp.send("Input.insertText", { text: "Export WAV 24-bit" });
    await sleep(300);
    await cdp.key("Enter");
    const file = await waitFor("the Desk's WAV export", 120, () => {
      const f = readdirSync(downloads).find((n) => n.endsWith(".wav"));
      return f && statSync(join(downloads, f)).size > 0 ? join(downloads, f) : null;
    });
    await sleep(1000);
    wav = readFileSync(file);
  } finally {
    await session.close();
    await vite?.close();
    proxy.close();
  }

  const meta = JSON.parse(String(received.get("/received/meta"))) as Record<string, unknown>;
  const audio = received.get("/received/audio") ?? Buffer.alloc(0);
  const sentVideo = received.get("/received/video") ?? Buffer.alloc(0);
  const original = readFileSync(video);
  const sentPath = join(downloads, "received.wav");
  writeFileSync(sentPath, audio);
  const sent = decode(sentPath);
  const orig = decode(video);
  const { frames, slack } = expectedFrames(video, sent.sampleRate, orig.channels[0].length);
  const gap = Math.abs(sent.channels[0].length - frames);
  const lSent = ffmpegEbur128(sent.channels, sent.sampleRate).integrated;
  const lOrig = ffmpegEbur128(orig.channels, orig.sampleRate).integrated;

  const checks: [string, boolean][] = [
    [`message: ${meta.type} v${meta.v} from ${meta.origin}, name ${meta.name}, audio ${meta.audioType}`, meta.type === "music-shader:handoff" && meta.v === 1 && meta.audioType === "audio/wav"],
    [`video sent = file loaded (sha ${sha(sentVideo)} vs ${sha(original)}, ${meta.videoType})`, sentVideo.equals(original)],
    [`WAV sent = Desk's Export WAV 24-bit, byte for byte (sha ${sha(audio)} vs ${sha(wav)}, ${audio.length} bytes)`, audio.equals(wav)],
    [`same length as the original's audio track (${sent.channels[0].length} vs ${frames} frames @ ${sent.sampleRate} Hz${slack ? `, ±${slack} for Matroska's ms timestamps` : ", exact"})`, gap <= slack && sent.sampleRate === orig.sampleRate],
    [`mastered, not the original: ${lSent.toFixed(1)} LUFS vs original ${lOrig.toFixed(1)} LUFS (needs ≥ +${LOUDER_LU} LU)`, lSent - lOrig >= LOUDER_LU],
  ];
  for (const [line, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${line}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`handoffcheck: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
