import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav.ts";
import { rng } from "../analysis/test-signals.ts";

function text(v: DataView, at: number, n: number): string {
  return String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(at + i)));
}

function sampleAt(v: DataView, bits: 16 | 24, index: number): number {
  const at = 44 + index * (bits / 8);
  if (bits === 16) return v.getInt16(at, true);
  const u = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16);
  return u & 0x800000 ? u - 0x1000000 : u;
}

describe("encodeWav", () => {
  it.each([16, 24] as const)("writes a valid %d-bit PCM header", (bits) => {
    const v = new DataView(encodeWav([new Float32Array(10), new Float32Array(10)], 44100, bits));
    const bytes = bits / 8;
    expect(text(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 10 * 2 * bytes);
    expect(text(v, 8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 2 * bytes);
    expect(v.getUint16(32, true)).toBe(2 * bytes);
    expect(v.getUint16(34, true)).toBe(bits);
    expect(text(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(10 * 2 * bytes);
    expect(v.byteLength).toBe(44 + 10 * 2 * bytes);
  });

  it.each([
    ["zero", 0, 0],
    ["half scale", 0.5, 4194304],
    ["negative full scale", -1, -8388608],
    ["just under full scale", 0.9999999, 8388607],
    ["clips above full scale", 1.7, 8388607],
    ["clips below", -3, -8388608],
  ])("24-bit: %s", (_name, x, want) => {
    const v = new DataView(encodeWav([Float32Array.of(x)], 48000, 24));
    expect(sampleAt(v, 24, 0)).toBe(want);
  });

  it("interleaves channels L, R, L, R", () => {
    const v = new DataView(encodeWav([Float32Array.of(0.25, 0.5), Float32Array.of(-0.25, -0.5)], 48000, 24));
    expect([0, 1, 2, 3].map((i) => sampleAt(v, 24, i))).toEqual([2097152, -2097152, 4194304, -4194304]);
  });

  it("16-bit adds TPDF dither: within ±1 LSB of the exact value and unbiased", () => {
    const x = new Float32Array(20000).fill(1000.3 / 32768);
    const v = new DataView(encodeWav([x], 44100, 16, rng(7)));
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const s = sampleAt(v, 16, i);
      expect(Math.abs(s - 1000.3)).toBeLessThanOrEqual(1.7);
      sum += s;
    }
    expect(sum / x.length).toBeCloseTo(1000.3, 1);
  });

  it("16-bit dither never wraps around at full scale", () => {
    const v = new DataView(encodeWav([new Float32Array(1000).fill(1)], 44100, 16, rng(3)));
    for (let i = 0; i < 1000; i++) expect(sampleAt(v, 16, i)).toBeGreaterThan(32700);
  });

  it.each([
    ["no channels", [], 44100],
    ["mismatched lengths", [new Float32Array(2), new Float32Array(3)], 44100],
    ["bad sample rate", [new Float32Array(2)], 0],
  ])("rejects %s", (_name, channels, sr) => {
    expect(() => encodeWav(channels, sr, 24)).toThrow(RangeError);
  });
});
