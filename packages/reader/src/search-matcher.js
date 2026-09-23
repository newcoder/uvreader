// Search matcher for the reader engine. Foliate's matcher compares code points
// directly, so a simplified query never finds traditional text (and the other
// way around). This matcher normalizes the query and every walked string to the
// same form for comparison while reading the excerpt from the original text,
// which keeps the book's own characters in the result list. Normalization is
// one character per character, so the ranges map back exactly.
import { search as searchText } from "foliate-js/search.js";
import { textWalker } from "foliate-js/text-walker.js";

import { normalizeHanzi } from "./hanzi-normalize.js";

const CONTEXT_LENGTH = 50;
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ");

// Same excerpt shape as foliate-js/search.js, built from the original strings.
function makeExcerpt(strs, { startIndex, startOffset, endIndex, endOffset }) {
  const start = strs[startIndex];
  const end = strs[endIndex];
  const match = start === end
    ? start.slice(startOffset, endOffset)
    : start.slice(startOffset) + strs.slice(startIndex + 1, endIndex).join("") + end.slice(0, endOffset);
  const trimmedStart = normalizeWhitespace(start.slice(0, startOffset)).trimStart();
  const trimmedEnd = normalizeWhitespace(end.slice(endOffset)).trimEnd();
  const pre = `${trimmedStart.length < CONTEXT_LENGTH ? "" : "…"}${trimmedStart.slice(-CONTEXT_LENGTH)}`;
  const post = `${trimmedEnd.slice(0, CONTEXT_LENGTH)}${trimmedEnd.length < CONTEXT_LENGTH ? "" : "…"}`;
  return { pre, match, post };
}

export function createHanziSearchMatcher(opts = {}) {
  const { defaultLocale, matchCase, matchDiacritics, matchWholeWords } = opts;
  return function* (doc, query) {
    const needle = normalizeHanzi(query);
    const iter = textWalker(doc, function* (strs, makeRange) {
      const haystack = strs.map(normalizeHanzi);
      for (const result of searchText(haystack, needle, {
        locales: doc.body?.lang || doc.documentElement?.lang || defaultLocale || "en",
        granularity: matchWholeWords ? "word" : "grapheme",
        sensitivity: matchDiacritics && matchCase ? "variant"
          : matchDiacritics && !matchCase ? "accent"
          : !matchDiacritics && matchCase ? "case"
          : "base",
      })) {
        const { startIndex, startOffset, endIndex, endOffset } = result.range;
        yield {
          range: makeRange(startIndex, startOffset, endIndex, endOffset),
          excerpt: makeExcerpt(strs, result.range),
        };
      }
    });
    for (const result of iter) yield result;
  };
}
