# Master Kit: notes for coding agents

Browser app for learning audio mastering on finished mp3s: TypeScript + Web Audio + Vite. See README.md.
Mastering only (no stems). Danny does all git; never init, commit or push.

## Commands

- `just check`: typecheck + eslint + vitest (run before ending a turn; prek runs the same)
- `just dev`: dev server on 127.0.0.1:5174 (5173 is music-shader's); reachable from Windows Chrome via WSL localhost forwarding.
  Songs come from `MUSIC_DIR` (default `../deluge-quest/web/public/audio`).
- `just analyze <file> [--json]`: metrics report for one song (ffmpeg decodes to f32 PCM)
- `just crosscheck [files...]`: our meters vs `ffmpeg -af ebur128=peak=true`; no args = EBU synthetic cases
- `just render <track> [--set JSON] [--bypass eq,tame,multi,comp,color,limiter] [--wav FILE] | --live S`: runs the real browser
  chain in headless Chrome (starts its own Vite) and prints before/after plus a null test (bypass every module for a
  bit-exact −144 dB). The way to verify audio-engine changes from WSL. `tools/chrome.ts` has the CDP helpers (also for screenshots).
- `just automaster <track> [--ref <track>] [--genre KEY] [--wav FILE] [--session FILE] [--json]`: auto-master in headless Chrome
  (page route `/?auto=1[&genre=]`, same `autoMaster()` as the Desk's `A`); prints the reasons, knobs and before/after.
- `just remux <video> <master.wav> [--out FILE] [--force]`: puts a Desk-exported master back under its video. Refuses a
  master that's offset or a different length; muxes, measures the new audio against the old on the file's timeline,
  corrects in samples (container timestamps round), and writes `--out` only at ≤ 0.25 ms.
- `just album <track>... | --all [--out DIR] [--bits 24|16] [--genre KEY]`: the `/?auto=1` route per song, then
  `applyEdges` + `encodeWav` in Node; numbered WAVs + loudness spread.

## Layout

- `src/analysis/`: meters (offline `loudness`/`truePeak`/`bandEnergies`/`stereoImage`, streaming `LiveLoudness`/`TruePeakMeter`/`LiveStereo`)
- `src/dsp/`: `Compressor` (peak/RMS, sidechain HPF), `Limiter`, `Multiband` (`crossover.ts` = 3-band Linkwitz-Riley,
  bands sum flat; neutral = skipped bit-exact, on/off crossfades): per-sample DSP classes, run in the worklet and in Node tests;
  `biquad.ts` = EQ magnitude response (matches `BiquadFilterNode.getFrequencyResponse` to 0.0000 dB);
  `edges.ts` = lead-in/fades/tail (`applyEdges` for export, `edgeAutomation` for live gain curves);
  `tamer.ts` = 2 dynamic resonance cuts (narrow vs wide band-pass detector); `color.ts` = warmth + soft clip,
  2x oversampled by `oversample.ts` (half-band FIR, fixed `COLOR_LATENCY` = 47 samples even when off)
- `src/master/`: pure desk logic. `settings.ts` (every knob: range, default, module, `nudge`/`toFraction`/`formatParam`;
  `parseSettings` validates untrusted input), `monitor.ts` (A/B/reference gains, loudness match, which meters to show), `score.ts`,
  `hints.ts`, `explain.ts` (help text), `history.ts` (undo/redo), `snapshot.ts` (snapshot type + "what differs"),
  `session.ts` (session JSON file: `parseSession` validates untrusted input), `automaster.ts` (pure planner: Report
  [+ reference, genre, taste] → settings + a reason per move; `easeDynamics`), `genres.ts` (profiles + `genreFromName`),
  `shootout.ts` (gentle/balanced/punchy variants, taste), `streaming.ts`, `album.ts`
- `src/audio/`: Web Audio glue. `chain.ts` builds the graph for AudioContext or OfflineAudioContext,
  `engine.ts` is live playback (+ reference, mono check, snapshot chain), `render.ts` offline full-song, `drill-render.ts` drill clips,
  `measure.ts` runs `analyze()` in `analysis.worker.ts`, `dynamics.worklet.ts` hosts the DSP classes and meters,
  `sample-rate.ts` reads a file's own rate from its header (mp3/WAV/FLAC), `auto.ts` = render loops (`driveForTarget`
  for `l`, `autoMaster` = plan → Drive → ease once if dynamics fail, `shootout` = three styles each rendered to −14),
  `tracks.ts` (`fetchTrack`)
- `src/album/view.ts`: the Album tab (batch auto-master, loudness spread, join previews, export in order)
- `src/desk/`: the UI (plain DOM, no framework). `desk.ts` (Desk class, keys, render at rAF), `nav.ts` (pure
  knob selection), `dom.ts` helpers, `storage.ts` (localStorage, always read back through a validator)
- `src/drills/`: `drills.ts` (pure: levels, questions, progress, loudness match), `player.ts`, `view.ts`
- `src/export/wav.ts`: PCM WAV encoder (pure)
- `src/main.ts`: routes `/` to the Desk, `/?render=1` to the offline render used by `tools/render.ts`, `/?auto=1` to auto-master
- `tools/`: CLIs (`analyze`, `crosscheck`, `render`, `export`, `shot`, `automaster`); `chrome.ts` = headless Chrome + Vite
  (+ `pullChannels`), `compare.ts` = before/after table, `ffmpeg.ts` (+ `writeWav`)

## Conventions

- Imports use explicit `.ts` extensions (Node runs tools/*.ts with type stripping; no enums or parameter properties).
- `src/analysis/` and `src/dsp/` must stay DOM-free: they run in Node tests and in AudioWorklets.
  Inputs are `Float32Array[]` channels plus a sample rate.
- Meter math follows the standards: BS.1770-4 / EBU R128 (`loudness.ts`), Tech 3342 LRA, BS.1770 Annex 2 true peak (`peak.ts`).
  Expected values in tests come from EBU Tech 3341/3342 cases, not from our own output.
  After touching meter math, run `just crosscheck`.
- The limiter must keep output ≤ ceiling on a 16x true-peak check (tests use mp3-bandwidth noise).
  After touching it, `just render ... --wav out/x.wav` then `just crosscheck out/x.wav`.
- Adding a knob: add it to `PARAMS` in `src/master/settings.ts`, map it in `eqBands`/`stereoParams`/`compressorParams`/`limiterParams`,
  and give it help text in `explain.ts` (tsc enforces that).
- Two decodes per song: the engine's (AudioContext rate, live playback and drills) and the Desk's `native` one
  (the file's own rate, via `decodeNative`): measuring, scoring and export use the native one.
- Web Audio `BiquadFilterNode` Q is in dB for `highpass`/`lowpass` (linear for peaking); see `BUTTERWORTH_Q_DB`.
- Delivery targets live in `src/analysis/targets.ts`; tonal bands in `BANDS` (`spectrum.ts`).
- Tests: vitest with `it.each` tables; synthetic audio from `src/analysis/test-signals.ts`.
  Fade test tones (`faded`) when measuring true peak: a hard onset rings above the steady-state peak.
- UI changes: `just shot <track> [--play S] [--keys ...] [--query drills=1]` and look at both PNGs.
  The mobile PNG must be 780 px wide (390 @2x); wider means something overflows the phone screen.
  Desk panels that re-render at 10 Hz must not rebuild clickable children every frame (see the hints signature).
- Export changes: `just export <track> [--bits 16]` (downloads through the real button, checks with ffprobe + ebur128).
- Comparisons between A/B, reference and drill clips are always loudness-matched; keep it that way (only the streaming preview `p` unmatches them, on purpose).
- `out/` is scratch output (gitignored).

## Plan

1. ✅ Scaffold + DOM-free analysis math
2. ✅ Audio engine: load mp3, play, EQ/comp/limiter chain (AudioWorklet lookahead limiter), A/B, bypass
3. ✅ Desk UI: meters, targets, keyboard knobs, `a` A/B, `b` bypass selected module, `i` explain, score
4. ✅ WAV export (24-bit / 16-bit TPDF), verified with ffmpeg
5. ✅ Drills (EQ, compression, limiting, stereo width; 5 levels each, streaks)
6. ✅ Hints + reference-track comparison

Since: export at the file's own sample rate, mid/side stage (stereo width + mono bass knobs), correlation and
side/mid meters, mono check (`o`), limiting and width drills, meters for the reference while it plays,
RMS detector option, side air shelf (mid/side EQ), undo/redo (`u`/`U`, `src/master/history.ts`),
loudness-over-time plot in the full-song check (`Report.shortTerm`, `src/desk/curve.ts` + `loudness-plot.ts`),
spectrum & EQ panel (`src/dsp/biquad.ts` = Web Audio biquad response, `src/desk/freq.ts`, `spectrum-view.ts`),
GR history traces (`src/master/ring.ts`, `gr-trace.ts`), presets (`src/master/presets.ts`), `l` = Drive for
-14 LUFS (`src/master/autogain.ts`), limiter/compressor fast paths (~2x faster renders, bit-identical output),
draggable EQ dots (`src/desk/eq-drag.ts`), self-ticking checklist (`src/master/checklist.ts`), band solo (`s`,
a bandpass on the engine's monitor path; meters and analysers tap before it, so soloing never changes readings),
snapshot compare (`c` save / `x` hear / `X` swap: a second `buildChain` fed by the same source, matched to the master's
short-term loudness like the original; `just render ... --live` checks it), session JSON files (palette: Save session / Load a session file),
multiband module (`multi`, between EQ and Compressor; modules are `MODULES` in signal order, so Tab goes EQ → Multiband →
Compressor → Limiter; build bypass objects with `noBypass()`), auto-master (`A` / `just automaster`; the no-reference
tonal target is `tiltedShares(ANALYSER_TILT_DB_PER_OCT)` in `spectrum.ts`; tests check its plans trip no hint warning),
Edges module (`edges`, last in `MODULES`: lead-in, fade-in, fade-out, tail; `Report.edges` from `src/analysis/edges.ts`,
sound = above -60 dBFS; fades start/stop at the sound, lead-in/tail count silence already there). Edges are applied
only at Desk export and live (an `edgeGain` on the engine's master path, after the meters); never in `renderMaster`,
so `settingsKey` ignores them and `just render/automaster --wav` stay raw chain output. Hint thresholds and auto-master
values share `EDGE_RULES` (`hints.ts`). Playback from the top waits `PREROLL_SECONDS` (or the missing lead-in) so a
waking audio device can't swallow the first hit (`startDelay` in `transport.ts`). Streaming preview (`p` cycles
Spotify → Apple Music → YouTube → off; `src/master/streaming.ts` = platform rules + `playbackGainDb`): every source
plays at its own platform gain instead of loudness-matched (`monitorGains(..., stream)`), the one deliberate exception
to matched comparisons. The master's gain is exact from a current measurement, else live ≈ (original + A/B match);
the Full-song check lists each platform's gain. Apple's turn-down-only behavior is from secondary sources.
Tamer (`tame`, after EQ) and Color (`color`, before the limiter) modules; `MODULES` = eq, tame, multi, comp, color,
limiter, edges. `Report.resonances` (`src/analysis/resonance.ts`): hints/auto-master act only on 1.5–8 kHz
(`TAME_RULES`; lower peaks are mostly the song's notes). Color's clip threshold is relative to the limiter's
(ceiling − Drive + "Clip above"). Genre profiles feed auto-master; the blind shootout (`v`) stores pick counts
(`loadTaste`) and `tasteLean` blends later plans toward gentle/punchy. Tests check every genre × case × style plan
trips no hint warning. Album tab + `just album`. Style: idiom's (`../idiom`) Dusk theme, dark scheme: plum surfaces,
one lilac accent (`--accent` fills, `--accent-ink` for accent text and focus); DM Sans / DM Mono / Instrument Serif
(wordmark, module names), self-hosted woff2 + OFL in `src/desk/fonts/`; colors and the 4 px spacing scale are tokens in
`desk.css`, chart series are `--series-*` (canvases read them), so never hard-code a hex in TS.
Keyboard-first layout: top bar (mode tabs, Song/Ref/Genre crumbs that open the palette, Commands, `?`), transport
(every button is a `keyButton` showing its key; relabel with `setLabel` so the cap survives), then rail | stage | side:
the rail (`1`–`7`, Tab) shows one module open at a time and each module's changed/bypassed/GR state; the stage holds that
module, the knob's explanation (`i`) and the spectrum; the side holds meters, hints, checklist. `palette.ts` = command
palette (`/`, Ctrl+K; `t R G P` open it on one group; ranking in `search.ts`, ported from idiom); new actions go in
`Desk.commands()` and, if they have a key, in `KEY_GROUPS` (the `?` overlay).
`window.__engine` is exposed for probes: tap private nodes (e.g. `stereoOut`) with an AnalyserNode and compare
output/input spectra at the same time (music changes too fast for before/after readings).

Perf: a render of a 3 min song takes ~4.5 s in headless Chrome (+~1 s multiband, +~1.5 s color, +~0.5 s tamer);
auto-master ~35 s, a shootout ~35 s, `just album` ~23 s per song. DSP speed-ups must stay bit-identical; compare old vs
new on a real song (copy the old class into `out/`, process the same PCM through both, count differing samples).
Memory: the Desk keeps only the master of a render (`MasterAudio`); `l` keeps only its closest render.

Video (`src/master/video.ts`): mp4/mov/webm/mkv (or any `video/*` type) load as songs; `fileSampleRate` reads their
rate. Sync is absolute: `Engine.setVideo` runs every settings change through `lockSync` (Lead-in and Tail = 0), auto-master
and hints skip those knobs (`video` in `PlanInput`/`HintInput`), and Desk export throws unless the WAV has the source's
exact frame count. Chrome and ffmpeg decode AAC/Opus starts identically (0-sample offset, checked), so the master is aligned.

Hints must not contradict each other: a suggestion stops short of what another hint warns about (width < 150%,
EQ within ±5.5 dB); tests apply each suggestion and check no warning appears.

Ideas not built: multiband presets / drills, codec check (AAC/Opus encode + true peak via WebCodecs), small-speaker
simulation, color/clipper drills, genre profiles measured from real references instead of rules of thumb.
