// The single offline font is embedded in styles.css, which Obsidian installs
// alongside main.js on desktop and mobile. Missing glyphs use the CSS fallback.
export const BUNDLED_FONT_FAMILIES = Object.freeze({
  zhuque: "QBR Zhuque Fangsong",
});

export async function ensureBundledReaderFont(doc, fontId) {
  if (fontId !== "zhuque" || !doc?.fonts) return false;
  try {
    const faces = await doc.fonts.load(`16px "${BUNDLED_FONT_FAMILIES.zhuque}"`);
    return faces.length > 0;
  } catch (error) {
    console.error("UV Reader: could not load the bundled font", error);
    return false;
  }
}
