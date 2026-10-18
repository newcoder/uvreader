// 书坊:EPUB 3 构建器(单栏流式)。章节 HTML + 样式 + 字体 → 可在阅读器打开的 EPUB。
// 样式来自共享的 book-styles.js,预览与成品共用同一份 CSS,避免"预览好看、成品走样"。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { BOOK_STYLE_DEFAULTS, normalizeBookStyles, renderBookCss } from "../shared/book-styles.js";

export { BOOK_STYLE_DEFAULTS, normalizeBookStyles, renderBookCss };

export const IMAGE_MEDIA_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
});

// 章节 HTML 里的本地图片 → 收进 EPUB(相对 baseDir 解析),src 改成 images/<文件名>。
// 缺失或不支持的格式直接去掉该 <img>,避免成品里出现破图。
export function collectBookImages(chapters, { baseDir = "", log = () => {} } = {}) {
  const images = [];
  const byPath = new Map();
  const rewriteHtml = (html) => String(html || "").replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*?)>/gi, (whole, before, src, after) => {
    if (/^(https?:|data:|blob:)/i.test(src)) return whole;
    const resolved = path.isAbsolute(src) ? src : path.join(baseDir, String(src).replace(/[\\/]+/g, path.sep));
    const ext = path.extname(resolved).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType || !fs.existsSync(resolved)) {
      log("book image skipped", src);
      return "";
    }
    let entry = byPath.get(resolved);
    if (!entry) {
      const fileName = `image-${byPath.size + 1}${ext === ".jpeg" ? ".jpg" : ext}`;
      entry = { fileName, mediaType, data: fs.readFileSync(resolved) };
      byPath.set(resolved, entry);
      images.push(entry);
    }
    return `<img${before}src="images/${entry.fileName}"${after}>`;
  });
  const rewritten = (Array.isArray(chapters) ? chapters : []).map((chapter) => ({ ...chapter, html: rewriteHtml(chapter.html) }));
  return { chapters: rewritten, images };
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

// 平铺的(level, item)列表 → 树。导航的层级**必须**靠树的形状表达:
//   <li><a>第一章</a><ol><li><a>1.1</a></li></ol></li>
// 把子级 <ol> 写成上一个 <li> 的**兄弟**是非法结构,标准解析器(foliate/Calibre/ADE)
// 只认 ol 的直接 li 孩子,子级整片看不见 —— 用户实测「面板只有一级」就是这个原因。
function navTree(chapters) {
  const list = (Array.isArray(chapters) ? chapters : []).map((chapter) => ({
    title: String(chapter?.title || ""),
    file: String(chapter?.file || ""),
    level: Math.min(Math.max(Number(chapter?.level) || 1, 1), 3),
    children: [],
  }));
  const roots = [];
  const stack = [];
  for (const node of list) {
    while (stack.length >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function buildNav(chapters, title = "目录") {
  const lines = [];
  const render = (nodes, indent) => {
    for (const node of nodes) {
      if (!node.children.length) {
        lines.push(`${indent}<li><a href="${node.file}">${escapeXml(node.title)}</a></li>`);
        continue;
      }
      lines.push(`${indent}<li><a href="${node.file}">${escapeXml(node.title)}</a>`);
      lines.push(`${indent}  <ol>`);
      render(node.children, `${indent}    `);
      lines.push(`${indent}  </ol>`);
      lines.push(`${indent}</li>`);
    }
  };
  render(navTree(chapters), "      ");
  return xhtmlDocument({
    title,
    body: `<nav epub:type="toc" id="toc">\n      <h1>${escapeXml(title)}</h1>\n      <ol>\n${lines.join("\n")}\n      </ol>\n    </nav>`,
  });
}

export function buildNcx(chapters, { title, identifier }) {
  // NCX 也要支持层级(EPUB2 阅读器):子级 navPoint 写在**父条目的** navPoint 里 ——
  // 无标签的分组节点不合规,有些阅读器会把整组当成一条空目录。
  const points = [];
  let order = 0;
  const render = (nodes, indent) => {
    for (const node of nodes) {
      order += 1;
      points.push(`${indent}<navPoint id="navPoint-${order}" playOrder="${order}">`);
      points.push(`${indent}  <navLabel><text>${escapeXml(node.title)}</text></navLabel>`);
      points.push(`${indent}  <content src="${node.file}"/>`);
      render(node.children, `${indent}  `);
      points.push(`${indent}</navPoint>`);
    }
  };
  render(navTree(chapters), "    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${points.join("\n")}
  </navMap>
</ncx>
`;
}

export function buildOpf({ book, chapters, files, hasCover, hasColophon }) {
  const manifest = [];
  manifest.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  manifest.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifest.push(`    <item id="css" href="styles.css" media-type="text/css"/>`);
  for (const file of files) {
    const id = file.id || `img-${manifest.length}`;
    manifest.push(`    <item id="${escapeXml(id)}" href="${escapeXml(file.href)}" media-type="${escapeXml(file.mediaType)}"/>`);
  }
  chapters.forEach((chapter, index) => {
    manifest.push(`    <item id="chapter-${index + 1}" href="${escapeXml(chapter.file)}" media-type="application/xhtml+xml"/>`);
  });
  if (hasCover) manifest.push(`    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
  if (hasColophon) manifest.push(`    <item id="colophon" href="colophon.xhtml" media-type="application/xhtml+xml"/>`);
  const spine = [];
  if (hasCover) spine.push(`    <itemref idref="cover"/>`);
  // 目录文档**不进 spine**:进了 spine 就会被全文搜索当成正文索引(用户实测在正文里
  // 搜到整份目录、多级、位置还准),也会在阅读顺序/页码里多出一节。EPUB 3 阅读器
  // 从 manifest 的 properties="nav" 取目录,不需要它在 spine 里。
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

// 生成 EPUB(zip)。
export async function buildEpub({ book = {}, styles = {}, chapters = [], cover = null, images = [], colophon = "", nav = null } = {}, out) {
  if (!chapters.length) throw new Error("没有章节可写");
  const title = String(book.title || "未命名");
  const identifier = String(book.identifier || `urn:qbr:${Date.now().toString(36)}`);
  const modified = String(book.modified || new Date().toISOString().replace(/\.\d+Z$/, "Z"));
  const files = chapters.map((chapter, index) => ({
    ...chapter,
    file: `chapter-${String(index + 1).padStart(3, "0")}.xhtml`,
    title: String(chapter.title || `第 ${index + 1} 章`),
  }));

  const css = renderBookCss(styles);

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/styles.css", css);
  files.forEach((chapter) => {
    // 章节标题在分章时从正文里「吃掉」了:成书要把它当标题排版写回正文,
    // 否则标题只出现在导航里、翻到正文反而看不到(用户实测反馈)。
    const heading = String(chapter.title || "").trim() ? `<h1 class="chapter-title">${escapeXml(chapter.title)}</h1>\n` : "";
    zip.file(`OEBPS/${chapter.file}`, xhtmlDocument({ title: chapter.title, body: `${heading}${chapter.html}`, lang: book.language }));
  });
  const navItems = Array.isArray(nav) && nav.length ? nav : files;
  zip.file("OEBPS/nav.xhtml", buildNav(navItems));
  zip.file("OEBPS/toc.ncx", buildNcx(navItems, { title, identifier }));

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

  const colophonHtml = [colophon ? `<div>${colophon}</div>` : ""].filter(Boolean).join("\n");
  const hasColophon = Boolean(colophonHtml);
  if (hasColophon) {
    zip.file("OEBPS/colophon.xhtml", xhtmlDocument({ title: "版权与字体", body: `<h1>版权与字体</h1>\n${colophonHtml}`, lang: book.language }));
  }

  zip.file("OEBPS/content.opf", buildOpf({ book: { ...book, title, identifier, modified }, chapters: files, files: manifestFiles, hasCover, hasColophon }));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buffer);
  }
  return { out, bytes: buffer.length, chapters: files.length, hasCover, buffer };
}
