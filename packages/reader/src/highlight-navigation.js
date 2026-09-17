// Encode parentheses too: raw CFI ranges otherwise terminate Markdown links.
const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function highlightBacklink(vault, book, highlight) {
  if (!book || !highlight) return "";
  const params = { vault, book };
  if (highlight.cfi) {
    if (highlight.id) params.highlight = highlight.id;
    params.cfi = highlight.cfi;
  } else if (Number.isInteger(highlight.block) && highlight.block >= 0) {
    if (highlight.id) params.highlight = highlight.id;
    params.block = highlight.block;
  } else if (Number.isInteger(highlight.page) && highlight.page > 0) params.page = highlight.page;
  else return "";
  return `obsidian://qiaomu-reader?${Object.entries(params).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${key}=${encode(value)}`).join("&")}`;
}

export async function jumpToEngineHighlight(view, highlight) {
  if (!highlight?.cfi || !view.engine) throw new Error("Highlight has no CFI");
  const engine = view.engine;
  await engine.goTo(highlight.cfi);
  if (view.engine !== engine || view._closed) return;
  if (highlight.id) await engine.addHighlight(highlight.id, highlight.cfi, highlight.color);
  (view.closePanel || view._closePanel)?.call(view);
  view._armImmersive?.();
}

// Upgrade only exact generated quote lines. User comments, edits, headings,
// existing links, and line endings are left byte-for-byte intact.
export function addMissingQuoteLinks(text, entries) {
  const links = new Map();
  for (const { quote, uri } of entries) {
    if (!uri) continue;
    // Identical excerpts at different locations are ambiguous; leave them alone.
    links.set(quote, links.has(quote) ? null : uri);
  }
  return String(text).replace(/^[^\r\n]+/gm, (line) => {
    const uri = links.get(line.trimEnd());
    return uri ? `${line.trimEnd()} [↩](${uri})${line.slice(line.trimEnd().length)}` : line;
  });
}
