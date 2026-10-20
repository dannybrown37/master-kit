/** Live playback: one song through the mastering chain, with loudness-matched A/B and per-module bypass. */
import { LISTENS, LoudnessMatch, monitorGains } from "../master/monitor.ts";
import type { Listen, StreamDb } from "../master/monitor.ts";
import { contentBounds } from "../analysis/edges.ts";
import { edgeAutomation } from "../dsp/edges.ts";
import type { Bounds } from "../dsp/edges.ts";
import { EDGE_KEYS, clampParam, defaultSettings, edgeParams, noBypass } from "../master/settings.ts";
import type { Bypass, Module, ParamKey, Settings } from "../master/settings.ts";
import type { Snapshot } from "../master/snapshot.ts";
import { buildChain, loadWorklets } from "./chain.ts";
import type { Chain } from "./chain.ts";
import { REPORT_SECONDS } from "./messages.ts";
import type { FromDynamics, FromMeter, MeterReading, ToMeter } from "./messages.ts";
import { Transport, startDelay } from "./transport.ts";
import { Ring } from "../master/ring.ts";

const SWITCH_SECONDS = 0.005;
const FFT_SIZE = 8192;
const GR_HISTORY_SECONDS = 10;
/** A band on its own is much quieter than the full mix; +6 dB makes it easier to hear. */
const SOLO_GAIN = 2;
const SPECTRUM_SMOOTHING = 0.85;
/** Number of bins `spectrum()` fills. */
export const SPECTRUM_BINS = FFT_SIZE / 2;
const SILENT: MeterReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, peak: -Infinity, truePeak: -Infinity, correlation: NaN, sideDb: NaN };

/** The modules that turn the song down, and so have a GR meter. */
export type Dynamics = Exclude<Module, "eq" | "edges">;
export const DYNAMICS: readonly Dynamics[] = ["tame", "multi", "comp", "color", "limiter"];
export function isDynamics(module: Module): module is Dynamics {
  return (DYNAMICS as readonly Module[]).includes(module);
}
const DYNAMICS_NODE = { tame: "tamer", multi: "multiband", comp: "compressor", color: "color", limiter: "limiter" } as const satisfies Record<Dynamics, keyof Chain>;

/** Gain reduction now (dB); `bands` = per band, for the modules that have bands (multiband: low, mid, high; tamer: 1, 2). */
export type Reduction = Record<Dynamics, number> & { bands: Partial<Record<Dynamics, number[]>> };

export interface EngineState {
  playing: boolean;
  position: number;
  duration: number;
  listen: Listen;
  matchDb: number;
  bypass: Bypass;
  settings: Settings;
  original: MeterReading;
  master: MeterReading;
  /** The reference's own level (before its match gain); it plays, silently, whenever the song does. */
  reference: MeterReading;
  reduction: Reduction;
  hasReference: boolean;
  /** Gain on the reference so it matches the master's loudness. */
  referenceDb: number;
  /** Listening summed to mono. */
  mono: boolean;
  /** Centre of the soloed EQ band (Hz), or null. */
  solo: number | null;
  /** The snapshot chain's level (before its match gain). */
  snapshot: MeterReading;
  /** Saved knobs running on a second chain, or null. */
  snapshotKnobs: Snapshot | null;
  /** Gain on the snapshot so it matches the master's loudness. */
  snapshotDb: number;
  /** Streaming preview gains, or null (comparisons loudness-matched). */
  stream: StreamDb | null;
}

export class Engine {
  readonly ctx: AudioContext;
  private readonly chain: Chain;
  private readonly wet: GainNode;
  /** The Edges fades, on the master only (meters tap before it). */
  private readonly edgeGain: GainNode;
  /** Where the song's sound starts and stops (s). */
  private edgeBounds: Bounds = { start: 0, end: 0 };
  private readonly dry: GainNode;
  private readonly refGain: GainNode;
  private readonly stereoOut: GainNode;
  private readonly monoOut: GainNode;
  private mono = false;
  private readonly direct: GainNode;
  private readonly soloFilter: BiquadFilterNode;
  private readonly soloGain: GainNode;
  private solo: { frequency: number; q: number } | null = null;
  private refBuffer: AudioBuffer | null = null;
  private refSource: AudioBufferSourceNode | null = null;
  private referenceDb = 0;
  private stream: StreamDb | null = null;
  private readonly refIn: GainNode;
  private readonly meters: Record<Listen, AudioWorkletNode>;
  private readonly analysers: Record<Listen, AnalyserNode>;
  private readonly match = new LoudnessMatch();
  private readonly snapChain: Chain;
  private readonly snapGain: GainNode;
  private readonly snapMatch = new LoudnessMatch();
  private snapshot: Snapshot | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private transport = new Transport(0);
  private settings: Settings = defaultSettings();
  private bypass: Bypass = noBypass();
  private listen: Listen = "master";
  private readings: Record<Listen, MeterReading> = { original: SILENT, master: SILENT, reference: SILENT, snapshot: SILENT };
  private reduction: Reduction = { tame: 0, multi: 0, comp: 0, color: 0, limiter: 0, bands: {} };
  /** Gain reduction (dB) every REPORT_SECONDS while playing, the last GR_HISTORY_SECONDS. */
  readonly grHistory = Object.fromEntries(DYNAMICS.map((m) => [m, new Ring(GR_HISTORY_SECONDS / REPORT_SECONDS)])) as Record<Dynamics, Ring>;
  /** Called whenever meters or transport change. */
  onChange: (state: EngineState) => void = () => {};

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.chain = buildChain(ctx, this.settings, this.bypass);
    const bus = new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit" });
    this.stereoOut = new GainNode(ctx, { gain: 1 });
    // One channel with "speakers" mixing = (L+R)/2; the destination copies it to both speakers.
    this.monoOut = new GainNode(ctx, { gain: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    // bus ─┬─ direct ──────────────────┬─ monitor ─► stereo / mono ─► speakers
    //      └─ bandpass ─► solo gain ───┘  (solo: hear only one EQ band's frequencies)
    const monitor = new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit" });
    monitor.connect(this.stereoOut).connect(ctx.destination);
    monitor.connect(this.monoOut).connect(ctx.destination);
    this.direct = new GainNode(ctx, { gain: 1 });
    bus.connect(this.direct).connect(monitor);
    this.soloFilter = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 1000, Q: 1 });
    this.soloGain = new GainNode(ctx, { gain: 0 });
    bus.connect(this.soloFilter).connect(this.soloGain).connect(monitor);
    this.wet = new GainNode(ctx, { gain: 1 });
    this.dry = new GainNode(ctx, { gain: 0 });
    this.edgeGain = new GainNode(ctx, { gain: 1 });
    this.chain.master.connect(this.edgeGain).connect(this.wet).connect(bus);
    this.chain.original.connect(this.dry).connect(bus);
    // Same latency as the main chain, so switching to the snapshot stays sample-aligned.
    this.snapChain = buildChain(ctx, this.settings, this.bypass);
    this.snapGain = new GainNode(ctx, { gain: 0 });
    this.snapChain.master.connect(this.snapGain).connect(bus);
    // A port nobody listens to queues its GR reports forever; a handler starts it so they are dropped.
    for (const module of DYNAMICS) this.snapChain[DYNAMICS_NODE[module]].port.onmessage = (): void => {};
    this.refGain = new GainNode(ctx, { gain: 0 });
    this.refGain.connect(bus);
    this.refIn = new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit" });
    this.refIn.connect(this.refGain);
    const meter = (): AudioWorkletNode => new AudioWorkletNode(ctx, "meter", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit" });
    this.meters = { original: meter(), master: meter(), reference: meter(), snapshot: meter() };
    const analyser = (): AnalyserNode => new AnalyserNode(ctx, { fftSize: FFT_SIZE, smoothingTimeConstant: SPECTRUM_SMOOTHING });
    this.analysers = { original: analyser(), master: analyser(), reference: analyser(), snapshot: analyser() };
    const taps: Record<Listen, AudioNode> = { original: this.chain.original, master: this.chain.master, reference: this.refIn, snapshot: this.snapChain.master };
    for (const which of LISTENS) {
      taps[which].connect(this.meters[which]);
      taps[which].connect(this.analysers[which]);
      this.listenTo(this.meters[which], which);
    }
    for (const module of DYNAMICS) {
      this.chain[DYNAMICS_NODE[module]].port.onmessage = (ev: MessageEvent<FromDynamics>): void => {
        this.reduction[module] = ev.data.db;
        if (ev.data.bands) this.reduction.bands[module] = ev.data.bands;
        if (this.transport.playing) this.grHistory[module].push(ev.data.db);
      };
    }
  }

  static async create(): Promise<Engine> {
    const ctx = new AudioContext({ latencyHint: "playback" });
    await loadWorklets(ctx);
    return new Engine(ctx);
  }

  private listenTo(node: AudioWorkletNode, which: Listen): void {
    node.port.onmessage = (ev: MessageEvent<FromMeter>): void => {
      this.readings[which] = ev.data.reading;
      if (which === "master") {
        this.match.update(this.readings.original.shortTerm, this.readings.master.shortTerm, REPORT_SECONDS);
        if (this.snapshot) this.snapMatch.update(this.readings.snapshot.shortTerm, this.readings.master.shortTerm, REPORT_SECONDS);
        if (this.listen === "original" || this.listen === "snapshot") this.applyMonitor();
        this.onChange(this.state);
      }
    };
  }

  get state(): EngineState {
    const now = this.ctx.currentTime;
    return {
      playing: this.transport.playing,
      position: this.transport.position(now),
      duration: this.transport.duration,
      listen: this.listen,
      matchDb: this.match.db,
      bypass: { ...this.bypass },
      settings: { ...this.settings },
      original: this.readings.original,
      master: this.readings.master,
      reference: this.readings.reference,
      reduction: { ...this.reduction, bands: { ...this.reduction.bands } },
      hasReference: this.refBuffer !== null,
      referenceDb: this.referenceDb,
      mono: this.mono,
      solo: this.solo?.frequency ?? null,
      snapshot: this.readings.snapshot,
      snapshotKnobs: this.snapshot && { settings: { ...this.snapshot.settings }, bypass: { ...this.snapshot.bypass } },
      snapshotDb: this.snapMatch.db,
      stream: this.stream,
    };
  }

  /** Runs `settings` on the second chain, to compare with the knobs at matched loudness (`toggleSnapshot`). */
  setSnapshot(settings: Settings, bypass: Bypass): void {
    if (!this.snapshot) this.source?.connect(this.snapChain.input);
    this.snapshot = { settings: { ...settings }, bypass: { ...bypass } };
    this.snapChain.apply(this.snapshot.settings, this.snapshot.bypass);
    this.snapMatch.reset();
    this.resetMeter("snapshot");
    this.onChange(this.state);
  }

  clearSnapshot(): void {
    if (this.snapshot) this.source?.disconnect(this.snapChain.input);
    this.snapshot = null;
    this.snapMatch.reset();
    this.resetMeter("snapshot");
    if (this.listen === "snapshot") this.setListen("master");
    this.onChange(this.state);
  }

  toggleSnapshot(): void {
    if (this.snapshot) this.setListen(this.listen === "snapshot" ? "master" : "snapshot");
  }

  /** The knobs and the snapshot trade places; you keep hearing the same sound (the listen side flips with it). */
  swapSnapshot(): void {
    const snap = this.snapshot;
    if (!snap) return;
    this.snapshot = { settings: { ...this.settings }, bypass: { ...this.bypass } };
    this.settings = { ...snap.settings };
    this.bypass = { ...snap.bypass };
    this.chain.apply(this.settings, this.bypass);
    this.snapChain.apply(this.snapshot.settings, this.snapshot.bypass);
    this.snapMatch.swap();
    this.resetMeter("master");
    this.resetMeter("snapshot");
    if (this.listen === "snapshot" || this.listen === "master") this.setListen(this.listen === "snapshot" ? "master" : "snapshot");
    this.onChange(this.state);
  }

  /** Live spectrum (dB per bin, mono sum, before any match gain) into `out` (length SPECTRUM_BINS). */
  spectrum(which: Listen, out: Float32Array<ArrayBuffer>): void {
    this.analysers[which].getFloatFrequencyData(out);
  }

  get reference(): AudioBuffer | null {
    return this.refBuffer;
  }

  /** The reference plays in sync with the song (looping if shorter) whenever you listen to it. */
  async loadReference(data: ArrayBuffer): Promise<AudioBuffer> {
    const buffer = await this.ctx.decodeAudioData(data);
    const wasPlaying = this.transport.playing;
    if (wasPlaying) this.pause();
    this.refBuffer = buffer;
    this.resetMeter("reference");
    if (wasPlaying) await this.play();
    this.onChange(this.state);
    return buffer;
  }

  clearReference(): void {
    this.refSource?.stop();
    this.refSource?.disconnect();
    this.refSource = null;
    this.refBuffer = null;
    this.resetMeter("reference");
    if (this.listen === "reference") this.setListen("master");
    this.onChange(this.state);
  }

  /** Gain (dB) applied to the reference so it plays at the master's loudness. */
  setReferenceMatch(db: number): void {
    this.referenceDb = db;
    this.applyMonitor();
  }

  /** Streaming preview: every source plays at the platform's gain for it (null = back to loudness-matched). */
  setStream(stream: StreamDb | null): void {
    this.stream = stream && { ...stream };
    this.applyMonitor();
    this.onChange(this.state);
  }

  toggleReference(): void {
    if (this.refBuffer) this.setListen(this.listen === "reference" ? "master" : "reference");
  }

  get loaded(): AudioBuffer | null {
    return this.buffer;
  }

  async load(data: ArrayBuffer): Promise<void> {
    this.stopSource();
    const buffer = await this.ctx.decodeAudioData(data);
    this.buffer = buffer;
    const { start, end } = contentBounds(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)));
    this.edgeBounds = { start: start / buffer.sampleRate, end: end / buffer.sampleRate };
    this.transport = new Transport(buffer.duration);
    this.clearSnapshot();
    this.resetMeters();
    this.match.reset();
    for (const module of DYNAMICS) this.grHistory[module].clear();
    this.onChange(this.state);
  }

  async play(): Promise<void> {
    if (!this.buffer || this.transport.playing) return;
    const woke = this.ctx.state !== "running";
    await this.ctx.resume();
    const leadIn = Math.max(0, edgeParams(this.settings, this.bypass).lead - this.edgeBounds.start);
    const from = this.transport.play(this.ctx.currentTime, (f) => startDelay(f, woke, leadIn));
    const at = this.transport.startTime;
    this.scheduleEdges();
    const source = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer });
    source.connect(this.chain.input);
    if (this.snapshot) source.connect(this.snapChain.input);
    source.onended = (): void => {
      if (this.source !== source) return;
      this.source = null;
      this.transport.pause(this.ctx.currentTime);
      this.onChange(this.state);
    };
    source.start(at, from);
    this.source = source;
    if (this.refBuffer) {
      const ref = new AudioBufferSourceNode(this.ctx, { buffer: this.refBuffer, loop: true });
      ref.connect(this.refIn);
      ref.start(at, from % this.refBuffer.duration);
      this.refSource = ref;
    }
    this.onChange(this.state);
  }

  pause(): void {
    this.transport.pause(this.ctx.currentTime);
    this.stopSource();
    this.scheduleEdges();
    this.onChange(this.state);
  }

  /** Fades as gain automation from where the song is now; the master path is `latencySeconds` behind the source. */
  private scheduleEdges(): void {
    const gain = this.edgeGain.gain;
    const now = this.ctx.currentTime;
    gain.cancelScheduledValues(0);
    if (!this.transport.playing) {
      gain.setValueAtTime(1, now);
      return;
    }
    const at = Math.max(now, this.transport.startTime);
    const from = this.transport.position(at);
    const { initial, curves } = edgeAutomation(from, this.edgeBounds, edgeParams(this.settings, this.bypass));
    gain.setValueAtTime(initial, now);
    const songStart = at + this.chain.latencySeconds - from;
    for (const c of curves) gain.setValueCurveAtTime(c.values, songStart + c.at, c.duration);
  }

  async toggle(): Promise<void> {
    if (this.transport.playing) this.pause();
    else await this.play();
  }

  async seek(seconds: number): Promise<void> {
    const wasPlaying = this.transport.playing;
    this.pause();
    this.transport.seek(seconds, this.ctx.currentTime);
    this.resetMeters();
    if (wasPlaying) await this.play();
    else this.onChange(this.state);
  }

  set(key: ParamKey, value: number): number {
    this.settings[key] = clampParam(key, value);
    this.chain.apply(this.settings, this.bypass);
    if ((EDGE_KEYS as readonly string[]).includes(key)) this.scheduleEdges();
    this.onChange(this.state);
    return this.settings[key];
  }

  setAll(settings: Settings): void {
    this.settings = { ...settings };
    this.chain.apply(this.settings, this.bypass);
    this.scheduleEdges();
    this.onChange(this.state);
  }

  toggleBypass(module: Module): void {
    this.setBypass({ ...this.bypass, [module]: !this.bypass[module] });
  }

  setBypass(bypass: Bypass): void {
    this.bypass = { ...bypass };
    this.chain.apply(this.settings, this.bypass);
    this.scheduleEdges();
    this.onChange(this.state);
  }

  setListen(listen: Listen): void {
    this.listen = listen;
    this.applyMonitor();
    this.onChange(this.state);
  }

  toggleAB(): void {
    this.setListen(this.listen === "master" ? "original" : "master");
  }

  /** Hear only the frequencies around one EQ band (null = everything). Follows the band if called again while on. */
  setSolo(band: { frequency: number; q: number } | null): void {
    const was = this.solo;
    this.solo = band;
    const at = this.ctx.currentTime;
    if (band) {
      this.soloFilter.frequency.setTargetAtTime(band.frequency, at, SWITCH_SECONDS);
      this.soloFilter.Q.setTargetAtTime(band.q, at, SWITCH_SECONDS);
    }
    if (!!was !== !!band) {
      this.direct.gain.setTargetAtTime(band ? 0 : 1, at, SWITCH_SECONDS);
      this.soloGain.gain.setTargetAtTime(band ? SOLO_GAIN : 0, at, SWITCH_SECONDS);
      this.onChange(this.state);
    }
  }

  /** Mono check: what a phone speaker or a mono club PA plays. Applies to master, original and reference alike. */
  toggleMono(): void {
    this.mono = !this.mono;
    const at = this.ctx.currentTime;
    this.stereoOut.gain.setTargetAtTime(this.mono ? 0 : 1, at, SWITCH_SECONDS);
    this.monoOut.gain.setTargetAtTime(this.mono ? 1 : 0, at, SWITCH_SECONDS);
    this.onChange(this.state);
  }

  private applyMonitor(): void {
    const { wet, dry, ref, snap } = monitorGains(this.listen, { original: this.match.db, reference: this.referenceDb, snapshot: this.snapMatch.db }, this.stream);
    const at = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(wet, at, SWITCH_SECONDS);
    this.dry.gain.setTargetAtTime(dry, at, SWITCH_SECONDS);
    this.refGain.gain.setTargetAtTime(ref, at, SWITCH_SECONDS);
    this.snapGain.gain.setTargetAtTime(snap, at, SWITCH_SECONDS);
  }

  /** Starts integrated loudness and true-peak hold over (also done on load and seek). */
  resetMeters(): void {
    for (const which of LISTENS) this.resetMeter(which);
    this.onChange(this.state);
  }

  private resetMeter(which: Listen): void {
    this.meters[which].port.postMessage({ type: "reset" } satisfies ToMeter);
    this.readings[which] = SILENT;
  }

  private stopSource(): void {
    for (const s of [this.source, this.refSource]) {
      s?.stop();
      s?.disconnect();
    }
    this.source = null;
    this.refSource = null;
  }
}
