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
import { GENRES, genre, genreFromName } from "../master/genres.ts";
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
import { pickAudioFile, songTitle } from "../master/library.ts";
import { REMUX_HEADER, SYNC_LOCKED_KEYS, assertSameLength, isVideoName, remuxOutcome, videoExportName } from "../master/video.ts";
import { HANDOFF_TIMEOUT_MS, handoffMessage, isShaderReady, shaderOrigin, videoMimeType } from "../master/handoff.ts";
import { MeterBar, button, clock, db, download, h, keyButton, setLabel, signed } from "./dom.ts";
import { Palette } from "./palette.ts";
import type { Command } from "./palette.ts";
import { GrTrace } from "./gr-trace.ts";
import { LoudnessPlot } from "./loudness-plot.ts";
import { initialNav, jumpModule, knobsOf, moveKnob, moveModule, selectKnob, selected } from "./nav.ts";
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

/** The `?` overlay. Space-separated keys render as separate caps. */
const KEY_GROUPS: [string, [string, string][]][] = [
  [
    "Find anything",
    [
      ["/", "command palette (also Ctrl+K)"],
      ["t", "pick a song"],
      ["R", "pick a reference"],
      ["G", "pick a genre"],
      ["P", "start from a preset"],
      ["?", "this list"],
    ],
  ],
  [
    "Knobs",
    [
      ["Tab 1–7", "module (Shift+Tab back)"],
      ["↑ ↓", "knob"],
      ["← →", "turn it (Shift: fine)"],
      ["0", "reset knob"],
      ["b", "bypass module"],
      ["u U", "undo / redo"],
      ["i", "explanations on / off"],
    ],
  ],
  [
    "Listen",
    [
      ["space", "play / pause"],
      [", .", "back / forward 5 s"],
      ["a", "A/B with the original"],
      ["r", "the reference"],
      ["o", "mono"],
      ["p", "streaming preview"],
      ["s", "solo EQ band"],
    ],
  ],
  [
    "Compare",
    [
      ["c", "save snapshot"],
      ["x", "hear snapshot"],
      ["X", "swap snapshot and knobs"],
      ["v", "blind shootout (1 2 3, Enter)"],
    ],
  ],
  [
    "Master",
    [
      ["A", "auto-master"],
      ["h", "apply top hint"],
      ["l", `Drive for ${TARGETS.integrated} LUFS`],
      ["m", "measure the whole song"],
      ["z", "restart the meters"],
      ["e E", "export WAV 24 / 16-bit (a video: e exports the video)"],
    ],
  ],
  ["Modes", [["d", "desk / drills"]]],
];

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

/** A panel heading's shortcut: the key cap, then what it does. */
function headKey(key: string, what: string): HTMLElement {
  return h("span", "kbd", h("kbd", "", key), ` ${what}`);
}

export function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: Math.max(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
}

export class Desk {
  readonly root: HTMLElement;
  protected readonly engine: Engine;
  protected state: EngineState;
  protected track = "";
  /** The song is a video's sound: Lead-in and Tail are locked at 0 and export must keep the exact length. */
  protected video = false;
  /** The video file itself, kept for Export video (decoding detaches the other copies). */
  private videoBytes: ArrayBuffer | null = null;
  /** The picked file's own MIME type ("" for library tracks). */
  private videoType = "";
  protected originalReport: Report | null = null;
  protected measured: Measured | null = null;
  /** The song decoded at its file's own sample rate: what gets measured, rendered and exported. */
  protected native: Promise<AudioBuffer> | null = null;
  protected busy = "";
  private nav: Nav = initialNav();
  private readonly history = new History<Settings>();
  private readonly checklistEl: HTMLElement;
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

  private readonly tracks: string[];
  private readonly palette = new Palette();
  private readonly keysDialog: HTMLDialogElement;
  private readonly songCrumb: HTMLButtonElement;
  private readonly refCrumb: HTMLButtonElement;
  private readonly genreCrumb: HTMLButtonElement;
  private readonly sessionFile: HTMLInputElement;
  private readonly rail = new Map<Module, HTMLElement>();
  private readonly helpEl: HTMLElement;
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
  private readonly shaderButton: HTMLButtonElement;
  private readonly shaderOrigin = shaderOrigin(location.origin);
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
  private readonly drills: DrillView;
  private readonly album: AlbumView;
  private readonly modeButtons: Record<Mode, HTMLButtonElement>;
  private mode: Mode = "desk";

  constructor(root: HTMLElement, engine: Engine, tracks: string[]) {
    this.root = root;
    this.engine = engine;
    this.state = engine.state;

    this.tracks = tracks;
    this.fileInput = h("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "audio/*,video/*";
    this.fileInput.hidden = true;
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

    this.playButton = keyButton("Play", "space", () => this.run(this.engine.toggle()), "play / pause");
    this.playButton.classList.add("play");
    this.timeEl = h("span", "time");
    this.progressFill = h("div", "fill");
    const progress = h("div", "progress", this.progressFill);
    progress.title = "click to seek (, and . jump 5 s, Home to the top)";
    progress.onclick = (ev): void => {
      const rect = progress.getBoundingClientRect();
      this.run(this.engine.seek(((ev.clientX - rect.left) / rect.width) * this.state.duration));
    };
    this.listenEl = h("span", "listen");
    this.abButton = keyButton("A/B", "a", () => this.engine.toggleAB(), "hear the original at matched loudness");
    this.measureButton = keyButton("Measure", "m", () => this.run(this.measureMaster()), "render the whole song offline and score it");
    this.exportButton = keyButton("Export", "e", () => this.run(this.exportMain()), "24-bit WAV, or the video with the master under it (E: 16-bit WAV)");
    this.exportButton.classList.add("primary");
    this.shaderButton = button("Open in Music Shader", () => this.openInShader(), "send this video and its master to Music Shader to add visuals");
    this.shaderButton.hidden = true;
    this.refButton = keyButton("Ref", "r", () => this.engine.toggleReference(), "hear the reference at the master's loudness");
    this.monoButton = keyButton("Mono", "o", () => this.engine.toggleMono(), "listen summed to mono (phone speaker, club PA)");
    this.streamButton = keyButton("Stream", "p", () => this.cycleStream(), "hear it the way Spotify / Apple Music / YouTube play it back (their loudness normalization)");
    const saveSnap = keyButton("Snap", "c", () => this.saveSnapshot(), "save these knobs as a snapshot to compare against");
    this.snapButton = keyButton("vs Snap", "x", () => this.toggleSnapshot(), "hear the snapshot at the master's loudness (X: swap it with your knobs)");
    const auto = keyButton("Auto", "A", () => this.run(this.autoMaster()), "auto-master: plan a master from this song's measurements (and the reference), with the reason for each knob");
    this.toolbar = h(
      "div",
      "transport",
      h("div", "group", this.playButton, this.timeEl),
      progress,
      this.listenEl,
      h("div", "group", this.abButton, this.refButton, this.monoButton, this.streamButton, saveSnap, this.snapButton),
      h("div", "group", auto, this.measureButton, this.exportButton, this.shaderButton),
    );

    this.drills = new DrillView(engine.ctx, () => engine.loaded);
    this.album = new AlbumView(engine.ctx, tracks, {
      pauseDesk: () => engine.pause(),
      openInDesk: (track) => {
        this.setMode("desk");
        this.run(this.loadTrack(track));
      },
    });
    this.modeButtons = {
      desk: button("Desk", () => this.setMode("desk"), "d: switch desk / drills"),
      drills: button("Drills", () => this.setMode("drills"), "d: switch desk / drills"),
      album: button("Album", () => this.setMode("album"), "master several songs alike and export them in order"),
    };
    const tabs = h("nav", "tabs", this.modeButtons.desk, this.modeButtons.drills, this.modeButtons.album);
    tabs.setAttribute("aria-label", "Mode");
    this.refFile = h("input");
    this.refFile.type = "file";
    this.refFile.accept = "audio/*,video/*";
    this.refFile.hidden = true;
    this.refFile.onchange = (): void => {
      const file = this.refFile.files?.[0];
      if (file) this.run(file.arrayBuffer().then((data) => this.loadReference(file.name, data)));
    };
    this.sessionFile = h("input");
    this.sessionFile.type = "file";
    this.sessionFile.accept = ".json,application/json";
    this.sessionFile.hidden = true;
    this.sessionFile.onchange = (): void => {
      const file = this.sessionFile.files?.[0];
      this.sessionFile.value = "";
      if (file) this.run(this.loadSession(file));
    };
    const crumb = (what: string, key: string, group: string): HTMLButtonElement => {
      const b = h("button", "crumb", h("span", "crumb-label", what), h("span", "crumb-value"), h("kbd", "", key));
      b.type = "button";
      b.title = `${what}: change it (${key})`;
      b.onclick = (): void => this.openPalette(group);
      return b;
    };
    this.songCrumb = crumb("Song", "t", "Song");
    this.refCrumb = crumb("Ref", "R", "Reference");
    this.genreCrumb = crumb("Genre", "G", "Genre");
    const search = h("button", "search-button", h("span", "", "Commands"), h("kbd", "", "/"));
    search.type = "button";
    search.title = "Command palette: every song, setting and action (/ or Ctrl+K)";
    search.onclick = (): void => this.openPalette();
    const keysButton = h("button", "icon-button", "?");
    keysButton.type = "button";
    keysButton.title = "Keyboard shortcuts (?)";
    keysButton.setAttribute("aria-label", "Keyboard shortcuts");
    keysButton.onclick = (): void => this.toggleKeys();
    const header = h(
      "header",
      "topbar",
      h("h1", "", "Master Kit"),
      tabs,
      h("div", "crumbs", this.songCrumb, this.refCrumb, this.genreCrumb),
      h("div", "topbar-end", search, keysButton),
      this.fileInput,
      this.refFile,
      this.sessionFile,
    );
    this.keysDialog = this.buildKeysDialog();

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
      h("h2", "", "Meters", headKey("z", "restart")),
      head,
      ...Object.values(meterRows).map((r) => r.row),
      this.liveScoreEl,
    );
    // One module open at a time: the rail picks it (Tab, 1–7), the stage shows its knobs over the spectrum.
    const railList = h("ol", "rail-list");
    MODULES.forEach((m, i) => {
      const item = h("button", "rail-item", h("kbd", "", String(i + 1)), h("span", "rail-name", MODULE_NAMES[m]), h("span", "rail-state"));
      item.type = "button";
      item.onclick = (): void => {
        this.nav = jumpModule(this.nav, i);
        this.schedule();
      };
      railList.append(h("li", "", item));
      this.rail.set(m, item);
    });
    const railEl = h("nav", "rail", railList);
    railEl.setAttribute("aria-label", "Modules, in signal order");

    this.explainEl = h("section", "explain");
    this.scoreEl = h("section", "panel scorecard");
    this.hintsEl = h("section", "panel hints");
    this.checklistEl = h("section", "panel checklist");
    this.shootEl = h("section", "panel shootout");
    this.shootEl.hidden = true;
    this.deskEl = h(
      "main",
      "desk",
      railEl,
      h("div", "stage", ...modulePanels, this.explainEl, this.spectrum.el),
      h("div", "side", meterPanel, this.hintsEl, this.checklistEl),
    );
    this.lower = h("div", "lower", this.scoreEl);
    this.helpEl = h("footer", "foot", h("kbd", "", "/"), " commands · ", h("kbd", "", "?"), " every key · ", h("kbd", "", "Tab"), " ", h("kbd", "", "1–7"), " modules · ", h("kbd", "", "↑↓"), " knob · ", h("kbd", "", "←→"), " turn it");

    root.replaceChildren(h("div", "app", header, this.toolbar, this.messageEl, this.shootEl, this.deskEl, this.lower, this.drills.el, this.album.el, this.helpEl), this.palette.el, this.keysDialog);
    engine.onChange = (s): void => {
      this.state = s;
      this.schedule();
    };
    document.addEventListener("keydown", (ev) => this.onKey(ev));
    this.schedule();
  }

  private buildKeysDialog(): HTMLDialogElement {
    const groups = KEY_GROUPS.map(([title, rows]) =>
      h("section", "keys-group", h("h3", "", title), h("dl", "", ...rows.flatMap(([key, what]) => [h("dt", "", ...key.split(" ").map((k) => h("kbd", "", k))), h("dd", "", what)]))),
    );
    const dialog = h("dialog", "keys-dialog", h("header", "", h("h2", "", "Keyboard"), h("p", "dim", "Everything here is also in the command palette: press / and type.")), h("div", "keys-grid", ...groups));
    dialog.setAttribute("aria-label", "Keyboard shortcuts");
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("keydown", (ev) => {
      if (ev.key === "?") {
        ev.preventDefault();
        dialog.close();
      }
    });
    return dialog;
  }

  private toggleKeys(): void {
    if (this.keysDialog.open) this.keysDialog.close();
    else this.keysDialog.showModal();
  }

  /** `group`: open on one kind of thing (songs, references…); otherwise everything. */
  private openPalette(group?: string): void {
    const all = this.commands();
    const list = group ? all.filter((c) => c.group === group) : all;
    this.palette.show(list, "", group ? `Pick a ${group.toLowerCase()}` : "Type a song, a setting or a command");
  }

  private commands(): Command[] {
    const s = this.state;
    const cmd = (group: string, title: string, run: () => unknown, key?: string, extra: Partial<Command> = {}): Command => ({
      id: `${group}:${title}`,
      group,
      title,
      key,
      run: () => {
        this.run(run());
        this.schedule();
      },
      ...extra,
    });
    const genreNow = this.genreOverride;
    // Long lists last, so an empty palette opens on actions; typing finds a song just as fast.
    const pickers = [
      ...this.tracks.map((t) => cmd("Song", t, () => this.loadTrack(t), undefined, { current: t === this.track })),
      cmd("Song", "Open an audio file…", () => this.fileInput.click(), undefined, { terms: "load browse disk" }),
      cmd("Reference", "No reference", () => this.loadReferenceTrack(""), undefined, { current: !this.reference, terms: "none clear" }),
      ...this.tracks.map((t) => cmd("Reference", t, () => this.loadReferenceTrack(t), undefined, { current: this.reference?.name === t })),
      cmd("Reference", "Reference from a file…", () => this.refFile.click(), undefined, { terms: "load browse disk" }),
      cmd("Genre", `Auto (${genre(genreFromName(this.track)).label}, from the file name)`, () => (this.genreOverride = null), undefined, { current: genreNow === null }),
      ...GENRES.map((g) => cmd("Genre", g.label, () => (this.genreOverride = g.key), undefined, { current: genreNow === g.key })),
      ...PRESETS.map((p) => cmd("Preset", p.name, () => this.applyPreset(p), undefined, { terms: `start ${p.about}` })),
    ];
    return [
      ...MODULES.map((m, i) => cmd("Module", MODULE_NAMES[m], () => (this.nav = jumpModule(this.nav, i)), String(i + 1), { current: m === this.nav.module })),
      cmd("Listen", s.playing ? "Pause" : "Play", () => this.engine.toggle(), "space"),
      cmd("Listen", "A/B against the original", () => this.engine.toggleAB(), "a"),
      cmd("Listen", "Hear the reference", () => this.engine.toggleReference(), "r"),
      cmd("Listen", "Mono check", () => this.engine.toggleMono(), "o"),
      cmd("Listen", "Streaming preview (next platform)", () => this.cycleStream(), "p", { terms: "spotify apple youtube" }),
      cmd("Listen", "Solo the selected EQ band", () => this.toggleSolo(), "s"),
      cmd("Listen", "Back to the top", () => this.engine.seek(0), "Home"),
      cmd("Snapshot", "Save snapshot", () => this.saveSnapshot(), "c"),
      cmd("Snapshot", "Compare with snapshot", () => this.toggleSnapshot(), "x"),
      cmd("Snapshot", "Swap snapshot and knobs", () => this.swapSnapshot(), "X"),
      cmd("Master", "Auto-master", () => this.autoMaster(), "A", { terms: "plan automatic" }),
      cmd("Master", "Blind shootout: gentle / balanced / punchy", () => this.startShootout(), "v"),
      cmd("Master", `Drive for ${TARGETS.integrated} LUFS`, () => this.matchTarget(), "l", { terms: "loudness target limiter" }),
      cmd("Master", "Apply the top hint", () => this.applyHint(this.currentHints.find((x) => x.knob && x.suggest !== undefined)), "h"),
      cmd("Master", `Bypass ${MODULE_NAMES[this.nav.module]}`, () => this.engine.toggleBypass(this.nav.module), "b"),
      cmd("Master", "Reset the selected knob", () => this.setKnob(selected(this.nav), DEFAULTS[selected(this.nav)], null), "0"),
      cmd("Master", "Undo", () => this.undo(false), "u"),
      cmd("Master", "Redo", () => this.undo(true), "U"),
      cmd("Master", "Measure the whole song", () => this.measureMaster(), "m", { terms: "score render" }),
      cmd("Master", "Restart the meters", () => this.engine.resetMeters(), "z", { terms: "zero" }),
      ...(this.video ? [cmd("File", "Export video (master under the picture)", () => this.exportVideo(), "e", { terms: "download save mp4 mux" })] : []),
      ...(this.video && this.shaderOrigin ? [cmd("File", "Open in Music Shader", () => this.openInShader(), undefined, { terms: "visuals shader send" })] : []),
      cmd("File", "Export WAV 24-bit", () => this.exportWav(24), this.video ? undefined : "e", { terms: "download save" }),
      cmd("File", "Export WAV 16-bit (dithered)", () => this.exportWav(16), "E", { terms: "download save cd" }),
      cmd("File", "Save session to a file", () => this.saveSession(), undefined, { terms: "json download" }),
      cmd("File", "Load a session file (u undoes)", () => this.sessionFile.click(), undefined, { terms: "json open" }),
      cmd("View", this.explain ? "Hide explanations" : "Show explanations", () => (this.explain = !this.explain), "i", { terms: "help explain" }),
      cmd("View", "Keyboard shortcuts", () => this.toggleKeys(), "?"),
      cmd("View", "Desk", () => this.setMode("desk"), undefined, { current: this.mode === "desk" }),
      cmd("View", "Drills: ear training", () => this.setMode("drills"), "d", { current: this.mode === "drills" }),
      cmd("View", "Album: master several songs alike", () => this.setMode("album"), undefined, { current: this.mode === "album" }),
      ...pickers,
    ];
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
    const names = this.tracks;
    const pick = [initialTrack, lastTrack()].find((t): t is string => !!t && names.includes(t)) ?? names[0];
    if (!pick) {
      this.say("no song library here: drop an audio file anywhere, or press / and open one");
      return;
    }
    await this.loadTrack(pick, urlSettings);
    const ref = initialReference ?? lastReference();
    if (ref && names.includes(ref)) await this.loadReferenceTrack(ref);
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
    this.run(file.arrayBuffer().then((data) => this.loadData(file.name, data, null, isVideoName(file.name, file.type), file.type)));
  }

  private async loadTrack(name: string, settings: Settings | null = null): Promise<void> {
    const res = await fetch(trackUrl(name));
    if (!res.ok) throw new Error(`could not load "${name}" (${res.status})`);
    await this.loadData(name, await res.arrayBuffer(), settings);
  }

  protected async loadData(name: string, data: ArrayBuffer, settings: Settings | null = null, video = isVideoName(name), mimeType = ""): Promise<void> {
    this.say(`loading ${name}…`);
    const copy = data.slice(0);
    this.videoBytes = video ? data.slice(0) : null;
    this.videoType = video ? mimeType : "";
    await this.engine.load(data);
    this.track = name;
    this.video = video;
    saveLastTrack(name);
    this.engine.setVideo(video);
    this.engine.setAll(settings ?? loadSettings(name) ?? defaultSettings());
    this.genreOverride = null;
    this.shoot = null;
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
        { reference: ref, genre: this.currentGenre(), taste: tasteLean(loadTaste()), video: this.video },
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
        { reference: this.reference?.report ?? null, genre: this.currentGenre(), video: this.video },
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

  /** The full-song master (rendered or reused) as WAV at the song's own sample rate, edges applied. */
  private async masterWav(bits: BitDepth): Promise<{ wav: ArrayBuffer; name: string; summary: string; channels: Float32Array[]; sampleRate: number } | null> {
    const m = await this.measureMaster();
    if (!m) return null;
    const { settings, bypass } = this.state;
    const out = applyEdges(m.rendered.master, m.rendered.sampleRate, edgeParams(settings, bypass));
    if (this.video && this.native) assertSameLength((await this.native).length, out[0].length);
    const r = m.report;
    return {
      wav: encodeWav(out, m.rendered.sampleRate, bits),
      name: `${safeBaseName(this.track)} (master ${bits}-bit).wav`,
      summary: `${(m.rendered.sampleRate / 1000).toFixed(1)} kHz · ${db(r.integrated)} LUFS · ${db(r.truePeak)} dBTP`,
      channels: out,
      sampleRate: m.rendered.sampleRate,
    };
  }

  /**
   * Opens Music Shader first (synchronously, inside the click, so popup blockers allow it), renders the master while
   * it loads, and posts video + WAV once the shader says ready. Gives up after 20 s or if the window closes.
   */
  private openInShader(): void {
    const origin = this.shaderOrigin;
    const video = this.videoBytes;
    if (!origin || !video || !this.video) return;
    const win = window.open(`${origin}/?handoff=1`);
    if (!win) {
      this.say("the browser blocked the Music Shader window: allow pop-ups for this site and try again", true);
      return;
    }
    const name = this.track;
    const ready = new Promise<void>((resolve, reject) => {
      const done = (): void => {
        window.removeEventListener("message", onMessage);
        clearInterval(closedPoll);
        clearTimeout(timer);
      };
      const onMessage = (e: MessageEvent): void => {
        if (!isShaderReady(e, origin, win)) return;
        done();
        resolve();
      };
      const fail = (why: string) => (): void => {
        done();
        reject(new Error(why));
      };
      const closedPoll = setInterval(() => win.closed && fail("the Music Shader window was closed")(), 500);
      const timer = setTimeout(fail("Music Shader didn't answer within 20 s"), HANDOFF_TIMEOUT_MS);
      window.addEventListener("message", onMessage);
    });
    ready.catch(() => {});
    this.run(
      (async (): Promise<void> => {
        // masterWav shows its own "rendering…" (and refuses while anything else is busy).
        const w = await this.masterWav(24);
        if (!w) {
          if (!win.closed) win.close();
          this.say("not sent to Music Shader: the master couldn't render right now (busy?); try again", true);
          return;
        }
        this.say("waiting for Music Shader…");
        try {
          await ready;
        } catch (e) {
          this.say(`not sent to Music Shader: ${e instanceof Error ? e.message : String(e)}`, true);
          return;
        }
        const file = new File([video], name, { type: this.videoType || videoMimeType(name) });
        win.postMessage(handoffMessage(name, file, new Blob([w.wav], { type: "audio/wav" })), origin);
        this.say(`sent "${name}" and its master to Music Shader · ${w.summary}`);
      })(),
    );
  }

  private exportMain(): Promise<void> {
    return this.video ? this.exportVideo() : this.exportWav(24);
  }

  protected async exportWav(bits: BitDepth): Promise<void> {
    const w = await this.masterWav(bits);
    if (!w) return;
    download(new Blob([w.wav], { type: "audio/wav" }), w.name);
    this.exported = true;
    this.say(`exported "${w.name}" · ${w.summary}`);
  }

  /** The dev server muxes the master under the picture (`tools/remux.ts`, sync-checked); without it, the WAV + how to remux. */
  protected async exportVideo(): Promise<void> {
    const video = this.videoBytes;
    if (!video) return this.exportWav(24);
    const w = await this.masterWav(24);
    if (!w) return;
    this.busy = "putting the master under the picture (checking sync)…";
    this.schedule();
    let browserProblem: string;
    try {
      const { muxVideo } = await import("../audio/mux.ts");
      const muxed = await muxVideo(video, this.track, w.channels, w.sampleRate);
      const name = videoExportName(this.track);
      download(muxed.blob, name);
      this.exported = true;
      this.say(`exported "${name}" · in sync (${muxed.lagSamples} samples) · ${muxed.codec.toUpperCase()} · ${w.summary}`);
      return;
    } catch (e) {
      browserProblem = e instanceof Error ? e.message : String(e);
      console.warn(`in-browser Export video failed: ${browserProblem}`);
    } finally {
      this.busy = "";
    }
    this.busy = "putting the master under the picture on the dev server…";
    this.schedule();
    const call = async (init?: RequestInit, query = ""): Promise<Response | null> => fetch(`/api/remux${query}`, init).catch(() => null);
    const outcome = (r: Response | null): ReturnType<typeof remuxOutcome> => remuxOutcome(r?.status ?? null, r?.headers.has(REMUX_HEADER) ?? false);
    let res: Response | null = null;
    try {
      // A cheap probe first, so a static host doesn't get the whole video uploaded just to answer 405.
      if (outcome(await call()) !== "unavailable") {
        const q = new URLSearchParams({ name: this.track, videoBytes: String(video.byteLength) });
        res = await call({ method: "POST", body: new Blob([video, w.wav]) }, `?${q}`);
      }
    } finally {
      this.busy = "";
    }
    const result = outcome(res);
    if (result === "unavailable" || !res) {
      download(new Blob([w.wav], { type: "audio/wav" }), w.name);
      this.exported = true;
      this.say(`couldn't make the video here (${browserProblem}); exported "${w.name}" instead. Put it under the picture with: just remux "${this.track}" "${w.name}"`, true);
      return;
    }
    if (result === "refused") {
      this.say(`video not exported: ${browserProblem}; the dev server also refused: ${await res.text()}`, true);
      return;
    }
    const name = videoExportName(this.track);
    download(await res.blob(), name);
    this.exported = true;
    this.say(`exported "${name}" · in sync (dev server; in-browser failed: ${browserProblem}) · ${w.summary}`);
  }

  /** `group` null makes the change its own undo step (resets, hints); otherwise quick turns of one knob merge. */
  private setKnob(key: ParamKey, value: number, group: string | null = key): void {
    const before = this.engine.state.settings;
    if (this.video && (SYNC_LOCKED_KEYS as readonly ParamKey[]).includes(key) && clampParam(key, value) !== 0) {
      this.say(`${PARAMS.find((p) => p.key === key)?.label ?? key} stays at 0 for a video: silence there would shift the sound off the picture`);
      return;
    }
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
    const bypass = keyButton("on", "b", () => this.engine.toggleBypass(module), "bypass this module");
    const knobsEl = h("div", "knobs");
    const el = h("section", "panel module", h("h2", "", MODULE_NAMES[module], bypass), knobsEl);
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
      knobsEl.append(row);
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
    if (this.palette.open || this.keysDialog.open) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      this.openPalette();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const action = this.keyAction(ev);
    if (!action) return;
    ev.preventDefault();
    this.run(action());
    this.schedule();
  }

  protected keyAction(ev: KeyboardEvent): (() => unknown) | null {
    if (ev.key === "d") return () => this.setMode(this.mode === "desk" ? "drills" : "desk");
    if (ev.key === "/") return () => this.openPalette();
    if (ev.key === "?") return () => this.toggleKeys();
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
      s: () => this.toggleSolo(),
      t: () => this.openPalette("Song"),
      R: () => this.openPalette("Reference"),
      G: () => this.openPalette("Genre"),
      P: () => this.openPalette("Preset"),
      i: () => (this.explain = !this.explain),
      ...Object.fromEntries(MODULES.map((_, i) => [String(i + 1), () => (this.nav = jumpModule(this.nav, i))])),
      h: () => this.applyHint(this.currentHints.find((x) => x.knob && x.suggest !== undefined)),
      e: () => this.exportMain(),
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
    for (const el of [this.toolbar, this.deskEl, this.lower, this.helpEl]) el.hidden = drilling;
    this.drills.el.hidden = this.mode !== "drills";
    this.album.el.hidden = this.mode !== "album";
    for (const m of ["desk", "drills", "album"] as const) this.modeButtons[m].className = this.mode === m ? "on" : "";
    const crumbValue = (b: HTMLButtonElement, text: string, set: boolean): void => {
      const value = b.querySelector(".crumb-value");
      if (value && value.textContent !== text) value.textContent = text;
      b.classList.toggle("unset", !set);
    };
    crumbValue(this.songCrumb, songTitle(this.track) || "none", !!this.track);
    crumbValue(this.refCrumb, this.reference ? songTitle(this.reference.name) : "none", !!this.reference);
    crumbValue(this.genreCrumb, genre(this.currentGenre()).label + (this.genreOverride ? "" : " · auto"), !!this.genreOverride);
    this.songCrumb.hidden = this.mode === "album";
    // Drills and Album have their own keys (t = next drill), so the crumbs' caps only show on the Desk.
    this.root.classList.toggle("off-desk", drilling);
    this.messageEl.textContent = this.busy || this.message;
    this.messageEl.className = `message${this.messageIsError ? " error" : ""}`;
    setLabel(this.playButton, s.playing ? "Pause" : "Play");
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
    setLabel(this.streamButton, this.platform ? platform(this.platform).name : "Stream");
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
    setLabel(this.exportButton, this.video ? "Export video" : "Export");
    const showShader = this.video && this.shaderOrigin !== null;
    if (this.shaderButton.hidden === showShader) this.shaderButton.hidden = !showShader;
    this.shaderButton.disabled = this.exportButton.disabled;

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
      const active = module === this.nav.module;
      view.el.className = `panel module${active ? " active" : ""}${off ? " bypassed" : ""}`;
      view.el.hidden = !active;
      setLabel(view.bypass, off ? "bypassed" : "on");
      view.bypass.className = off ? "off" : "on";
      let worst = 0;
      if (view.gr) {
        const values = BAND_GR_NAMES[view.gr.module] ? (s.reduction.bands[view.gr.module] ?? []) : [s.reduction[view.gr.module]];
        view.gr.rows.forEach((row, i) => {
          const gr = values[i] ?? 0;
          worst = Math.max(worst, gr);
          row.bar.set(gr, gr > 6 ? "bad" : gr > 3 ? "warn" : "");
          row.value.textContent = `${gr.toFixed(1)} dB`;
        });
        const ring = this.engine.grHistory[view.gr.module];
        if (!drilling && active) view.gr.trace?.draw(ring.values(), ring.size);
      }
      const item = this.rail.get(module);
      if (item) {
        const changed = knobsOf(module).some((k) => Math.abs(s.settings[k] - DEFAULTS[k]) > 1e-9);
        item.className = `rail-item${active ? " active" : ""}${changed ? " changed" : ""}${off ? " off" : ""}`;
        item.setAttribute("aria-current", String(active));
        const state = item.querySelector(".rail-state");
        const text = off ? "off" : worst >= 0.05 ? `−${worst.toFixed(1)}` : "";
        if (state && state.textContent !== text) state.textContent = text;
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

  private toggleSolo(): void {
    if (this.soloOn) this.soloOn = false;
    else if (soloBand(selected(this.nav), eqBands(this.state.settings, this.state.bypass))) this.soloOn = true;
    else this.say("select an EQ band's knob (or grab its dot) to solo it");
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
    const title = h("h2", "", "Hints", headKey("h", "apply top"));
    if (!o) {
      this.currentHints = [];
      this.hintsSignature = "";
      this.hintsEl.replaceChildren(title, h("p", "dim", "measuring the original…"));
      return;
    }
    const measured = this.measured?.key === this.currentKey() ? this.measured.report : null;
    this.currentHints = hints({ original: o, master: measured, settings: this.state.settings, bypass: this.state.bypass, reference: this.reference?.report, video: this.video });
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
    const top = this.currentHints.find((x) => x.knob && x.suggest !== undefined);
    const items = this.currentHints.map((hint) => {
      const li = h("li", hint.level, hint.text);
      if (hint.knob) {
        const label = hint.suggest !== undefined ? `apply ${signed(hint.suggest)}` : "go to knob";
        const title = hint.suggest !== undefined ? `set ${SPECS.get(hint.knob)?.label} ${signed(hint.suggest)}` : "";
        li.append(hint === top ? keyButton(label, "h", () => this.applyHint(hint), title) : button(label, () => this.applyHint(hint), title));
      }
      return li;
    });
    const refNote = this.reference
      ? h("p", "dim", this.reference.report ? `comparing tone with ${this.reference.name}` : "measuring the reference…")
      : h("p", "dim", "press R to pick a reference and compare tonal balance");
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
      this.explainEl.replaceChildren(h("p", "dim", "press i for explanations"));
      return;
    }
    this.meterHelp ??= h("details", "", h("summary", "dim", "About the meters"), ...Object.values(METER_HELP).map((t) => h("p", "dim", t)));
    this.explainEl.replaceChildren(
      h("h2", "", `${SPECS.get(current)?.label ?? current}`, headKey("i", "hide")),
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
    const title = h("h2", "", "Full-song check", headKey("m", "measure"));
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
    children.push(h("h3", "", "Loudness over the song", h("span", "dim", " · blue original · lilac master · click to seek")), this.plot.el, table);
    children.push(...this.streamingTable(o, r && !stale ? r : null, ref ?? null));
    this.scoreEl.replaceChildren(...children);
    this.plot.update(o, r && !stale ? r : null, ref ?? null, this.state.position);
  }
}
