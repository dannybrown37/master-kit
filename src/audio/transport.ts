/** Play/pause/seek bookkeeping against an external clock (AudioContext.currentTime), in seconds. */

/** Audio devices (Windows, Bluetooth) can take this long to wake up and drop whatever plays meanwhile. */
export const PREROLL_SECONDS = 0.1;

/**
 * How long to wait before the song starts. From the top it always waits (the first hit is what gets swallowed),
 * at least `leadIn` (the Edges lead-in still missing from the file); mid-song only if the device just woke.
 */
export function startDelay(from: number, woke: boolean, leadIn: number): number {
  if (from <= 0) return Math.max(PREROLL_SECONDS, leadIn);
  return woke ? PREROLL_SECONDS : 0;
}

export class Transport {
  readonly duration: number;
  playing = false;
  private offset = 0;
  private startedAt = 0;

  constructor(duration: number) {
    this.duration = duration;
  }

  /** Clock time the song (re)started or will start, after any delay. */
  get startTime(): number {
    return this.startedAt;
  }

  position(now: number): number {
    const raw = this.playing ? this.offset + Math.max(0, now - this.startedAt) : this.offset;
    return Math.min(this.duration, Math.max(0, raw));
  }

  ended(now: number): boolean {
    return this.position(now) >= this.duration;
  }

  /** Returns the song position playback starts from; `delay(from)` = seconds until the audio starts. */
  play(now: number, delay: (from: number) => number = () => 0): number {
    if (this.offset >= this.duration) this.offset = 0;
    this.startedAt = now + delay(this.offset);
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
