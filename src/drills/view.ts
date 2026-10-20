/** Drills screen: hear A (clip) vs B (clip + hidden process), pick what changed, build streaks. */
import { renderDrill } from "../audio/drill-render.ts";
import { MeterBar, button, h } from "../desk/dom.ts";
import { readJson, writeJson } from "../desk/storage.ts";
import { DRILL_KINDS, LEVELS, STREAK_TO_LEVEL_UP, answer, makeQuestion, nextKind, parseProgress } from "./drills.ts";
import type { DrillKind, Progress, Question } from "./drills.ts";
import { ClipPlayer } from "./player.ts";

const KIND_NAMES: Record<DrillKind, string> = { eq: "EQ", comp: "Compression", limit: "Limiting", width: "Stereo width" };
const ANSWER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

export class DrillView {
  readonly el: HTMLElement;
  private readonly player: ClipPlayer;
  private readonly song: () => AudioBuffer | null;
  private kind: DrillKind = "eq";
  private progress: Record<DrillKind, Progress>;
  private question: Question | null = null;
  private picked: number | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private readonly levelBar = new MeterBar(0, STREAK_TO_LEVEL_UP);

  constructor(ctx: AudioContext, song: () => AudioBuffer | null) {
    this.player = new ClipPlayer(ctx);
    this.song = song;
    const stored = readJson("drills");
    const obj = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    this.progress = Object.fromEntries(DRILL_KINDS.map((k) => [k, parseProgress(obj[k], LEVELS[k].length)])) as Record<DrillKind, Progress>;
    this.el = h("section", "panel drill");
  }

  /** Called when the drills screen opens or the song changes. */
  async enter(): Promise<void> {
    if (!this.question) await this.next();
    this.render();
  }

  leave(): void {
    this.player.stop();
    this.render();
  }

  songChanged(): void {
    this.player.stop();
    this.question = null;
  }

  async next(): Promise<void> {
    const song = this.song();
    if (!song) {
      this.error = "load a song first";
      this.render();
      return;
    }
    const gen = ++this.generation;
    const wasPlaying = this.player.playing;
    this.player.stop();
    const level = this.progress[this.kind].level;
    const q = makeQuestion(this.kind, level, song.duration, Math.random);
    this.question = q;
    this.picked = null;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const clips = await renderDrill(song, q, LEVELS[q.kind][q.level].choices[q.answer].process);
      if (gen !== this.generation) return;
      this.player.load(clips);
      if (wasPlaying) await this.player.play();
    } finally {
      if (gen === this.generation) this.loading = false;
      this.render();
    }
  }

  private pick(choice: number): void {
    const q = this.question;
    if (!q || this.picked !== null || this.loading || choice >= LEVELS[q.kind][q.level].choices.length) return;
    this.picked = choice;
    const levels = LEVELS[q.kind].length;
    this.progress = { ...this.progress, [q.kind]: answer(this.progress[q.kind], choice === q.answer, levels) };
    writeJson("drills", this.progress);
    this.render();
  }

  private switchKind(kind: DrillKind): Promise<void> {
    if (kind === this.kind) return Promise.resolve();
    this.kind = kind;
    return this.next();
  }

  keyAction(ev: KeyboardEvent): (() => unknown) | null {
    const i = ANSWER_KEYS.indexOf(ev.key);
    if (i >= 0) return () => this.pick(i);
    const actions: Record<string, () => unknown> = {
      " ": () => this.player.toggle().then(() => this.render()),
      a: () => {
        this.player.flip();
        this.render();
      },
      n: () => this.next(),
      Enter: () => this.next(),
      t: () => this.switchKind(nextKind(this.kind)),
    };
    return actions[ev.key] ?? null;
  }

  render(): void {
    const p = this.progress[this.kind];
    const q = this.question;
    const level = LEVELS[this.kind][q?.level ?? p.level];
    const kinds = h(
      "div",
      "row tabs",
      ...DRILL_KINDS.map((k) => {
        const b = button(KIND_NAMES[k], () => void this.switchKind(k).catch((e: unknown) => this.fail(e)), "t: switch drill");
        b.className = k === this.kind ? "on" : "";
        return b;
      }),
    );
    this.levelBar.set(p.levelStreak, "good");
    const stats = h(
      "div",
      "row",
      h("span", "big", `Level ${p.level + 1}/${LEVELS[this.kind].length} · ${level.title}`),
      h("span", "dim", `streak ${p.streak} · best ${p.best} · ${p.correct}/${p.answered} right`),
    );
    const toNext =
      p.level + 1 < LEVELS[this.kind].length
        ? h("div", "meter", h("span", "", "next level"), this.levelBar.el, h("span", "value", `${p.levelStreak}/${STREAK_TO_LEVEL_UP}`), h("span", ""))
        : h("div", "dim", "top level: keep the streak going");

    const sideA = button("A original", () => {
      this.player.setSide("A");
      this.render();
    });
    const sideB = button("B processed", () => {
      this.player.setSide("B");
      this.render();
    });
    sideA.className = this.player.side === "A" ? "on" : "";
    sideB.className = this.player.side === "B" ? "on" : "";
    const play = button(this.player.playing ? "■ stop" : "▶ play loop", () => void this.player.toggle().then(() => this.render()), "space");
    play.disabled = this.loading || !q;
    const transport = h("div", "row", play, sideA, sideB, h("span", "dim", q ? `clip ${q.clipStart.toFixed(0)}–${(q.clipStart + q.clipSeconds).toFixed(0)} s · levels matched` : ""));

    const choices = h(
      "div",
      "choices",
      ...level.choices.map((c, i) => {
        const b = button(`${ANSWER_KEYS[i]}  ${c.label}`, () => this.pick(i));
        if (this.picked !== null && q) b.className = i === q.answer ? "right" : i === this.picked ? "wrong" : "";
        b.disabled = this.loading;
        return b;
      }),
    );

    let feedback: HTMLElement;
    if (this.error) feedback = h("p", "notok", this.error);
    else if (this.loading) feedback = h("p", "dim", "preparing clip…");
    else if (this.picked !== null && q) {
      const right = this.picked === q.answer;
      const truth = level.choices[q.answer].label;
      feedback = h(
        "p",
        right ? "ok big" : "notok big",
        right ? `✓ right: ${truth}` : `✗ it was ${truth} (you said ${level.choices[this.picked].label}). Flip A/B again to hear it, then n.`,
      );
    } else feedback = h("p", "", level.prompt);

    const next = button("next (n)", () => void this.next().catch((e: unknown) => this.fail(e)));
    const keys = h("p", "keys", "space play · a flip A/B · 1–9, 0 answer · n next · t next drill · d back to the desk");
    this.el.replaceChildren(kinds, stats, toNext, transport, feedback, choices, h("div", "row", next), keys);
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.render();
  }
}
