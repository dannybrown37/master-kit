/**
 * The mastering chain as Web Audio nodes. Works on AudioContext and OfflineAudioContext alike.
 *
 *   input ─► EQ (4 bands) ─► mid/side (width, mono bass) ─► tamer ─► multiband ─► compressor ─► color ─► limiter ─► master
 *     └──────────────────────► delay (color + limiter latency) ─────────────────────────────────────────► original
 */
import { COLOR_LATENCY } from "../dsp/color.ts";
import type { CompressorParams } from "../dsp/compressor.ts";
import { limiterLatency } from "../dsp/limiter.ts";
import type { LimiterParams } from "../dsp/limiter.ts";
import { BUTTERWORTH_Q_DB, colorParams, compressorParams, eqBands, limiterParams, multibandParams, stereoParams, tamerParams } from "../master/settings.ts";
import type { Bypass, Settings, StereoParams } from "../master/settings.ts";
import type { ToColor, ToCompressor, ToLimiter, ToMultiband, ToTamer } from "./messages.ts";
import workletUrl from "./dynamics.worklet.ts?worker&url";

export interface Chain {
  input: AudioNode;
  master: AudioNode;
  original: AudioNode;
  tamer: AudioWorkletNode;
  multiband: AudioWorkletNode;
  compressor: AudioWorkletNode;
  color: AudioWorkletNode;
  limiter: AudioWorkletNode;
  latencySeconds: number;
  apply(settings: Settings, bypass: Bypass): void;
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
const SMOOTHING_SECONDS = 0.01;

export function loadWorklets(ctx: BaseAudioContext): Promise<void> {
  let ready = loaded.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet.addModule(workletUrl);
    loaded.set(ctx, ready);
  }
  return ready;
}

function stereoWorklet(ctx: BaseAudioContext, name: string, params: unknown): AudioWorkletNode {
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: { params },
  });
}

/** A standalone compressor node (drills). Call `loadWorklets(ctx)` first. */
export function compressorNode(ctx: BaseAudioContext, params: CompressorParams): AudioWorkletNode {
  return stereoWorklet(ctx, "compressor", params);
}

/** A standalone limiter node (drills); delays by `limiterLatency`. Call `loadWorklets(ctx)` first. */
export function limiterNode(ctx: BaseAudioContext, params: LimiterParams): AudioWorkletNode {
  return stereoWorklet(ctx, "limiter", params);
}

export interface StereoStage {
  input: AudioNode;
  output: AudioNode;
  apply(p: StereoParams, at: number): void;
}

/**
 *   L ─┬─ ×½ ──┬─► mid ─────────────────────────────────────────────────┬────► L out
 *   R ─┼─ ×½ ──┘                                                       ┌┼────► (mid + side)
 *      ├─ ×½ ──┬─► side ─► high-pass ×2 ─► air shelf ─► × width ──────┴┼─×−1─► R out
 *      └─ ×−½ ─┘           (mono bass; off = flat shelf)               └────► (mid − side)
 * Feed it two channels.
 */
export function stereoStage(ctx: BaseAudioContext, p: StereoParams): StereoStage {
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  const mid = new GainNode(ctx);
  const side = new GainNode(ctx);
  split.connect(new GainNode(ctx, { gain: 0.5 }), 0).connect(mid);
  split.connect(new GainNode(ctx, { gain: 0.5 }), 1).connect(mid);
  split.connect(new GainNode(ctx, { gain: 0.5 }), 0).connect(side);
  split.connect(new GainNode(ctx, { gain: -0.5 }), 1).connect(side);
  const filters = [0, 1].map(() => new BiquadFilterNode(ctx, { type: "lowshelf", gain: 0, Q: BUTTERWORTH_Q_DB }));
  const air = new BiquadFilterNode(ctx, { type: "highshelf", frequency: p.sideAirHz, gain: p.sideAirDb });
  const width = new GainNode(ctx, { gain: p.side });
  side.connect(filters[0]).connect(filters[1]).connect(air).connect(width);
  mid.connect(merge, 0, 0);
  mid.connect(merge, 0, 1);
  width.connect(merge, 0, 0);
  width.connect(new GainNode(ctx, { gain: -1 })).connect(merge, 0, 1);
  const apply = (next: StereoParams, at: number): void => {
    width.gain.setTargetAtTime(next.side, at, SMOOTHING_SECONDS);
    air.frequency.setTargetAtTime(next.sideAirHz, at, SMOOTHING_SECONDS);
    air.gain.setTargetAtTime(next.sideAirDb, at, SMOOTHING_SECONDS);
    for (const f of filters) {
      // A lowshelf at 0 dB is exactly flat: "off" without rebuilding the graph.
      const type = next.monoBassHz > 0 ? "highpass" : "lowshelf";
      if (f.type !== type) f.type = type;
      if (next.monoBassHz > 0) f.frequency.setTargetAtTime(next.monoBassHz, at, SMOOTHING_SECONDS);
    }
  };
  apply(p, 0);
  return { input: split, output: merge, apply };
}

/** Call `loadWorklets(ctx)` first. */
export function buildChain(ctx: BaseAudioContext, settings: Settings, bypass: Bypass): Chain {
  const input = new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit" });
  const eq = eqBands(settings, bypass).map((b) => new BiquadFilterNode(ctx, { type: b.type, frequency: b.frequency, gain: b.gain, Q: b.q }));
  const tamer = stereoWorklet(ctx, "tamer", tamerParams(settings, bypass));
  const multiband = stereoWorklet(ctx, "multiband", multibandParams(settings, bypass));
  const compressor = stereoWorklet(ctx, "compressor", compressorParams(settings, bypass));
  const color = stereoWorklet(ctx, "color", colorParams(settings, bypass));
  const limiter = stereoWorklet(ctx, "limiter", limiterParams(settings, bypass));
  const latencySeconds = (COLOR_LATENCY + limiterLatency(ctx.sampleRate)) / ctx.sampleRate;
  const original = new DelayNode(ctx, { delayTime: latencySeconds, maxDelayTime: Math.max(1, latencySeconds) });

  const stereo = stereoStage(ctx, stereoParams(settings, bypass));

  const series: AudioNode[] = [input, ...eq, stereo.input];
  for (let i = 1; i < series.length; i++) series[i - 1].connect(series[i]);
  stereo.output.connect(tamer).connect(multiband).connect(compressor).connect(color).connect(limiter);
  input.connect(original);

  return {
    input,
    master: limiter,
    original,
    tamer,
    multiband,
    compressor,
    color,
    limiter,
    latencySeconds,
    apply(s: Settings, b: Bypass): void {
      const at = ctx.currentTime;
      eqBands(s, b).forEach((band, i) => {
        eq[i].frequency.setTargetAtTime(band.frequency, at, SMOOTHING_SECONDS);
        eq[i].gain.setTargetAtTime(band.gain, at, SMOOTHING_SECONDS);
        eq[i].Q.setTargetAtTime(band.q, at, SMOOTHING_SECONDS);
      });
      stereo.apply(stereoParams(s, b), at);
      tamer.port.postMessage({ type: "params", params: tamerParams(s, b) } satisfies ToTamer);
      multiband.port.postMessage({ type: "params", params: multibandParams(s, b) } satisfies ToMultiband);
      compressor.port.postMessage({ type: "params", params: compressorParams(s, b) } satisfies ToCompressor);
      color.port.postMessage({ type: "params", params: colorParams(s, b) } satisfies ToColor);
      limiter.port.postMessage({ type: "params", params: limiterParams(s, b) } satisfies ToLimiter);
    },
  };
}
