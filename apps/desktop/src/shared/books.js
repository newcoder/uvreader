// Book extension whitelist for the desktop shell. Keep in sync with
// ENGINE_EXTENSIONS in src/reader-engine.js plus PDF.
export const BOOK_EXTENSIONS = Object.freeze([
  "epub",
  "fb2",
  "fbz",
  "mobi",
  "azw",
  "azw3",
  "cbz",
  "pdf",
]);

export function extensionOf(filePath) {
  const name = String(filePath || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isBookFile(filePath) {
  return BOOK_EXTENSIONS.includes(extensionOf(filePath));
}
