import { describe, expect, it } from "vitest";
import { parseTrackList, pickAudioFile } from "./library.ts";

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
