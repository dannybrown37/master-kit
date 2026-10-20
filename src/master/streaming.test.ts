import { describe, expect, it } from "vitest";
import { PLATFORMS, masterLoudness, nextPlatform, platform, playbackGainDb } from "./streaming.ts";
import type { PlatformKey } from "./streaming.ts";

describe("playbackGainDb", () => {
  it.each([
    ["spotify", "a loud master is turned down to -14", -9, -1, -5],
    ["spotify", "on target: untouched", -14, -1, 0],
    ["spotify", "a quiet master with headroom is turned up all the way", -18, -6, 4],
    ["spotify", "a quiet master is turned up only until its peaks reach -1 dBTP", -18, -3, 2],
    ["spotify", "a quiet master already peaking over -1: no boost", -18, 0.5, 0],
    ["youtube", "turns loud masters down", -9, -1, -5],
    ["youtube", "never turns quiet masters up", -18, -6, 0],
    ["apple", "targets -16", -9, -1, -7],
    ["apple", "never turns quiet masters up", -20, -6, 0],
  ] as const)("%s: %s", (key, _name, integrated, truePeak, want) => {
    expect(playbackGainDb(platform(key), { integrated, truePeak })).toBeCloseTo(want, 9);
  });

  it.each([
    ["silence", -Infinity, -Infinity],
    ["not measured", NaN, NaN],
  ])("%s: no gain", (_name, integrated, truePeak) => {
    expect(playbackGainDb(platform("spotify"), { integrated, truePeak })).toBe(0);
  });
});

describe("masterLoudness", () => {
  const original = { integrated: -12.8, truePeak: 0.7 };
  it.each([
    ["a current measurement is exact", { integrated: -10, truePeak: -1 }, 3, -0.5, { integrated: -10, truePeak: -1, exact: true }],
    ["no measurement: original + the live A/B match, live true peak", null, 3, -0.5, { integrated: -9.8, truePeak: -0.5, exact: false }],
    ["no live peak yet: the original's, shifted by the match", null, 3, -Infinity, { integrated: -9.8, truePeak: 3.7, exact: false }],
  ])("%s", (_name, measured, matchDb, liveTruePeak, want) => {
    const got = masterLoudness(measured, original, matchDb, liveTruePeak);
    expect(got.exact).toBe(want.exact);
    expect(got.integrated).toBeCloseTo(want.integrated, 9);
    expect(got.truePeak).toBeCloseTo(want.truePeak, 9);
  });
});

describe("nextPlatform", () => {
  it("cycles off → every platform → off", () => {
    const seen: (PlatformKey | null)[] = [];
    let p: PlatformKey | null = null;
    for (let i = 0; i <= PLATFORMS.length; i++) {
      p = nextPlatform(p);
      seen.push(p);
    }
    expect(seen).toEqual([...PLATFORMS.map((x) => x.key), null]);
  });
});
