/** Play/pause/seek bookkeeping against an external clock (AudioContext.currentTime), in seconds. */
export class Transport {
  readonly duration: number;
  playing = false;
  private offset = 0;
  private startedAt = 0;

  constructor(duration: number) {
    this.duration = duration;
  }

  position(now: number): number {
    const raw = this.playing ? this.offset + (now - this.startedAt) : this.offset;
    return Math.min(this.duration, Math.max(0, raw));
  }

  ended(now: number): boolean {
    return this.position(now) >= this.duration;
  }

  /** Returns the song position playback starts from. */
  play(now: number): number {
    if (this.offset >= this.duration) this.offset = 0;
    this.startedAt = now;
    this.playing = true;
    return this.offset;
  }

  pause(now: number): void {
    this.offset = this.position(now);
    this.playing = false;
  }

  /** Returns the clamped position. */
  seek(to: number, now: number): number {
    this.offset = Number.isFinite(to) ? Math.min(this.duration, Math.max(0, to)) : 0;
    this.startedAt = now;
    return this.offset;
  }
}
