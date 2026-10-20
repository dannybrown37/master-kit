import { KFilter, MOMENTARY_HOPS, SHORT_TERM_HOPS, hopLength, integratedFromBlocks, powerToLufs } from "./loudness.ts";
import { samplePeak } from "./peak.ts";

/** Streaming BS.1770 meter: same numbers as `loudness()`, fed one block at a time (e.g. 128-frame render quanta). */
export class LiveLoudness {
  private readonly sampleRate: number;
  private readonly hop: number;
  private readonly filters: KFilter[] = [];
  private readonly recent = new Float64Array(SHORT_TERM_HOPS);
  private hops = 0;
  private partial = 0;
  private filled = 0;
  private blockPowers: number[] = [];
  /** dBFS of the most recent push. */
  peak = -Infinity;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.hop = hopLength(sampleRate);
  }

  push(channels: Float32Array[]): void {
    while (this.filters.length < channels.length) this.filters.push(new KFilter(this.sampleRate));
    this.peak = samplePeak(channels);
    const n = channels[0]?.length ?? 0;
    let at = 0;
    while (at < n) {
      const end = Math.min(n, at + this.hop - this.filled);
      for (let c = 0; c < channels.length; c++) this.partial += this.filters[c].energy(channels[c], at, end);
      this.filled += end - at;
      at = end;
      if (this.filled === this.hop) this.completeHop();
    }
  }

  private completeHop(): void {
    this.recent[this.hops % SHORT_TERM_HOPS] = this.partial;
    this.hops++;
    this.partial = 0;
    this.filled = 0;
    if (this.hops >= MOMENTARY_HOPS) this.blockPowers.push(this.windowPower(MOMENTARY_HOPS));
  }

  private windowPower(width: number): number {
    let sum = 0;
    for (let i = 1; i <= width; i++) sum += this.recent[(this.hops - i) % SHORT_TERM_HOPS];
    return Math.max(sum, 0) / (width * this.hop);
  }

  get momentary(): number {
    return this.hops >= MOMENTARY_HOPS ? powerToLufs(this.windowPower(MOMENTARY_HOPS)) : -Infinity;
  }

  get shortTerm(): number {
    return this.hops >= SHORT_TERM_HOPS ? powerToLufs(this.windowPower(SHORT_TERM_HOPS)) : -Infinity;
  }

  get integrated(): number {
    return integratedFromBlocks(this.blockPowers);
  }

  reset(): void {
    this.filters.length = 0;
    this.recent.fill(0);
    this.hops = 0;
    this.partial = 0;
    this.filled = 0;
    this.blockPowers = [];
    this.peak = -Infinity;
  }
}
