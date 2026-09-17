export const READER_BLOCK_SELECTOR = "p,h1,h2,h3,h4,.qiaomu-reader-pdf-text-layer";
export const PDF_AI_CONTEXT_MAX_CHARS = 180_000;

export function pdfPageKind(textLength, textLooksUnreadable = false) {
  return textLength > 0 && !textLooksUnreadable ? "text" : "scan";
}

export function pdfPageTextForAi(items) {
  const lines = [];
  let line = "";
  for (const item of Array.isArray(items) ? items : []) {
    const value = typeof item?.str === "string" ? item.str.replace(/\s+/g, " ").trim() : "";
    if (!value) continue;
    line += `${line ? " " : ""}${value}`;
    if (item.hasEOL) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Keep searchable text for pages that are not visible without constructing a
// positioned PDF.js TextLayer for the whole document. A full TextLayer can
// contain hundreds of spans per page and is created only when the page enters
// the reader viewport.
export function pdfPageTextFallback(items) {
  let text = "";
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.str !== "string") continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.trim();
}

export function packPdfDocumentContext(pages, maxChars = PDF_AI_CONTEXT_MAX_CHARS) {
  const clean = (Array.isArray(pages) ? pages : []).map((page, index) => ({
    page: positiveInt(page?.page, index + 1),
    text: String(page?.text || "").trim(),
  })).filter((page) => page.text);
  if (!clean.length) return { text: "", pageCount: 0, sourceChars: 0, truncated: false };

  const sourceChars = clean.reduce((total, page) => total + page.text.length, 0);
  const render = (page, text) => `[第 ${page.page} 页]\n${text}`;
  const budget = Math.max(1_000, Math.round(Number(maxChars) || PDF_AI_CONTEXT_MAX_CHARS));
  const headers = clean.reduce((total, page) => total + render(page, "").length + 2, 0);
  if (sourceChars + headers <= budget) {
    return { text: clean.map((page) => render(page, page.text)).join("\n\n"), pageCount: clean.length, sourceChars, truncated: false };
  }

  // Keep every text-bearing page represented when a very large PDF exceeds a
  // model-safe first-turn payload. Even sampling is more useful for whole-book
  // questions than silently cutting off the second half of the document.
  const perPage = Math.max(1, Math.floor((budget - headers) / clean.length));
  const packed = clean.map((page) => {
    const text = page.text.length > perPage ? `${page.text.slice(0, Math.max(1, perPage - 1)).trimEnd()}…` : page.text;
    return render(page, text);
  }).join("\n\n").slice(0, budget);
  return { text: packed, pageCount: clean.length, sourceChars, truncated: true };
}

function positiveInt(value, fallback = 1) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Build the trusted shell for one fixed-layout PDF page.
 *
 * `textLayerHtml` is produced by PDF.js TextLayer from escaped text nodes; the
 * original PDF never gets to provide HTML attributes or executable markup.
 */
export function pdfPageShell({
  pageNumber,
  width,
  height,
  kind,
  isLast = false,
  textLayerHtml = "",
  textFallback = "",
}) {
  const page = positiveInt(pageNumber);
  const pageWidth = positiveInt(width);
  const pageHeight = positiveInt(height);
  const pageKind = kind === "text" ? "text" : "scan";
  const lastClass = isLast ? " qiaomu-reader-pdf-last-page" : "";
  const escapedFallback = String(textFallback || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const textLayer = pageKind !== "text" ? "" : textLayerHtml
    || `<div class="qiaomu-reader-pdf-text-layer qiaomu-reader-pdf-text-placeholder" data-pdf-selectable="false">${escapedFallback}</div>`;
  return `<div class="qiaomu-reader-pdf-page-break qiaomu-reader-pdf-${pageKind}-page${lastClass}" data-pdf-page-no="${page}" data-pdf-page-kind="${pageKind}">`
    + `<figure class="qiaomu-reader-pdf-native-page">`
    + `<div class="qiaomu-reader-pdf-page-surface" data-pdf-width="${pageWidth}" data-pdf-height="${pageHeight}">`
    + `<img class="qiaomu-reader-pdf-page-img qiaomu-reader-pdf-lazy" data-pdf-page="${page}" width="${pageWidth}" height="${pageHeight}" alt="">`
    + textLayer
    + `</div></figure></div>`;
}
