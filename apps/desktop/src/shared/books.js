// Book extension whitelist for the desktop shell. Keep in sync with
// ENGINE_EXTENSIONS in src/reader-engine.js plus PDF. Standalone images open
// through the same reader via a one-page in-memory CBZ.
import { IMAGE_BOOK_EXTENSIONS } from "../../../../packages/reader/src/image-book.js";

export const BOOK_EXTENSIONS = Object.freeze([
  "epub",
  "fb2",
  "fbz",
  "mobi",
  "azw",
  "azw3",
  "cbz",
  "pdf",
  ...IMAGE_BOOK_EXTENSIONS,
]);

// Office/OpenDocument files are not parsed by the reader yet. They are handed
// to the operating system's default application instead, so a space or the
// open-file dialog can still open them without adding a document engine.
export const EXTERNAL_DOC_EXTENSIONS = Object.freeze([
  "doc", "docx", "docm", "odt", "rtf", "ofd",
  "xls", "xlsx", "ppt", "pptx", "csv",
]);

export function extensionOf(filePath) {
  const name = String(filePath || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isBookFile(filePath) {
  return BOOK_EXTENSIONS.includes(extensionOf(filePath));
}

export function isExternalDocFile(filePath) {
  return EXTERNAL_DOC_EXTENSIONS.includes(extensionOf(filePath));
}

export function isOpenableFile(filePath) {
  return isBookFile(filePath) || isExternalDocFile(filePath);
}
