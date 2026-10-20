import { describe, expect, it } from "vitest";
import { LiveLoudness } from "./live.ts";
import { loudness } from "./loudness.ts";
import { SR, noise, sine, sineSteps, stereo } from "./test-signals.ts";

function feed(meter: LiveLoudness, channels: Float32Array[], block: number): void {
  for (let start = 0; start < channels[0].length; start += block) {
    meter.push(channels.map((c) => c.subarray(start, Math.min(start + block, c.length))));
  }
}

describe("LiveLoudness", () => {
  it.each([128, 1000, 4800])("matches the offline meter when fed in %d-frame blocks", (block) => {
    const channels = stereo(sineSteps([[-30, 4], [-15, 3], [-25, 4]]));
    const offline = loudness(channels, SR);
    const meter = new LiveLoudness(SR);
    feed(meter, channels, block);
    expect(meter.momentary).toBeCloseTo(offline.momentary.at(-1) ?? NaN, 6);
    expect(meter.shortTerm).toBeCloseTo(offline.shortTerm.at(-1) ?? NaN, 6);
    expect(meter.integrated).toBeCloseTo(offline.integrated, 6);
  });

  it("reads -Infinity until a full window has arrived", () => {
    const meter = new LiveLoudness(SR);
    meter.push(stereo(sine(1000, 0.35, -20)));
    expect(meter.momentary).toBe(-Infinity);
    meter.push(stereo(sine(1000, 0.1, -20)));
    expect(meter.momentary).toBeCloseTo(-20, 0);
    expect(meter.shortTerm).toBe(-Infinity);
  });

  it("tracks the sample peak of the most recent push", () => {
    const meter = new LiveLoudness(SR);
    meter.push([Float32Array.of(0.1, -0.5), Float32Array.of(0.25, 0)]);
    expect(meter.peak).toBeCloseTo(20 * Math.log10(0.5), 6);
  });

  it("reset forgets history", () => {
    const meter = new LiveLoudness(SR);
    feed(meter, stereo(noise(4, -10)), 512);
    meter.reset();
    expect([meter.momentary, meter.shortTerm, meter.integrated]).toEqual([-Infinity, -Infinity, -Infinity]);
  });
});
