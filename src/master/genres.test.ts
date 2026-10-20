import { describe, expect, it } from "vitest";
import { BANDS } from "../analysis/spectrum.ts";
import { GENRES, genre, genreFromName, parseGenre } from "./genres.ts";

describe("genreFromName", () => {
  it.each([
    ["First in Line [2025, edm].mp3", "edm"],
    ["Final Battle [2024, cinematic edm].mp3", "edm"],
    ["Barrel Rondo [2026, neoclassical edm].mp3", "edm"],
    ["Castle Crush [2020, arcade edm].mp3", "edm"],
    ["Corners [2020, lofi].mp3", "lofi"],
    ["Blue Mars [2019, ambient].mp3", "ambient"],
    ["Aformency [2020, cinematic].mp3", "cinematic"],
    ["Ghost in the Map [2019, synthwave].mp3", "synthwave"],
    ["Cruisin' [2020, arcade].mp3", "arcade"],
    ["Icy Flight [2022, neoclassical].mp3", "acoustic"],
    ["Brahms Cello Sonata No 1, Mvt 1, Exposition [2022, transcription].mp3", "acoustic"],
    ["My Song.mp3", "generic"],
    ["Odd [2020, polka].mp3", "generic"],
    ["Loud [2020, EDM].mp3", "edm"],
  ] as const)("%s → %s", (name, key) => {
    expect(genreFromName(name)).toBe(key);
  });
});

describe("profiles", () => {
  it.each(GENRES.map((g) => [g.key, g] as const))("%s has a tone offset per band and a reason", (_key, g) => {
    expect(g.tone).toHaveLength(BANDS.length);
    expect(g.why.length).toBeGreaterThan(20);
  });

  it("the generic profile changes nothing", () => {
    expect(genre("generic").tone.every((x) => x === 0)).toBe(true);
  });

  it.each([
    ["edm", "edm"],
    ["nonsense", null],
    [42, null],
  ])("parseGenre(%s)", (input, want) => {
    expect(parseGenre(input)).toBe(want);
  });
});
