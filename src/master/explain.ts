/** Plain-language help shown by `?` on the desk. */
import type { Module, ParamKey } from "./settings.ts";

export const MODULE_HELP: Record<Module, string> = {
  eq: "EQ: small, broad moves fix tonal balance. In mastering ±1–2 dB is a lot; if you need ±6, the mix needs fixing. Stereo width lives here too.",
  multi:
    "Multiband: three compressors, each on its own slice of the spectrum (low, mid, high). It tames one range only when it gets loud: a booming bass note or a harsh cymbal, without touching the rest. Every band starts off; lower a band's threshold until its GR moves.",
  comp: "Compressor: turns loud moments down so the song feels denser. Watch the GR meter: 1–3 dB is typical glue for a master.",
  limiter: "Limiter: a very fast, very high-ratio compressor that stops peaks at the ceiling. Drive pushes the song into it to make it louder.",
  edges:
    "Edges: the silence and fades around the song, applied to the exported file (fades also play live). There's no formal standard; common practice is a few ms fade-in, 0–500 ms of silence before, a clean fade at the end and ~1 s of silence after. Everything starts off.",
};

export const PARAM_HELP: Record<ParamKey, string> = {
  eqLowFreq: "Where the low shelf starts. Everything below this goes up or down together (kick and bass weight).",
  eqLowGain: "Low shelf boost/cut. Cut if the bass booms or the limiter is busy on kicks; boost for weight on small speakers.",
  eqMudFreq: "Centre of the 'mud' band (150–800 Hz), where boxy, cloudy build-up lives.",
  eqMudGain: "A small cut here often clears up a crowded mix. Big boosts sound boxy.",
  eqMudQ: "Width of the mud band: low Q = broad and gentle, high Q = narrow and surgical.",
  eqPresFreq: "Centre of the presence band (1–8 kHz): vocal clarity, snare crack, attack.",
  eqPresGain: "Boost for forwardness and clarity; too much is harsh and tiring. Cut to tame harshness.",
  eqPresQ: "Width of the presence band.",
  eqAirFreq: "Where the high shelf starts: the sheen and 'air' above the presence range.",
  eqAirGain: "A little boost adds openness. Too much brings out hiss and sibilance (s-sounds).",
  eqMonoBassHz: "Makes everything below this frequency mono (only the side signal is filtered). Keeps kick and sub solid and centred on club systems and vinyl. 80–150 Hz is typical for EDM.",
  eqSideAirGain:
    "Mid/side EQ: a high shelf on the side signal only, at the air shelf's frequency. +1–3 dB adds shimmer to the stereo edges (reverbs, hats, pads) without making the vocal or snare in the centre harsher.",
  eqWidth: "Turns the side (L−R: what differs between speakers) up or down; the centre stays put. 100% = untouched, 0% = mono. Past ~130% things start to sound phasey and fall apart in mono (o).",
  mbLowThreshold: "Where the low band (kick, bass, sub) starts being turned down. Off = never. Lower it until the low GR shows 2–4 dB on the boomiest notes.",
  mbLowGain: "Static level of the low band after compression: like a low shelf, but with a steep, phase-coherent split.",
  mbMidThreshold: "Where the mid band (vocals, guitars, snare body) starts being turned down. Usually left off in mastering.",
  mbMidGain: "Static level of the mid band.",
  mbHighThreshold: "Where the high band (cymbals, sibilance, hiss) starts being turned down. Catches harsh hits without dulling the whole top end the way an EQ cut would.",
  mbHighGain: "Static level of the high band.",
  mbLowHz: "Where low ends and mid begins. ~120–250 Hz keeps the kick and bass in the low band.",
  mbHighHz: "Where mid ends and high begins. 4–6 kHz isolates cymbals and sibilance.",
  mbRatio: "How hard every band turns down past its threshold. 2–4:1 is typical; higher sounds like the band ducks.",
  mbAttack: "How fast the bands react. Slower (20–40 ms) lets kick and snare transients through; fast catches sibilance.",
  mbRelease: "How fast the bands let go. Too fast flutters on bass notes; 150–300 ms is a safe start.",
  compThreshold: "Level where compression starts. Lower it until the GR meter moves on the loud hits.",
  compRatio: "How hard it turns down past the threshold. 2:1 = 2 dB over becomes 1 dB over. Masters usually stay at 1.5–3:1.",
  compKnee: "Soft knee eases compression in gradually around the threshold: smoother, less audible.",
  compAttack: "How fast it reacts. Short attack flattens transients (punch); 10–30 ms lets the kick's snap through.",
  compRelease: "How fast it lets go. Too fast pumps and distorts bass; too slow keeps the song squashed.",
  compMakeup: "Turns the compressed signal back up. Use A/B (loudness-matched) to judge: louder always sounds 'better'.",
  compSidechainHz: "Filters the bass out of what the compressor listens to, so a big kick or sub doesn't pump the whole mix. Try 80–150 Hz on bass-heavy songs.",
  compRmsMs:
    "What the compressor listens to. Peak reacts to every hit (drums get squashed first). RMS averages over a window (20–50 ms is typical), so it follows loudness and lets short transients through: smoother, more glue-like.",
  limDrive: "Gain into the limiter. Positive = louder and more limiting; negative turns a hot song down to the streaming target.",
  limCeiling: "The highest the output may reach. -1 dBTP leaves room for lossy encoding (Spotify, YouTube) without clipping.",
  limRelease: "How fast the limiter recovers. Short = louder but can distort; long = cleaner but can duck after hits.",
  edgeLeadMs:
    "Silence before the first sound (counting what's already in the file). Players and Bluetooth speakers can take ~100 ms to start, so a song that hits on its first sample loses that hit. 100–300 ms is plenty.",
  edgeFadeInMs: "A fade from silence at the first sound. 2–10 ms removes the click of starting mid-waveform without softening the hit; longer fades the intro in.",
  edgeFadeOutMs:
    "A fade to silence ending at the last sound. ~100 ms declicks a hard cut and keeps the ending abrupt; 3–10 s fades the song away (a decision about the arrangement, so A/B it).",
  edgeTailMs: "Silence after the last sound (counting what's already in the file), so the next track or an ad doesn't crash in. ~1 s is typical; less for albums meant to play gapless.",
};

export const METER_HELP = {
  momentary: "Momentary loudness: the last 0.4 s, in LUFS (loudness units, like dB but weighted to how we hear).",
  shortTerm: "Short-term loudness: the last 3 s. Watch it in the loud parts.",
  integrated: "Integrated loudness: the whole song (since play). Streaming services turn songs to about -14 LUFS.",
  truePeak: "True peak: the highest point including between samples, what a DAC or mp3 encoder sees. Keep it at -1 dBTP or lower.",
  plr: "PLR (peak-to-loudness ratio): true peak minus integrated. Small = squashed; a healthy master keeps ~9 dB or more.",
  correlation: "Correlation: +1 = mono, 0 = wide, below 0 = parts cancel when played in mono (phone speaker, club PA). Bass-heavy songs read near +1.",
  width: "Side vs mid: how loud the stereo difference is next to the centre. -20 dB is narrow, -10 typical, near 0 very wide.",
  reference: "While you hear the reference (r), the bars show the reference at its own level and the | marks the master.",
} as const;
