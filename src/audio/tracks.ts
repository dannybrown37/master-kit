/** Songs from MUSIC_DIR, served by the Vite dev server under /tracks/. */

export function trackUrl(name: string): string {
  return `${import.meta.env.BASE_URL}tracks/${encodeURIComponent(name)}`;
}

export async function fetchTrack(name: string): Promise<ArrayBuffer> {
  const res = await fetch(trackUrl(name));
  if (!res.ok) throw new Error(`could not load track "${name}" (${res.status})`);
  return res.arrayBuffer();
}
