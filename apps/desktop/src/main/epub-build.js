// 书坊:EPUB 3 构建器(单栏流式)。章节 HTML + 样式 + 字体 → 可在阅读器打开的 EPUB。
// 预览与成品共用 renderBookCss 生成的同一份 CSS,避免"预览好看、成品走样"。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

export const BOOK_STYLE_DEFAULTS = Object.freeze({
  fontSize: 17,
  lineHeight: 1.75,
  margin: 5,
  indent: 2,
  spacing: 0,
  align: "justify",
  theme: "follow",
  headingAlign: "left",
  bodyFont: "Georgia, 'Songti SC', serif",
  headingFont: "",
  latinFont: "",
  codeFont: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
});

// 主题:follow 不写颜色(交给阅读器);其余给出纸色/墨色。
const THEMES = Object.freeze({
  follow: { bg: "", fg: "", rule: "" },
  paper: { bg: "#ffffff", fg: "#1f1f1f", rule: "#e2e2e2" },
  warm: { bg: "#faf6ef", fg: "#3a3228", rule: "#e8dfd2" },
  celadon: { bg: "#f4f7f4", fg: "#26312b", rule: "#dde6dd" },
  night: { bg: "#1b1b1f", fg: "#d6d3cd", rule: "#3a3a40" },
});

export function normalizeBookStyles(styles = {}) {
  const merged = { ...BOOK_STYLE_DEFAULTS, ...(styles || {}) };
  merged.fontSize = Math.min(28, Math.max(12, Number(merged.fontSize) || BOOK_STYLE_DEFAULTS.fontSize));
  merged.lineHeight = Math.min(2.4, Math.max(1.2, Number(merged.lineHeight) || BOOK_STYLE_DEFAULTS.lineHeight));
  merged.margin = Math.min(12, Math.max(0, Number(merged.margin) ?? BOOK_STYLE_DEFAULTS.margin));
  merged.indent = Math.min(4, Math.max(0, Number(merged.indent) ?? BOOK_STYLE_DEFAULTS.indent));
  merged.spacing = Math.min(2, Math.max(0, Number(merged.spacing) || 0));
  merged.align = merged.align === "left" ? "left" : "justify";
  merged.headingAlign = merged.headingAlign === "center" ? "center" : "left";
  merged.theme = THEMES[merged.theme] ? merged.theme : "follow";
  return merged;
}

export function renderBookCss(styles = {}, { fontFaces = [] } = {}) {
  const s = normalizeBookStyles(styles);
  const theme = THEMES[s.theme];
  const faces = fontFaces
    .map((face) => `@font-face { font-family: '${face.family}'; src: url('${face.src}'); font-style: normal; font-weight: ${face.weight || 400}; font-display: swap; }`)
    .join("\n");
  const colorBlock = theme.bg
    ? `html, body { background: ${theme.bg}; color: ${theme.fg}; }\nhr { border-top-color: ${theme.rule}; }\n`
    : "";
  const headingFont = s.headingFont ? `${s.headingFont}, ` : "";
  const bodyFont = s.latinFont ? `${s.bodyFont}, ${s.latinFont}` : s.bodyFont;
  return `${faces ? `${faces}\n` : ""}/* 单栏流式排版:不写死宽度,交给阅读器分栏/分页 */
html { -webkit-text-size-adjust: 100%; }
${colorBlock}body {
  font-family: ${bodyFont};
  font-size: ${s.fontSize}px;
  line-height: ${s.lineHeight};
  margin: ${s.margin}%;
  text-align: ${s.align};
  word-wrap: break-word;
  -webkit-hyphens: none;
  hyphens: none;
}
p { margin: 0 0 ${s.spacing}em; text-indent: ${s.indent}em; }
h1 + p, h2 + p, h3 + p, h4 + p, hr + p, blockquote + p, figure + p, pre + p { text-indent: 0; }
h1, h2, h3, h4 { font-family: ${headingFont}inherit; line-height: 1.3; margin: 1.4em 0 .7em; text-align: ${s.headingAlign}; text-indent: 0; page-break-after: avoid; }
h1 { font-size: 1.6em; margin-top: 0; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; } h4 { font-size: 1em; }
blockquote { margin: 1em 0; padding: .2em 0 .2em 1em; border-left: 3px solid currentColor; opacity: .85; }
blockquote p { text-indent: 0; }
pre { font-family: ${s.codeFont}; font-size: .9em; line-height: 1.5; padding: .7em .9em; overflow-x: auto; border: 1px solid rgba(128,128,128,.25); border-radius: 4px; white-space: pre-wrap; }
code { font-family: ${s.codeFont}; font-size: .92em; }
pre code { font-size: 1em; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: .85em; opacity: .75; }
hr { border: 0; border-top: 1px solid rgba(128,128,128,.4); margin: 1.6em 0; }
a { color: inherit; text-decoration: underline; }
table { border-collapse: collapse; margin: 1em 0; font-size: .95em; }
th, td { border: 1px solid rgba(128,128,128,.35); padding: .3em .6em; }
`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xhtmlDocument({ title, body, lang = "zh", stylesheet = "styles.css" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="${stylesheet}"/>
</head>
<body>
${body}
</body>
</html>
`;
}

export function buildNav(chapters, title = "目录") {
  const items = chapters
    .map((chapter) => `      <li><a href="${chapter.file}">${escapeXml(chapter.title)}</a></li>`)
    .join("\n");
  return xhtmlDocument({
    title,
    body: `<nav epub:type="toc" id="toc">\n      <h1>${escapeXml(title)}</h1>\n      <ol>\n${items}\n      </ol>\n    </nav>`,
  });
}

export function buildNcx(chapters, { title, identifier }) {
  const points = chapters
    .map((chapter, index) => `    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(chapter.title)}</text></navLabel>
      <content src="${chapter.file}"/>
    </navPoint>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

export function buildOpf({ book, chapters, files, hasCover, fontFiles = [], hasColophon }) {
  const manifest = [];
  manifest.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  manifest.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifest.push(`    <item id="css" href="styles.css" media-type="text/css"/>`);
  for (const file of files) {
    const id = file.id || `img-${manifest.length}`;
    manifest.push(`    <item id="${escapeXml(id)}" href="${escapeXml(file.href)}" media-type="${escapeXml(file.mediaType)}"/>`);
  }
  for (const font of fontFiles) {
    manifest.push(`    <item id="${escapeXml(font.id)}" href="${escapeXml(font.href)}" media-type="${escapeXml(font.mediaType)}"/>`);
  }
  chapters.forEach((chapter, index) => {
    manifest.push(`    <item id="chapter-${index + 1}" href="${escapeXml(chapter.file)}" media-type="application/xhtml+xml"/>`);
  });
  if (hasCover) manifest.push(`    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
  if (hasColophon) manifest.push(`    <item id="colophon" href="colophon.xhtml" media-type="application/xhtml+xml"/>`);
  const spine = [];
  if (hasCover) spine.push(`    <itemref idref="cover"/>`);
  spine.push(`    <itemref idref="nav" linear="no"/>`);
  chapters.forEach((_chapter, index) => spine.push(`    <itemref idref="chapter-${index + 1}"/>`));
  if (hasColophon) spine.push(`    <itemref idref="colophon"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(book.language || "zh")}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(book.identifier)}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author || "")}</dc:creator>
    <dc:language>${escapeXml(book.language || "zh")}</dc:language>
    <meta property="dcterms:modified">${escapeXml(book.modified)}</meta>
${hasCover ? `    <meta name="cover" content="cover-image"/>\n` : ""}  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine toc="ncx">
${spine.join("\n")}
  </spine>
</package>
`;
}

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

// 生成 EPUB(zip);fonts: [{ path, family, fileName, licenseText, licenseName }]。
export async function buildEpub({ book = {}, styles = {}, chapters = [], fonts = [], cover = null, images = [], colophon = "" } = {}, out) {
  if (!chapters.length) throw new Error("没有章节可写");
  const title = String(book.title || "未命名");
  const identifier = String(book.identifier || `urn:qbr:${Date.now().toString(36)}`);
  const modified = String(book.modified || new Date().toISOString().replace(/\.\d+Z$/, "Z"));
  const files = chapters.map((chapter, index) => ({
    ...chapter,
    file: `chapter-${String(index + 1).padStart(3, "0")}.xhtml`,
    title: String(chapter.title || `第 ${index + 1} 章`),
  }));

  const fontFaces = fonts.map((font) => ({ family: font.family, src: `fonts/${font.fileName}`, weight: font.weight || 400 }));
  const css = renderBookCss(styles, { fontFaces });

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/styles.css", css);
  files.forEach((chapter) => {
    zip.file(`OEBPS/${chapter.file}`, xhtmlDocument({ title: chapter.title, body: chapter.html, lang: book.language }));
  });
  zip.file("OEBPS/nav.xhtml", buildNav(files));
  zip.file("OEBPS/toc.ncx", buildNcx(files, { title, identifier }));

  const manifestFiles = [];
  for (const image of images) {
    const entry = `images/${image.fileName}`;
    zip.file(`OEBPS/${entry}`, image.data);
    manifestFiles.push({ id: image.id || path.basename(image.fileName, path.extname(image.fileName)), href: entry, mediaType: image.mediaType || "image/jpeg" });
  }

  let hasCover = false;
  if (cover?.data) {
    const coverName = cover.fileName || "cover.jpg";
    zip.file(`OEBPS/images/${coverName}`, cover.data);
    manifestFiles.push({ id: "cover-image", href: `images/${coverName}`, mediaType: cover.mediaType || "image/jpeg" });
    zip.file("OEBPS/cover.xhtml", xhtmlDocument({
      title: "封面",
      body: `  <div style="margin:0;padding:0;text-align:center"><img src="images/${escapeXml(coverName)}" alt="${escapeXml(title)}" style="max-width:100%;height:auto;margin:0"/></div>`,
      lang: book.language,
    }));
    hasCover = true;
  }

  const fontFiles = [];
  fonts.forEach((font, index) => {
    const entry = `fonts/${font.fileName}`;
    const ext = path.extname(font.fileName).toLowerCase();
    zip.file(`OEBPS/${entry}`, font.data);
    fontFiles.push({ id: `font-${index + 1}`, href: entry, mediaType: ext === ".otf" ? "font/otf" : ext === ".woff2" ? "font/woff2" : "font/ttf" });
  });
  const licenses = fonts.filter((font) => font.licenseText);
  licenses.forEach((font, index) => {
    zip.file(`OEBPS/fonts/OFL-${index + 1}-${String(font.family || "font").replace(/[^\w.-]+/g, "-")}.txt`, String(font.licenseText));
  });

  const colophonHtml = [
    colophon ? `<div>${colophon}</div>` : "",
    licenses.length
      ? `<h2>字体许可</h2><ul>${licenses.map((font) => `<li>${escapeXml(font.family)}${font.licenseName ? `（${escapeXml(font.licenseName)}）` : ""}</li>`).join("")}</ul><p>本书嵌入了字体子集，授权文本见 EPUB 内 fonts/ 目录。</p>`
      : "",
  ].filter(Boolean).join("\n");
  const hasColophon = Boolean(colophonHtml);
  if (hasColophon) {
    zip.file("OEBPS/colophon.xhtml", xhtmlDocument({ title: "版权与字体", body: `<h1>版权与字体</h1>\n${colophonHtml}`, lang: book.language }));
  }

  zip.file("OEBPS/content.opf", buildOpf({ book: { ...book, title, identifier, modified }, chapters: files, files: manifestFiles, hasCover, fontFiles, hasColophon }));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buffer);
  }
  return { out, bytes: buffer.length, chapters: files.length, fonts: fonts.length, hasCover, buffer };
}
