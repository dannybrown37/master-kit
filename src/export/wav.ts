/** PCM WAV encoder (16-bit with TPDF dither, or 24-bit). DOM-free. */

export type BitDepth = 16 | 24;

/**
 * Interleaves `channels` into a canonical 44-byte-header WAV.
 * `random` drives the 16-bit dither (inject a seeded one in tests).
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: BitDepth, random: () => number = Math.random): ArrayBuffer {
  if (channels.length === 0) throw new RangeError("need at least one channel");
  if (channels.some((c) => c.length !== channels[0].length)) throw new RangeError("channels differ in length");
  if (!(Number.isInteger(sampleRate) && sampleRate > 0)) throw new RangeError(`bad sample rate ${sampleRate}`);
  const frames = channels[0].length;
  const bytes = bits / 8;
  const blockAlign = channels.length * bytes;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const v = new DataView(out);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels.length, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  ascii(36, "data");
  v.setUint32(40, dataSize, true);

  const max = 2 ** (bits - 1);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      // TPDF dither (sum of two uniforms, ±1 LSB) decorrelates 16-bit rounding error from the music.
      const dither = bits === 16 ? random() - random() : 0;
      const s = Math.max(-max, Math.min(max - 1, Math.round(ch[i] * max + dither)));
      if (bits === 16) v.setInt16(at, s, true);
      else {
        v.setUint8(at, s & 0xff);
        v.setUint8(at + 1, (s >> 8) & 0xff);
        v.setUint8(at + 2, (s >> 16) & 0xff);
      }
      at += bytes;
    }
  }
  return out;
}
