// Audio-thread processors: compressor, limiter and loudness meter, wrapping the DOM-free DSP classes.
import { LiveLoudness } from "../analysis/live.ts";
import { TruePeakMeter } from "../analysis/peak.ts";
import { LiveStereo } from "../analysis/stereo.ts";
import { Compressor } from "../dsp/compressor.ts";
import type { CompressorParams } from "../dsp/compressor.ts";
import { Limiter } from "../dsp/limiter.ts";
import type { LimiterParams } from "../dsp/limiter.ts";
import { Multiband } from "../dsp/multiband.ts";
import type { MultibandParams } from "../dsp/multiband.ts";
import { REPORT_SECONDS } from "./messages.ts";
import type { FromDynamics, FromMeter, ToMeter } from "./messages.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}

interface Processor {
  process(inputs: Float32Array[], outputs: Float32Array[]): void;
  reductionDb: number;
  readonly bandReductionDb?: readonly number[];
}

const QUANTUM = 128;
const REPORT_EVERY = Math.max(1, Math.round((REPORT_SECONDS * sampleRate) / QUANTUM));

/** Shared wrapper: runs a DSP processor on input 0 → output 0 and reports gain reduction. */
function dynamicsProcessor<P>(create: (params: P) => Processor & { setParams(p: P): void }): unknown {
  return class extends AudioWorkletProcessor {
    private readonly dsp: Processor & { setParams(p: P): void };
    private blocks = 0;
    private worst = 0;
    private readonly worstBands = [0, 0, 0];

    constructor(options: { processorOptions: { params: P } }) {
      super(options);
      this.dsp = create(options.processorOptions.params);
      this.port.onmessage = (ev: MessageEvent<{ type: "params"; params: P }>): void => this.dsp.setParams(ev.data.params);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const input = inputs[0];
      const output = outputs[0];
      const frames = output[0]?.length ?? QUANTUM;
      const channels = output.map((_, c) => input[c] ?? input[0] ?? new Float32Array(frames));
      this.dsp.process(channels, output);
      this.worst = Math.max(this.worst, this.dsp.reductionDb);
      const bands = this.dsp.bandReductionDb;
      if (bands) for (let i = 0; i < bands.length; i++) this.worstBands[i] = Math.max(this.worstBands[i], bands[i]);
      if (++this.blocks % REPORT_EVERY === 0) {
        this.port.postMessage({ type: "reduction", db: this.worst, ...(bands ? { bands: [...this.worstBands] } : {}) } satisfies FromDynamics);
        this.worst = 0;
        this.worstBands.fill(0);
      }
      return true;
    }
  };
}

registerProcessor(
  "compressor",
  dynamicsProcessor<CompressorParams>((p) => new Compressor(sampleRate, p)),
);
registerProcessor(
  "multiband",
  dynamicsProcessor<MultibandParams>((p) => new Multiband(sampleRate, p)),
);
registerProcessor(
  "limiter",
  dynamicsProcessor<LimiterParams>((p) => new Limiter(sampleRate, p)),
);

class MeterProcessor extends AudioWorkletProcessor {
  private readonly meter = new LiveLoudness(sampleRate);
  private readonly truePeak = new TruePeakMeter(sampleRate);
  private readonly stereo = new LiveStereo(sampleRate);
  private blocks = 0;
  private peak = -Infinity;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToMeter>): void => {
      if (ev.data.type === "reset") {
        this.meter.reset();
        this.truePeak.reset();
        this.stereo.reset();
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      this.meter.push(input);
      this.truePeak.push(input);
      this.stereo.push(input);
      this.peak = Math.max(this.peak, this.meter.peak);
    }
    if (++this.blocks % REPORT_EVERY === 0) {
      const { momentary, shortTerm, integrated } = this.meter;
      const { correlation, sideDb } = this.stereo.image;
      const reading = { momentary, shortTerm, integrated, peak: this.peak, truePeak: this.truePeak.max, correlation, sideDb };
      this.port.postMessage({ type: "meter", reading } satisfies FromMeter);
      this.peak = -Infinity;
    }
    return true;
  }
}

registerProcessor("meter", MeterProcessor);
