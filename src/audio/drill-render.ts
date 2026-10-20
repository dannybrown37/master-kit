/** Builds a drill's A (clip) and B (clip + hidden process), loudness-matched. */
import { loudness } from "../analysis/loudness.ts";
import { samplePeak } from "../analysis/peak.ts";
import { matchGains } from "../drills/drills.ts";
import type { DrillProcess, Question } from "../drills/drills.ts";
import { limiterLatency } from "../dsp/limiter.ts";
import { compressorNode, limiterNode, loadWorklets, stereoStage } from "./chain.ts";

export interface DrillClips {
  a: AudioBuffer;
  b: AudioBuffer;
  gains: { a: number; b: number };
}

const EDGE_FADE_SECONDS = 0.02;
const LIMIT_CEILING_DB = -1;

function channels(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
}

export async function renderDrill(song: AudioBuffer, q: Question, process: DrillProcess): Promise<DrillClips> {
  const sr = song.sampleRate;
  const start = Math.round(q.clipStart * sr);
  const frames = Math.min(song.length - start, Math.round(q.clipSeconds * sr));
  if (frames <= 0) throw new RangeError("clip is outside the song");
  const a = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate: sr });
  const fade = Math.min(Math.round(EDGE_FADE_SECONDS * sr), frames >> 1);
  for (let c = 0; c < 2; c++) {
    const x = song.getChannelData(Math.min(c, song.numberOfChannels - 1)).slice(start, start + frames);
    // Faded edges so the loop doesn't click.
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      x[i] *= g;
      x[frames - 1 - i] *= g;
    }
    a.copyToChannel(x, c);
  }

  // The limiter delays by its lookahead; render that much longer and drop it so B lines up with A.
  const delay = process.kind === "limit" ? limiterLatency(sr) : 0;
  const ctx = new OfflineAudioContext(2, frames + delay, sr);
  const source = new AudioBufferSourceNode(ctx, { buffer: a });
  let input: AudioNode = ctx.destination;
  let output: AudioNode | null = null;
  if (process.kind === "eq") {
    input = output = new BiquadFilterNode(ctx, { type: "peaking", frequency: process.freq, gain: process.gainDb, Q: process.q });
  } else if (process.kind === "comp") {
    await loadWorklets(ctx);
    const thresholdDb = samplePeak(channels(a)) - process.depthDb;
    input = output = compressorNode(ctx, { thresholdDb, ratio: process.ratio, kneeDb: 3, attackMs: process.attackMs, releaseMs: process.releaseMs, makeupDb: 0, sidechainHz: 0, rmsMs: 0 });
  } else if (process.kind === "limit") {
    await loadWorklets(ctx);
    const driveDb = LIMIT_CEILING_DB + process.depthDb - samplePeak(channels(a));
    input = output = limiterNode(ctx, { driveDb, ceilingDb: LIMIT_CEILING_DB, releaseMs: process.releaseMs });
  } else if (process.kind === "width") {
    const stage = stereoStage(ctx, { side: process.width / 100, monoBassHz: 0, sideAirHz: 10000, sideAirDb: 0 });
    input = stage.input;
    output = stage.output;
  }
  output?.connect(ctx.destination);
  source.connect(input);
  source.start();
  const rendered = await ctx.startRendering();
  const b = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate: sr });
  for (let c = 0; c < 2; c++) b.copyToChannel(rendered.getChannelData(c).subarray(delay, delay + frames), c);

  const la = loudness(channels(a), sr).integrated;
  const lb = loudness(channels(b), sr).integrated;
  return { a, b, gains: matchGains(la, lb, samplePeak(channels(a)), samplePeak(channels(b))) };
}
