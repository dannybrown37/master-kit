/** Headless Chrome over the DevTools protocol, plus a throwaway Vite server to point it at. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export class Cdp {
  private readonly ws: WebSocket;
  private next = 1;
  private readonly pending = new Map<number, (m: CdpMessage) => void>();
  readonly logs: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent): void => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const args = (msg.params?.args ?? []) as { value?: unknown; description?: string }[];
        this.logs.push(args.map((a) => a.description ?? String(a.value)).join(" "));
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        this.logs.push(`uncaught: ${d?.exception?.description ?? d?.text ?? "unknown"}`);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => resolve();
      ws.onerror = (): void => reject(new Error(`could not connect to ${url}`));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T };
      exceptionDetails?: { text: string };
    };
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text}\n${this.logs.join("\n")}`);
    return r.result?.value as T;
  }

  async key(key: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key });
  }

  /** Waits for the page to set `<html data-status>` to "ready" (or "error"). */
  async waitReady(timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const status = await this.evaluate<string>("document.documentElement.dataset.status ?? ''");
      if (status === "ready") return;
      if (status === "error") throw new Error(`page reported an error\n${this.logs.join("\n")}`);
      await sleep(250);
    }
    throw new Error(`page not ready after ${timeoutSeconds} s\n${this.logs.join("\n")}`);
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEBUG_PORT = 9334;

async function pageTarget(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (err: unknown) {
      if (!(err instanceof TypeError)) throw err;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not start");
}

const CHUNK = 1 << 20;

/** Copies a rendered stereo pair out of the page (`window.__renderChunk`), 1 M samples per round trip. */
export async function pullChannels(cdp: Cdp, which: "master" | "original", length: number): Promise<Float32Array[]> {
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (let c = 0; c < 2; c++) {
    for (let start = 0; start < length; start += CHUNK) {
      const b64 = await cdp.evaluate<string>(`window.__renderChunk(${JSON.stringify(which)}, ${c}, ${start}, ${CHUNK})`);
      const bytes = Buffer.from(b64, "base64");
      channels[c].set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), start);
    }
  }
  return channels;
}

export interface Session {
  cdp: Cdp;
  base: string;
  close(): Promise<void>;
}

/** Starts Vite on a free port and a headless Chrome attached to it. */
export async function startSession(width = 1000, height = 700): Promise<Session> {
  const server: ViteDevServer = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite did not report a port");
  const chrome: ChildProcess = spawn(
    "google-chrome",
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "master-kit-"))}`,
      "--autoplay-policy=no-user-gesture-required",
      // Lets probes test window.open handoffs (headless closes popups otherwise).
      "--disable-popup-blocking",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cdp = await Cdp.connect(await pageTarget());
  await cdp.send("Runtime.enable");
  return {
    cdp,
    base: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      cdp.close();
      chrome.kill();
      await server.close();
    },
  };
}
