import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { syncOffset } from "../src/master/video.ts";

export interface Decoded {
  channels: Float32Array[];
  sampleRate: number;
}

export function run(cmd: string, args: string[], input?: Buffer): { stdout: Buffer; stderr: string } {
  const res = spawnSync(cmd, args, { input, maxBuffer: 2 ** 31 });
  if (res.error) throw new Error(`${cmd} not runnable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr.toString().trim()}`);
  return { stdout: res.stdout, stderr: res.stderr.toString() };
}

/** Decodes any ffmpeg-readable file to float channels at its native sample rate. */
export function decode(path: string): Decoded {
  const probe = run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", path]);
  const stream = (JSON.parse(probe.stdout.toString()) as { streams?: { sample_rate?: string; channels?: number }[] }).streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const count = Number(stream?.channels);
  if (!(sampleRate > 0) || !(count > 0)) throw new Error(`no audio stream in ${path}`);
  const { stdout } = run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"]);
  const all = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const frames = Math.floor(all.length / count);
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) channels[c][i] = all[i * count + c];
  return { channels, sampleRate };
}

/** First audio stream at a chosen rate. `onTimeline`: padded with silence from t = 0, so a sample's index is where players put it, priming and all. */
export function audioAt(path: string, sampleRate: number, channels: number, onTimeline = false): Float32Array[] {
  const timeline = onTimeline ? ["-af", "aresample=async=1:first_pts=0"] : [];
  const { stdout } = run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", ...timeline, "-ar", String(sampleRate), "-ac", String(channels), "-f", "f32le", "-acodec", "pcm_f32le", "-"]);
  const all = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const frames = Math.floor(all.length / channels);
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => all[i * channels + c]));
}

interface Stream {
  codec_type: string;
  start_time?: string;
}

export function streams(path: string): Stream[] {
  const { stdout } = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", path]);
  return (JSON.parse(stdout.toString()) as { streams?: Stream[] }).streams ?? [];
}

export function startTime(path: string, type: string): number {
  const s = Number(streams(path).find((x) => x.codec_type === type)?.start_time);
  return Number.isFinite(s) ? s : 0;
}

/**
 * Samples `out`'s sound sits late (+) against its picture, compared with `source`: both decoded on their timelines,
 * minus any shift of the (copied) video's start, since players sync sound to picture by timestamp.
 */
export function lagAgainstPicture(source: string, out: string, rate: number, channels: number, sourceAudio = audioAt(source, rate, channels, true)): number {
  const shift = Math.round((startTime(out, "video") - startTime(source, "video")) * rate);
  return syncOffset(audioAt(out, rate, channels, true), sourceAudio, rate) - shift;
}

/** MD5 of a file's video packets, copied: equal means the picture is bit-for-bit untouched. */
export function videoMd5(path: string): string {
  return run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:v", "-c", "copy", "-f", "md5", "-"]).stdout.toString().trim();
}

export function interleave(channels: Float32Array[]): Buffer {
  const out = new Float32Array(channels[0].length * channels.length);
  for (let i = 0; i < channels[0].length; i++) for (let c = 0; c < channels.length; c++) out[i * channels.length + c] = channels[c][i];
  return Buffer.from(out.buffer);
}

/** Writes float channels as a 32-bit float WAV (lossless: exactly what the chain produced). */
export function writeWav(path: string, channels: Float32Array[], sampleRate: number): void {
  mkdirSync(dirname(path), { recursive: true });
  run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels.length), "-i", "pipe:0", "-c:a", "pcm_f32le", path], interleave(channels));
}

export interface Ebur128 {
  integrated: number;
  loudnessRange: number;
  truePeak: number;
}

/** ffmpeg's own EBU R128 meter, used as an independent reference. */
export function ffmpegEbur128(channels: Float32Array[], sampleRate: number): Ebur128 {
  const { stderr } = run(
    "ffmpeg",
    ["-nostats", "-hide_banner", "-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels.length), "-i", "pipe:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    interleave(channels),
  );
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const grab = (re: RegExp): number => {
    const m = re.exec(summary);
    if (!m) throw new Error(`could not parse ffmpeg ebur128 summary:\n${summary}`);
    return m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  return {
    integrated: grab(/I:\s+(-?[\d.]+|-inf) LUFS/),
    loudnessRange: grab(/LRA:\s+(-?[\d.]+) LU/),
    truePeak: grab(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}
