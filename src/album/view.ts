/**
 * Album mode: pick songs and their order, auto-master them all alike (genre from each name, your shootout taste),
 * check they sit at the same loudness, preview the joins between them, and export the lot in order.
 */
import { autoMaster } from "../audio/auto.ts";
import { measure } from "../audio/measure.ts";
import { decodeAt, decodeNative, renderMaster } from "../audio/render.ts";
import { fetchTrack } from "../audio/tracks.ts";
import { applyEdges } from "../dsp/edges.ts";
import type { EdgeParams } from "../dsp/edges.ts";
import { encodeWav } from "../export/wav.ts";
import type { BitDepth } from "../export/wav.ts";
import { albumFileName, consistency, moveItem, transitionEdges } from "../master/album.ts";
import { GENRES, genre, genreFromName, parseGenre } from "../master/genres.ts";
import type { GenreKey } from "../master/genres.ts";
import { score } from "../master/score.ts";
import { edgeParams, noBypass } from "../master/settings.ts";
import type { Settings } from "../master/settings.ts";
import { tasteLean } from "../master/shootout.ts";
import { button, db, download, h } from "../desk/dom.ts";
import { loadSettings, loadTaste, readJson, saveSettings, writeJson } from "../desk/storage.ts";

/** Seconds of each song a transition preview plays. */
const PREVIEW_SECONDS = 8;
/** Only used when a file's header doesn't say its rate. */
const FALLBACK_RATE = 44100;

interface Result {
  integrated: number;
  truePeak: number;
  plr: number;
  score: number;
}

interface Row {
  name: string;
  /** null = from the file name. */
  genre: GenreKey | null;
  status: string;
  error: boolean;
  result: Result | null;
}

/** File System Access API (Chrome); not in TypeScript's DOM types yet. */
interface DirectoryHandle {
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<{ write(data: ArrayBuffer): Promise<void>; close(): Promise<void> }> }>;
}
type DirectoryPicker = (options: { mode: "readwrite" }) => Promise<DirectoryHandle>;

function parseResult(input: unknown): Result | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
  const out = { integrated: num(r.integrated), truePeak: num(r.truePeak), plr: num(r.plr), score: num(r.score) };
  return Object.values(out).every(Number.isFinite) ? out : null;
}

export interface AlbumHooks {
  /** Stop the Desk's playback before the album plays anything. */
  pauseDesk(): void;
  /** Open one song on the Desk (with its album knobs). */
  openInDesk(track: string): void;
}

export class AlbumView {
  readonly el: HTMLElement;
  private readonly ctx: AudioContext;
  private readonly all: string[];
  private readonly hooks: AlbumHooks;
  /** The album, in order. */
  private order: string[];
  private readonly rows = new Map<string, Row>();
  private busy = "";
  /** The last finished action's message, shown until the next one. */
  private flash = "";
  private cancelled = false;
  private preview: AudioBufferSourceNode | null = null;
  private bits: BitDepth = 24;

  constructor(ctx: AudioContext, tracks: string[], hooks: AlbumHooks) {
    this.ctx = ctx;
    this.all = tracks;
    this.hooks = hooks;
    this.el = h("section", "panel album");
    const stored = readJson("album");
    const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    const order = Array.isArray(raw.order) ? raw.order.filter((t): t is string => typeof t === "string" && tracks.includes(t)) : [];
    this.order = [...new Set(order)];
    const results = typeof raw.results === "object" && raw.results !== null ? (raw.results as Record<string, unknown>) : {};
    const genres = typeof raw.genres === "object" && raw.genres !== null ? (raw.genres as Record<string, unknown>) : {};
    for (const name of tracks) {
      const result = parseResult(results[name]);
      this.rows.set(name, { name, genre: parseGenre(genres[name]), status: result ? "mastered" : "", error: false, result });
    }
    this.render();
  }

  private row(name: string): Row {
    const r = this.rows.get(name);
    if (!r) throw new RangeError(`not a track: ${name}`);
    return r;
  }

  private save(): void {
    const results: Record<string, Result> = {};
    const genres: Record<string, GenreKey> = {};
    for (const r of this.rows.values()) {
      if (r.result) results[r.name] = r.result;
      if (r.genre) genres[r.name] = r.genre;
    }
    writeJson("album", { order: this.order, results, genres });
  }

  private genreOf(name: string): GenreKey {
    return this.row(name).genre ?? genreFromName(name);
  }

  leave(): void {
    this.stopPreview();
  }

  keyAction(ev: KeyboardEvent): (() => unknown) | null {
    if (ev.key === "Escape") return () => this.stop();
    if (ev.key === " ") return () => this.stopPreview();
    return null;
  }

  private stop(): void {
    this.stopPreview();
    if (this.busy) this.cancelled = true;
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.cancelled = false;
    try {
      await task();
    } catch (err: unknown) {
      this.busy = "";
      this.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = "";
      this.render();
    }
  }

  private setStatus(text: string): void {
    this.busy = text;
    this.render();
  }

  /** Auto-masters every song in the album, one at a time; knobs land in each song's Desk settings. */
  private masterAll(): Promise<void> {
    return this.run(async () => {
      const taste = tasteLean(loadTaste());
      for (const [i, name] of this.order.entries()) {
        if (this.cancelled) break;
        const row = this.row(name);
        const prefix = `${i + 1}/${this.order.length} ${name}`;
        row.status = "working";
        row.error = false;
        this.setStatus(`${prefix}: decoding…`);
        try {
          const buffer = await decodeNative(await fetchTrack(name), FALLBACK_RATE);
          this.setStatus(`${prefix}: measuring…`);
          const channels = Array.from({ length: 2 }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
          const original = await measure(channels, buffer.sampleRate);
          const auto = await autoMaster(buffer, original, { genre: this.genreOf(name), taste }, (text) => this.setStatus(`${prefix}: ${text}`), () => this.cancelled);
          if (!auto) {
            row.status = "stopped";
            break;
          }
          saveSettings(name, auto.settings);
          row.result = { integrated: auto.report.integrated, truePeak: auto.report.truePeak, plr: auto.report.plr, score: score(original, auto.report).total };
          row.status = "mastered";
        } catch (err: unknown) {
          row.status = err instanceof Error ? err.message : String(err);
          row.error = true;
        }
        this.save();
      }
    });
  }

  private knobs(name: string): Settings | null {
    return this.row(name).result ? loadSettings(name) : null;
  }

  /** Renders every mastered song again with its knobs and Edges, and writes the WAVs in album order. */
  private exportAll(): Promise<void> {
    return this.run(async () => {
      const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
      const dir = picker ? await picker({ mode: "readwrite" }) : null;
      let written = 0;
      for (const [i, name] of this.order.entries()) {
        if (this.cancelled) break;
        const settings = this.knobs(name);
        if (!settings) continue;
        const file = albumFileName(i, name, this.bits);
        this.setStatus(`exporting ${i + 1}/${this.order.length}: ${file}`);
        const buffer = await decodeNative(await fetchTrack(name), FALLBACK_RATE);
        const bypass = noBypass();
        const { sampleRate, master } = await renderMaster(buffer, settings, bypass);
        const wav = encodeWav(applyEdges(master, sampleRate, edgeParams(settings, bypass)), sampleRate, this.bits);
        if (dir) {
          const writable = await (await dir.getFileHandle(file, { create: true })).createWritable();
          await writable.write(wav);
          await writable.close();
        } else {
          download(new Blob([wav], { type: "audio/wav" }), file);
        }
        written++;
      }
      this.flash = `exported ${written} song${written === 1 ? "" : "s"}${dir ? " to the folder you picked" : ""}`;
    });
  }

  /** Plays the last seconds of song i (fade-out, tail) straight into the first seconds of song i+1 (lead-in, fade-in). */
  private previewJoin(i: number): Promise<void> {
    return this.run(async () => {
      const [a, b] = [this.order[i], this.order[i + 1]];
      const [sa, sb] = [this.knobs(a), this.knobs(b)];
      if (!sa || !sb) throw new Error("master both songs first");
      this.hooks.pauseDesk();
      this.stopPreview();
      this.setStatus(`rendering the join ${a} → ${b}…`);
      const rate = this.ctx.sampleRate;
      const bypass = noBypass();
      const clip = async (name: string, s: Settings, end: boolean, edges: EdgeParams): Promise<Float32Array[]> => {
        const buffer = await decodeAt(await fetchTrack(name), rate);
        const from = end ? Math.max(0, buffer.duration - PREVIEW_SECONDS) : 0;
        const { master } = await renderMaster(buffer, s, bypass, from, PREVIEW_SECONDS);
        return applyEdges(master, rate, edges);
      };
      const ending = await clip(a, sa, true, transitionEdges(edgeParams(sa, bypass)).ending);
      const opening = await clip(b, sb, false, transitionEdges(edgeParams(sb, bypass)).opening);
      const joined = new AudioBuffer({ numberOfChannels: 2, length: ending[0].length + opening[0].length, sampleRate: rate });
      for (let c = 0; c < 2; c++) {
        joined.getChannelData(c).set(ending[c], 0);
        joined.getChannelData(c).set(opening[c], ending[0].length);
      }
      await this.ctx.resume();
      const source = new AudioBufferSourceNode(this.ctx, { buffer: joined });
      source.connect(this.ctx.destination);
      source.onended = (): void => {
        if (this.preview === source) this.preview = null;
        this.flash = "";
        this.render();
      };
      source.start(this.ctx.currentTime + 0.1);
      this.preview = source;
      this.flash = `playing the join ${i + 1} → ${i + 2} (space stops)`;
    });
  }

  private stopPreview(): void {
    this.preview?.stop();
    this.preview?.disconnect();
    this.preview = null;
  }

  private toggle(name: string): void {
    this.order = this.order.includes(name) ? this.order.filter((t) => t !== name) : [...this.order, name];
    this.save();
    this.render();
  }

  private move(i: number, delta: number): void {
    this.order = moveItem(this.order, i, delta);
    this.save();
    this.render();
  }

  render(): void {
    const working = !!this.busy;
    const title = h("h2", "", "Album", h("span", "kbd", "Esc: stop"));
    const intro = h(
      "p",
      "dim",
      "Pick songs (in play order), auto-master them alike (genre from each name, your shootout taste), check they sit at the same loudness, hear each join, export in order.",
    );
    const lufs = this.order.map((n) => this.row(n).result?.integrated ?? NaN);
    const { spreadLu, outliers } = consistency(lufs);
    const genreSelect = (name: string): HTMLSelectElement => {
      const s = h("select");
      s.replaceChildren(new Option(`auto (${genre(genreFromName(name)).label})`, ""), ...GENRES.map((g) => new Option(g.label, g.key)));
      s.value = this.row(name).genre ?? "";
      s.disabled = working;
      s.onchange = (): void => {
        this.row(name).genre = parseGenre(s.value);
        this.save();
      };
      return s;
    };
    const head = h("tr", "", ...["#", "song", "genre", "LUFS", "dBTP", "PLR", "score", "", ""].map((t) => h("th", "", t)));
    const body = this.order.map((name, i) => {
      const r = this.row(name);
      const res = r.result;
      const cls = outliers.includes(i) ? "outlier" : "";
      const tools = h(
        "td",
        "tools",
        button("↑", () => this.move(i, -1), "earlier in the album"),
        button("↓", () => this.move(i, 1), "later in the album"),
        button("desk", () => this.hooks.openInDesk(name), "open on the Desk with its album knobs"),
        button("✕", () => this.toggle(name), "remove from the album"),
      );
      const join = i < this.order.length - 1 ? button(`▶ join ${i + 1}→${i + 2}`, () => void this.previewJoin(i), `hear the end of this song into the start of the next (${PREVIEW_SECONDS} s each)`) : "";
      for (const b of tools.querySelectorAll("button")) b.disabled = working;
      return h(
        "tr",
        r.error ? "error" : cls,
        h("td", "num", String(i + 1)),
        h("td", "name", name, r.status && r.status !== "mastered" ? h("span", "dim", ` · ${r.status}`) : ""),
        h("td", "", genreSelect(name)),
        h("td", `num ${cls}`, res ? db(res.integrated) : ""),
        h("td", "num", res ? db(res.truePeak) : ""),
        h("td", "num", res ? db(res.plr) : ""),
        h("td", "num", res ? String(res.score) : ""),
        h("td", "", join),
        tools,
      );
    });
    const bitsSelect = h("select");
    bitsSelect.replaceChildren(new Option("24-bit WAV", "24"), new Option("16-bit WAV (dithered)", "16"));
    bitsSelect.value = String(this.bits);
    bitsSelect.onchange = (): void => {
      this.bits = bitsSelect.value === "16" ? 16 : 24;
    };
    const mastered = this.order.filter((n) => this.row(n).result).length;
    const actions = h(
      "div",
      "row",
      button(`auto-master ${this.order.length} song${this.order.length === 1 ? "" : "s"}`, () => void this.masterAll(), "one at a time; knobs land in each song's Desk settings"),
      bitsSelect,
      button(`export ${mastered} in order…`, () => void this.exportAll(), "pick a folder (Chrome) or download one by one"),
      ...(working ? [button("stop", () => this.stop(), "Esc")] : []),
    );
    for (const b of actions.querySelectorAll("button")) if (b.textContent !== "stop") b.disabled = working || this.order.length === 0;
    const summary =
      mastered > 1
        ? h(
            "p",
            outliers.length ? "warn" : "dim",
            outliers.length
              ? `Loudness spread ${spreadLu.toFixed(1)} LU: ${outliers.map((i) => `#${i + 1}`).join(", ")} ${outliers.length === 1 ? "stands" : "stand"} out by more than 1 LU from the rest. Open ${outliers.length === 1 ? "it" : "them"} on the Desk (l sets Drive for -14 LUFS).`
              : `Loudness spread ${spreadLu.toFixed(1)} LU: the album plays at an even level.`,
          )
        : "";
    const status = h("p", "message", this.busy || this.flash);
    const add = h("select");
    add.replaceChildren(new Option("add a song…", ""), ...this.all.filter((t) => !this.order.includes(t)).map((t) => new Option(t, t)));
    add.disabled = working;
    add.onchange = (): void => {
      if (add.value) this.toggle(add.value);
    };
    const addAll = button("add all", () => {
      this.order = [...this.order, ...this.all.filter((t) => !this.order.includes(t))];
      this.save();
      this.render();
    });
    addAll.disabled = working;
    this.el.replaceChildren(title, intro, h("div", "row", add, addAll), actions, status, summary, h("div", "scroll", h("table", "album-table", head, ...body)));
  }
}
