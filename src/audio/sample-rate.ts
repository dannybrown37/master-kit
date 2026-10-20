/**
 * Reads a song file's own sample rate from its header (mp3, WAV, FLAC), so the offline render and
 * export can run at it instead of the AudioContext's rate (often 48 kHz for a 44.1 kHz mp3).
 * Returns null for formats it doesn't know or headers that don't make sense.
 */

const MIN_RATE = 8000;
const MAX_RATE = 384_000;
const MP3_SCAN_BYTES = 64 * 1024;
const MPEG_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

const plausible = (rate: number): number | null => (Number.isInteger(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rate : null);

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function wavRate(v: DataView, b: Uint8Array): number | null {
  for (let at = 12; at + 8 <= b.length; ) {
    const size = v.getUint32(at + 4, true);
    if (ascii(b, at, "fmt ")) return at + 16 <= b.length ? plausible(v.getUint32(at + 12, true)) : null;
    at += 8 + size + (size & 1);
  }
  return null;
}

function flacRate(b: Uint8Array): number | null {
  // STREAMINFO is always the first metadata block; its rate is 20 bits at data offset 10.
  if (b.length < 8 + 13 || (b[4] & 0x7f) !== 0) return null;
  return plausible((b[18] << 12) | (b[19] << 4) | (b[20] >> 4));
}

function id3Size(b: Uint8Array): number {
  if (!ascii(b, 0, "ID3") || b.length < 10) return 0;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function mp3Rate(b: Uint8Array): number | null {
  const start = id3Size(b);
  const end = Math.min(b.length - 3, start + MP3_SCAN_BYTES);
  for (let i = start; i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const bitrate = b[i + 2] >> 4;
    const rateIndex = (b[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || bitrate === 15 || rateIndex === 3) continue;
    return MPEG_RATES[version][rateIndex];
  }
  return null;
}

export function fileSampleRate(data: ArrayBuffer): number | null {
  const b = new Uint8Array(data);
  const v = new DataView(data);
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return wavRate(v, b);
  if (ascii(b, 0, "fLaC")) return flacRate(b);
  if (ascii(b, 0, "OggS")) return null;
  return mp3Rate(b);
}
