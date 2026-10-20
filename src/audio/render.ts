/** Renders a song through the mastering chain faster than real time (OfflineAudioContext). */
import type { Bypass, Settings } from "../master/settings.ts";
import { buildChain, loadWorklets } from "./chain.ts";
import { fileSampleRate } from "./sample-rate.ts";

export interface Rendered {
  sampleRate: number;
  master: Float32Array[];
  original: Float32Array[];
}

export async function decodeAt(data: ArrayBuffer, sampleRate: number): Promise<AudioBuffer> {
  return new OfflineAudioContext(2, 1, sampleRate).decodeAudioData(data);
}

/** Decodes at the file's own sample rate (no resampling), or at `fallbackRate` if the header is unknown. Detaches `data`. */
export async function decodeNative(data: ArrayBuffer, fallbackRate: number): Promise<AudioBuffer> {
  return decodeAt(data, fileSampleRate(data) ?? fallbackRate);
}

/** Output is latency-compensated: sample 0 of `master` lines up with sample 0 of `original`. */
export async function renderMaster(buffer: AudioBuffer, settings: Settings, bypass: Bypass, fromSeconds = 0, seconds = Infinity): Promise<Rendered> {
  const sr = buffer.sampleRate;
  const start = Math.min(buffer.length, Math.max(0, Math.round(fromSeconds * sr)));
  const frames = Math.min(buffer.length - start, Math.round(Math.min(seconds, buffer.duration) * sr));
  if (frames <= 0) throw new RangeError("nothing to render");
  const probe = new OfflineAudioContext(2, 1, sr);
  await loadWorklets(probe);
  const latency = Math.round(buildChain(probe, settings, bypass).latencySeconds * sr);

  const ctx = new OfflineAudioContext(2, frames + latency, sr);
  await loadWorklets(ctx);
  const chain = buildChain(ctx, settings, bypass);
  const source = new AudioBufferSourceNode(ctx, { buffer });
  source.connect(chain.input);
  chain.master.connect(ctx.destination);
  source.start(0, start / sr, frames / sr);
  const out = await ctx.startRendering();
  const channels = (b: AudioBuffer, offset: number): Float32Array[] =>
    Array.from({ length: 2 }, (_, c) => b.getChannelData(Math.min(c, b.numberOfChannels - 1)).slice(offset, offset + frames));
  return { sampleRate: sr, master: channels(out, latency), original: channels(buffer, start) };
}
