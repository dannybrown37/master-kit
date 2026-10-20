/** `analyze()` in a Web Worker. */
import type { Report } from "../analysis/report.ts";
import AnalysisWorker from "./analysis.worker.ts?worker";

export type MeasureRequest = { id: number; channels: Float32Array[]; sampleRate: number };
export type MeasureReply = { id: number; report: Report } | { id: number; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Report) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w: Worker = new AnalysisWorker();
  w.onmessage = (ev: MessageEvent<MeasureReply>): void => {
    const p = pending.get(ev.data.id);
    pending.delete(ev.data.id);
    if ("report" in ev.data) p?.resolve(ev.data.report);
    else p?.reject(new Error(ev.data.error));
  };
  w.onerror = (ev: ErrorEvent): void => {
    for (const p of pending.values()) p.reject(new Error(`analysis worker failed: ${ev.message}`));
    pending.clear();
  };
  worker = w;
  return w;
}

/** Copies the channels (the caller keeps its buffers). */
export function measure(channels: Float32Array[], sampleRate: number): Promise<Report> {
  const id = nextId++;
  const copies = channels.map((c) => c.slice());
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, channels: copies, sampleRate } satisfies MeasureRequest, copies.map((c) => c.buffer));
  });
}
