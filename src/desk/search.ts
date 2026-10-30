/** Command palette matching, ported from idiom's site search (src/lib/search.ts). */

export interface SearchEntry {
  id: string;
  title: string;
  group: string;
  /** Extra words that should find this entry. */
  terms?: string;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Every query word must start some word of the entry. Ranked: title starts with the whole query,
 * then title words cover the query, then the rest (group or extra terms). Ties keep input order.
 */
export function search<T extends SearchEntry>(entries: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  const parts = words(q);
  const covers = (haystack: string[]): boolean => parts.every((part) => haystack.some((word) => word.startsWith(part)));
  const ranked: [number, T][] = [];
  for (const entry of entries) {
    const title = words(entry.title);
    if (!covers([...title, ...words(entry.group), ...words(entry.terms ?? "")])) continue;
    ranked.push([entry.title.toLowerCase().startsWith(q) ? 0 : covers(title) ? 1 : 2, entry]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
}
