function readableStreamsSupportAsyncIteration() {
  if (typeof Symbol === "undefined" || !Symbol.asyncIterator) return false;
  if (typeof ReadableStream === "undefined") return true;
  return typeof ReadableStream.prototype?.[Symbol.asyncIterator] === "function";
}

/**
 * Read PDF.js text content without requiring ReadableStream async iteration.
 *
 * Safari 26.5 exposes ReadableStream but not Symbol.asyncIterator. PDF.js 6
 * uses `for await` in getTextContent(), so text extraction throws before the
 * first PDF page can open. Its public streamTextContent() reader API works on
 * the same browser and lets us aggregate the exact TextContent shape manually.
 */
export async function getPdfTextContent(page, params = {}) {
  if (page?.isPureXfa || typeof page?.streamTextContent !== "function" || readableStreamsSupportAsyncIteration()) {
    return page.getTextContent(params);
  }

  const reader = page.streamTextContent(params).getReader();
  const textContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      textContent.lang ??= value.lang;
      Object.assign(textContent.styles, value.styles);
      textContent.items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
  return textContent;
}
