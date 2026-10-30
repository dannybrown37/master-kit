import { describe, expect, it } from "vitest";
import { search } from "./search.ts";
import type { SearchEntry } from "./search.ts";

const entries: SearchEntry[] = [
  { id: "song-barrel", title: "Barrel Rondo [2026, neoclassical edm].mp3", group: "Song" },
  { id: "ref-barrel", title: "Barrel Rondo [2026, neoclassical edm].mp3", group: "Reference" },
  { id: "song-aform", title: "Aformency [2020, cinematic].mp3", group: "Song" },
  { id: "auto", title: "Auto-master", group: "Action", terms: "plan" },
  { id: "export", title: "Export WAV 24-bit", group: "Action", terms: "download save" },
  { id: "genre-cine", title: "Cinematic", group: "Genre" },
];

const ids = (query: string): string[] => search(entries, query).map((e) => e.id);

describe("palette search", () => {
  it("returns everything, in order, for an empty query", () => {
    expect(ids("  ")).toEqual(entries.map((e) => e.id));
  });

  it.each<[string, string[]]>([
    ["barrel", ["song-barrel", "ref-barrel"]],
    ["ref barrel", ["ref-barrel"]],
    ["AUTO", ["auto"]],
    ["auto m", ["auto"]],
    ["download", ["export"]],
    ["2020", ["song-aform"]],
    ["rel", []],
    ["zzz", []],
  ])("matches %j", (query, expected) => {
    expect(ids(query)).toEqual(expected);
  });

  it("ranks a title prefix above a title word above group or terms only", () => {
    expect(ids("cine")).toEqual(["genre-cine", "song-aform"]);
    expect(ids("plan")).toEqual(["auto"]);
  });
});
