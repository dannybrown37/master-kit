/**
 * In-browser "Export video": copies the video's picture packets untouched (same timestamps) into a new file of the
 * same kind and encodes the master under them, starting where the old audio started. Before handing the file over
 * it decodes the new and old sound around the middle on the picture's timeline and refuses anything > 0.25 ms off.
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
} from "mediabunny";
import type { AudioCodec, InputAudioTrack, OutputFormat } from "mediabunny";
import { alignOpusPreSkip, muxPlan, placeOnTimeline, shiftStart, syncOffset } from "../master/video.ts";
import type { MuxContainer } from "../master/video.ts";

const CHUNK_FRAMES = 8192;
const CHECK_SECONDS = 14;
const MAX_LAG_SECONDS = 0.00025;

export interface MuxResult {
  blob: Blob;
  codec: AudioCodec;
  lagSamples: number;
}

function outputFormat(container: MuxContainer): OutputFormat {
  if (container === "mp4") return new Mp4OutputFormat({ fastStart: "in-memory" });
  if (container === "mov") return new MovOutputFormat({ fastStart: "in-memory" });
  if (container === "webm") return new WebMOutputFormat();
  return new MkvOutputFormat();
}

async function tracks(input: Input): Promise<{ video: NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>; audio: InputAudioTrack }> {
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getAudioTracks();
  if (!video) throw new Error("no picture track found in the file");
  if (audio.length !== 1) throw new Error(`the video has ${audio.length} audio tracks; Export video handles exactly one`);
  return { video, audio: audio[0] };
}

/**
 * Decoded sound from `from` (seconds after the picture starts) for CHECK_SECONDS. Like a player, it plays the samples
 * back to back from the first one's timestamp: per-block timestamps in MKV/WebM are rounded to 1 ms and would jitter.
 */
async function soundAgainstPicture(input: Input, from: number, sampleRate: number, channels: number): Promise<Float32Array[]> {
  const { video, audio } = await tracks(input);
  if ((await audio.getSampleRate()) !== sampleRate) throw new Error("the new and old sound have different sample rates, so sync can't be checked");
  const start = (await video.getFirstTimestamp()) + from;
  const end = start + CHECK_SECONDS;
  const chunks: { timestamp: number; channels: Float32Array[] }[] = [];
  let first: number | null = null;
  let played = 0;
  for await (const s of new AudioSampleSink(audio).samples()) {
    first ??= s.timestamp;
    const at = first + played / sampleRate;
    played += s.numberOfFrames;
    if (at + s.duration >= start) {
      const planes = Array.from({ length: s.numberOfChannels }, (_, c) => {
        const plane = new Float32Array(s.numberOfFrames);
        s.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        return plane;
      });
      chunks.push({ timestamp: at, channels: planes });
    }
    s.close();
    if (at > end) break;
  }
  return placeOnTimeline(chunks, start, Math.round(CHECK_SECONDS * sampleRate), sampleRate, channels);
}

async function copyPicture(input: Input, source: EncodedVideoPacketSource): Promise<void> {
  const { video } = await tracks(input);
  const decoderConfig = (await video.getDecoderConfig()) ?? undefined;
  let first = true;
  for await (const packet of new EncodedPacketSink(video).packets()) {
    await source.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
    first = false;
  }
  source.close();
}

async function encodeSound(source: AudioSampleSource, master: Float32Array[], sampleRate: number, startAt: number): Promise<void> {
  const frames = master[0].length;
  for (let at = 0; at < frames; at += CHUNK_FRAMES) {
    const n = Math.min(CHUNK_FRAMES, frames - at);
    const data = new Float32Array(n * master.length);
    master.forEach((c, i) => data.set(c.subarray(at, at + n), i * n));
    const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: master.length, sampleRate, timestamp: startAt + at / sampleRate });
    await source.add(sample);
    sample.close();
  }
  source.close();
}

export async function muxVideo(videoBytes: ArrayBuffer, name: string, master: Float32Array[], sampleRate: number): Promise<MuxResult> {
  const input = new Input({ source: new BlobSource(new Blob([videoBytes])), formats: ALL_FORMATS });
  const { video, audio } = await tracks(input);
  const plan = muxPlan(name);
  const format = outputFormat(plan.container);
  const videoCodec = await video.getCodec();
  if (!videoCodec || !format.getSupportedVideoCodecs().includes(videoCodec)) throw new Error(`a ${plan.container} file can't carry this picture (${videoCodec ?? "unknown codec"})`);
  const wanted = plan.codecs.filter((c): c is AudioCodec => (format.getSupportedAudioCodecs() as string[]).includes(c));
  const codec = await getFirstEncodableAudioCodec(wanted, { numberOfChannels: master.length, sampleRate });
  if (!codec) throw new Error(`this browser can't encode ${wanted.join(" or ")} at ${sampleRate} Hz`);

  const startAt = await audio.getFirstTimestamp();
  const middle = Math.max(0, (await input.computeDuration()) / 2 - CHECK_SECONDS / 2);
  const original = await soundAgainstPicture(input, middle, sampleRate, master.length);
  const rotation = await video.getRotation();
  const tags = await input.getMetadataTags();

  // Codecs and containers place sound slightly differently (priming, 1 ms ticks): measure, shift the samples, retry.
  let earlier = 0;
  let lag = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const output = new Output({ format: outputFormat(plan.container), target: new BufferTarget() });
    const picture = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(picture, { rotation });
    const sound = new AudioSampleSource({ codec, quality: QUALITY_VERY_HIGH });
    output.addAudioTrack(sound);
    output.setMetadataTags(tags);
    await output.start();
    await Promise.all([copyPicture(input, picture), encodeSound(sound, shiftStart(master, earlier), sampleRate, startAt)]);
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("the muxer produced no file");
    if (codec === "opus" && (plan.container === "webm" || plan.container === "mkv")) alignOpusPreSkip(new Uint8Array(buffer));
    const muxed = new Input({ source: new BlobSource(new Blob([buffer])), formats: ALL_FORMATS });
    lag = syncOffset(await soundAgainstPicture(muxed, middle, sampleRate, master.length), original, sampleRate);
    console.log(`Export video, try ${attempt}: ${lag} samples against the picture`);
    if (Math.abs(lag) <= MAX_LAG_SECONDS * sampleRate) return { blob: new Blob([buffer], { type: await output.getMimeType() }), codec, lagSamples: lag };
    earlier += lag;
  }
  throw new Error(`couldn't place the new sound within 0.25 ms of the picture (${((lag / sampleRate) * 1000).toFixed(2)} ms off)`);
}
