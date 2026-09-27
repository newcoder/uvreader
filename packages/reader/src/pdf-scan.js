// Scanned-PDF detection and the naming for the generated searchable copy.
// Pure helpers: the reader decides from per-page kinds whether the file needs
// an OCR text layer, and the derived file keeps its source name.

// Below this share of text pages a PDF is treated as scanned (or mostly
// scanned) and gets a generated text layer. A text book with a few image pages
// stays well above it; a scan with one digital table-of-contents page stays
// below.
export const PDF_SCAN_TEXT_RATIO = 0.25;

// A page only counts as carrying a text layer when it has this much text. Scans
// often ship a tiny watermark (a URL or page number, a few characters), which
// would otherwise make every page look digital and skip the OCR pass.
export const PDF_SCAN_MIN_TEXT_CHARS = 40;

export function pdfScanPageKind(text) {
  return String(text || "").length >= PDF_SCAN_MIN_TEXT_CHARS ? "text" : "scan";
}

export function pdfScanVerdict(pageKinds, { total } = {}) {
  const kinds = Array.isArray(pageKinds) ? pageKinds : [];
  const pageCount = Number.isFinite(total) ? Number(total) : kinds.length;
  const textPages = kinds.filter((kind) => kind === "text").length;
  const scanned = pageCount > 0 && textPages / pageCount < PDF_SCAN_TEXT_RATIO;
  return { scanned, total: pageCount, textPages };
}

// "book.pdf" → "book_text.pdf": the original name stays untouched and a
// converted copy is recognisable next to it.
export function searchablePdfName(name = "") {
  const base = String(name).trim().replace(/[\\/]+/g, "/").split("/").pop() || "";
  const stem = base.replace(/\.pdf$/i, "").trim() || "book";
  return `${stem}_text.pdf`;
}
