import { describe, expect, it } from "vitest";
import { defaultSettings } from "./settings.ts";
import { alignOpusPreSkip, assertSameLength, fitLength, isVideoName, lockSync, muxPlan, parseRemuxUpload, placeOnTimeline, remuxOutcome, shiftStart, syncOffset, videoExportName } from "./video.ts";

const RATE = 48000;

function noise(seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x / 2 ** 32 - 0.5) * Math.sin((Math.PI * i) / RATE) ** 2;
  }
  return out;
}

/** A master: shifted by `lag` samples (positive = late), one-pole low-passed and turned down, like EQ + gain would. */
function mastered(src: Float32Array, lag: number): Float32Array {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    const j = i - lag;
    y += 0.3 * ((j >= 0 && j < src.length ? src[j] : 0) - y);
    out[i] = 0.5 * y;
  }
  return out;
}

describe("syncOffset", () => {
  const src = noise(20);
  it.each([
    ["in sync", 0],
    ["a 200 ms lead-in", 9600],
    ["1 ms late", 48],
    ["one sample late", 1],
    ["30 ms early", -1440],
  ])("%s → that many samples", (_name, lag) => {
    expect(syncOffset([mastered(src, lag)], [src], RATE)).toBe(lag);
  });

  it("silence can't be checked: throws rather than calling it in sync", () => {
    const quiet = new Float32Array(20 * RATE);
    expect(() => syncOffset([quiet], [quiet], RATE)).toThrow(/silent/);
  });
});

describe("videoExportName", () => {
  it.each([
    ["Holiday.mp4", "Holiday (master).mp4"],
    ["take 2.MOV", "take 2 (master).MOV"],
    ["clip.webm", "clip (master).webm"],
    ["old cam.avi", "old cam (master).mkv"],
  ])("%s → %s", (track, want) => {
    expect(videoExportName(track)).toBe(want);
  });
});

describe("parseRemuxUpload", () => {
  const q = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);

  it("splits the body at videoBytes and picks the output container", () => {
    expect(parseRemuxUpload(q({ name: "clip.mov", videoBytes: "1000" }), 5000)).toEqual({ videoBytes: 1000, inExt: ".mov", outExt: ".mov" });
  });

  it("only takes the extension from the name, never a path", () => {
    expect(parseRemuxUpload(q({ name: "../../etc/x.avi", videoBytes: "10" }), 100)).toEqual({ videoBytes: 10, inExt: ".avi", outExt: ".mkv" });
  });

  it.each([
    ["no name", { videoBytes: "10" }],
    ["no videoBytes", { name: "a.mp4" }],
    ["videoBytes not an integer", { name: "a.mp4", videoBytes: "1e3" }],
    ["videoBytes zero", { name: "a.mp4", videoBytes: "0" }],
    ["no room for the WAV", { name: "a.mp4", videoBytes: "90" }],
    ["odd extension characters", { name: "a.m$4", videoBytes: "10" }],
  ])("rejects %s", (_name, params) => {
    expect(() => parseRemuxUpload(q(params), 100)).toThrow();
  });
});

describe("remuxOutcome", () => {
  it.each([
    ["our endpoint, ok", 200, true, "video"],
    ["our endpoint refused (sync)", 422, true, "refused"],
    ["our endpoint, bad request", 400, true, "refused"],
    ["static host 405 (nginx)", 405, false, "unavailable"],
    ["static host 404", 404, false, "unavailable"],
    ["SPA fallback serving index.html with 200", 200, false, "unavailable"],
    ["network error", null, false, "unavailable"],
  ] as const)("%s → %s", (_name, status, ours, want) => {
    expect(remuxOutcome(status, ours)).toBe(want);
  });
});

describe("muxPlan", () => {
  it.each([
    ["clip.mp4", { container: "mp4", codecs: ["aac"] }],
    ["clip.M4V", { container: "mp4", codecs: ["aac"] }],
    ["clip.mov", { container: "mov", codecs: ["aac", "pcm-s24"] }],
    ["clip.webm", { container: "webm", codecs: ["opus"] }],
    ["clip.mkv", { container: "mkv", codecs: ["flac", "pcm-s24"] }],
    ["old.avi", { container: "mkv", codecs: ["flac", "pcm-s24"] }],
  ] as const)("%s", (name, want) => {
    expect(muxPlan(name)).toEqual(want);
  });
});

describe("placeOnTimeline", () => {
  const chunk = (timestamp: number, ...values: number[]): { timestamp: number; channels: Float32Array[] } => ({ timestamp, channels: [Float32Array.from(values)] });

  it("puts each chunk at its timestamp relative to `from`, silence in the gaps", () => {
    const out = placeOnTimeline([chunk(0.2, 1, 2), chunk(0.5, 3)], 0.1, 6, 10, 1);
    expect([...out[0]]).toEqual([0, 1, 2, 0, 3, 0]);
  });

  it("clips chunks that start before `from` or run past the end", () => {
    const out = placeOnTimeline([chunk(0, 1, 2, 3), chunk(0.4, 4, 5, 6)], 0.1, 4, 10, 1);
    expect([...out[0]]).toEqual([2, 3, 0, 4]);
  });

  it("rounds timestamps to the nearest sample", () => {
    const out = placeOnTimeline([chunk(0.10004, 7)], 0, 3, 10, 1);
    expect([...out[0]]).toEqual([0, 7, 0]);
  });
});

describe("alignOpusPreSkip", () => {
  /** Tracks with CodecDelay (8-byte uint, ns) and an OpusHead CodecPrivate, then a Cluster holding `clusterBytes`. */
  function webm(codecDelayNs: number | null, preSkip: number, clusterBytes: number[] = []): Uint8Array {
    const head = [...new TextEncoder().encode("OpusHead"), 1, 2, preSkip & 0xff, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0];
    const delay = codecDelayNs === null ? [] : [0x56, 0xaa, 0x88, ...new Array<number>(4).fill(0), (codecDelayNs >>> 24) & 0xff, (codecDelayNs >> 16) & 0xff, (codecDelayNs >> 8) & 0xff, codecDelayNs & 0xff];
    const entry = [...delay, 0x63, 0xa2, 0x80 | head.length, ...head];
    return Uint8Array.from([0x16, 0x54, 0xae, 0x6b, 0x80 | (entry.length + 2), 0xae, 0x80 | entry.length, ...entry, 0x1f, 0x43, 0xb6, 0x75, 0x80 | clusterBytes.length, ...clusterBytes]);
  }
  const preSkipOf = (b: Uint8Array): number => {
    const at = new TextDecoder("latin1").decode(b).indexOf("OpusHead");
    return b[at + 10] | (b[at + 11] << 8);
  };

  it("sets pre-skip to the CodecDelay (13.5 ms = 648 samples at 48 kHz)", () => {
    const b = webm(13_500_000, 312);
    expect(alignOpusPreSkip(b)).toBe(648);
    expect(preSkipOf(b)).toBe(648);
  });

  it("leaves an already consistent file alone", () => {
    const b = webm(6_500_000, 312);
    expect(alignOpusPreSkip(b)).toBe(312);
    expect(preSkipOf(b)).toBe(312);
  });

  it.each([
    ["no CodecDelay", webm(null, 312)],
    ["not Opus", Uint8Array.from([0x16, 0x54, 0xae, 0x6b, 0x80])],
  ])("%s → null, untouched", (_name, b) => {
    const before = [...b];
    expect(alignOpusPreSkip(b)).toBeNull();
    expect([...b]).toEqual(before);
  });

  it("never reads a lookalike inside the media data (after the first Cluster)", () => {
    const fake = [0x56, 0xaa, 0x88, 0, 0, 0, 0, 0, 0, 0, 1, ...new TextEncoder().encode("OpusHead"), 1, 2, 0x38, 0x01];
    const b = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, 0x80 | fake.length, ...fake]);
    expect(alignOpusPreSkip(b)).toBeNull();
  });
});

describe("shiftStart", () => {
  it.each([
    ["earlier: drops samples off the front", 2, [3, 4, 0, 0]],
    ["later: adds silence in front", -1, [0, 1, 2, 3]],
    ["zero: unchanged", 0, [1, 2, 3, 4]],
  ])("%s, same length", (_name, by, want) => {
    expect(shiftStart([Float32Array.from([1, 2, 3, 4])], by).map((c) => [...c])).toEqual([want]);
  });
});

describe("fitLength", () => {
  it.each([
    ["trims extra samples off the end", [1, 2, 3, 4], 3, [1, 2, 3]],
    ["pads the end with silence", [1, 2], 4, [1, 2, 0, 0]],
    ["leaves an exact fit alone", [1, 2], 2, [1, 2]],
  ])("%s", (_name, input, frames, want) => {
    expect(fitLength([Float32Array.from(input)], frames).map((c) => [...c])).toEqual([want]);
  });
});

describe("isVideoName", () => {
  it.each([
    ["clip.mp4", true],
    ["Clip.MOV", true],
    ["a.b.webm", true],
    ["take 2.mkv", true],
    ["song.m4a", false],
    ["song.mp3", false],
    ["mp4", false],
    ["", false],
  ])("%s → %s", (name, want) => {
    expect(isVideoName(name)).toBe(want);
  });

  it.each([
    ["holiday.avi", "video/x-msvideo", true],
    ["song.mp3", "audio/mpeg", false],
  ])("%s with type %s → %s", (name, type, want) => {
    expect(isVideoName(name, type)).toBe(want);
  });
});

describe("lockSync", () => {
  it("zeroes lead-in and tail, keeps fades and every other knob", () => {
    const s = { ...defaultSettings(), edgeLeadMs: 200, edgeTailMs: 1000, edgeFadeInMs: 5, edgeFadeOutMs: 100, limDrive: 4 };
    expect(lockSync(s)).toEqual({ ...s, edgeLeadMs: 0, edgeTailMs: 0 });
  });

  it("does not mutate its input", () => {
    const s = { ...defaultSettings(), edgeLeadMs: 200 };
    lockSync(s);
    expect(s.edgeLeadMs).toBe(200);
  });
});

describe("assertSameLength", () => {
  it("passes when the export has exactly the source's frames", () => {
    expect(() => assertSameLength(48000, 48000)).not.toThrow();
  });

  it.each([
    ["one sample longer", 48001],
    ["one sample shorter", 47999],
    ["a 200 ms lead-in longer", 48000 + 9600],
  ])("throws when %s", (_name, exported) => {
    expect(() => assertSameLength(48000, exported)).toThrow(/sync/);
  });
});
