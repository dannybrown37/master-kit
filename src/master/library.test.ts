import { describe, expect, it } from "vitest";
import { parseTrackList, pickAudioFile, songTitle } from "./library.ts";

describe("parseTrackList", () => {
  it.each([
    ["dev server list", "application/json", '{"dir":"/m","tracks":["a.mp3","b.wav"]}', ["a.mp3", "b.wav"]],
    ["static host index.html fallback", "text/html", "<!doctype html>", []],
    ["404 page with no type", null, "Not found", []],
    ["json but broken", "application/json", "{", []],
    ["json null", "application/json", "null", []],
    ["tracks not an array", "application/json", '{"tracks":"a.mp3"}', []],
    ["non-strings dropped", "application/json", '{"tracks":["a.mp3",3,"",null]}', ["a.mp3"]],
  ])("%s", (_name, type, body, want) => {
    expect(parseTrackList(type, body)).toEqual(want);
  });
});

describe("pickAudioFile", () => {
  it.each([
    ["audio mime", [{ name: "x", type: "audio/mpeg" }], "x"],
    ["extension when type empty", [{ name: "Song.FLAC", type: "" }], "Song.FLAC"],
    ["skips non-audio", [{ name: "notes.txt", type: "text/plain" }, { name: "s.mp3", type: "" }], "s.mp3"],
    ["none", [{ name: "pic.png", type: "image/png" }], null],
    ["empty", [], null],
  ])("%s", (_name, files, want) => {
    expect(pickAudioFile(files)?.name ?? null).toBe(want);
  });
});

describe("songTitle", () => {
  it.each([
    ["tags and extension", "Barrel Rondo [2026, neoclassical edm].mp3", "Barrel Rondo"],
    ["extension only", "My Song.wav", "My Song"],
    ["brackets mid-name stay", "Intro [live] take 2.flac", "Intro [live] take 2"],
    ["nothing left falls back to the name", "[2020].mp3", "[2020].mp3"],
  ])("%s", (_name, file, want) => {
    expect(songTitle(file)).toBe(want);
  });
});
