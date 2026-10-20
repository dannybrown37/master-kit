/**
 * Ear-training drills: B is the clip with one hidden process applied; guess which one.
 * B is loudness-matched to A so level never gives the answer away. DOM-free.
 */

export const DRILL_KINDS = ["eq", "comp", "limit", "width"] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export function nextKind(kind: DrillKind): DrillKind {
  return DRILL_KINDS[(DRILL_KINDS.indexOf(kind) + 1) % DRILL_KINDS.length];
}

export type DrillProcess =
  | { kind: "none" }
  | { kind: "eq"; freq: number; gainDb: number; q: number }
  /** `depthDb`: threshold this far below the clip's peak, so the amount doesn't depend on how loud the song is. */
  | { kind: "comp"; depthDb: number; ratio: number; attackMs: number; releaseMs: number }
  /** `depthDb`: the clip's peak is driven this far past a -1 dB ceiling. */
  | { kind: "limit"; depthDb: number; releaseMs: number }
  /** Side level in percent, as on the desk's Stereo width knob (100 = unchanged). */
  | { kind: "width"; width: number };

export interface Choice {
  label: string;
  process: DrillProcess;
}

export interface Level {
  title: string;
  prompt: string;
  choices: Choice[];
}

const EQ_Q = 1.4;

function hz(f: number): string {
  return f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
}

function boosts(freqs: number[], gainDb: number, names?: string[]): Choice[] {
  return freqs.map((freq, i) => ({ label: names ? `${names[i]} (${hz(freq)})` : hz(freq), process: { kind: "eq", freq, gainDb, q: EQ_Q } }));
}

const NONE: Choice = { label: "none", process: { kind: "none" } };
const comp = (label: string, depthDb: number, ratio: number, attackMs = 10, releaseMs = 120): Choice => ({
  label,
  process: { kind: "comp", depthDb, ratio, attackMs, releaseMs },
});

const limit = (label: string, depthDb: number, releaseMs = 50): Choice => ({ label, process: { kind: "limit", depthDb, releaseMs } });
const width = (label: string, w: number): Choice => ({ label, process: { kind: "width", width: w } });
const SAME: Choice = { label: "unchanged", process: { kind: "none" } };

export const LEVELS: Record<DrillKind, Level[]> = {
  eq: [
    { title: "EQ 1 · big boost", prompt: "B has a +12 dB boost. Low, mid or high?", choices: boosts([100, 1000, 8000], 12, ["low", "mid", "high"]) },
    { title: "EQ 2 · five bands", prompt: "B has a +9 dB boost. Where?", choices: boosts([80, 250, 1000, 3000, 10000], 9) },
    { title: "EQ 3 · seven bands", prompt: "B has a +6 dB boost. Where?", choices: boosts([63, 160, 400, 1000, 2500, 6300, 12500], 6) },
    {
      title: "EQ 4 · boost or cut",
      prompt: "B has a 6 dB boost or cut. Which band, which way?",
      choices: [80, 250, 1000, 3000, 10000].flatMap((f) => [
        { label: `${hz(f)} +6`, process: { kind: "eq", freq: f, gainDb: 6, q: EQ_Q } as const },
        { label: `${hz(f)} −6`, process: { kind: "eq", freq: f, gainDb: -6, q: EQ_Q } as const },
      ]),
    },
    { title: "EQ 5 · octaves", prompt: "B has a +3 dB boost. Which octave?", choices: boosts([31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], 3) },
  ],
  comp: [
    { title: "Comp 1 · on or off", prompt: "Is B compressed? Levels are matched: listen for a denser body with hits that click out on top", choices: [NONE, comp("heavy", 24, 6)] },
    { title: "Comp 2 · how much", prompt: "How hard is B compressed?", choices: [NONE, comp("medium", 14, 3), comp("heavy", 24, 6)] },
    { title: "Comp 3 · subtle", prompt: "How hard is B compressed?", choices: [NONE, comp("light", 8, 2), comp("medium", 14, 3), comp("heavy", 24, 6)] },
    {
      title: "Comp 4 · attack",
      prompt: "B is compressed. Fast attack (dull, flattened hits) or slow (hits snap through)?",
      choices: [comp("fast attack 0.3 ms", 18, 4, 0.3), comp("slow attack 30 ms", 18, 4, 30)],
    },
    {
      title: "Comp 5 · release",
      prompt: "B is compressed. Fast release (pumping, breathing) or slow (steady, held down)?",
      choices: [comp("fast release 25 ms", 18, 4, 5, 25), comp("slow release 600 ms", 18, 4, 5, 600)],
    },
  ],
  limit: [
    { title: "Limit 1 · on or off", prompt: "Is B limited? Listen for drum hits that lost their crack and a flatter, harder sound", choices: [NONE, limit("heavy (12 dB)", 12)] },
    { title: "Limit 2 · how much", prompt: "How hard is B limited?", choices: [NONE, limit("6 dB", 6), limit("12 dB", 12)] },
    { title: "Limit 3 · subtle", prompt: "How hard is B limited?", choices: [NONE, limit("3 dB", 3), limit("6 dB", 6), limit("9 dB", 9)] },
    {
      title: "Limit 4 · release",
      prompt: "B is limited 10 dB. Fast release (gritty, distorted bass) or slow (the mix ducks after each hit)?",
      choices: [limit("fast release 5 ms", 10, 5), limit("slow release 400 ms", 10, 400)],
    },
    { title: "Limit 5 · fine", prompt: "How hard is B limited?", choices: [NONE, limit("2 dB", 2), limit("4 dB", 4), limit("6 dB", 6), limit("8 dB", 8)] },
  ],
  width: [
    { title: "Width 1 · mono", prompt: "Is B mono? Listen for the sound collapsing to the centre", choices: [SAME, width("mono", 0)] },
    { title: "Width 2 · narrow or wide", prompt: "Is B narrower or wider?", choices: [width("narrower (50%)", 50), width("wider (180%)", 180)] },
    { title: "Width 3 · three way", prompt: "Is B narrower, wider or unchanged?", choices: [width("narrower (50%)", 50), SAME, width("wider (160%)", 160)] },
    { title: "Width 4 · subtle", prompt: "Is B narrower, wider or unchanged?", choices: [width("narrower (70%)", 70), SAME, width("wider (140%)", 140)] },
    { title: "Width 5 · fine", prompt: "Is B narrower, wider or unchanged?", choices: [width("narrower (80%)", 80), SAME, width("wider (125%)", 125)] },
  ],
};

export const CLIP_SECONDS = 8;

export interface Question {
  kind: DrillKind;
  level: number;
  answer: number;
  clipStart: number;
  clipSeconds: number;
}

/** Random clip from the middle 80% of the song (skips intros and fade-outs) and a random answer. */
export function makeQuestion(kind: DrillKind, level: number, songSeconds: number, random: () => number): Question {
  const choices = LEVELS[kind][level].choices.length;
  const answer = Math.min(choices - 1, Math.floor(random() * choices));
  const clipSeconds = Math.min(CLIP_SECONDS, songSeconds);
  const lo = songSeconds * 0.1;
  const hi = songSeconds * 0.9 - clipSeconds;
  const start = hi > lo ? lo + random() * (hi - lo) : (songSeconds - clipSeconds) / 2;
  return { kind, level, answer, clipStart: Math.round(start * 10) / 10, clipSeconds };
}

export const STREAK_TO_LEVEL_UP = 5;

export interface Progress {
  level: number;
  streak: number;
  /** Right answers in a row at the current level. */
  levelStreak: number;
  best: number;
  correct: number;
  answered: number;
}

export function initialProgress(): Progress {
  return { level: 0, streak: 0, levelStreak: 0, best: 0, correct: 0, answered: 0 };
}

export function answer(p: Progress, right: boolean, levelCount = Infinity): Progress {
  if (!right) return { ...p, streak: 0, levelStreak: 0, answered: p.answered + 1 };
  const streak = p.streak + 1;
  const levelUp = p.levelStreak + 1 >= STREAK_TO_LEVEL_UP && p.level + 1 < levelCount;
  return {
    level: levelUp ? p.level + 1 : p.level,
    streak,
    levelStreak: levelUp ? 0 : p.levelStreak + 1,
    best: Math.max(p.best, streak),
    correct: p.correct + 1,
    answered: p.answered + 1,
  };
}

/** Validates stored progress: bad fields fall back to their initial value. */
export function parseProgress(input: unknown, levelCount: number): Progress {
  const out = initialProgress();
  if (typeof input !== "object" || input === null) return out;
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof Progress)[]) {
    const v = raw[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  out.level = Math.min(out.level, levelCount - 1);
  out.answered = Math.max(out.answered, out.correct);
  out.best = Math.max(out.best, out.streak);
  return out;
}

/** Playback gains (linear) for A and B: equal loudness, and the louder peak no higher than -1 dBFS. */
export function matchGains(aLufs: number, bLufs: number, aPeakDb: number, bPeakDb: number, ceilingDb = -1): { a: number; b: number } {
  const matchDb = Number.isFinite(aLufs) && Number.isFinite(bLufs) ? aLufs - bLufs : 0;
  const loudest = Math.max(aPeakDb, bPeakDb + matchDb);
  const trimDb = Number.isFinite(loudest) ? Math.min(0, ceilingDb - loudest) : 0;
  return { a: 10 ** (trimDb / 20), b: 10 ** ((matchDb + trimDb) / 20) };
}
