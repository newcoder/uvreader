// 书坊:EPUB 3 构建器(单栏流式)。章节 HTML + 样式 + 字体 → 可在阅读器打开的 EPUB。
// 样式来自共享的 book-styles.js,预览与成品共用同一份 CSS,避免"预览好看、成品走样"。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { BOOK_STYLE_DEFAULTS, BOOK_THEMES, normalizeBookStyles, renderBookCss } from "../shared/book-styles.js";

export { BOOK_STYLE_DEFAULTS, BOOK_THEMES, normalizeBookStyles, renderBookCss };

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
