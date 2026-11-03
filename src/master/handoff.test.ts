import { describe, expect, it } from "vitest";
import { HANDOFF_TIMEOUT_MS, handoffMessage, isShaderReady, shaderOrigin, videoMimeType } from "./handoff.ts";

describe("shaderOrigin", () => {
  it.each([
    ["https://master.dannybrown.dev", "https://shader.dannybrown.dev"],
    ["http://127.0.0.1:5174", "http://127.0.0.1:5173"],
    ["http://localhost:5174", "http://localhost:5173"],
    ["http://127.0.0.1:5173", null],
    ["http://127.0.0.1:4173", null],
    ["https://localhost:5174", null],
    ["http://master.dannybrown.dev", null],
    ["https://evil.master.dannybrown.dev", null],
    ["https://master.dannybrown.dev.evil.com", null],
    ["https://shader.dannybrown.dev", null],
    ["null", null],
    ["", null],
  ])("%s → %s", (origin, want) => {
    expect(shaderOrigin(origin)).toBe(want);
  });
});

describe("isShaderReady", () => {
  const win = {};
  const ORIGIN = "https://shader.dannybrown.dev";
  const ready = { type: "music-shader:ready", v: 1 };

  it("accepts ready from the opened window at the shader origin", () => {
    expect(isShaderReady({ origin: ORIGIN, source: win, data: ready }, ORIGIN, win)).toBe(true);
  });

  it.each([
    ["wrong origin", { origin: "https://evil.example", source: win, data: ready }],
    ["origin with a different port", { origin: "https://shader.dannybrown.dev:444", source: win, data: ready }],
    ["another window", { origin: ORIGIN, source: {}, data: ready }],
    ["no source", { origin: ORIGIN, source: null, data: ready }],
    ["wrong type", { origin: ORIGIN, source: win, data: { type: "music-shader:handoff", v: 1 } }],
    ["wrong version", { origin: ORIGIN, source: win, data: { type: "music-shader:ready", v: 2 } }],
    ["version as a string", { origin: ORIGIN, source: win, data: { type: "music-shader:ready", v: "1" } }],
    ["no version", { origin: ORIGIN, source: win, data: { type: "music-shader:ready" } }],
    ["a string", { origin: ORIGIN, source: win, data: "music-shader:ready" }],
    ["null data", { origin: ORIGIN, source: win, data: null }],
    ["an array", { origin: ORIGIN, source: win, data: ["music-shader:ready", 1] }],
  ])("rejects %s", (_name, event) => {
    expect(isShaderReady(event, ORIGIN, win)).toBe(false);
  });
});

describe("videoMimeType", () => {
  it.each([
    ["clip.mp4", "video/mp4"],
    ["Clip.M4V", "video/mp4"],
    ["take.mov", "video/quicktime"],
    ["a.webm", "video/webm"],
    ["a.mkv", "video/x-matroska"],
    ["old.avi", ""],
    ["noext", ""],
  ])("%s → %s", (name, want) => {
    expect(videoMimeType(name)).toBe(want);
  });
});

describe("handoffMessage", () => {
  it("builds the v1 handoff with the original name, the video file and the WAV", () => {
    const video = new Blob(["v"]);
    const audio = new Blob(["a"], { type: "audio/wav" });
    expect(handoffMessage("clip.mp4", video, audio)).toEqual({ type: "music-shader:handoff", v: 1, name: "clip.mp4", video, audio });
  });

  it("waits 20 s for ready", () => {
    expect(HANDOFF_TIMEOUT_MS).toBe(20_000);
  });
});
