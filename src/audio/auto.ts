/** Render loops: limiter Drive for the loudness target, and the full auto-master (plan → Drive → check dynamics). */
import { loudness } from "../analysis/loudness.ts";
import type { Report } from "../analysis/report.ts";
import { TARGETS } from "../analysis/targets.ts";
import { matchLoudness } from "../master/autogain.ts";
import type { MatchResult } from "../master/autogain.ts";
import { easeDynamics, planMaster } from "../master/automaster.ts";
import { score } from "../master/score.ts";
import type { Bypass, Settings } from "../master/settings.ts";
import { formatParam } from "../master/settings.ts";
import { measure } from "./measure.ts";
import { renderMaster } from "./render.ts";
import type { Rendered } from "./render.ts";

/** Only the master is kept: a full-song channel pair is ~60 MB, and the original is already in memory. */
export type MasterAudio = Pick<Rendered, "sampleRate" | "master">;

export interface DriveMatch {
  result: MatchResult;
  /** The render at `result.drive` (null if cancelled). */
  audio: MasterAudio | null;
}

/**
 * Renders with a few Drive values until the master hits the loudness target. `onRender(drive)` reports progress;
 * `cancelled()` stops early (e.g. the song changed). Only the closest render is kept.
 */
export async function driveForTarget(
  buffer: AudioBuffer,
  settings: Settings,
  bypass: Bypass,
  onRender: (drive: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<DriveMatch> {
  const kept: { closest: { drive: number; gap: number; audio: MasterAudio } | null } = { closest: null };
  const result = await matchLoudness(
    async (drive) => {
      if (cancelled()) return NaN;
      onRender(drive);
      const { sampleRate, master } = await renderMaster(buffer, { ...settings, limDrive: drive }, bypass);
      const lufs = loudness(master, sampleRate).integrated;
      const gap = Math.abs(TARGETS.integrated - lufs);
      // Same rule as matchLoudness picks its best: strictly closer wins.
      if (!kept.closest || gap < kept.closest.gap) kept.closest = { drive, gap, audio: { sampleRate, master } };
      return lufs;
    },
    settings.limDrive,
    TARGETS.integrated,
  );
  const best = kept.closest;
  return { result, audio: best && best.drive === result.drive ? best.audio : null };
}

export interface AutoMaster {
  settings: Settings;
  bypass: Bypass;
  steps: string[];
  audio: MasterAudio;
  report: Report;
}

/** Plans a master from the song's measurements, sets Drive by rendering, and eases the compression once if dynamics suffered. */
export async function autoMaster(
  buffer: AudioBuffer,
  original: Report,
  reference: Report | null,
  onProgress: (text: string) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<AutoMaster | null> {
  const plan = planMaster({ original, reference });
  const steps = [...plan.steps];
  let settings = plan.settings;
  for (let attempt = 0; ; attempt++) {
    const { result, audio } = await driveForTarget(buffer, settings, plan.bypass, (d) => onProgress(`auto-master: rendering with Drive ${formatParam("limDrive", d)}…`), cancelled);
    if (!audio || cancelled()) return null;
    settings = { ...settings, limDrive: result.drive };
    onProgress("auto-master: measuring…");
    const report = await measure(audio.master, audio.sampleRate);
    const reach = result.reached ? "" : " (the closest it gets)";
    steps.push(`Limiter: Drive ${formatParam("limDrive", result.drive)} → ${report.integrated.toFixed(1)} LUFS${reach}, ${report.truePeak.toFixed(1)} dBTP, found in ${result.steps.length} render${result.steps.length > 1 ? "s" : ""}.`);
    const dynamics = score(original, report).parts.find((p) => p.name === "dynamics");
    const eased = dynamics?.ok || attempt > 0 ? null : easeDynamics(settings);
    if (!eased) {
      const sc = score(original, report);
      steps.push(`Result: ${sc.total}/100 (${sc.parts.map((p) => `${p.name} ${p.ok ? "✓" : "✗"}`).join(", ")}). A starting point: A/B it (a), then trust your ears.`);
      return { settings, bypass: plan.bypass, steps, audio, report };
    }
    steps.push(`Dynamics: PLR fell to ${report.plr.toFixed(1)} dB (${dynamics?.detail}), so the compression is eased and Drive found again.`);
    settings = eased;
  }
}
