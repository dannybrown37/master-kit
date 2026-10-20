/**
 * Streaming preview: the gain each platform applies on playback (loudness normalization), from a song's full-song
 * integrated loudness and true peak.
 * Spotify (Normal, the default): -14 LUFS; quieter songs are turned up only as far as their true peak stays under
 * -1 dBTP (https://support.spotify.com/us/artists/article/loudness-normalization/).
 * YouTube: -14 LUFS, turns down only. Apple Music (Sound Check): -16 LUFS; treated as turn-down only, which secondary
 * sources report but Apple doesn't document.
 */

export type PlatformKey = "spotify" | "apple" | "youtube";

export interface Platform {
  key: PlatformKey;
  name: string;
  lufs: number;
  /** Quieter songs are turned up (as far as their peaks allow); false = turned down only. */
  turnsUp: boolean;
}

export const PLATFORMS: readonly Platform[] = [
  { key: "spotify", name: "Spotify", lufs: -14, turnsUp: true },
  { key: "apple", name: "Apple Music", lufs: -16, turnsUp: false },
  { key: "youtube", name: "YouTube", lufs: -14, turnsUp: false },
];

/** Spotify keeps 1 dB of headroom for lossy encoding when it turns a song up. */
const BOOST_PEAK_LIMIT_DBTP = -1;

export interface Loudness {
  integrated: number;
  truePeak: number;
}

export function platform(key: PlatformKey): Platform {
  const p = PLATFORMS.find((x) => x.key === key);
  if (!p) throw new RangeError(`unknown platform ${key}`);
  return p;
}

export function nextPlatform(current: PlatformKey | null): PlatformKey | null {
  const i = current ? PLATFORMS.findIndex((p) => p.key === current) : -1;
  return PLATFORMS[i + 1]?.key ?? null;
}

/** dB the platform turns the song by on playback; 0 if the loudness is unknown. */
export function playbackGainDb(p: Platform, { integrated, truePeak }: Loudness): number {
  if (!Number.isFinite(integrated)) return 0;
  const gain = p.lufs - integrated;
  if (gain <= 0) return gain;
  if (!p.turnsUp || !Number.isFinite(truePeak)) return 0;
  return Math.max(0, Math.min(gain, BOOST_PEAK_LIMIT_DBTP - truePeak));
}

/**
 * The master's full-song loudness: a current measurement if there is one, else an estimate that follows the knobs
 * live: the original's loudness plus the A/B match (master minus original, smoothed), and the live true-peak hold.
 */
export function masterLoudness(measured: Loudness | null, original: Loudness, matchDb: number, liveTruePeak: number): Loudness & { exact: boolean } {
  if (measured) return { ...measured, exact: true };
  return {
    integrated: original.integrated + matchDb,
    truePeak: Number.isFinite(liveTruePeak) ? liveTruePeak : original.truePeak + matchDb,
    exact: false,
  };
}
