// Small, offline typographic covers shared by bundled editions and the library.
const PALETTES = [
  ["#dce7df", "#263f38"], ["#eee2cf", "#57432b"],
  ["#dce5ec", "#304655"], ["#e9dcd5", "#593d35"],
  ["#e4dfed", "#443b59"], ["#e8e7d5", "#45472e"],
];
const EDITIONS = ["道德经", "唐诗三百首", "Meditations", "Jekyll and Hyde", "Alice in Wonderland", "世说新语"];
const escapeXml = value => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const plain = value => String(value ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();

export function coverPalette(title) {
  const known = EDITIONS.indexOf(title);
  let hash = 0;
  for (const char of title) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return PALETTES[known < 0 ? hash % PALETTES.length : known];
}

export function coverAuthor(author) {
  if (Array.isArray(author)) return author.map(coverAuthor).filter(Boolean).join(" · ");
  return plain(typeof author === "object" && author ? author.name : author);
}

// Approximate glyph widths keep titles bounded without a canvas or font download.
function wrap(text, width, maxLines) {
  const lines = []; let line = "", used = 0;
  const measure = char => /[\u2e80-\uffff]/u.test(char) ? 1 : /[MW@]/.test(char) ? .85 : /[il.,' ]/.test(char) ? .28 : .56;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const size = measure(char);
    if (used + size > width && line) {
      const space = line.lastIndexOf(" ");
      const split = char !== " " && space > line.length / 3 ? space : line.length;
      lines.push(line.slice(0, split).trim()); line = line.slice(split).trim();
      used = Array.from(line).reduce((sum, c) => sum + measure(c), 0);
      if (lines.length === maxLines) {
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + "…";
        return lines;
      }
    }
    line += char; used += size;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function createBookCover({ title, author = "" }) {
  title = plain(title).slice(0, 500) || "Untitled";
  author = coverAuthor(author).slice(0, 200);
  const [paper, ink] = coverPalette(title);
  const titleLines = wrap(title, 7.5, 5);
  const authorLines = wrap(author, 17, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
<title>${escapeXml(title)}</title><rect width="600" height="900" fill="${paper}"/>
<path d="M32 0V900" stroke="${ink}" stroke-opacity=".12"/>
<path d="M64 96H126" stroke="${ink}" stroke-width="4"/>
<g fill="${ink}" font-family="Georgia, 'Songti SC', 'Noto Serif CJK SC', serif" font-size="60" font-weight="600">
${titleLines.map((line, i) => `<text x="64" y="${202 + i * 82}">${escapeXml(line)}</text>`).join("\n")}</g>
<g fill="${ink}" font-family="Georgia, 'Songti SC', serif" font-size="27">
${authorLines.map((line, i) => `<text x="66" y="${650 + i * 38}">${escapeXml(line)}</text>`).join("\n")}</g>
<circle cx="475" cy="873" r="145" fill="none" stroke="${ink}" stroke-opacity=".17" stroke-width="2"/>
<circle cx="475" cy="873" r="112" fill="none" stroke="${ink}" stroke-opacity=".12" stroke-width="2"/>
<path d="M64 800H242" stroke="${ink}" stroke-opacity=".25"/>
</svg>`;
}

// Recognize only our old fallback artwork, never arbitrary embedded SVG covers.
export function isGeneratedBookCover(svg) {
  return svg.includes('<circle cx="475" cy="873" r="145"') && svg.includes('<path d="M64 800H242"');
}

export function migrateCoverCache(cache, artworkVersion) {
  if (artworkVersion === 1) return cache;
  return Object.fromEntries(Object.entries(cache).filter(([, url]) => {
    if (typeof url !== "string" || !url.startsWith("data:image/svg+xml;base64,")) return true;
    try { return !isGeneratedBookCover(atob(url.split(",")[1])); }
    catch { return true; }
  }));
}
