// Reading order for saved highlights. Fixed-layout pages anchor by block and
// occurrence; engine formats anchor by CFI, compared by EPUB CFI position so
// the list follows the book instead of the order highlights were added.
import { compare as compareCfi } from "foliate-js/epubcfi.js";

export function compareHighlights(a, b) {
  const aBlock = Number.isInteger(a?.block);
  const bBlock = Number.isInteger(b?.block);
  if (aBlock && bBlock) return (a.block - b.block) || ((a.occ || 0) - (b.occ || 0));
  if (aBlock !== bBlock) return aBlock ? -1 : 1;
  if (a?.cfi && b?.cfi) {
    try { return compareCfi(a.cfi, b.cfi); } catch { return 0; }
  }
  return 0;
}

export function sortHighlightsByPosition(list) {
  return [...(list || [])].sort(compareHighlights);
}
