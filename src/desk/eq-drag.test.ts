import { describe, expect, it } from "vitest";
import { EQ_BAND_KNOBS, SHELF_SOLO_Q, bandEdges, dragToKnobs, nearestBand, plotX, plotFreq, soloBand } from "./eq-drag.ts";

const BOX = { width: 1000, height: 200, fMin: 20, fMax: 20000, rangeDb: 15 };

describe("soloBand", () => {
  const bands = [
    { type: "lowshelf", frequency: 100, gain: 0, q: 1 },
    { type: "peaking", frequency: 300, gain: -2, q: 1.4 },
    { type: "peaking", frequency: 3000, gain: 0, q: 0.5 },
    { type: "highshelf", frequency: 10000, gain: 0, q: 1 },
  ] as const;
  it.each([
    ["mud gain → the mud band at its Q", "eqMudGain", { frequency: 300, q: 1.4 }],
    ["presence Q knob counts too", "eqPresQ", { frequency: 3000, q: 0.5 }],
    ["shelves use a broad octave-ish band", "eqLowFreq", { frequency: 100, q: SHELF_SOLO_Q }],
    ["air shelf", "eqAirGain", { frequency: 10000, q: SHELF_SOLO_Q }],
    ["non-band knob: nothing to solo", "eqWidth", null],
    ["compressor knob: nothing to solo", "compRatio", null],
  ] as const)("%s", (_name, knob, want) => {
    expect(soloBand(knob, [...bands])).toEqual(want);
  });
});

describe("bandEdges", () => {
  it.each([
    // Q 1.414 ≈ 1 octave; Q 0.667 ≈ 2 octaves (RBJ: BW = 2/ln2 · asinh(1 / 2Q)).
    [1000, Math.SQRT2, 1],
    [1000, 2 / 3, 2],
  ])("%d Hz at Q %d spans about %d octave(s), centred in octaves", (f, q, octaves) => {
    const [lo, hi] = bandEdges(f, q);
    expect(Math.log2(hi / lo)).toBeCloseTo(octaves, 1);
    expect(Math.sqrt(lo * hi)).toBeCloseTo(f, 6);
  });
});

describe("eq drag mapping", () => {
  it.each([20, 200, 2000, 20000])("x ↔ frequency round-trips at %d Hz", (f) => {
    expect(plotFreq(plotX(f, BOX), BOX)).toBeCloseTo(f, 6);
  });

  it("x is logarithmic: each decade is a third of the width", () => {
    expect(plotX(200, BOX)).toBeCloseTo(1000 / 3, 6);
  });

  it.each([
    ["middle of the height is 0 dB", 1, 500, 100, { eqMudFreq: plotFreq(500, BOX), eqMudGain: 0 }],
    ["top is +15 dB", 1, 500, 0, { eqMudFreq: plotFreq(500, BOX), eqMudGain: 15 }],
    ["bottom is -15 dB", 3, 900, 200, { eqAirFreq: plotFreq(900, BOX), eqAirGain: -15 }],
  ] as const)("dragToKnobs: %s", (_name, band, x, y, want) => {
    expect(dragToKnobs(band, x, y, BOX)).toEqual(want);
  });

  it("maps every band to its freq and gain knobs", () => {
    expect(EQ_BAND_KNOBS).toEqual([
      { freq: "eqLowFreq", gain: "eqLowGain" },
      { freq: "eqMudFreq", gain: "eqMudGain", q: "eqMudQ" },
      { freq: "eqPresFreq", gain: "eqPresGain", q: "eqPresQ" },
      { freq: "eqAirFreq", gain: "eqAirGain" },
    ]);
  });

  it.each([
    ["on a dot", 300, 100, 1],
    ["near a dot", 310, 108, 1],
    ["too far from every dot", 600, 20, -1],
  ])("nearestBand: %s", (_name, x, y, want) => {
    const dots = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 700, y: 100 },
      { x: 900, y: 100 },
    ];
    expect(nearestBand(dots, x, y, 20)).toBe(want);
  });
});
