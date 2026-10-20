import { describe, expect, it } from "vitest";
import { Compressor, gainComputer } from "./compressor.ts";
import type { CompressorParams } from "./compressor.ts";
import { SR, concat, dbToAmp } from "../analysis/test-signals.ts";

const BASE: CompressorParams = { thresholdDb: -18, ratio: 4, kneeDb: 0, attackMs: 10, releaseMs: 100, makeupDb: 0, sidechainHz: 0, rmsMs: 0 };

function tone(freq: number, seconds: number, db: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => dbToAmp(db) * Math.sin((2 * Math.PI * freq * i) / SR));
}

function square(seconds: number, db: number): Float32Array {
  const amp = dbToAmp(db);
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => (Math.floor(i / 50) % 2 ? amp : -amp));
}

function run(comp: Compressor, channels: Float32Array[], block = 128): Float32Array[] {
  const out = channels.map((c) => new Float32Array(c.length));
  for (let s = 0; s < channels[0].length; s += block) {
    const e = Math.min(s + block, channels[0].length);
    comp.process(
      channels.map((c) => c.subarray(s, e)),
      out.map((c) => c.subarray(s, e)),
    );
  }
  return out;
}

function levelDb(x: Float32Array, from: number): number {
  let peak = 0;
  for (let i = from; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  return 20 * Math.log10(peak);
}

describe("gainComputer (static curve, Giannoulis et al. 2012)", () => {
  it.each([
    ["below threshold", -30, 0, -30],
    ["at threshold, hard knee", -18, 0, -18],
    ["above threshold, hard knee", -6, 0, -15],
    ["below the knee", -24, 6, -24],
    ["at threshold, inside the knee", -18, 6, -18 + (1 / 4 - 1) * (6 / 8)],
    ["above the knee", -6, 6, -15],
  ])("%s: %d dB in → expected out", (_name, input, kneeDb, want) => {
    expect(gainComputer(input, { ...BASE, kneeDb })).toBeCloseTo(want, 9);
  });

  it.each([-21, -15])("is continuous at the knee edge %d dB", (edge) => {
    const p = { ...BASE, kneeDb: 6 };
    expect(gainComputer(edge - 1e-9, p)).toBeCloseTo(gainComputer(edge + 1e-9, p), 6);
  });
});

describe("Compressor", () => {
  it.each([
    ["4:1, -6 dBFS in", { ...BASE }, -6, -15],
    ["2:1, -6 dBFS in", { ...BASE, ratio: 2 }, -6, -12],
    ["makeup +3 dB", { ...BASE, makeupDb: 3 }, -6, -12],
    ["below threshold passes", { ...BASE }, -24, -24],
    ["ratio 1 passes", { ...BASE, ratio: 1 }, -6, -6],
  ])("settles on the static curve: %s", (_name, params, input, want) => {
    const comp = new Compressor(SR, params);
    const [out] = run(comp, [square(1, input)]);
    expect(levelDb(out, SR / 2)).toBeCloseTo(want, 2);
    expect(comp.reductionDb).toBeCloseTo(Math.max(0, input - want + params.makeupDb), 2);
  });

  it("attack: reaches 63% of the final 9 dB reduction after attackMs", () => {
    const comp = new Compressor(SR, BASE);
    run(comp, [square(BASE.attackMs / 1000, -6)]);
    expect(comp.reductionDb).toBeCloseTo(9 * (1 - Math.exp(-1)), 1);
  });

  it("release: falls to 37% of the reduction releaseMs after the signal drops", () => {
    const comp = new Compressor(SR, BASE);
    run(comp, [square(0.5, -6)]);
    run(comp, [square(BASE.releaseMs / 1000, -30)]);
    expect(comp.reductionDb).toBeCloseTo(9 * Math.exp(-1), 1);
  });

  it("links stereo: a loud left channel turns the right down too", () => {
    const comp = new Compressor(SR, BASE);
    const [, right] = run(comp, [square(1, -6), square(1, -30)]);
    expect(levelDb(right, SR / 2)).toBeCloseTo(-39, 2);
  });

  it.each([
    ["peak", BASE],
    ["RMS", { ...BASE, rmsMs: 30 }],
  ])("gives the same output for any block size (%s)", (_name, params) => {
    const input = [concat(square(0.3, -30), square(0.3, -3), square(0.3, -20))];
    const a = run(new Compressor(SR, params), input, 128);
    const b = run(new Compressor(SR, params), input, 1000);
    expect(b[0]).toEqual(a[0]);
  });

  it("RMS reads a sine 3.01 dB under its peak", () => {
    // -6 dBFS peak → -9.01 dB RMS: 8.99 dB over a -18 threshold, 4:1 takes away 3/4 of that.
    const comp = new Compressor(SR, { ...BASE, rmsMs: 30 });
    run(comp, [tone(1000, 1, -6)]);
    expect(comp.reductionDb).toBeCloseTo((12 - 3.0103) * (3 / 4), 1);
  });

  it("RMS: a square wave (RMS = peak) settles on the same curve as peak detection", () => {
    const comp = new Compressor(SR, { ...BASE, rmsMs: 30 });
    const [out] = run(comp, [square(1, -6)]);
    expect(levelDb(out, SR / 2)).toBeCloseTo(-15, 1);
  });

  it("RMS: a short click barely moves it, unlike the peak detector", () => {
    const click = concat(new Float32Array(SR / 10), square(0.001, -3), new Float32Array(SR / 100));
    const peakComp = new Compressor(SR, { ...BASE, attackMs: 0.1 });
    const rmsComp = new Compressor(SR, { ...BASE, attackMs: 0.1, rmsMs: 50 });
    const most = (comp: Compressor): number => {
      let max = 0;
      for (let s = 0; s < click.length; s += 16) {
        comp.process([click.subarray(s, s + 16)], [new Float32Array(Math.min(16, click.length - s))]);
        max = Math.max(max, comp.reductionDb);
      }
      return max;
    };
    expect(most(peakComp)).toBeGreaterThan(10);
    expect(most(rmsComp)).toBeLessThan(1);
  });

  it("RMS is stereo-linked like the peak detector", () => {
    const comp = new Compressor(SR, { ...BASE, rmsMs: 30 });
    const [, right] = run(comp, [square(1, -6), square(1, -30)]);
    expect(levelDb(right, SR / 2)).toBeCloseTo(-39, 1);
  });

  it("can process in place", () => {
    const x = square(0.5, -6);
    const expected = run(new Compressor(SR, BASE), [x.slice()])[0];
    new Compressor(SR, BASE).process([x], [x]);
    expect(x).toEqual(expected);
  });

  it.each([
    ["50 Hz bass mostly stops triggering it", 50, 0, 0.3],
    ["2 kHz triggers it as before", 2000, 0.97, 1.01],
  ])("sidechain high-pass at 150 Hz: %s", (_name, freq, lo, hi) => {
    const tone = Float32Array.from({ length: SR }, (_, i) => dbToAmp(-6) * Math.sin((2 * Math.PI * freq * i) / SR));
    const reduction = (sidechainHz: number): number => {
      const comp = new Compressor(SR, { ...BASE, sidechainHz });
      run(comp, [tone]);
      return comp.reductionDb;
    };
    const ratio = reduction(150) / reduction(0);
    expect(ratio).toBeGreaterThanOrEqual(lo);
    expect(ratio).toBeLessThanOrEqual(hi);
  });

  it("sidechain filter only changes the detector: the bass still comes through", () => {
    const comp = new Compressor(SR, { ...BASE, sidechainHz: 150 });
    const tone = Float32Array.from({ length: SR }, (_, i) => dbToAmp(-6) * Math.sin((2 * Math.PI * 50 * i) / SR));
    const [out] = run(comp, [tone]);
    expect(levelDb(out, SR / 2)).toBeGreaterThan(-7.5);
  });

  it("applies new params mid-stream", () => {
    const comp = new Compressor(SR, BASE);
    run(comp, [square(0.5, -6)]);
    comp.setParams({ ...BASE, ratio: 1 });
    const [out] = run(comp, [square(1, -6)]);
    expect(levelDb(out, SR / 2)).toBeCloseTo(-6, 2);
  });
});
