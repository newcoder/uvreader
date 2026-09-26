// Scanned-PDF detection and the naming for the generated searchable copy.
// Pure helpers: the reader decides from per-page kinds whether the file needs
// an OCR text layer, and the derived file keeps its source name.

// Below this share of text pages a PDF is treated as scanned (or mostly
// scanned) and gets a generated text layer. A text book with a few image pages
// stays well above it; a scan with one digital table-of-contents page stays
// below.
export const PDF_SCAN_TEXT_RATIO = 0.25;

export function pdfScanVerdict(pageKinds, { total } = {}) {
  const kinds = Array.isArray(pageKinds) ? pageKinds : [];
  const pageCount = Number.isFinite(total) ? Number(total) : kinds.length;
  const textPages = kinds.filter((kind) => kind === "text").length;
  const scanned = pageCount > 0 && textPages / pageCount < PDF_SCAN_TEXT_RATIO;
  return { scanned, total: pageCount, textPages };
}

// "book.pdf" → "book.searchable.pdf"; the copy lives next to its source name so
// it stays recognisable in the file list.
export function searchablePdfName(name = "") {
  const base = String(name).trim().replace(/[\\/]+/g, "/").split("/").pop() || "";
  const stem = base.replace(/\.pdf$/i, "").trim() || "book";
  return `${stem}.searchable.pdf`;
}
