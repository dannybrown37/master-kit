import { describe, expect, it } from "vitest";
import { defaultSettings, noBypass } from "./settings.ts";
import { parseSession, sessionFileName, toSession } from "./session.ts";

const ON = noBypass();

describe("session", () => {
  it("round-trips through JSON", () => {
    const settings = { ...defaultSettings(), limDrive: 4.5, eqLowGain: -2 };
    const bypass = { ...ON, comp: true };
    const text = JSON.stringify(toSession("song.mp3", settings, bypass));
    expect(parseSession(JSON.parse(text))).toEqual({ track: "song.mp3", settings, bypass });
  });

  it.each([
    ["not an object", "hello"],
    ["null", null],
    ["another app's JSON", { foo: 1 }],
    ["a newer format", { app: "master-kit", version: 2, settings: {} }],
    ["settings missing", { app: "master-kit", version: 1 }],
  ])("rejects %s", (_name, input) => {
    expect(parseSession(input)).toBeNull();
  });

  it("clamps and drops bad values like stored settings", () => {
    const s = parseSession({ app: "master-kit", version: 1, track: 7, settings: { limDrive: 99, eqLowGain: "loud", evil: 1 }, bypass: { comp: "yes", eq: true } });
    expect(s).toEqual({ track: "", settings: { ...defaultSettings(), limDrive: 12 }, bypass: { ...ON, eq: true } });
  });

  it.each([
    ["First in Line [2025, edm].mp3", "First in Line [2025, edm] (session).json"],
    ["a/b:c?.mp3", "a_b_c_ (session).json"],
    ["", "song (session).json"],
  ])("file name for %s", (track, want) => {
    expect(sessionFileName(track)).toBe(want);
  });
});
