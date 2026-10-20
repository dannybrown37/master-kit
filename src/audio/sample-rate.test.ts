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

describe("fileSampleRate", () => {
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
    ["WAV with an absurd rate", bytes("RIFF", [0, 0, 0, 0], "WAVE", "fmt ", [16, 0, 0, 0], [1, 0, 2, 0, 1, 0, 0, 0], new Array<number>(8).fill(0))],
  ])("unknown or broken: %s → null", (_name, data) => {
    expect(fileSampleRate(data)).toBeNull();
  });
});
