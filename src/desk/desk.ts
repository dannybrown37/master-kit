/** The Desk: keyboard-first mastering UI over the live Engine. */
import type { Report } from "../analysis/report.ts";
import { TARGETS } from "../analysis/targets.ts";
import type { Dynamics, Engine, EngineState } from "../audio/engine.ts";
import { measure } from "../audio/measure.ts";
import { decodeNative, renderMaster } from "../audio/render.ts";
import { METER_HELP, MODULE_HELP, PARAM_HELP } from "../master/explain.ts";
import { hints } from "../master/hints.ts";
import type { Hint } from "../master/hints.ts";
import { LISTENS, meterPair, referenceMatchDb } from "../master/monitor.ts";
import type { Listen } from "../master/monitor.ts";
import { SPECTRUM_BINS, isDynamics } from "../audio/engine.ts";
import { SpectrumView } from "./spectrum-view.ts";
import { EQ_BAND_KNOBS, soloBand } from "./eq-drag.ts";
import { score } from "../master/score.ts";
import type { Score } from "../master/score.ts";
import { History } from "../master/history.ts";
import { autoMaster as runAutoMaster, driveForTarget, shootout as runShootout } from "../audio/auto.ts";
import { STYLE_INFO, blindOrder, recordPick, tasteLean } from "../master/shootout.ts";
import type { Style } from "../master/shootout.ts";
import type { MasterAudio } from "../audio/auto.ts";
import { checklist } from "../master/checklist.ts";
import { PRESETS, applyPreset } from "../master/presets.ts";
import type { Preset } from "../master/presets.ts";
import { EDGE_KEYS, MODULES, MODULE_NAMES, PARAMS, changedParams, clampParam, defaultSettings, edgeParams, eqBands, formatParam, fromFraction, nudge, toFraction } from "../master/settings.ts";
import type { Bypass, Module, ParamKey, Settings } from "../master/settings.ts";
import { snapshotDiff } from "../master/snapshot.ts";
import { GENRES, genre, genreFromName, parseGenre } from "../master/genres.ts";
import type { GenreKey } from "../master/genres.ts";
import { PLATFORMS, masterLoudness, nextPlatform, platform, playbackGainDb } from "../master/streaming.ts";
import type { PlatformKey } from "../master/streaming.ts";
import { parseSession, safeBaseName, sessionFileName, toSession } from "../master/session.ts";
import { applyEdges } from "../dsp/edges.ts";
import { encodeWav } from "../export/wav.ts";
import type { BitDepth } from "../export/wav.ts";
import { AlbumView } from "../album/view.ts";
import { DrillView } from "../drills/view.ts";
import { trackUrl } from "../audio/tracks.ts";
import { pickAudioFile } from "../master/library.ts";
import { MeterBar, button, clock, db, download, h, signed } from "./dom.ts";
import { GrTrace } from "./gr-trace.ts";
import { LoudnessPlot } from "./loudness-plot.ts";
import { initialNav, knobsOf, moveKnob, moveModule, selectKnob, selected } from "./nav.ts";
import type { Nav } from "./nav.ts";
import { lastReference, lastTrack, loadSettings, loadTaste, saveLastReference, saveLastTrack, saveSettings, saveTaste } from "./storage.ts";

/** Modules with one GR row per band. */
const BAND_GR_NAMES: Partial<Record<Dynamics, readonly string[]>> = { multi: ["Low", "Mid", "High"], tame: ["Band 1", "Band 2"] };
const SPECS = new Map(PARAMS.map((p) => [p.key as ParamKey, p]));
const DEFAULTS = defaultSettings();
const FINE = 0.2;
const SEEK_SECONDS = 5;
const MAX_SESSION_BYTES = 64 * 1024;
const LUFS_RANGE: [number, number] = [-36, 0];
const TP_RANGE: [number, number] = [-12, 3];
const GR_MAX = 12;
const SIDE_RANGE: [number, number] = [-30, 0];
const TARGET_ZONE: [number, number] = [TARGETS.integrated - TARGETS.integratedTolerance, TARGETS.integrated + TARGETS.integratedTolerance];

interface KnobView {
  row: HTMLElement;
  bar: MeterBar;
  value: HTMLElement;
}

interface PanelView {
  el: HTMLElement;
  bypass: HTMLButtonElement;
  /** One GR row, or one per band (multiband, tamer); the trace shows the module's worst. */
  gr?: { module: Dynamics; rows: { bar: MeterBar; value: HTMLElement }[]; trace: GrTrace | null };
}

interface MeterView {
  row: HTMLElement;
  bar: MeterBar;
  value: HTMLElement;
  sub: HTMLElement;
}


export interface Measured {
  key: string;
  rendered: MasterAudio;
  report: Report;
}

export type Mode = "desk" | "drills" | "album";

/** Identifies a render. Edges are left out: they're applied at export, so changing them needs no new render. */
export function settingsKey(settings: Settings, bypass: Bypass): string {
  const rendered = Object.fromEntries(Object.entries(settings).filter(([k]) => !(EDGE_KEYS as readonly string[]).includes(k)));
  return JSON.stringify([rendered, { ...bypass, edges: false }]);
}

export function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: Math.max(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
}

export class Desk {
  readonly root: HTMLElement;
  protected readonly engine: Engine;
  protected state: EngineState;
  protected track = "";
  protected originalReport: Report | null = null;
  protected measured: Measured | null = null;
  /** The song decoded at its file's own sample rate: what gets measured, rendered and exported. */
  protected native: Promise<AudioBuffer> | null = null;
  protected busy = "";
  private nav: Nav = initialNav();
  private readonly history = new History<Settings>();
  private readonly checklistEl: HTMLElement;
  private readonly refRow: HTMLElement;
  private checklistSignature = "";
  private explainSignature: string | null = null;
  private meterHelp: HTMLElement | null = null;
  /** What you've listened to since loading the song (for the checklist). */
  private heard = { original: false, reference: false, mono: false };
  private exported = false;
  /** Why auto-master set each knob, from its last run on this song. */
  private autoSteps: string[] = [];
  private autoEl: HTMLDetailsElement | null = null;
  private soloOn = false;
  /** Streaming preview platform, or null. */
  private platform: PlatformKey | null = null;
  /** The master's platform gain comes from a current measurement (else it's a live estimate). */
  private streamExact = false;
  private soloKey = "";
  private readonly spectrum = new SpectrumView({
    onGrab: (band) => {
      this.nav = selectKnob(this.nav, EQ_BAND_KNOBS[band].gain);
      this.schedule();
    },
    // Both knobs share one undo group, so a whole drag undoes in one step.
    onDrag: (band, knobs) => {
      for (const [key, value] of Object.entries(knobs) as [ParamKey, number][]) this.setKnob(key, value, `eqdrag:${band}`);
      this.schedule();
    },
    onReset: (band) => {
      this.setKnob(EQ_BAND_KNOBS[band].gain, 0, null);
      this.schedule();
    },
    onWheel: (band, steps) => {
      const q = EQ_BAND_KNOBS[band].q;
      if (!q) return;
      this.nav = selectKnob(this.nav, q);
      this.setKnob(q, nudge(q, this.state.settings[q], steps));
      this.schedule();
    },
  });
  private readonly spectrumBins = Object.fromEntries(LISTENS.map((l) => [l, new Float32Array(SPECTRUM_BINS)])) as Record<Listen, Float32Array<ArrayBuffer>>;
  private readonly plot = new LoudnessPlot(TARGET_ZONE, (seconds) => this.run(this.engine.seek(seconds)));
  private explain = true;
  private message = "";
  private messageIsError = false;
  private pending = false;

  private readonly trackSelect: HTMLSelectElement;
  private readonly refSelect: HTMLSelectElement;
  private readonly genreSelect: HTMLSelectElement;
  /** Picked by hand; null = from the file name. */
  private genreOverride: GenreKey | null = null;
  /** A running blind shootout: versions by style, played in `order`; `before` = the knobs to go back to on cancel. */
  private shoot: {
    order: Style[];
    versions: Record<Style, Settings>;
    bypass: Bypass;
    current: number;
    before: { settings: Settings; bypass: Bypass };
    picked: Style | null;
  } | null = null;
  private readonly shootEl: HTMLElement;
  private shootSignature = "";
  private readonly refFile: HTMLInputElement;
  private readonly hintsEl: HTMLElement;
  private reference: { name: string; report: Report | null } | null = null;
  private currentHints: Hint[] = [];
  private hintsSignature = "";
  private readonly fileInput: HTMLInputElement;
  private readonly messageEl: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly listenEl: HTMLElement;
  private readonly abButton: HTMLButtonElement;
  private readonly measureButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly refButton: HTMLButtonElement;
  private readonly snapButton: HTMLButtonElement;
  protected readonly toolbar: HTMLElement;
  private readonly knobs = new Map<ParamKey, KnobView>();
  private readonly panels = new Map<Module, PanelView>();
  private readonly meters: Record<"momentary" | "shortTerm" | "integrated" | "truePeak" | "correlation" | "width", MeterView>;
  private readonly monoButton: HTMLButtonElement;
  private readonly streamButton: HTMLButtonElement;
  private readonly liveScoreEl: HTMLElement;
  private readonly meterHead: { bar: HTMLElement; value: HTMLElement; sub: HTMLElement };
  private readonly explainEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  protected readonly lower: HTMLElement;
  protected readonly deskEl: HTMLElement;
  private readonly keysEl: HTMLElement;
  private readonly drills: DrillView;
  private readonly album: AlbumView;
  private readonly modeButtons: Record<Mode, HTMLButtonElement>;
  private mode: Mode = "desk";

  constructor(root: HTMLElement, engine: Engine, tracks: string[]) {
    this.root = root;
    this.engine = engine;
    this.state = engine.state;

    this.trackSelect = h("select");
    this.trackSelect.title = "Songs in MUSIC_DIR";
    this.trackSelect.replaceChildren(...tracks.map((t) => new Option(t, t)));
    this.trackSelect.onchange = (): void => this.run(this.loadTrack(this.trackSelect.value));
    this.fileInput = h("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "audio/*";
    this.fileInput.onchange = (): void => {
      const file = this.fileInput.files?.[0];
      if (file) this.loadFile(file);
    };
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = pickAudioFile([...(e.dataTransfer?.files ?? [])]);
      if (file && this.mode !== "album") this.loadFile(file);
    });
    this.messageEl = h("span", "message");

    this.playButton = button("▶ play", () => this.run(this.engine.toggle()), "space");
    this.timeEl = h("span", "time");
    this.progressFill = h("div", "fill");
    const progress = h("div", "progress", this.progressFill);
    progress.title = "click to seek (, and . jump 5 s)";
    progress.onclick = (ev): void => {
      const rect = progress.getBoundingClientRect();
      this.run(this.engine.seek(((ev.clientX - rect.left) / rect.width) * this.state.duration));
    };
    this.listenEl = h("span", "listen");
    this.abButton = button("A/B", () => this.engine.toggleAB(), "a: hear the original at matched loudness");
    this.measureButton = button("measure song", () => this.run(this.measureMaster()), "m: render the whole song offline and score it");
    this.exportButton = button("export WAV", () => this.run(this.exportWav(24)), "e: 24-bit WAV · E: 16-bit dithered");
    this.refButton = button("Ref", () => this.engine.toggleReference(), "r: hear the reference at the master's loudness");
    this.monoButton = button("Mono", () => this.engine.toggleMono(), "o: listen summed to mono (phone speaker, club PA)");
    this.streamButton = button("streaming", () => this.cycleStream(), "p: hear it the way Spotify / Apple Music / YouTube play it back (their loudness normalization)");
    const saveSnap = button("snap", () => this.saveSnapshot(), "c: save these knobs as a snapshot to compare against");
    this.snapButton = button("vs snap", () => this.toggleSnapshot(), "x: hear the snapshot at the master's loudness · X: swap it with your knobs");
    this.toolbar = h(
      "div",
      "row",
      this.playButton,
      this.timeEl,
      progress,
      this.listenEl,
      this.abButton,
      this.refButton,
      this.monoButton,
      this.streamButton,
      saveSnap,
      this.snapButton,
      this.measureButton,
      this.exportButton,
    );

    this.drills = new DrillView(engine.ctx, () => engine.loaded);
    this.album = new AlbumView(engine.ctx, tracks, {
      pauseDesk: () => engine.pause(),
      openInDesk: (track) => {
        this.setMode("desk");
        this.trackSelect.value = track;
        this.run(this.loadTrack(track));
      },
    });
    this.modeButtons = {
      desk: button("Desk", () => this.setMode("desk"), "d: switch desk / drills"),
      drills: button("Drills", () => this.setMode("drills"), "d: switch desk / drills"),
      album: button("Album", () => this.setMode("album"), "master several songs alike and export them in order"),
    };
    const tabs = h("span", "row tabs", this.modeButtons.desk, this.modeButtons.drills, this.modeButtons.album);
    this.refSelect = h("select");
    this.refSelect.title = "Reference track: a finished song you want yours to sit next to";
    this.refSelect.replaceChildren(new Option("reference: none", ""), ...tracks.map((t) => new Option(`ref: ${t}`, t)));
    this.refSelect.onchange = (): void => this.run(this.loadReferenceTrack(this.refSelect.value));
    this.refFile = h("input");
    this.refFile.type = "file";
    this.refFile.accept = "audio/*";
    this.refFile.title = "Reference from a file";
    this.refFile.onchange = (): void => {
      const file = this.refFile.files?.[0];
      if (file) this.run(file.arrayBuffer().then((data) => this.loadReference(file.name, data)));
    };
    const presetSelect = h("select");
    presetSelect.title = "Load a starting point (u undoes it)";
    presetSelect.replaceChildren(new Option("start from a preset…", ""), ...PRESETS.map((p) => new Option(p.name, p.name)));
    presetSelect.onchange = (): void => {
      const preset = PRESETS.find((p) => p.name === presetSelect.value);
      presetSelect.value = "";
      presetSelect.blur();
      if (preset) this.applyPreset(preset);
    };
    const sessionFile = h("input");
    sessionFile.type = "file";
    sessionFile.accept = ".json,application/json";
    sessionFile.hidden = true;
    sessionFile.onchange = (): void => {
      const file = sessionFile.files?.[0];
      sessionFile.value = "";
      if (file) this.run(this.loadSession(file));
    };
    const session = h("select");
    session.title = "Session file: these knobs as JSON, to keep or load in another browser";
    session.replaceChildren(new Option("session…", ""), new Option("save to file", "save"), new Option("load from file (u undoes)", "load"));
    session.onchange = (): void => {
      const action = session.value;
      session.value = "";
      session.blur();
      if (action === "save") this.saveSession();
      if (action === "load") sessionFile.click();
    };
    const auto = button("auto-master", () => this.run(this.autoMaster()), "A: plan a master from this song's measurements (and the reference), with the reason for each knob");
    this.genreSelect = h("select");
    this.genreSelect.title = "Genre for auto-master: the tonal target, glue, color and clipping a style usually wants (auto = from the [year, genre] tag in the file name)";
    this.genreSelect.onchange = (): void => {
      this.genreOverride = parseGenre(this.genreSelect.value);
    };
    this.syncGenreSelect();
    const shootout = button("shootout", () => this.run(this.startShootout()), "v: hear three versions of the auto-master blind and pick by ear; your picks steer later auto-masters");
    this.refRow = h("div", "row", this.refSelect, this.refFile, this.genreSelect, presetSelect, auto, shootout, session, sessionFile);
    const header = h("header", "", h("div", "row", h("h1", "", "MASTER KIT"), tabs, this.trackSelect, this.fileInput, this.messageEl), this.refRow, this.toolbar);

    const modulePanels = MODULES.map((m) => this.buildPanel(m));
    const meterRows = {
      momentary: this.meterRow("Momentary", new MeterBar(...LUFS_RANGE)),
      shortTerm: this.meterRow("Short-term", new MeterBar(...LUFS_RANGE, { zone: TARGET_ZONE })),
      integrated: this.meterRow("Integrated", new MeterBar(...LUFS_RANGE, { zone: TARGET_ZONE })),
      truePeak: this.meterRow("True peak", new MeterBar(...TP_RANGE, { line: TARGETS.truePeakMax })),
      correlation: this.meterRow("Correlation", new MeterBar(-1, 1, { line: 0 })),
      width: this.meterRow("Side/mid", new MeterBar(...SIDE_RANGE)),
    };
    this.meters = meterRows;
    this.liveScoreEl = h("div", "dim");
    this.meterHead = { bar: h("span", ""), value: h("span", "value"), sub: h("span", "sub") };
    const head = h("div", "meter head", h("span", "", ""), this.meterHead.bar, this.meterHead.value, this.meterHead.sub);
    const meterPanel = h(
      "section",
      "panel meters",
      h("h2", "", "Meters", h("span", "kbd", "z: zero")),
      head,
      ...Object.values(meterRows).map((r) => r.row),
      this.liveScoreEl,
    );
    // Four columns, modules in signal order down and across; more side by side would squeeze the knobs.
    const p = Object.fromEntries(MODULES.map((m, i) => [m, modulePanels[i]])) as Record<Module, HTMLElement>;
    this.deskEl = h(
      "main",
      "desk",
      h("div", "stack", p.eq, p.tame),
      p.multi,
      h("div", "stack", p.comp, p.color, p.limiter),
      h("div", "stack meters-col", meterPanel, p.edges),
    );

    this.explainEl = h("section", "panel explain");
    this.scoreEl = h("section", "panel scorecard");
    this.hintsEl = h("section", "panel hints");
    this.checklistEl = h("section", "panel checklist");
    this.shootEl = h("section", "panel shootout");
    this.shootEl.hidden = true;
    this.lower = h("div", "lower", h("div", "stack", this.checklistEl, this.hintsEl, this.explainEl), this.scoreEl);
    this.keysEl = h("footer", "keys");
    this.keysEl.innerHTML = this.keyHelp();

    root.replaceChildren(h("div", "app", header, this.shootEl, this.deskEl, this.spectrum.el, this.lower, this.drills.el, this.album.el, this.keysEl));
    engine.onChange = (s): void => {
      this.state = s;
      this.schedule();
    };
    document.addEventListener("keydown", (ev) => this.onKey(ev));
    this.schedule();
  }

  protected keyHelp(): string {
    const k = (key: string, what: string): string => `<kbd>${key}</kbd> ${what}`;
    return [
      k("space", "play"),
      k("↑↓", "knob"),
      k("←→", "adjust (shift: fine)"),
      k("tab", "module"),
      k("a", "A/B"),
      k("b", "bypass module"),
      k("0", "reset knob"),
      k("u / U", "undo / redo"),
      k("?", "explain"),
      k(", .", "seek"),
      k("m", "measure"),
      k("l", `Drive for ${TARGETS.integrated} LUFS`),
      k("A", "auto-master"),
      k("v", "blind shootout"),
      k("r", "reference"),
      k("o", "mono"),
      k("p", "streaming preview"),
      k("c / x / X", "snapshot: save / compare / swap"),
      k("s", "solo EQ band"),
      k("h", "apply top hint"),
      k("e / E", "export WAV 24 / 16-bit"),
      k("d", "drills"),
    ].join(" · ");
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "desk") {
      if (this.shoot && !this.shoot.picked) this.endShootout(true);
      this.shoot = null;
      this.engine.pause();
    }
    if (mode === "drills") this.run(this.drills.enter());
    else this.drills.leave();
    if (mode === "album") this.album.render();
    else this.album.leave();
    this.schedule();
  }

  async start(initialTrack: string | null, urlSettings: Settings | null, initialReference: string | null = null): Promise<void> {
    const names = [...this.trackSelect.options].map((o) => o.value);
    const pick = [initialTrack, lastTrack()].find((t): t is string => !!t && names.includes(t)) ?? names[0];
    if (!pick) {
      this.say("no song library here: drop an audio file anywhere or choose one");
      return;
    }
    this.trackSelect.value = pick;
    await this.loadTrack(pick, urlSettings);
    const ref = initialReference ?? lastReference();
    if (ref && names.includes(ref)) {
      this.refSelect.value = ref;
      await this.loadReferenceTrack(ref);
    }
  }

  private async loadReferenceTrack(name: string): Promise<void> {
    if (!name) {
      this.engine.clearReference();
      this.reference = null;
      saveLastReference("");
      this.schedule();
      return;
    }
    const res = await fetch(trackUrl(name));
    if (!res.ok) throw new Error(`could not load reference "${name}" (${res.status})`);
    await this.loadReference(name, await res.arrayBuffer());
  }

  private async loadReference(name: string, data: ArrayBuffer): Promise<void> {
    this.reference = { name, report: null };
    this.say(`loading reference ${name}…`);
    const buffer = await this.engine.loadReference(data);
    saveLastReference(name);
    const report = await measure(channelsOf(buffer), buffer.sampleRate);
    if (this.reference?.name === name) this.reference = { name, report };
    this.say(`reference: ${name}`);
  }

  protected currentGenre(): GenreKey {
    return this.genreOverride ?? genreFromName(this.track);
  }

  private syncGenreSelect(): void {
    const detected = genre(genreFromName(this.track)).label;
    this.genreSelect.replaceChildren(new Option(`genre: auto (${detected})`, ""), ...GENRES.map((g) => new Option(`genre: ${g.label}`, g.key)));
    this.genreSelect.value = this.genreOverride ?? "";
  }

  private cycleStream(): void {
    this.platform = nextPlatform(this.platform);
    if (!this.platform) {
      this.engine.setStream(null);
      this.say("streaming preview off: A/B, reference and snapshot are loudness-matched again");
      return;
    }
    const p = platform(this.platform);
    const up = p.turnsUp ? "turns quieter songs up as far as their peaks allow" : "only turns loud songs down";
    this.say(`streaming preview: ${p.name} plays everything at ${p.lufs} LUFS (${up}). A/B and the reference now play as a listener hears them: normalized, not matched.`);
    this.syncStream();
  }

  /** Platform gains from full-song loudness; the master's follows the knobs live (≈) until a current measurement exists. */
  private syncStream(): void {
    const o = this.originalReport;
    if (!this.platform || !o) return;
    const p = platform(this.platform);
    const s = this.state;
    const measured = this.measured?.key === this.currentKey() ? this.measured.report : null;
    const master = masterLoudness(measured, o, s.matchDb, s.master.truePeak);
    this.streamExact = master.exact;
    const ref = this.reference?.report;
    const want = { master: playbackGainDb(p, master), original: playbackGainDb(p, o), reference: ref ? playbackGainDb(p, ref) : 0 };
    const now = s.stream;
    if (!now || (Object.keys(want) as (keyof typeof want)[]).some((k) => Math.abs(want[k] - now[k]) > 0.05)) this.engine.setStream(want);
  }

  /** The reference plays at the master's loudness: measured if current, else the live meter, else the original. */
  private syncReferenceMatch(): void {
    const ref = this.reference?.report;
    if (!ref) return;
    const measured = this.measured?.key === this.currentKey() ? this.measured.report.integrated : NaN;
    const live = this.state.master.integrated;
    const target = Number.isFinite(measured) ? measured : Number.isFinite(live) ? live : (this.originalReport?.integrated ?? NaN);
    const db = referenceMatchDb(target, ref.integrated);
    if (Math.abs(db - this.state.referenceDb) > 0.05) this.engine.setReferenceMatch(db);
  }

  protected run(p: Promise<unknown> | unknown): void {
    Promise.resolve(p).catch((err: unknown) => this.say(err instanceof Error ? err.message : String(err), true));
  }

  protected say(text: string, error = false): void {
    this.message = text;
    this.messageIsError = error;
    if (error) console.error(text);
    this.schedule();
  }

  private loadFile(file: File): void {
    this.run(file.arrayBuffer().then((data) => this.loadData(file.name, data)));
  }

  private async loadTrack(name: string, settings: Settings | null = null): Promise<void> {
    const res = await fetch(trackUrl(name));
    if (!res.ok) throw new Error(`could not load "${name}" (${res.status})`);
    await this.loadData(name, await res.arrayBuffer(), settings);
  }

  protected async loadData(name: string, data: ArrayBuffer, settings: Settings | null = null): Promise<void> {
    this.say(`loading ${name}…`);
    const copy = data.slice(0);
    await this.engine.load(data);
    this.track = name;
    saveLastTrack(name);
    this.engine.setAll(settings ?? loadSettings(name) ?? defaultSettings());
    this.genreOverride = null;
    this.shoot = null;
    this.syncGenreSelect();
    this.history.clear();
    this.originalReport = null;
    this.measured = null;
    this.heard = { original: false, reference: false, mono: false };
    this.exported = false;
    this.autoSteps = [];
    this.say(name);
    this.drills.songChanged();
    if (this.mode === "drills") this.run(this.drills.enter());
    const native = decodeNative(copy, this.engine.ctx.sampleRate);
    this.native = native;
    const buffer = await native;
    const report = await measure(channelsOf(buffer), buffer.sampleRate);
    if (this.native === native) this.originalReport = report;
    this.schedule();
  }

  protected currentKey(): string {
    return settingsKey(this.state.settings, this.state.bypass);
  }

  /** Renders the whole song offline with the current settings and measures it (reused if nothing changed). */
  protected async measureMaster(): Promise<Measured | null> {
    const native = this.native;
    if (!native || this.busy) return this.measured;
    const key = this.currentKey();
    if (this.measured?.key === key) return this.measured;
    const { settings, bypass } = this.state;
    this.busy = "rendering…";
    this.schedule();
    try {
      const { sampleRate, master } = await renderMaster(await native, settings, bypass);
      if (this.native !== native) return null;
      this.busy = "measuring…";
      this.schedule();
      this.measured = { key, rendered: { sampleRate, master }, report: await measure(master, sampleRate) };
      return this.measured;
    } finally {
      this.busy = "";
      this.schedule();
    }
  }

  /** Sets limiter Drive so the full-song master hits the loudness target (renders the song a few times). */
  protected async matchTarget(): Promise<void> {
    const native = this.native;
    if (!native || this.busy) return;
    const { bypass } = this.state;
    if (bypass.limiter) {
      this.say("the limiter is bypassed: turn it on (b) so Drive can set the loudness", true);
      return;
    }
    const buffer = await native;
    const { settings } = this.state;
    try {
      const { result, audio } = await driveForTarget(
        buffer,
        settings,
        bypass,
        (drive) => {
          this.busy = `matching ${TARGETS.integrated} LUFS: rendering with Drive ${signed(drive)} dB…`;
          this.schedule();
        },
        () => this.native !== native,
      );
      if (this.native !== native) return;
      this.setKnob("limDrive", result.drive, null);
      // Labelled with the settings it was rendered with: if knobs moved meanwhile, it simply shows as stale.
      if (audio) {
        this.busy = "measuring…";
        this.schedule();
        this.measured = { key: settingsKey({ ...settings, limDrive: result.drive }, bypass), rendered: audio, report: await measure(audio.master, audio.sampleRate) };
      }
      const how = result.reached ? "" : ` (closest Drive gets: the target is out of reach${result.drive >= 12 ? ", add compression or makeup" : ""})`;
      this.say(`Drive ${signed(result.drive)} dB → ${db(result.lufs)} LUFS in ${result.steps.length} render${result.steps.length > 1 ? "s" : ""}${how}`);
    } finally {
      this.busy = "";
      this.schedule();
    }
  }

  /** Plans and renders a first master from the song's measurements (and the reference); undoable with u. */
  protected async autoMaster(): Promise<void> {
    const native = this.native;
    const original = this.originalReport;
    if (!native || this.busy) return;
    if (!original) {
      this.say("still measuring the original: try again in a moment");
      return;
    }
    const ref = this.reference?.report ?? null;
    try {
      const auto = await runAutoMaster(
        await native,
        original,
        { reference: ref, genre: this.currentGenre(), taste: tasteLean(loadTaste()) },
        (text) => {
          this.busy = text;
          this.schedule();
        },
        () => this.native !== native,
      );
      if (!auto || this.native !== native) return;
      this.history.record(this.engine.state.settings, null, performance.now());
      this.engine.setAll(auto.settings);
      this.engine.setBypass(auto.bypass);
      this.saveKnobs();
      this.measured = { key: settingsKey(auto.settings, auto.bypass), rendered: auto.audio, report: auto.report };
      this.autoSteps = auto.steps;
      this.say(`auto-master: ${auto.report.integrated.toFixed(1)} LUFS, ${auto.report.truePeak.toFixed(1)} dBTP. Why each knob moved: see Hints. u undoes it`);
    } finally {
      this.busy = "";
      this.schedule();
    }
  }

  /** Renders three versions (gentle, balanced, punchy) at the same loudness and plays them blind, in a random order. */
  protected async startShootout(): Promise<void> {
    const native = this.native;
    const original = this.originalReport;
    if (!native || this.busy) return;
    if (!original) {
      this.say("still measuring the original: try again in a moment");
      return;
    }
    try {
      const result = await runShootout(
        await native,
        original,
        { reference: this.reference?.report ?? null, genre: this.currentGenre() },
        (text) => {
          this.busy = text;
          this.schedule();
        },
        () => this.native !== native,
      );
      if (!result || this.native !== native) return;
      const { settings, bypass } = this.engine.state;
      this.history.record(settings, null, performance.now());
      this.shoot = { order: blindOrder(), versions: result.versions, bypass: result.bypass, current: 0, before: { settings, bypass }, picked: null };
      this.engine.setBypass(result.bypass);
      this.hearVersion(0);
      this.say("blind shootout: 1 / 2 / 3 switch versions (same loudness), Enter picks the one playing, Esc cancels");
    } finally {
      this.busy = "";
      this.schedule();
    }
  }

  private hearVersion(i: number): void {
    const s = this.shoot;
    if (!s || s.picked) return;
    s.current = i;
    this.engine.setAll(s.versions[s.order[i]]);
  }

  private pickVersion(): void {
    const s = this.shoot;
    if (!s || s.picked) return;
    const style = s.order[s.current];
    s.picked = style;
    const taste = recordPick(loadTaste(), style);
    saveTaste(taste);
    this.saveKnobs();
    const lean = tasteLean(taste);
    const where = Math.abs(lean) < 0.05 ? "no lean yet" : `auto-master now leans ${lean > 0 ? "punchy" : "gentle"} ${Math.round(Math.abs(lean) * 100)}%`;
    this.say(`you picked ${s.current + 1} = ${style} (${STYLE_INFO[style]}) · ${where}. Its knobs are on the desk now.`);
  }

  /** `restore`: back to the knobs from before the shootout. */
  private endShootout(restore: boolean): void {
    const s = this.shoot;
    if (!s) return;
    if (restore) {
      this.engine.setAll(s.before.settings);
      this.engine.setBypass(s.before.bypass);
      this.say("shootout cancelled: your knobs are back");
    }
    this.shoot = null;
  }

  private renderShootout(): void {
    const s = this.shoot;
    this.deskEl.classList.toggle("blind", !!s && !s.picked);
    this.spectrum.el.classList.toggle("blind", !!s && !s.picked);
    const signature = JSON.stringify(s ? [s.current, s.picked, s.order] : null);
    if (signature === this.shootSignature) return;
    this.shootSignature = signature;
    this.shootEl.hidden = !s;
    if (!s) return;
    const title = h("h2", "", "Blind shootout", h("span", "kbd", s.picked ? "Enter: done" : "1 2 3 · Enter: pick · Esc"));
    if (s.picked) {
      const taste = loadTaste();
      const reveal = s.order.map((style, i) => h("li", style === s.picked ? "picked" : "", `${i + 1} = ${style}: ${STYLE_INFO[style]}`));
      this.shootEl.replaceChildren(
        title,
        h("ol", "reveal", ...reveal),
        h("p", "dim", `Picks so far: gentle ${taste.gentle} · balanced ${taste.balanced} · punchy ${taste.punchy}. Auto-master leans toward what you pick.`),
        button("done", () => this.endShootout(false), "Enter: keep these knobs"),
      );
      return;
    }
    const versions = s.order.map((_, i) => {
      const b = button(String(i + 1), () => this.hearVersion(i), `${i + 1}: hear version ${i + 1}`);
      b.className = i === s.current ? "on" : "";
      return b;
    });
    this.shootEl.replaceChildren(
      title,
      h("p", "", "Three versions of this master at the same loudness, in a random order. The knobs are hidden: listen, switch, pick the one you'd ship."),
      h("div", "row", ...versions, button("pick this one", () => this.pickVersion(), "Enter"), button("cancel", () => this.endShootout(true), "Esc")),
    );
  }

  /** Renders (or reuses) the full-song master and downloads it as WAV at the song's own sample rate. */
  protected async exportWav(bits: BitDepth): Promise<void> {
    const m = await this.measureMaster();
    if (!m) return;
    const { settings, bypass } = this.state;
    const wav = encodeWav(applyEdges(m.rendered.master, m.rendered.sampleRate, edgeParams(settings, bypass)), m.rendered.sampleRate, bits);
    const name = `${safeBaseName(this.track)} (master ${bits}-bit).wav`;
    download(new Blob([wav], { type: "audio/wav" }), name);
    const r = m.report;
    this.exported = true;
    this.say(`exported "${name}" · ${(m.rendered.sampleRate / 1000).toFixed(1)} kHz · ${db(r.integrated)} LUFS · ${db(r.truePeak)} dBTP`);
  }

  /** `group` null makes the change its own undo step (resets, hints); otherwise quick turns of one knob merge. */
  private setKnob(key: ParamKey, value: number, group: string | null = key): void {
    const before = this.engine.state.settings;
    if (clampParam(key, value) === before[key]) return;
    this.history.record(before, group, performance.now());
    this.engine.set(key, value);
    this.saveKnobs();
  }

  private undo(redo: boolean): void {
    const current = this.engine.state.settings;
    const next = redo ? this.history.redo(current) : this.history.undo(current);
    if (!next) {
      this.say(redo ? "nothing to redo" : "nothing to undo");
      return;
    }
    const changed = changedParams(current, next);
    this.engine.setAll(next);
    this.saveKnobs();
    if (changed.length === 1) this.nav = selectKnob(this.nav, changed[0]);
    this.say(`${redo ? "redo" : "undo"}: ${changed.map((k) => `${SPECS.get(k)?.label} ${formatParam(k, next[k])}`).join(", ")}`);
  }

  private saveSnapshot(): void {
    const { settings, bypass } = this.engine.state;
    this.engine.setSnapshot(settings, bypass);
    this.say("snapshot saved: change knobs, then x flips between it and your knobs (loudness-matched), X swaps them");
  }

  private toggleSnapshot(): void {
    const s = this.engine.state;
    if (!s.snapshotKnobs) {
      this.say("no snapshot yet: c saves the current knobs");
      return;
    }
    this.engine.toggleSnapshot();
    if (this.engine.state.listen === "snapshot") this.say(`snapshot: ${snapshotDiff(s, s.snapshotKnobs)}`);
  }

  /** Undoable like a preset: `u` brings your knobs back (the snapshot keeps what it got). */
  private swapSnapshot(): void {
    const s = this.engine.state;
    if (!s.snapshotKnobs) {
      this.say("no snapshot yet: c saves the current knobs");
      return;
    }
    this.history.record(s.settings, null, performance.now());
    this.engine.swapSnapshot();
    this.saveKnobs();
    this.say("swapped: the snapshot's knobs are now yours (x compares with what you had)");
  }

  private applyPreset(preset: Preset): void {
    this.history.record(this.engine.state.settings, null, performance.now());
    this.engine.setAll(applyPreset(preset, this.originalReport?.integrated));
    this.saveKnobs();
    this.say(`${preset.name}: ${preset.about}`);
    this.schedule();
  }

  private saveSession(): void {
    const { settings, bypass } = this.engine.state;
    const name = sessionFileName(this.track);
    download(new Blob([JSON.stringify(toSession(this.track, settings, bypass), null, 2)], { type: "application/json" }), name);
    this.say(`saved "${name}"`);
  }

  private async loadSession(file: File): Promise<void> {
    if (file.size > MAX_SESSION_BYTES) throw new Error(`"${file.name}" is too big to be a session file`);
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error(`"${file.name}" is not JSON`);
    }
    const session = parseSession(raw);
    if (!session) throw new Error(`"${file.name}" is not a Master Kit session file`);
    this.history.record(this.engine.state.settings, null, performance.now());
    this.engine.setAll(session.settings);
    this.engine.setBypass(session.bypass);
    this.saveKnobs();
    const other = session.track && session.track !== this.track ? ` (saved for ${session.track})` : "";
    this.say(`loaded session${other}: u undoes it`);
  }

  private saveKnobs(): void {
    if (this.track) saveSettings(this.track, this.engine.state.settings);
  }

  private buildPanel(module: Module): HTMLElement {
    const bypass = button("on", () => this.engine.toggleBypass(module), "b: bypass this module");
    bypass.onpointerdown = (ev): void => ev.stopPropagation();
    const title = h("h2", "", MODULE_NAMES[module], bypass);
    title.onclick = (): void => {
      this.nav = { ...this.nav, module };
      this.schedule();
    };
    const el = h("section", "panel", title);
    for (const key of knobsOf(module)) {
      const bar = new MeterBar(0, 1);
      const value = h("span", "value");
      const row = h("div", "knob", h("span", "label", SPECS.get(key)?.label ?? key), bar.el, value);
      row.onclick = (): void => {
        this.nav = selectKnob(this.nav, key);
        this.schedule();
      };
      row.ondblclick = (): void => this.setKnob(key, DEFAULTS[key], null);
      this.dragKnob(bar.el, key);
      el.append(row);
      this.knobs.set(key, { row, bar, value });
    }
    const view: PanelView = { el, bypass };
    if (isDynamics(module)) {
      const grRow = (name: string): { bar: MeterBar; value: HTMLElement } => {
        const bar = new MeterBar(0, GR_MAX);
        const value = h("span", "value");
        const label = h("span", "", name);
        label.title = "gain reduction: how much this is turning the song down right now";
        el.append(h("div", "meter gr", label, bar.el, value, h("span", "")));
        return { bar, value };
      };
      const names = BAND_GR_NAMES[module];
      const rows = names ? names.map((name) => grRow(`${name} GR`)) : [grRow(module === "color" ? "Clip" : "GR")];
      // The tamer and color panels stay short: a trace each would make their column the tallest.
      const trace = module === "tame" || module === "color" ? null : new GrTrace(GR_MAX, 10);
      if (trace) el.append(trace.el);
      view.gr = { module, rows, trace };
    }
    this.panels.set(module, view);
    return el;
  }

  private dragKnob(bar: HTMLElement, key: ParamKey): void {
    const setFrom = (ev: PointerEvent): void => {
      const rect = bar.getBoundingClientRect();
      this.setKnob(key, fromFraction(key, (ev.clientX - rect.left) / rect.width));
    };
    bar.onpointerdown = (ev): void => {
      bar.setPointerCapture(ev.pointerId);
      this.nav = selectKnob(this.nav, key);
      setFrom(ev);
    };
    bar.onpointermove = (ev): void => {
      if (bar.hasPointerCapture(ev.pointerId)) setFrom(ev);
    };
  }

  private meterRow(label: string, bar: MeterBar): MeterView {
    const value = h("span", "value");
    const sub = h("span", "sub");
    return { row: h("div", "meter", h("span", "", label), bar.el, value, sub), bar, value, sub };
  }

  protected onKey(ev: KeyboardEvent): void {
    if (ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLInputElement) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const action = this.keyAction(ev);
    if (!action) return;
    ev.preventDefault();
    this.run(action());
    this.schedule();
  }

  protected keyAction(ev: KeyboardEvent): (() => unknown) | null {
    if (ev.key === "d") return () => this.setMode(this.mode === "desk" ? "drills" : "desk");
    if (this.mode === "drills") return this.drills.keyAction(ev);
    if (this.mode === "album") return this.album.keyAction(ev);
    if (this.shoot && !this.shoot.picked) {
      // Blind: only listening keys; the knobs would give the versions away.
      const listening: Record<string, () => unknown> = {
        " ": () => this.engine.toggle(),
        "1": () => this.hearVersion(0),
        "2": () => this.hearVersion(1),
        "3": () => this.hearVersion(2),
        Enter: () => this.pickVersion(),
        Escape: () => this.endShootout(true),
        ",": () => this.engine.seek(this.state.position - SEEK_SECONDS),
        ".": () => this.engine.seek(this.state.position + SEEK_SECONDS),
        a: () => this.engine.toggleAB(),
        o: () => this.engine.toggleMono(),
        p: () => this.cycleStream(),
      };
      return listening[ev.key] ?? null;
    }
    if (this.shoot?.picked && (ev.key === "Escape" || ev.key === "Enter")) return () => this.endShootout(false);
    const knob = selected(this.nav);
    const s = this.state;
    const actions: Record<string, () => unknown> = {
      " ": () => this.engine.toggle(),
      ArrowUp: () => (this.nav = moveKnob(this.nav, -1)),
      ArrowDown: () => (this.nav = moveKnob(this.nav, 1)),
      ArrowLeft: () => this.setKnob(knob, nudge(knob, s.settings[knob], ev.shiftKey ? -FINE : -1)),
      ArrowRight: () => this.setKnob(knob, nudge(knob, s.settings[knob], ev.shiftKey ? FINE : 1)),
      Tab: () => (this.nav = moveModule(this.nav, ev.shiftKey ? -1 : 1)),
      a: () => this.engine.toggleAB(),
      b: () => this.engine.toggleBypass(this.nav.module),
      "0": () => this.setKnob(knob, DEFAULTS[knob], null),
      u: () => this.undo(false),
      U: () => this.undo(true),
      "?": () => (this.explain = !this.explain),
      ",": () => this.engine.seek(s.position - SEEK_SECONDS),
      ".": () => this.engine.seek(s.position + SEEK_SECONDS),
      Home: () => this.engine.seek(0),
      m: () => this.measureMaster(),
      l: () => this.matchTarget(),
      A: () => this.autoMaster(),
      v: () => this.startShootout(),
      r: () => this.engine.toggleReference(),
      o: () => this.engine.toggleMono(),
      p: () => this.cycleStream(),
      c: () => this.saveSnapshot(),
      x: () => this.toggleSnapshot(),
      X: () => this.swapSnapshot(),
      s: () => {
        if (this.soloOn) this.soloOn = false;
        else if (soloBand(knob, eqBands(s.settings, s.bypass))) this.soloOn = true;
        else this.say("select an EQ band's knob (or grab its dot) to solo it");
      },
      h: () => this.applyHint(this.currentHints.find((x) => x.knob && x.suggest !== undefined)),
      e: () => this.exportWav(24),
      E: () => this.exportWav(16),
      z: () => this.engine.resetMeters(),
    };
    return actions[ev.key] ?? null;
  }

  protected schedule(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  protected render(): void {
    const s = this.state;
    /** Not on the Desk: its panels are hidden and skip their drawing. */
    const drilling = this.mode !== "desk";
    for (const el of [this.toolbar, this.refRow, this.deskEl, this.spectrum.el, this.lower, this.keysEl]) el.hidden = drilling;
    this.drills.el.hidden = this.mode !== "drills";
    this.album.el.hidden = this.mode !== "album";
    for (const m of ["desk", "drills", "album"] as const) this.modeButtons[m].className = this.mode === m ? "on" : "";
    this.trackSelect.hidden = this.mode === "album" || this.trackSelect.options.length === 0;
    this.fileInput.hidden = this.mode === "album";
    this.messageEl.textContent = this.busy || this.message;
    this.messageEl.className = `message${this.messageIsError ? " error" : ""}`;
    this.playButton.textContent = s.playing ? "❚❚ pause" : "▶ play";
    this.timeEl.textContent = `${clock(s.position)} / ${clock(s.duration)}`;
    this.progressFill.style.width = `${s.duration > 0 ? (s.position / s.duration) * 100 : 0}%`;
    this.syncReferenceMatch();
    this.syncStream();
    const st = s.stream;
    const listenLabels: Record<Listen, string> = st
      ? {
          master: `MASTER ${signed(st.master)} dB`,
          original: `ORIGINAL ${signed(st.original)} dB`,
          reference: `REFERENCE ${signed(st.reference)} dB`,
          snapshot: `SNAPSHOT ${signed(st.master + s.snapshotDb)} dB`,
        }
      : {
          master: "MASTER",
          original: `ORIGINAL ${signed(s.matchDb)} dB`,
          reference: `REFERENCE ${signed(s.referenceDb)} dB`,
          snapshot: `SNAPSHOT ${signed(s.snapshotDb)} dB`,
        };
    this.listenEl.textContent = listenLabels[s.listen];
    if (this.platform) this.listenEl.textContent += ` · ON ${platform(this.platform).name.toUpperCase()}${this.streamExact ? "" : " ≈"}`;
    this.streamButton.textContent = this.platform ? `on ${platform(this.platform).name}` : "streaming";
    this.streamButton.className = this.platform ? "on" : "";
    this.refButton.disabled = !s.hasReference;
    this.refButton.className = s.listen === "reference" ? "on" : "";
    this.snapButton.disabled = !s.snapshotKnobs;
    this.snapButton.className = s.listen === "snapshot" ? "on" : "";
    this.listenEl.className = `listen ${s.listen}`;
    this.abButton.className = s.listen === "original" ? "on" : "";
    this.monoButton.className = s.mono ? "on" : "";
    if (s.mono) this.listenEl.textContent += " · MONO";
    this.syncSolo();
    if (s.solo !== null) this.listenEl.textContent += ` · SOLO ${formatParam("eqMudFreq", s.solo)}`;
    this.measureButton.disabled = !!this.busy || !this.engine.loaded;
    this.exportButton.disabled = this.measureButton.disabled;

    const current = selected(this.nav);
    for (const [key, view] of this.knobs) {
      const v = s.settings[key];
      const spec = SPECS.get(key);
      const f = toFraction(key, v);
      const snap = s.snapshotKnobs?.settings[key];
      const ghost = snap !== undefined && snap !== v ? toFraction(key, snap) : NaN;
      view.bar.span(spec && spec.min < 0 && spec.max > 0 ? toFraction(key, 0) : 0, f, "", ghost);
      view.value.textContent = formatParam(key, v);
      view.row.className = `knob${key === current ? " selected" : ""}${Math.abs(v - DEFAULTS[key]) > 1e-9 ? " changed" : ""}`;
    }
    for (const [module, view] of this.panels) {
      const off = s.bypass[module];
      view.el.className = `panel${module === this.nav.module ? " active" : ""}${off ? " bypassed" : ""}`;
      view.bypass.textContent = off ? "bypassed" : "on";
      view.bypass.className = off ? "off" : "on";
      if (view.gr) {
        const values = BAND_GR_NAMES[view.gr.module] ? (s.reduction.bands[view.gr.module] ?? []) : [s.reduction[view.gr.module]];
        view.gr.rows.forEach((row, i) => {
          const gr = values[i] ?? 0;
          row.bar.set(gr, gr > 6 ? "bad" : gr > 3 ? "warn" : "");
          row.value.textContent = `${gr.toFixed(1)} dB`;
        });
        const ring = this.engine.grHistory[view.gr.module];
        if (!drilling) view.gr.trace?.draw(ring.values(), ring.size);
      }
    }

    // While you hear the reference the bars show it, with the master as the "|" marker.
    const { main: m, ghost: o, labels } = meterPair(s.listen, { reference: s.hasReference, snapshot: !!s.snapshotKnobs }, s);
    this.meterHead.bar.textContent = `| = ${labels[1]}`;
    this.meterHead.value.textContent = labels[0];
    this.meterHead.sub.textContent = labels[1];
    const inZone = (x: number): "" | "good" => (x >= TARGET_ZONE[0] && x <= TARGET_ZONE[1] ? "good" : "");
    this.meterSet(this.meters.momentary, m.momentary, o.momentary, "");
    this.meterSet(this.meters.shortTerm, m.shortTerm, o.shortTerm, inZone(m.shortTerm));
    this.meterSet(this.meters.integrated, m.integrated, o.integrated, inZone(m.integrated) || (Number.isFinite(m.integrated) ? "warn" : ""));
    this.meterSet(this.meters.truePeak, m.truePeak, o.truePeak, m.truePeak > TARGETS.truePeakMax ? "bad" : "good");
    const corr = (x: number): number => (x + 1) / 2;
    this.meters.correlation.bar.span(0.5, Number.isFinite(m.correlation) ? corr(m.correlation) : 0.5, m.correlation < 0 ? "bad" : "good", corr(o.correlation));
    this.meters.correlation.value.textContent = Number.isFinite(m.correlation) ? m.correlation.toFixed(2) : "–";
    this.meters.correlation.sub.textContent = Number.isFinite(o.correlation) ? o.correlation.toFixed(2) : "–";
    this.meterSet(this.meters.width, m.sideDb, o.sideDb, "");

    if (!drilling) this.drawSpectrum(current);

    const live = this.liveScore();
    this.liveScoreEl.textContent = live
      ? `live score ${live.total}/100 (since play) · PLR ${db(s.master.truePeak - s.master.integrated)} dB`
      : "live score: play the song (z restarts the meters after big changes)";

    this.renderExplain(current);
    this.renderChecklist();
    this.renderShootout();
    this.renderHints();
    this.renderScore();
  }

  /** Bars: what you hear; line: what it is compared with. Both sit at the master's loudness so only tone differs. */
  private drawSpectrum(current: ParamKey): void {
    const s = this.state;
    const bins = this.spectrumBins;
    for (const which of LISTENS) this.engine.spectrum(which, bins[which]);
    const css = getComputedStyle(document.documentElement);
    const color = (name: string): string => css.getPropertyValue(name).trim();
    const master = { bins: bins.master, offsetDb: 0, color: color("--series-master"), label: "master" };
    const pair =
      s.listen === "reference" && s.hasReference
        ? { main: { bins: bins.reference, offsetDb: s.referenceDb, color: color("--series-reference"), label: "reference" }, ghost: master }
        : s.listen === "snapshot" && s.snapshotKnobs
          ? { main: { bins: bins.snapshot, offsetDb: s.snapshotDb, color: color("--series-snapshot"), label: "snapshot" }, ghost: master }
          : { main: master, ghost: { bins: bins.original, offsetDb: s.matchDb, color: color("--series-original"), label: "original" } };
    const bands = eqBands(s.settings, s.bypass);
    this.spectrum.draw({
      ...pair,
      sampleRate: this.engine.ctx.sampleRate,
      bands,
      selected: EQ_BAND_KNOBS.findIndex((k) => k.freq === current || k.gain === current || k.q === current),
      solo: this.soloOn ? soloBand(current, bands) : null,
    });
  }

  /** Solo follows the selected band (and its frequency as you move it); a non-band knob ends it. */
  private syncSolo(): void {
    const band = this.soloOn ? soloBand(selected(this.nav), eqBands(this.state.settings, this.state.bypass)) : null;
    if (!band) this.soloOn = false;
    const key = band ? `${band.frequency}:${band.q}` : "";
    if (key === this.soloKey) return;
    this.soloKey = key;
    this.engine.setSolo(band);
  }

  private applyHint(hint: Hint | undefined): void {
    if (!hint?.knob) return;
    this.nav = selectKnob(this.nav, hint.knob);
    if (hint.suggest !== undefined) this.setKnob(hint.knob, this.state.settings[hint.knob] + hint.suggest, null);
    this.schedule();
  }

  private renderChecklist(): void {
    const s = this.state;
    if (s.playing) {
      if (s.listen === "original") this.heard.original = true;
      if (s.listen === "reference") this.heard.reference = true;
      if (s.mono) this.heard.mono = true;
    }
    const o = this.originalReport;
    const r = this.measured?.key === this.currentKey() ? this.measured.report : null;
    const sc = o && r ? score(o, r) : null;
    const steps = checklist({
      hasReference: s.hasReference,
      heard: this.heard,
      compGr: this.engine.grHistory.comp.values(),
      measured: r && sc ? { integrated: r.integrated, truePeak: r.truePeak, dynamicsOk: sc.parts.some((p) => p.name === "dynamics" && p.ok) } : null,
      exported: this.exported,
    });
    const signature = JSON.stringify(steps);
    if (signature === this.checklistSignature) return;
    this.checklistSignature = signature;
    const next = steps.find((st) => !st.done);
    const count = steps.filter((st) => st.done).length;
    this.checklistEl.replaceChildren(
      h("h2", "", "Checklist", h("span", "kbd", `${count}/${steps.length}`)),
      h(
        "ul",
        "",
        ...steps.map((st) => {
          const li = h("li", st.done ? "done" : "", `${st.done ? "✓" : "○"} ${st.label}`, ...(st.status ? [h("span", "dim", ` · ${st.status}`)] : []));
          li.title = st.tip;
          return li;
        }),
      ),
      h("p", "dim", next ? `Next: ${next.tip}` : "All done: trust your ears for a last listen, then ship it."),
    );
  }

  private renderHints(): void {
    const o = this.originalReport;
    const title = h("h2", "", "Hints", h("span", "kbd", "h: apply top"));
    if (!o) {
      this.currentHints = [];
      this.hintsSignature = "";
      this.hintsEl.replaceChildren(title, h("p", "dim", "measuring the original…"));
      return;
    }
    const measured = this.measured?.key === this.currentKey() ? this.measured.report : null;
    this.currentHints = hints({ original: o, master: measured, settings: this.state.settings, bypass: this.state.bypass, reference: this.reference?.report });
    const signature = JSON.stringify([this.currentHints, this.reference?.name, !!this.reference?.report, this.autoSteps]);
    if (signature === this.hintsSignature) return;
    if (this.autoEl?.dataset.steps !== JSON.stringify(this.autoSteps)) {
      this.autoEl = this.autoSteps.length
        ? h("details", "auto", h("summary", "", "Auto-master: why each knob moved"), h("ol", "", ...this.autoSteps.map((st) => h("li", "", st))))
        : null;
      if (this.autoEl) {
        this.autoEl.open = true;
        this.autoEl.dataset.steps = JSON.stringify(this.autoSteps);
      }
    }
    this.hintsSignature = signature;
    const items = this.currentHints.map((hint) => {
      const li = h("li", hint.level, hint.text);
      if (hint.knob) {
        const label = hint.suggest !== undefined ? `apply ${signed(hint.suggest)}` : "go to knob";
        const b = button(label, () => this.applyHint(hint), hint.suggest !== undefined ? `set ${SPECS.get(hint.knob)?.label} ${signed(hint.suggest)}` : "");
        b.style.marginLeft = "6px";
        li.append(b);
      }
      return li;
    });
    const refNote = this.reference
      ? h("p", "dim", this.reference.report ? `comparing tone with ${this.reference.name}` : "measuring the reference…")
      : h("p", "dim", "pick a reference above to compare tonal balance");
    this.hintsEl.replaceChildren(title, ...(this.autoEl ? [this.autoEl] : []), h("ul", "", ...items), refNote);
  }

  private meterSet(view: MeterView, master: number, original: number, tone: "" | "good" | "warn" | "bad"): void {
    view.bar.set(master, tone, original);
    view.value.textContent = db(master);
    view.sub.textContent = db(original);
  }

  private liveScore(): Score | null {
    const m = this.state.master;
    if (!Number.isFinite(m.integrated)) return null;
    return score({ plr: this.originalReport?.plr ?? Infinity }, { integrated: m.integrated, truePeak: m.truePeak, plr: m.truePeak - m.integrated });
  }

  /** Rebuilt only when the knob changes, so the meters section keeps its open/closed state. */
  private renderExplain(current: ParamKey): void {
    const signature = this.explain ? current : "";
    if (signature === this.explainSignature) return;
    this.explainSignature = signature;
    if (!this.explain) {
      this.explainEl.replaceChildren(h("p", "dim", "? shows explanations"));
      return;
    }
    this.meterHelp ??= h("details", "", h("summary", "dim", "About the meters"), ...Object.values(METER_HELP).map((t) => h("p", "dim", t)));
    this.explainEl.replaceChildren(
      h("h2", "", `${SPECS.get(current)?.label ?? current}`, h("span", "kbd", "?: hide")),
      h("p", "", PARAM_HELP[current]),
      h("p", "dim", MODULE_HELP[this.nav.module]),
      this.meterHelp,
    );
  }

  /** What each platform does to the volume: louder than its target buys nothing, it's just turned down. */
  private streamingTable(o: Report, master: Report | null, ref: Report | null): Node[] {
    const cell = (p: (typeof PLATFORMS)[number], r: Report | null, cls = ""): HTMLElement => h("td", cls, r ? `${signed(playbackGainDb(p, r))} dB` : "");
    const rows = PLATFORMS.map((p) =>
      h("tr", "", h("td", "", `${p.name} (${p.lufs} LUFS)`), cell(p, o), cell(p, master), h("td", "", ""), ...(ref ? [cell(p, ref, "ref")] : []), h("td", "", "")),
    );
    const head = h("tr", "", h("th", "", "plays it at"), h("th", "", "original"), h("th", "", "master"), h("th", "", ""), ...(ref ? [h("th", "ref", "ref")] : []), h("th", "", ""));
    const spotify = PLATFORMS[0];
    const cut = master ? -playbackGainDb(spotify, master) : 0;
    const note =
      cut > 0.5
        ? `${spotify.name} turns this master down ${cut.toFixed(1)} dB: that loudness bought nothing, and the limiting it took stays. p plays it as listeners hear it.`
        : "p plays it as listeners hear it: each song at the platform's level, not matched to each other.";
    return [h("h3", "", "On streaming", h("span", "dim", " · volume change on playback (loudness normalization)")), h("table", "", head, ...rows), h("p", "dim", note)];
  }

  protected renderScore(): void {
    const o = this.originalReport;
    const mm = this.measured;
    const stale = mm && mm.key !== this.currentKey();
    const title = h("h2", "", "Full-song check", h("span", "kbd", "m: measure"));
    if (!o) {
      this.scoreEl.replaceChildren(title, h("p", "dim", this.engine.loaded ? "measuring the original…" : "load a song"));
      return;
    }
    const r = mm?.report;
    const ref = this.reference?.report;
    const row = (label: string, pick: (x: Report) => number, unit: string, digits = 1): HTMLElement => {
      const cell = (x: number | undefined, cls = ""): HTMLElement => h("td", cls, x === undefined ? "" : db(x, digits));
      const a = pick(o);
      const b = r ? pick(r) : undefined;
      return h(
        "tr",
        "",
        h("td", "", label),
        cell(a),
        cell(b),
        h("td", "dim", b === undefined ? "" : signed(b - a, digits)),
        ...(ref ? [cell(pick(ref), "ref")] : []),
        h("td", "dim", unit),
      );
    };
    const table = h(
      "table",
      "",
      h("tr", "", h("th", "", ""), h("th", "", "original"), h("th", "", "master"), h("th", "", "Δ"), ...(ref ? [h("th", "ref", "ref")] : []), h("th", "", "")),
      row("Integrated", (x) => x.integrated, "LUFS"),
      row("True peak", (x) => x.truePeak, "dBTP"),
      row("LRA", (x) => x.loudnessRange, "LU"),
      row("PLR", (x) => x.plr, "dB"),
      row("Crest", (x) => x.crest, "dB"),
      row("Correlation", (x) => x.stereo.correlation, "", 2),
      row("Side/mid", (x) => x.stereo.sideDb, "dB"),
      ...o.bands.map((band, i) => row(band.label, (x) => x.bands[i].db, "dB")),
    );
    const children: Node[] = [title];
    if (r) {
      const sc = score(o, r);
      children.push(
        h("div", "total", `${sc.total}/100`),
        h(
          "div",
          "parts",
          ...sc.parts.map((p) => h("div", p.ok ? "ok" : "notok", `${p.ok ? "✓" : "✗"} ${p.name} ${Math.round(p.points)}/${p.max} · ${p.detail}`)),
        ),
      );
      if (stale) children.push(h("p", "stale", "settings changed since this measurement: press m"));
    } else {
      children.push(h("p", "dim", this.busy || "press m to render the whole song with these settings and score it"));
    }
    children.push(h("h3", "", "Loudness over the song", h("span", "dim", " · blue original · amber master · click to seek")), this.plot.el, table);
    children.push(...this.streamingTable(o, r && !stale ? r : null, ref ?? null));
    this.scoreEl.replaceChildren(...children);
    this.plot.update(o, r && !stale ? r : null, ref ?? null, this.state.position);
  }
}
