/** Starting points. Each is applied over the defaults; thresholds depend on the song, so the texts say what to adjust. */
import { clampParam, defaultSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";

export interface Preset {
  name: string;
  about: string;
  settings: Partial<Settings>;
  /** Compressor threshold relative to the song's integrated loudness, so it bites the same on loud and quiet songs. */
  thresholdBelowLufs?: number;
}

export const GENTLE_GLUE: Preset = {
  name: "Gentle glue",
  about: "Slow RMS compression at 2:1 that gently holds the mix together (threshold set from this song's loudness; aim for 1-3 dB GR). Press l to set Drive for -14 LUFS.",
  settings: { compThreshold: -16, compRatio: 2, compAttack: 30, compRelease: 200, compKnee: 9, compSidechainHz: 100, compRmsMs: 30, compMakeup: 1, limDrive: 2 },
  thresholdBelowLufs: 3,
};

export const PRESETS: readonly Preset[] = [
  { name: "Flat (all defaults)", about: "Every knob back to neutral: EQ flat, compressor idle, limiter at 0 dB drive.", settings: {} },
  {
    name: "Limiter only",
    about: "The most transparent master: no EQ or compression, the limiter just catches peaks. Press l to set Drive for -14 LUFS.",
    settings: { limDrive: 2 },
  },
  GENTLE_GLUE,
  {
    name: "Loud EDM",
    about: "Punchy and loud: faster compression with a sidechain filter so the kick doesn't pump, mono bass, more limiter drive. Press l for -14 LUFS, then check PLR.",
    thresholdBelowLufs: 1,
    settings: {
      compThreshold: -14,
      compRatio: 2.5,
      compAttack: 10,
      compRelease: 80,
      compSidechainHz: 120,
      eqMonoBassHz: 120,
      eqAirGain: 1,
      limDrive: 5,
      limRelease: 30,
    },
  },
  {
    name: "Warm & wide",
    about: "Tone and space: a little low shelf and air, a touch wider with sparkle on the sides, bass kept mono. A/B it: subtle is the point.",
    settings: { eqLowFreq: 90, eqLowGain: 1.5, eqAirGain: 1.5, eqWidth: 115, eqSideAirGain: 1.5, eqMonoBassHz: 100, limDrive: 2 },
  },
  {
    name: "Clean up mud",
    about: "Cuts the 250-400 Hz build-up that makes mixes boxy, and lifts presence for clarity. Sweep Mud freq while listening to find the worst spot.",
    settings: { eqMudFreq: 300, eqMudGain: -2.5, eqMudQ: 1.2, eqPresGain: 1, limDrive: 2 },
  },
];

export function applyPreset(p: Preset, originalLufs = NaN): Settings {
  const s = { ...defaultSettings(), ...p.settings };
  if (p.thresholdBelowLufs !== undefined && Number.isFinite(originalLufs)) {
    s.compThreshold = clampParam("compThreshold", originalLufs - p.thresholdBelowLufs);
  }
  return s;
}
