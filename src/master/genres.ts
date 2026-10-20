/**
 * Genre profiles for auto-master: what "finished" usually sounds like in a style, as moves from the generic plan.
 * Rules of thumb for a starting point, not measurements of commercial releases; a reference track overrides the
 * tonal target. Detected from the "[year, genre]" tag in a file name, e.g. "First in Line [2025, edm].mp3".
 */

export type GenreKey = "edm" | "synthwave" | "arcade" | "lofi" | "ambient" | "cinematic" | "acoustic" | "generic";

export interface Genre {
  key: GenreKey;
  label: string;
  /** Added to the generic tonal target per band (sub, low, mud, mid, presence, air), dB: + = this style carries more. */
  tone: readonly number[];
  /** Glue compression: "dense" = the usual gentle glue; "none" = dynamics are the point, leave them. */
  glue: "dense" | "none";
  /** Color knobs: Warmth (%) and Clip above (dB; 6 = off). */
  warmth: number;
  clipDb: number;
  /** Mono bass below (Hz; 20 = off). */
  monoBassHz: number;
  why: string;
}

export const GENRES: readonly Genre[] = [
  {
    key: "edm",
    label: "EDM",
    tone: [3, 1, 0, 0, 0, 0],
    glue: "dense",
    warmth: 15,
    clipDb: 2.5,
    monoBassHz: 120,
    why: "a big sub is the point, kick peaks go to a soft clipper so the limiter doesn't pump, bass mono for club systems",
  },
  {
    key: "synthwave",
    label: "Synthwave",
    tone: [1, 1, 0, 0, 0, 0.5],
    glue: "dense",
    warmth: 25,
    clipDb: 3,
    monoBassHz: 100,
    why: "warm, glued and a little saturated, like tape; gentle clipping on the drums",
  },
  {
    key: "arcade",
    label: "Arcade",
    tone: [0, 0, 0, 0, 0.5, 0.5],
    glue: "dense",
    warmth: 10,
    clipDb: 3,
    monoBassHz: 100,
    why: "bright and punchy; square-wave leads already have plenty of harmonics, so little warmth",
  },
  {
    key: "lofi",
    label: "Lo-fi",
    tone: [0, 1, 0.5, 0, -1.5, -3],
    glue: "dense",
    warmth: 35,
    clipDb: 6,
    monoBassHz: 100,
    why: "dark and warm on purpose: a rolled-off top and saturation, no clipping (it should feel soft)",
  },
  {
    key: "ambient",
    label: "Ambient",
    tone: [0, 0, 0, 0, 0, 0],
    glue: "none",
    warmth: 0,
    clipDb: 6,
    monoBassHz: 80,
    why: "space and slow swells matter more than loudness: no glue, no clipping, a light touch",
  },
  {
    key: "cinematic",
    label: "Cinematic",
    tone: [1, 0, 0, 0, 0, 0],
    glue: "none",
    warmth: 10,
    clipDb: 6,
    monoBassHz: 80,
    why: "the contrast between quiet and huge is the drama: dynamics are left alone",
  },
  {
    key: "acoustic",
    label: "Acoustic / classical",
    tone: [0, 0, 0, 0, 0, 0],
    glue: "none",
    warmth: 0,
    clipDb: 6,
    monoBassHz: 20,
    why: "natural instruments: transparent, full dynamics, stereo bass left as recorded",
  },
  {
    key: "generic",
    label: "Generic",
    tone: [0, 0, 0, 0, 0, 0],
    glue: "dense",
    warmth: 0,
    clipDb: 6,
    monoBassHz: 100,
    why: "no style known: a balanced, gentle master",
  },
];

/** Tag words → profile; EDM wins in mixed tags ("cinematic edm" is mixed and mastered like EDM). */
const WORDS: [string, GenreKey][] = [
  ["edm", "edm"],
  ["synthwave", "synthwave"],
  ["lofi", "lofi"],
  ["arcade", "arcade"],
  ["ambient", "ambient"],
  ["cinematic", "cinematic"],
  ["neoclassical", "acoustic"],
  ["classical", "acoustic"],
  ["transcription", "acoustic"],
  ["acoustic", "acoustic"],
];

export function genre(key: GenreKey): Genre {
  const g = GENRES.find((x) => x.key === key);
  if (!g) throw new RangeError(`unknown genre ${key}`);
  return g;
}

export function parseGenre(input: unknown): GenreKey | null {
  return GENRES.find((g) => g.key === input)?.key ?? null;
}

export function genreFromName(name: string): GenreKey {
  const tag = /\[\s*\d{4}\s*,\s*([^\]]+)\]/.exec(name)?.[1].toLowerCase() ?? "";
  const words = tag.split(/[\s,/-]+/);
  return WORDS.find(([w]) => words.includes(w))?.[1] ?? "generic";
}
