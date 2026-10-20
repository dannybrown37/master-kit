/** Songs from MUSIC_DIR, served by the Vite dev server under /tracks/. */

export async function fetchTrack(name: string): Promise<ArrayBuffer> {
  const res = await fetch(`/tracks/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`could not load track "${name}" (${res.status})`);
  return res.arrayBuffer();
}
