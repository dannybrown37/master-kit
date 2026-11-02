/**
 * Reads a song file's own sample rate from its header (mp3, WAV, FLAC, MP4/MOV/M4A, MKV/WebM), so the offline render and
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

interface Span {
  id: number | string;
  start: number;
  end: number;
}

function* isoBoxes(v: DataView, b: Uint8Array, start: number, end: number): Generator<Span> {
  for (let at = start; at + 8 <= end; ) {
    let size = v.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    yield { id: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), start: at + header, end: at + size };
    at += size;
  }
}

const child = (v: DataView, b: Uint8Array, parent: Span | undefined, type: string): Span | undefined =>
  parent && [...isoBoxes(v, b, parent.start, parent.end)].find((s) => s.id === type);

/** MP4/MOV/M4A: the first sound track's sample entry (QuickTime v2 entries keep the rate as a float64). */
function isoRate(v: DataView, b: Uint8Array): number | null {
  const moov = child(v, b, { id: "", start: 0, end: b.length }, "moov");
  for (const trak of moov ? isoBoxes(v, b, moov.start, moov.end) : []) {
    if (trak.id !== "trak") continue;
    const mdia = child(v, b, trak, "mdia");
    const hdlr = child(v, b, mdia, "hdlr");
    if (!hdlr || hdlr.start + 12 > hdlr.end || !ascii(b, hdlr.start + 8, "soun")) continue;
    const stsd = child(v, b, child(v, b, child(v, b, mdia, "minf"), "stbl"), "stsd");
    const entry = stsd && [...isoBoxes(v, b, stsd.start + 8, stsd.end)][0];
    if (!entry || entry.start + 28 > entry.end) return null;
    if (v.getUint16(entry.start + 8) === 2) return entry.start + 40 <= entry.end ? plausible(Math.round(v.getFloat64(entry.start + 32))) : null;
    return plausible(v.getUint16(entry.start + 24));
  }
  return null;
}

const EBML = { segment: 0x18538067, tracks: 0x1654ae6b, trackEntry: 0xae, audio: 0xe1, rate: 0xb5, outputRate: 0x78b5 };

function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x100 >> len)) return len;
  return 0;
}

function* ebmlElements(b: Uint8Array, start: number, end: number): Generator<Span> {
  for (let at = start; at < end; ) {
    const idLen = vintLength(b[at]);
    if (!idLen || at + idLen >= end) return;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i];
    const sizeAt = at + idLen;
    const sizeLen = vintLength(b[sizeAt]);
    if (!sizeLen || sizeAt + sizeLen > end) return;
    let size = b[sizeAt] & (0xff >> sizeLen);
    let unknown = size === 0xff >> sizeLen;
    for (let i = 1; i < sizeLen; i++) {
      size = size * 256 + b[sizeAt + i];
      unknown &&= b[sizeAt + i] === 0xff;
    }
    const data = sizeAt + sizeLen;
    const stop = unknown ? end : data + size;
    if (stop > end) return;
    yield { id, start: data, end: stop };
    at = stop;
  }
}

function ebmlFloat(v: DataView, s: Span): number | null {
  if (s.end - s.start === 4) return v.getFloat32(s.start);
  if (s.end - s.start === 8) return v.getFloat64(s.start);
  return null;
}

/** Matroska/WebM: the first audio track's (output) sampling frequency. */
function matroskaRate(v: DataView, b: Uint8Array): number | null {
  const within = (parent: Span, id: number): Span[] => [...ebmlElements(b, parent.start, parent.end)].filter((s) => s.id === id);
  for (const segment of within({ id: 0, start: 0, end: b.length }, EBML.segment)) {
    // A live WebM Segment has no size, so stop walking it at Tracks rather than scanning every Cluster.
    for (const tracks of ebmlElements(b, segment.start, segment.end)) {
      if (tracks.id !== EBML.tracks) continue;
      for (const entry of within(tracks, EBML.trackEntry)) {
        const audio = within(entry, EBML.audio)[0];
        if (!audio) continue;
        const rates = within(audio, EBML.outputRate).concat(within(audio, EBML.rate));
        const rate = rates.length ? ebmlFloat(v, rates[0]) : null;
        return rate === null ? null : plausible(Math.round(rate));
      }
      return null;
    }
  }
  return null;
}

const ISO_TOP_BOXES = ["ftyp", "moov", "mdat", "wide", "free", "skip"];

export function fileSampleRate(data: ArrayBuffer): number | null {
  const b = new Uint8Array(data);
  const v = new DataView(data);
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return wavRate(v, b);
  if (ascii(b, 0, "fLaC")) return flacRate(b);
  if (ascii(b, 0, "OggS")) return null;
  if (ISO_TOP_BOXES.some((type) => ascii(b, 4, type))) return isoRate(v, b);
  if (b.length >= 4 && v.getUint32(0) === 0x1a45dfa3) return matroskaRate(v, b);
  return mp3Rate(b);
}
