// Offsets always refer to the original UTF-16 text used by DOM Range.
import { normalizeHanzi } from "./hanzi-normalize.js";

export function searchableQuery(query) {
  const q = String(query || "").trim();
  return q.length >= 2 || /\p{Script=Han}/u.test(q) ? q : "";
}

// Simplified and traditional forms compare as the same words. Matching runs on
// the normalized text while the reported hit, pre and post come from the
// original block, and normalization is one character per character, so the
// offsets stay valid for the DOM Range.
export function searchBookBlocks(blocks, query, limit = 300) {
  const q = searchableQuery(query);
  if (!q || limit <= 0) return [];
  const needle = normalizeHanzi(q);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  const hits = [];
  for (let block = 0; block < blocks.length && hits.length < limit; block++) {
    const text = String(blocks[block] || "");
    const haystack = normalizeHanzi(text);
    pattern.lastIndex = 0;
    let match;
    while (hits.length < limit && (match = pattern.exec(haystack))) {
      const offset = match.index, end = offset + match[0].length;
      const start = Math.max(0, offset - 45), stop = Math.min(text.length, end + 55);
      hits.push({ block, offset, hit: text.slice(offset, end), pre: (start ? "…" : "") + text.slice(start, offset), post: text.slice(end, stop) + (stop < text.length ? "…" : "") });
    }
  }
  return hits;
}

export function nextSearchIndex(current, direction, count) {
  if (!count) return -1;
  if (current < 0) return direction < 0 ? count - 1 : 0;
  return (current + direction + count) % count;
}
