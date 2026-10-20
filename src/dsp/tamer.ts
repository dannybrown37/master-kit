/**
 * Resonance tamer: up to two dynamic bell cuts. Each band listens to a narrow slice around its frequency and to the
 * wider neighbourhood around it; while the narrow slice sticks out more than a smooth spectrum would let it, the
 * slice is turned down (up to `depthDb`). A resonance that rings only on some notes is cut only on those notes.
 *
 *   x ─┬──────────────────────────────── − ─► y        cut: y = x − (1 − g)·BP(x)   (g = 1: untouched)
 *      └─ BP(f, Q) ─► × (1 − g) ─────────┘
 *   detector (mid): narrow BP(f, Q) power vs wide BP(f, 0.7) power → excess over a flat spectrum → g
 *
 * Stereo-linked (one gain from the mid). Neutral = bit-for-bit pass-through; switching off releases first.
 * DOM-free: runs in an AudioWorklet and in Node tests.
 */

export interface TamerBand {
  hz: number;
  /** Largest cut, dB; 0 = this band is off. */
  depthDb: number;
}

export interface TamerParams {
  /** Width of the cut and of the narrow detector: higher = narrower. */
  q: number;
  bands: TamerBand[];
}

export const NEUTRAL_TAMER: TamerParams = { q: 4, bands: [{ hz: 3000, depthDb: 0 }, { hz: 300, depthDb: 0 }] };

const WIDE_Q = 0.7;
/** How far past a flat spectrum the slice may stick out before it is cut (dB). */
const SLACK_DB = 2;
const ATTACK_MS = 5;
const RELEASE_MS = 80;
/** Gains are computed every STEP samples and ramped in between. */
const STEP = 16;
const SILENT_POWER = 1e-10;

export function isNeutralTamer(p: TamerParams): boolean {
  return p.bands.every((b) => b.depthDb <= 0);
}

/** RBJ band-pass with 0 dB peak gain, transposed direct form II; one state per channel. */
class BandPass {
  private b0 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1: Float64Array;
  private z2: Float64Array;

  constructor(channels: number) {
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);
  }

  design(hz: number, q: number, sampleRate: number): void {
    const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** b1 = 0 and b2 = −b0 for this band-pass. */
  step(c: number, x: number): number {
    const y = this.b0 * x + this.z1[c];
    this.z1[c] = -this.a1 * y + this.z2[c];
    this.z2[c] = -this.b0 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1.fill(0);
    this.z2.fill(0);
  }
}

interface BandState {
  narrow: BandPass;
  wide: BandPass;
  cut: BandPass;
  powerNarrow: number;
  powerWide: number;
  reductionDb: number;
  /** Linear gain ramp over the current STEP. */
  from: number;
  to: number;
}

function isIdle(b: BandState): boolean {
  return b.from === 1 && b.to === 1;
}

export class Tamer {
  reductionDb = 0;
  readonly bandReductionDb: number[];
  private readonly sampleRate: number;
  private params: TamerParams = NEUTRAL_TAMER;
  private active = false;
  private readonly bands: BandState[];
  private readonly attack: number;
  private readonly release: number;
  private readonly gainAttack: number;
  private readonly gainRelease: number;
  /** Flat spectrum: narrow/wide power = their bandwidth ratio. */
  private baselineDb = 0;
  private countdown = 0;

  constructor(sampleRate: number, params: TamerParams, channels = 2) {
    this.sampleRate = sampleRate;
    const coef = (ms: number, rate: number): number => Math.exp(-1000 / (ms * rate));
    this.attack = coef(ATTACK_MS, sampleRate);
    this.release = coef(RELEASE_MS, sampleRate);
    this.gainAttack = coef(ATTACK_MS, sampleRate / STEP);
    this.gainRelease = coef(RELEASE_MS, sampleRate / STEP);
    this.bands = params.bands.map(() => ({
      narrow: new BandPass(1),
      wide: new BandPass(1),
      cut: new BandPass(channels),
      powerNarrow: 0,
      powerWide: 0,
      reductionDb: 0,
      from: 1,
      to: 1,
    }));
    this.bandReductionDb = params.bands.map(() => 0);
    this.setParams(params);
  }

  setParams(p: TamerParams): void {
    const active = !isNeutralTamer(p);
    this.active = active;
    // Off: keep the frequencies, release the depth to 0 (no jump).
    this.params = active ? { q: p.q, bands: p.bands.map((b) => ({ ...b })) } : { ...this.params, bands: this.params.bands.map((b) => ({ ...b, depthDb: 0 })) };
    this.baselineDb = 10 * Math.log10(WIDE_Q / this.params.q);
    this.params.bands.forEach((b, i) => {
      const s = this.bands[i];
      // An idle band is skipped while off; when it comes on it starts from silence, not from stale filter state.
      if (b.depthDb > 0 && isIdle(s)) {
        s.narrow.reset();
        s.wide.reset();
        s.cut.reset();
        s.powerNarrow = 0;
        s.powerWide = 0;
      }
      s.narrow.design(b.hz, this.params.q, this.sampleRate);
      s.wide.design(b.hz, WIDE_Q, this.sampleRate);
      s.cut.design(b.hz, this.params.q, this.sampleRate);
    });
  }

  private idle(): boolean {
    return this.bands.every(isIdle);
  }

  private updateGain(b: BandState, depthDb: number): void {
    let target = 0;
    if (depthDb > 0 && b.powerWide > SILENT_POWER) {
      const excess = 10 * Math.log10(b.powerNarrow / b.powerWide) - this.baselineDb - SLACK_DB;
      target = Math.min(depthDb, Math.max(0, excess));
    }
    const k = target > b.reductionDb ? this.gainAttack : this.gainRelease;
    b.reductionDb = target + (b.reductionDb - target) * k;
    if (depthDb <= 0 && b.reductionDb < 1e-4) b.reductionDb = 0;
  }

  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    const n = inputs[0]?.length ?? 0;
    if (!this.active && this.idle()) {
      for (let c = 0; c < inputs.length; c++) outputs[c].set(inputs[c].subarray(0, n));
      this.reductionDb = 0;
      this.bandReductionDb.fill(0);
      return;
    }
    for (let c = 0; c < inputs.length; c++) outputs[c].set(inputs[c].subarray(0, n));
    const channels = inputs.length;
    let worst = 1;
    const worstBand = this.bands.map(() => 1);
    for (let i = 0; i < n; i++) {
      if (this.countdown === 0) {
        this.countdown = STEP;
        this.bands.forEach((b, bi) => {
          b.from = b.to;
          this.updateGain(b, this.params.bands[bi].depthDb);
          b.to = b.reductionDb === 0 ? 1 : 10 ** (-b.reductionDb / 20);
        });
      }
      const frac = (STEP - this.countdown) / STEP;
      this.countdown--;
      for (let bi = 0; bi < this.bands.length; bi++) {
        const b = this.bands[bi];
        if (this.params.bands[bi].depthDb <= 0 && isIdle(b)) continue;
        let mid = 0;
        for (let c = 0; c < channels; c++) mid += outputs[c][i];
        mid /= channels;
        const nb = b.narrow.step(0, mid);
        const wb = b.wide.step(0, mid);
        const pn = nb * nb;
        const pw = wb * wb;
        b.powerNarrow = pn + (b.powerNarrow - pn) * (pn > b.powerNarrow ? this.attack : this.release);
        b.powerWide = pw + (b.powerWide - pw) * (pw > b.powerWide ? this.attack : this.release);
        const g = b.from + (b.to - b.from) * frac;
        if (g === 1) {
          // Keep the cut filter's state current so a later cut starts smoothly.
          for (let c = 0; c < channels; c++) b.cut.step(c, outputs[c][i]);
          continue;
        }
        for (let c = 0; c < channels; c++) {
          const x = outputs[c][i];
          outputs[c][i] = x - (1 - g) * b.cut.step(c, x);
        }
        worstBand[bi] = Math.min(worstBand[bi], g);
        worst = Math.min(worst, g);
      }
    }
    worstBand.forEach((g, bi) => (this.bandReductionDb[bi] = -20 * Math.log10(g)));
    this.reductionDb = -20 * Math.log10(worst);
  }
}
