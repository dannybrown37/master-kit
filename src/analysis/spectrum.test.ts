import { describe, expect, it } from "vitest";
import { ANALYSER_TILT_DB_PER_OCT, BANDS, bandEnergies, fft, relativeGaps, tiltedShares } from "./spectrum.ts";
import { SR, noise, rng, sine } from "./test-signals.ts";

function naiveDft(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      outIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
  }
  return [outRe, outIm];
}

describe("fft", () => {
  it.each([2, 8, 64])("matches a naive DFT for n=%d", (n) => {
    const r = rng(n);
    const re = Float64Array.from({ length: n }, () => r() - 0.5);
    const im = Float64Array.from({ length: n }, () => r() - 0.5);
    const [wantRe, wantIm] = naiveDft(re, im);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(wantRe[k], 9);
      expect(im[k]).toBeCloseTo(wantIm[k], 9);
    }
  });

  it("rejects non-power-of-two sizes", () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(RangeError);
  });
});

describe("band energies", () => {
  it("bands tile 20 Hz–20 kHz without gaps", () => {
    expect(BANDS[0].lo).toBe(20);
    expect(BANDS.at(-1)?.hi).toBe(20000);
    for (let i = 1; i < BANDS.length; i++) expect(BANDS[i].lo).toBe(BANDS[i - 1].hi);
  });

  it.each([
    [40, "sub"],
    [120, "low"],
    [350, "mud"],
    [1000, "mid"],
    [4000, "presence"],
    [10000, "air"],
  ])("a %d Hz sine lands in %s", (freq, key) => {
    const bands = bandEnergies([sine(freq, 2, -12)], SR);
    const loudest = bands.reduce((a, b) => (b.db > a.db ? b : a));
    expect(loudest.key).toBe(key);
    expect(loudest.db).toBeGreaterThan(-0.5);
  });

  it("shares are relative to the total, so they ignore overall level", () => {
    const quiet = bandEnergies([noise(2, -30)], SR);
    const loud = bandEnergies([noise(2, -6)], SR);
    quiet.forEach((b, i) => expect(b.db).toBeCloseTo(loud[i].db, 1));
  });

  it("white noise splits energy by bandwidth", () => {
    const bands = bandEnergies([noise(4, -6)], SR);
    const air = bands.find((b) => b.key === "air");
    expect(air?.db).toBeCloseTo(10 * Math.log10((20000 - 6000) / (20000 - 20)), 0);
  });

  it("averages channel power, so out-of-phase stereo still counts", () => {
    const left = sine(1000, 1, -12);
    const right = left.map((x) => -x);
    const mono = bandEnergies([left], SR);
    bandEnergies([left, right], SR).forEach((b, i) => expect(b.db).toBeCloseTo(mono[i].db, 6));
  });

  it.each([
    ["stereo", [sine(40, 2, -12), sine(10000, 2, -12)]],
    ["three channels", [sine(40, 2, -12), sine(10000, 2, -12), sine(1000, 2, -12)]],
  ])("keeps each channel's content apart (%s)", (_name, channels) => {
    const share = -10 * Math.log10(channels.length);
    const bands = bandEnergies(channels, SR);
    for (const key of ["sub", "air"]) expect(bands.find((b) => b.key === key)?.db).toBeCloseTo(share, 1);
  });

  it("is -Infinity everywhere for silence", () => {
    expect(bandEnergies([new Float32Array(SR)], SR).every((b) => b.db === -Infinity)).toBe(true);
  });
});

describe("tiltedShares", () => {
  const lo = BANDS[0].lo;
  const hi = BANDS.at(-1)?.hi ?? 0;
  it.each([
    ["white noise reads flat untilted: shares by bandwidth", 0, (b: (typeof BANDS)[number]) => (b.hi - b.lo) / (hi - lo)],
    ["pink noise reads flat at 3 dB/oct: shares by octaves", 10 * Math.log10(2), (b: (typeof BANDS)[number]) => Math.log(b.hi / b.lo) / Math.log(hi / lo)],
  ])("%s", (_name, tilt, share) => {
    tiltedShares(tilt).forEach((db, i) => expect(db).toBeCloseTo(10 * Math.log10(share(BANDS[i])), 6));
  });

  it("the analyser's tilt is darker than pink: the sub share is the biggest", () => {
    const shares = tiltedShares(ANALYSER_TILT_DB_PER_OCT);
    expect(Math.max(...shares)).toBe(shares[0]);
  });
});

describe("relativeGaps", () => {
  it.each([
    ["a uniform offset is no gap", [-5, -7, -9], [-3, -5, -7], [0, 0, 0]],
    ["one heavy band stands out", [-1, -10, -10, -10], [-5, -10, -10, -10], [4, 0, 0, 0]],
    ["even count: the median is the middle pair's mean", [0, 1, 2, 3], [0, 0, 0, 0], [-1.5, -0.5, 0.5, 1.5]],
  ])("%s", (_name, bands, target, want) => {
    relativeGaps(bands, target).forEach((g, i) => expect(g).toBeCloseTo(want[i], 9));
  });
});
