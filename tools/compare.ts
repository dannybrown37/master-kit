/** Before/after table of two analysis reports, for the CLIs. */
import type { Report } from "../src/analysis/report.ts";

function row(label: string, a: number, b: number, unit: string): string {
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "-inf").padStart(7);
  const d = b - a;
  return `  ${label.padEnd(16)}${f(a)} ${f(b)}  ${Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : ""} ${unit}`;
}

export function compare(a: Report, b: Report): string {
  return [
    `  ${"".padEnd(16)}${"before".padStart(7)} ${"after".padStart(7)}`,
    row("Integrated", a.integrated, b.integrated, "LUFS"),
    row("Short-term max", a.shortTermMax, b.shortTermMax, "LUFS"),
    row("LRA", a.loudnessRange, b.loudnessRange, "LU"),
    row("True peak", a.truePeak, b.truePeak, "dBTP"),
    row("Sample peak", a.samplePeak, b.samplePeak, "dBFS"),
    row("Crest", a.crest, b.crest, "dB"),
    row("PLR", a.plr, b.plr, "dB"),
    ...a.bands.map((band, i) => row(band.label, band.db, b.bands[i].db, "dB")),
  ].join("\n");
}
