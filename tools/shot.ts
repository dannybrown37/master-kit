/**
 * Screenshots the Desk in headless Chrome at desktop and mobile width.
 *
 *   node tools/shot.ts [track] [--play S] [--keys "Tab,ArrowRight,m"] [--wait S] [--query "drills=1"] [--name desk]
 *
 * Writes out/<name>-desktop.png and out/<name>-mobile.png.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sleep, startSession } from "./chrome.ts";
import type { Cdp } from "./chrome.ts";

const USAGE = `Usage: just shot [track] [--play SECONDS] [--keys K1,K2,...] [--wait SECONDS] [--query a=1&b=2] [--name NAME]

Keys use DOM key names (Tab, ArrowRight, " " for space, a, m, ...). Screenshots go to out/NAME-{desktop,mobile}.png.`;

const WIDTHS = [
  ["desktop", 1440, 1000, 1, false],
  ["mobile", 390, 844, 2, true],
] as const;

async function capture(cdp: Cdp, file: string, width: number, height: number, scale: number, mobile: boolean): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
  await sleep(400);
  const { data } = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })) as { data: string };
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      play: { type: "string" },
      keys: { type: "string" },
      wait: { type: "string" },
      query: { type: "string" },
      name: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(`master-kit ${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`);
    return 0;
  }
  if (values.help || positionals.length > 1) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const name = values.name ?? "desk";
  if (!/^[\w-]+$/.test(name)) throw new RangeError(`--name must be letters, digits, - or _: ${name}`);
  const q = new URLSearchParams(values.query ?? "");
  if (positionals[0]) q.set("track", positionals[0]);
  if (values.play) q.set("autoplay", "1");
  mkdirSync("out", { recursive: true });
  const session = await startSession(WIDTHS[0][1], WIDTHS[0][2]);
  try {
    const { cdp } = session;
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${session.base}/?${q}` });
    await cdp.waitReady(60);
    if (values.play) await sleep(Number(values.play) * 1000);
    for (const key of (values.keys ?? "").split(",").filter(Boolean)) {
      await cdp.key(key);
      await sleep(150);
    }
    if (values.wait) await sleep(Number(values.wait) * 1000);
    for (const [label, w, hgt, scale, mobile] of WIDTHS) await capture(cdp, `out/${name}-${label}.png`, w, hgt, scale, mobile);
    const errors = cdp.logs.filter((l) => /error|uncaught/i.test(l));
    if (errors.length) console.log(errors.join("\n"));
  } finally {
    await session.close();
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`shot: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
