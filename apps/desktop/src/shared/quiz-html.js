// Generated quiz pages can carry Temml's red parse-error span when a model
// emitted a mismatched dollar delimiter. Both the builder and the viewer need
// to recover the readable text, so keep the cleanup in one shared place.

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function cleanTemmlErrors(html) {
  return String(html || "").replace(
    /<span\b[^>]*\bclass\s*=\s*(?:"[^"]*\btemml-error\b[^"]*"|'[^']*\btemml-error\b[^']*')[^>]*>([\s\S]*?)<\/span>/gi,
    (full, content) => escapeHtml(
      String(content).split(/ParseError:/i)[0].trim().replace(/\$/g, ""),
    ),
  );
}
