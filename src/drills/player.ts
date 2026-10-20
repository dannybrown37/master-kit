/** Loops A and B in sync; switching sides is a 5 ms crossfade, so you hear only the difference. */
import type { DrillClips } from "../audio/drill-render.ts";

export type Side = "A" | "B";

const FADE_SECONDS = 0.005;

export class ClipPlayer {
  private readonly ctx: AudioContext;
  private clips: DrillClips | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private gains: { a: GainNode; b: GainNode } | null = null;
  side: Side = "A";

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  load(clips: DrillClips): void {
    this.stop();
    this.clips = clips;
    this.side = "A";
  }

  async play(): Promise<void> {
    if (!this.clips || this.playing) return;
    await this.ctx.resume();
    const ga = new GainNode(this.ctx, { gain: this.side === "A" ? this.clips.gains.a : 0 });
    const gb = new GainNode(this.ctx, { gain: this.side === "B" ? this.clips.gains.b : 0 });
    ga.connect(this.ctx.destination);
    gb.connect(this.ctx.destination);
    const at = this.ctx.currentTime + 0.05;
    const start = (buffer: AudioBuffer, gain: GainNode): AudioBufferSourceNode => {
      const s = new AudioBufferSourceNode(this.ctx, { buffer, loop: true });
      s.connect(gain);
      s.start(at);
      return s;
    };
    this.sources = [start(this.clips.a, ga), start(this.clips.b, gb)];
    this.gains = { a: ga, b: gb };
  }

  stop(): void {
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    this.sources = [];
    this.gains?.a.disconnect();
    this.gains?.b.disconnect();
    this.gains = null;
  }

  async toggle(): Promise<void> {
    if (this.playing) this.stop();
    else await this.play();
  }

  setSide(side: Side): void {
    this.side = side;
    if (!this.gains || !this.clips) return;
    const at = this.ctx.currentTime;
    this.gains.a.gain.setTargetAtTime(side === "A" ? this.clips.gains.a : 0, at, FADE_SECONDS);
    this.gains.b.gain.setTargetAtTime(side === "B" ? this.clips.gains.b : 0, at, FADE_SECONDS);
  }

  flip(): void {
    this.setSide(this.side === "A" ? "B" : "A");
  }
}
