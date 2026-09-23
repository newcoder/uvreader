// Traditional and variant characters normalize to the covered form used by the
// glossaries. One character in, one character out, so the offsets of DOM Ranges
// and search highlights stay valid.
import { HANZI_TRADITIONAL, HANZI_VARIANTS } from "./hanzi-dict-data.js";

export function normalizeHanzi(text) {
  const value = String(text || "");
  let out = "";
  let changed = false;
  for (const char of value) {
    const mapped = HANZI_TRADITIONAL[char] || HANZI_VARIANTS[char];
    if (mapped) {
      out += mapped;
      changed = true;
    } else {
      out += char;
    }
  }
  return changed ? out : value;
}
