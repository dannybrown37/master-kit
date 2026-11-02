import { describe, expect, it } from "vitest";
import { fileSampleRate } from "./sample-rate.ts";
import { encodeWav } from "../export/wav.ts";

function bytes(...parts: (number[] | Uint8Array | string)[]): ArrayBuffer {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") out.push(...[...p].map((c) => c.charCodeAt(0)));
    else out.push(...p);
  }
  return new Uint8Array(out).buffer;
}

/** MPEG audio frame header: version bits (3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5), layer III, 128 kbps. */
function mpegHeader(version: number, rateIndex: number): number[] {
  return [0xff, 0xe0 | (version << 3) | (1 << 1) | 1, (9 << 4) | (rateIndex << 2), 0x44];
}

function id3(size: number): number[] {
  const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  return [0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe, ...new Array<number>(size).fill(0xff)];
}

function flac(rate: number): ArrayBuffer {
  const info = new Array<number>(34).fill(0);
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0xf) << 4) | (1 << 1);
  return bytes("fLaC", [0x80, 0, 0, 34], info);
}

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const f64 = (x: number): number[] => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return [...new Uint8Array(v.buffer)];
};
const f32 = (x: number): number[] => {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, x);
  return [...new Uint8Array(v.buffer)];
};
const flat = (...parts: (number[] | string)[]): number[] => [...new Uint8Array(bytes(...parts))];

/** ISO BMFF / QuickTime box. */
const box = (type: string, ...payload: (number[] | string)[]): number[] => {
  const body = flat(...payload);
  return [...u32(8 + body.length), ...flat(type), ...body];
};

/** Sound sample entry; version 2 (QuickTime) stores the rate as a float64. */
function soundEntry(rate: number, version = 0): number[] {
  const head = [...new Array<number>(6).fill(0), ...u16(1), ...u16(version), ...u16(0), ...u32(0), ...u16(2), ...u16(16), ...u16(0), ...u16(0)];
  const tail = version === 2 ? [...u32(0x10000), ...u32(72), ...f64(rate)] : u32((rate & 0xffff) * 0x10000);
  return box("mp4a", head, tail);
}

function track(handler: string, entry: number[]): number[] {
  const hdlr = box("hdlr", u32(0), u32(0), handler, new Array<number>(12).fill(0));
  const stsd = box("stsd", u32(0), u32(1), entry);
  return box("trak", box("mdia", box("mdhd", new Array<number>(24).fill(0)), hdlr, box("minf", box("stbl", stsd))));
}

function mp4(rate: number, version = 0, before: number[] = []): ArrayBuffer {
  const video = track("vide", box("avc1", new Array<number>(78).fill(0)));
  return bytes(box("ftyp", "isom", u32(0)), before, box("moov", box("mvhd", new Array<number>(100).fill(0)), video, track("soun", soundEntry(rate, version))));
}

/** EBML element; sizes ≥ 127 use the 8-byte form, "unknown" is the all-ones size live WebM uses for Segment. */
function el(id: number[], ...payload: (number[] | "unknown")[]): number[] {
  if (payload[0] === "unknown") return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...flat(...(payload.slice(1) as number[][]))];
  const body = flat(...(payload as number[][]));
  const size = body.length < 127 ? [0x80 | body.length] : [0x01, 0, 0, 0, ...u32(body.length)];
  return [...id, ...size, ...body];
}

const SEGMENT = [0x18, 0x53, 0x80, 0x67];
const TRACKS = [0x16, 0x54, 0xae, 0x6b];
const TRACK_ENTRY = [0xae];
const AUDIO = [0xe1];

function mkv(audio: number[], unknownSegment = false): ArrayBuffer {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], flat("webm")));
  const info = el([0x15, 0x49, 0xa9, 0x66], new Array<number>(20).fill(0));
  const videoTrack = el(TRACK_ENTRY, el([0x83], [1]), el([0xe0], el([0xb0], u16(320))));
  const audioTrack = el(TRACK_ENTRY, el([0x83], [2]), el(AUDIO, el([0x9f], [2]), audio));
  const tracks = el(TRACKS, videoTrack, audioTrack);
  return bytes(header, unknownSegment ? el(SEGMENT, "unknown", info, tracks) : el(SEGMENT, info, tracks));
}

describe("fileSampleRate", () => {
  it.each([
    ["mp4 48 kHz", mp4(48000), 48000],
    ["mp4 44.1 kHz", mp4(44100), 44100],
    ["QuickTime v2 entry at 96 kHz", mp4(96000, 2), 96000],
    ["mdat with a 64-bit size before moov", mp4(48000, 0, [...u32(1), ...flat("mdat"), ...u32(0), ...u32(24), ...u32(0), ...u32(0)]), 48000],
  ])("%s (audio track, not the video one)", (_name, data, rate) => {
    expect(fileSampleRate(data)).toBe(rate);
  });

  it.each([
    ["float64 rate", mkv(el([0xb5], f64(48000))), 48000],
    ["float32 rate", mkv(el([0xb5], f32(44100))), 44100],
    ["output rate wins (HE-AAC)", mkv([...el([0xb5], f64(24000)), ...el([0x78, 0xb5], f64(48000))]), 48000],
    ["unknown-size Segment (live WebM)", mkv(el([0xb5], f64(48000)), true), 48000],
  ])("Matroska/WebM %s", (_name, data, rate) => {
    expect(fileSampleRate(data)).toBe(rate);
  });

  it.each([
    ["MPEG1 44.1 kHz", 3, 0, 44100],
    ["MPEG1 48 kHz", 3, 1, 48000],
    ["MPEG1 32 kHz", 3, 2, 32000],
    ["MPEG2 22.05 kHz", 2, 0, 22050],
    ["MPEG2.5 8 kHz", 0, 2, 8000],
  ])("mp3 %s", (_name, version, index, rate) => {
    expect(fileSampleRate(bytes(mpegHeader(version, index), new Array<number>(400).fill(0)))).toBe(rate);
  });

  it("skips an ID3v2 tag, even one full of 0xff bytes that look like frame syncs", () => {
    expect(fileSampleRate(bytes(id3(3000), mpegHeader(3, 1)))).toBe(48000);
  });

  it("skips junk before the first frame and invalid headers", () => {
    const reservedRate = [0xff, 0xfb, 0x9c, 0x44];
    expect(fileSampleRate(bytes([0, 1, 2], reservedRate, mpegHeader(3, 0)))).toBe(44100);
  });

  it.each([44100, 48000, 96000])("WAV at %i Hz (our own encoder)", (rate) => {
    expect(fileSampleRate(encodeWav([new Float32Array(10), new Float32Array(10)], rate, 24))).toBe(rate);
  });

  it("WAV with a chunk before fmt", () => {
    const fmt = [1, 0, 2, 0, 0x80, 0xbb, 0, 0, 0, 0, 0, 0, 4, 0, 16, 0];
    expect(fileSampleRate(bytes("RIFF", [0, 0, 0, 0], "WAVE", "LIST", [3, 0, 0, 0], [1, 2, 3, 0], "fmt ", [16, 0, 0, 0], fmt))).toBe(48000);
  });

  it.each([44100, 48000, 88200])("FLAC at %i Hz", (rate) => {
    expect(fileSampleRate(flac(rate))).toBe(rate);
  });

  it.each([
    ["empty", bytes()],
    ["ogg", bytes("OggS", new Array<number>(40).fill(0))],
    ["truncated ID3", bytes([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x7f, 0x7f])],
    ["random text", bytes("hello world, not audio")],
    ["mp4 with no audio track", bytes(box("ftyp", "isom", u32(0)), box("moov", track("vide", box("avc1", new Array<number>(78).fill(0)))))],
    ["truncated moov", bytes(box("ftyp", "isom", u32(0)), u32(500), "moov", u32(10))],
    ["mkv with no audio track", bytes(el([0x1a, 0x45, 0xdf, 0xa3]), el(SEGMENT, el(TRACKS, el(TRACK_ENTRY, el([0x83], [1])))))],
    ["WAV with an absurd rate", bytes("RIFF", [0, 0, 0, 0], "WAVE", "fmt ", [16, 0, 0, 0], [1, 0, 2, 0, 1, 0, 0, 0], new Array<number>(8).fill(0))],
  ])("unknown or broken: %s → null", (_name, data) => {
    expect(fileSampleRate(data)).toBeNull();
  });
});
