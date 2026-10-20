// Runs the full-song report off the main thread so meters and keys stay responsive.
import { analyze } from "../analysis/report.ts";
import type { MeasureReply, MeasureRequest } from "./measure.ts";

self.onmessage = (ev: MessageEvent<MeasureRequest>): void => {
  const { id, channels, sampleRate } = ev.data;
  let reply: MeasureReply;
  try {
    reply = { id, report: analyze(channels, sampleRate) };
  } catch (err: unknown) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};
