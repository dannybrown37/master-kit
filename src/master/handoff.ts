/**
 * "Open in Music Shader" (contract v1 with music-shader): open the shader with ?handoff=1, wait for its ready
 * message from that window and origin, then post the original video and the master WAV once.
 */

export const HANDOFF_TIMEOUT_MS = 20_000;

const PROD = { master: "https://master.dannybrown.dev", shader: "https://shader.dannybrown.dev" };
const DEV_HOSTS = ["127.0.0.1", "localhost"];
const DEV_MASTER_PORT = "5174";
const DEV_SHADER_PORT = "5173";

/** Where music-shader lives for this master-kit origin; null hides the button. */
export function shaderOrigin(origin: string): string | null {
  if (origin === PROD.master) return PROD.shader;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !DEV_HOSTS.includes(url.hostname) || url.port !== DEV_MASTER_PORT || url.origin !== origin) return null;
  return `http://${url.hostname}:${DEV_SHADER_PORT}`;
}

export interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

export function isShaderReady(event: MessageLike, expectedOrigin: string, win: unknown): boolean {
  if (event.origin !== expectedOrigin || event.source === null || event.source !== win) return false;
  const d = event.data;
  if (typeof d !== "object" || d === null || Array.isArray(d)) return false;
  const msg = d as { type?: unknown; v?: unknown };
  return msg.type === "music-shader:ready" && msg.v === 1;
}

const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" };

/** For a video that came from the library (no File.type to keep); "" when unknown. */
export function videoMimeType(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (VIDEO_MIME[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

export interface HandoffMessage {
  type: "music-shader:handoff";
  v: 1;
  name: string;
  video: Blob;
  audio: Blob;
}

export function handoffMessage(name: string, video: Blob, audio: Blob): HandoffMessage {
  return { type: "music-shader:handoff", v: 1, name, video, audio };
}
