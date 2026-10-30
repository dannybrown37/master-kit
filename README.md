# Master Kit

A browser app for learning audio **mastering** on your own finished songs (mp3s), plus ear-training drills.
Mastering only: no stems, so no mixing.

Status: **all 6 steps built**: analysis core, audio engine, Desk UI, WAV export, drills, hints + reference comparison;
since then a live spectrum with a draggable EQ, band solo, GR history, presets, one-key loudness matching (`l`),
a self-ticking checklist, undo, snapshot compare, session files, a multiband compressor and auto-master (UI and CLI);
then a resonance tamer, color (saturation + soft clip), edges (lead-in, fades, tail), genre-aware auto-master,
a blind shootout that learns your taste, a streaming preview and an album mode (UI and CLI).

## Commands

```sh
just install                     # npm ci (pinned deps)
just dev                         # the app on http://localhost:5174 (songs from MUSIC_DIR); `just open` opens Windows Chrome
just check                       # typecheck + eslint + vitest
just analyze "song.mp3"          # loudness / peaks / dynamics / tonal balance report (--json too)
just crosscheck [files...]       # our meters vs ffmpeg ebur128 (no args: EBU test signals)
just render "<track>" --set '{"limDrive":3}' --wav out/x.wav   # master in headless Chrome, before/after table
just render "<track>" --live 8   # drive the realtime Desk with keys (A/B, bypass, knob)
just export "<track>" [--set JSON] [--bits 16]   # press "export" in headless Chrome, check the WAV with ffmpeg
just automaster "<track>" [--ref "<track>"] [--genre edm] [--wav out/x.wav] [--session out/x.json] [--json]   # auto-master, with reasons; no track = fzf pick
just album "<track>"... | --all [--out DIR] [--bits 16] [--genre KEY]   # auto-master several, numbered WAVs with edges + loudness spread
just shot ["<track>"] [--play S] [--keys Tab,m] [--query drills=1] [--name x]   # screenshots: out/x-{desktop,mobile}.png
```

Needs Node ≥ 22.18 (runs `.ts` directly), `ffmpeg`/`ffprobe` and `google-chrome` on PATH.
Songs come from `MUSIC_DIR` (default `../deluge-quest/web/public/audio`); the app also takes a file picker.

## The Desk

Keyboard first: `/` (or Ctrl+K) opens a command palette over every song, reference, genre, preset and action, and
`?` lists every key. Buttons show their key, so one click teaches it.

```
┌ Master Kit [Desk|Drills|Album]  Song Barrel Rondo t · Ref none R · Genre EDM·auto G   [Commands /] [?] ┐
│ [Play space] 0:31 / 3:11 ━━━━━━━  MASTER  [A/B a][Ref r][Mono o][Stream p][Snap c][vs Snap x]          │
│                                                               [Auto A][Measure m][Export e]            │
├ 1 EQ        ● ┬ Compressor ───────────────────────────────┬ Meters ──────────────────────────────────┤
│ 2 Tamer       │ Threshold ━━━━○──  -18 dB │ Release  ...  │ Momentary / Short-term / Integrated LUFS │
│ 3 Multiband   │ Ratio     ━○─────  2.0:1  │ Makeup   ...  │ True peak · Correlation · Side/mid       │
│ 4 Compressor●-2.1 GR ▇  ▀█▀▀ last 10 s                    ├ Hints (h applies the top one) ───────────┤
│ 5 Color       ├ what the selected knob does (i hides)     │                                          │
│ 6 Limiter     ├ Spectrum & EQ: bars = what you hear,      ├ Checklist (ticks itself) ────────────────┤
│ 7 Edges   off │   line = comparison, EQ curve + dots      │                                          │
├ Full-song check: score /100, original · master · Δ · reference; loudness over time; streaming gains   ┤
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  rail: ● = changed from default, off = bypassed, −2.1 = live gain reduction
```

| Key | Does |
| --- | --- |
| `/` or Ctrl+K | command palette: type part of a song, setting or action, Enter runs it |
| `t` `R` `G` `P` | palette opened on songs / references / genres / presets |
| `?` | every key, grouped |
| space | play / pause |
| ↑ ↓ | select knob · ← → adjust (shift: fine) · `0` reset knob · double-click resets, drag the bar sets |
| `u` / `U` | undo / redo knob changes (quick turns of one knob are one step) |
| tab / shift-tab, `1`–`7` | next / previous module, or straight to one (signal order) |
| `a` | A/B: the original, turned to the master's loudness (so "louder" can't win) |
| `r` | listen to the reference, turned to the master's loudness; the meters then show the reference (│ = master) |
| `b` | bypass the selected module |
| `m` | measure: render the whole song offline and score it (reused until a knob changes) |
| `l` | set limiter Drive so the full-song master hits −14 LUFS (renders 1–4 times, ~5 s each) |
| `A` | auto-master: plan every module from the song's measurements (and the reference), set Drive by rendering; `u` undoes it |
| `v` | blind shootout: three versions of the auto-master (gentle / balanced / punchy) at −14 LUFS in a random order, knobs hidden; `1` `2` `3` switch, Enter picks, Esc cancels |
| `h` | apply the top hint's suggestion |
| `o` | mono check: everything you hear summed to mono (phone speaker, club PA) |
| `p` | streaming preview: off → Spotify → Apple Music → YouTube; every song plays at that platform's level |
| `c` / `x` / `X` | snapshot: save the current knobs · flip between the snapshot and your knobs (loudness-matched) · swap them (`u` undoes) |
| `s` | solo the selected EQ band: hear only its frequencies (+6 dB), follows the band as you move it; finds mud fast |
| `e` / `E` | export WAV, 24-bit / 16-bit with TPDF dither, at the song file's own sample rate |
| `,` `.` / Home | seek ±5 s / start · `z` restart the live meters |
| `i` | explanations on/off · `d` drills |

Knob settings are saved per song in localStorage. The palette's **Save session / Load a session file** write them to a JSON file or load one back
(validated and clamped like stored settings; `u` undoes a load), for backups or another browser.

**Multiband** (between EQ and Compressor): a Linkwitz-Riley crossover (24 dB/oct; the bands sum back flat) splits the
song into low, mid and high, each with its own compressor and gain. Every band starts off (threshold 0 = off), and
with all bands off and at 0 dB the module is skipped entirely, bit for bit. Lower one band's threshold to tame only that
range when it gets loud: a boomy bass note, harsh cymbals. Each band has its own GR meter.

**Tamer** (after the EQ): two dynamic bell cuts for resonances. Each band compares a narrow slice around its
frequency with the wider neighbourhood and cuts (up to Depth) only while the slice sticks out more than a smooth
spectrum would let it, so a harsh partial is turned down on the notes where it rings and nowhere else. The full-song
measurement finds candidates (narrow humps that stand above the spectrum on both sides); hints and auto-master only act
on 1.5–8 kHz, because lower peaks are usually the song's own notes (auto-master names them, e.g. "392 Hz (G4)").

**Color** (between Compressor and Limiter): Warmth (tanh saturation mixed in: quiet parts stay clean, loud parts gain
odd harmonics) and a soft clipper set "Clip above" the limiter's threshold, so the sharpest peaks are clipped before
the limiter has to duck them. Both run 2x oversampled (half-band FIR, ~80 dB) so the distortion doesn't alias; the
module always adds its fixed 47-sample delay, so A/B stays sample-aligned whether it's on or off.

**Edges** (last): lead-in silence, fade-in, fade-out and tail, counted from where the sound starts and stops (above
−60 dBFS) and including silence already in the file. Applied to the export and heard live (fades, and lead-in from the
top); never part of the full-song render, so they don't cost a new measurement. Playback from the top waits 100 ms
(or the lead-in) so a waking audio device can't swallow the first hit.

**Auto-master** (`A`, or the header button; CLI: `just automaster`): a first master planned from the song's own
measurements, with a reason for every knob (listed in Hints). Tone is compared with the reference, or without one a
spectrum that reads flat on the 4.5 dB/oct analyser: EQ fixes half of each gap ≥ 2 dB (at most 2 dB, 3 with a reference;
nearly empty bands are left alone), bands ≥ 4 dB too heavy also get multiband compression at their average level, bass
goes mono below 100 Hz, width follows the reference (70–130%), gentle glue compression unless the mix is already dense
(PLR < 9), ceiling −1 dBTP. Then it renders to set Drive for −14 LUFS, and if the dynamics score fails it eases the
compression once and renders again. It's a starting point to A/B, not a verdict. The CLI runs the same code in headless
Chrome and can write the WAV and a session file to load in the Desk.
It is **genre-aware** (`G`, or the header's Genre; default from the `[year, genre]` tag in the file name, e.g. `[2025, edm]`):
each style shifts the tonal target (EDM keeps a big sub, lo-fi a dark top), decides glue (ambient, cinematic and
acoustic keep their dynamics), warmth, soft clipping and mono bass (`src/master/genres.ts`; rules of thumb, a reference
overrides the tone). It also aims the Tamer at harsh resonances and sets Edges. Your **shootout picks** lean it toward
gentle or punchy (`tasteLean`: (punchy − gentle) / (picks + 2)).

**Streaming preview** (`p`): each source plays at the gain a platform would give it on playback, instead of being
loudness-matched: Spotify −14 LUFS (quiet songs turned up only until their peaks reach −1 dBTP, per
[Spotify](https://support.spotify.com/us/artists/article/loudness-normalization/)), Apple Music −16 and YouTube −14
(turn-down only; Apple's behaviour is from secondary sources). The full-song check lists each platform's gain for the
original, master and reference.

**Album** (tab; CLI `just album`): pick songs in play order, auto-master them all (genre per name, your taste), see the
loudness spread (songs > 1 LU off the median are flagged), play each join (last 8 s of one song with its fade-out and
tail into the first 8 s of the next with its lead-in), and export numbered WAVs in order (Chrome: into a folder you
pick). Each song's knobs are saved, so `desk` opens it ready to tweak.

**Snapshot compare**: `c` saves the knobs; keep tweaking, then `x` flips between the two candidate masters, sample-aligned
and turned to the same loudness, so you judge the processing, not the level. The snapshot runs on a second copy of the
chain; its values show as pink ticks on the knobs that differ, and the status line lists what's different.

**Presets** (header): starting points (Limiter only, Gentle glue, Loud EDM, Warm & wide, Clean up mud, Flat).
Compressor thresholds are set from the song's own loudness; press `l` afterwards for −14 LUFS. `u` undoes a preset.

**Spectrum & EQ**: live spectrum of what you hear (bars) against its comparison (line: the original, or the master
while you hear the reference), both at matched loudness so only tone differs. Tilted +4.5 dB/octave and smoothed
over 1/6 octave, like most mastering analysers. The white line is the EQ curve (±15 dB), dots are the bands:
drag a dot to set its frequency and gain, mouse wheel over the mud/presence dots sets Q, double-click resets the gain.

**Checklist**: the mastering workflow (reference, A/B, 1–3 dB of compression, −14 LUFS, ≤ −1 dBTP, dynamics kept,
mono check, export), ticked automatically from what you've listened to and measured; "Next:" says what to do.

**GR history**: under each GR meter, the last 10 s of gain reduction while playing. Regular deep dips on every kick
mean the compressor is pumping.

**Loudness over the song** (full-song check): short-term loudness of the original (blue) and the measured master (lilac)
across the whole song, the target zone shaded and the reference's integrated loudness dashed. Click it to seek.

**Score** (full song): loudness 40 (−14 LUFS ±1, falling to 0 at 4 LU off), true peak 30 (≤ −1 dBTP, 0 at 0 dBTP),
dynamics 30 (PLR may drop to `min(original, 11) − 2` dB, 0 points 6 dB below that).

**Hints**: loudness and peaks vs targets, PLR/LRA loss vs the original, risky settings (ratio > 4, attack < 3 ms,
EQ ≥ 6 dB, width ≥ 150%, idle compressor), compressor ducking the sub (sub ≥ 2 dB down against the other bands
with the sidechain HPF off: suggests ~100 Hz), stereo (correlation below 0 cancels in mono; below 0.2 is very wide),
and with a reference: the up-to-3 bands that differ most after removing the median gap (band levels are shares of
the total, so one heavy band would otherwise make all others look light), and width vs the reference's side/mid.
Before any measurement: edges (a song that hits on its first sample, a hard cut at the end, < 0.5 s of tail), harsh
resonances for the Tamer, and overdone color (warmth > 50%, clip < +1.5 dB) or tamer depth (> 8 dB).

## Drills (`d`)

An 8 s clip from the middle of the song plays as A (original) and B (one hidden process), loudness-matched
and with peaks ≤ −1 dBFS, looping in sync. Flip with `a`, answer with `1`–`9`/`0`, `n` next, `t` next drill.
5 right in a row levels you up; progress is saved.

- **EQ**: +12 dB low/mid/high → +9 dB five bands → +6 dB seven bands → ±6 dB boost-or-cut → +3 dB octaves
- **Compression**: on/off → how much (3) → subtle (4) → fast vs slow attack → fast vs slow release
- **Limiting** (peaks pushed N dB into a −1 dB ceiling): on/off → 6 or 12 → 3/6/9 → fast vs slow release → 2/4/6/8
- **Stereo width**: mono or not → 50% vs 180% → 50/100/160% → 70/100/140% → 80/100/125%

## Signal chain

```
song ─┬─► EQ ─► width ─► tamer ─► multiband ─► compressor ─► color ─► limiter ─► master ─► edge fades ─┐
      │                                                                                                ├─► stereo / mono ─► speakers
      ├─► delay (color + limiter latency) ─► × match gain ───────────────────────────► original ──────┤
reference (synced, looped) ─► × match gain ──────────────────────────────────────────► reference ─────┘
                        (streaming preview: platform gains instead of match gains)
```

- **Width** (mid/side stage, part of the EQ module): scales the side (L−R) and leaves the mid (L+R) alone;
  0% = mono, 200% = side +6 dB. **Mono bass below** high-passes the side (24 dB/oct), so kick and sub sit in the centre.
  **Side air gain** is a high shelf on the side only (at the air shelf's frequency): mid/side EQ.

- **Compressor**: stereo-linked peak or RMS detector (RMS window 5–100 ms), soft knee, attack/release, explicit makeup,
  optional high-pass on the detector so sub-bass doesn't pump the mix.
- **Limiter**: 5 ms lookahead, 8x-oversampled peak detection, aims 0.1 dB under the ceiling so the
  output stays under it on any true-peak meter (checked with ffmpeg and 16x). Drive −12…+12 dB, so a
  song that is already too loud can be turned down to the target.

## What `analyze` measures

| Metric | Standard |
| --- | --- |
| Integrated, momentary, short-term loudness | ITU-R BS.1770-4, EBU R128 / Tech 3341 |
| Loudness range | EBU Tech 3342 |
| True peak (4x oversampled below 96 kHz) | ITU-R BS.1770-4 Annex 2 |
| Crest, PLR, tonal balance (6 bands, share of energy) | |
| Stereo correlation, side vs mid (dB) | |
| Edges: silence before/after the sound, level of its first/last 10 ms | |
| Resonances: 1/12-octave humps above both neighbours (150 Hz–8 kHz) | |

Streaming targets: −14 LUFS ±1 integrated, true peak ≤ −1 dBTP.

## Plan

1. ✅ Scaffold + DOM-free analysis core (`src/analysis/`), `just analyze`
2. ✅ Audio engine: load mp3, play, EQ → compressor → limiter (AudioWorklet lookahead limiter), A/B, bypass
3. ✅ Desk UI: meters with target zones, keyboard knobs, explanations, score
4. ✅ WAV export (24-bit, or 16-bit dithered) via OfflineAudioContext
5. ✅ Drills: EQ, compression, limiting and stereo-width ear training with levels and streaks
6. ✅ Hints and reference-track comparison
