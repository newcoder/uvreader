// Writes a generated navigation into a *copy* of an EPUB. The reader's
// generated TOC normally lives in derived/toc.json; other reading apps cannot
// see that file. This module edits the OPF/nav/NCX and adds stable anchors to
// the copied XHTML, leaving the original book and its reading record untouched.
import JSZip from "jszip";
import { matchTocTitles } from "./epub-toc.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const EPUB_NS = "http://www.idpf.org/2007/ops";
const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/";

function directoryOf(filePath) {
  const value = String(filePath || "");
  const slash = value.lastIndexOf("/");
  return slash < 0 ? "" : value.slice(0, slash);
}

function normalizeZipPath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function zipPath(directory, href) {
  return normalizeZipPath(`${directory ? `${directory}/` : ""}${decodeURI(String(href || ""))}`);
}

function relativePath(fromFile, targetFile) {
  const from = directoryOf(fromFile).split("/").filter(Boolean);
  const target = String(targetFile || "").split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  const up = Array.from({ length: from.length - common }, () => "..");
  return [...up, ...target.slice(common)].join("/");
}

function hrefFor(fromFile, target) {
  const value = String(target || "").trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const [path, ...fragment] = value.split("#");
  const relative = relativePath(fromFile, normalizeZipPath(path));
  return fragment.length ? `${relative}#${fragment.join("#")}` : relative;
}

function parseDocument(text, Parser, mime = "application/xml") {
  const parser = Parser || globalThis.DOMParser;
  if (!parser) throw new Error("当前环境不支持解析 EPUB");
  const doc = new parser().parseFromString(String(text || ""), mime);
  if (mime !== "text/html" && doc?.querySelector?.("parsererror")) {
    return new parser().parseFromString(String(text || ""), "text/html");
  }
  return doc;
}

function serializeDocument(doc, original, Serializer) {
  const serializer = Serializer || globalThis.XMLSerializer;
  if (!serializer) throw new Error("当前环境不支持写入 EPUB");
  const declaration = String(original || "").match(/^\s*<\?xml[^>]*\?>\s*/i)?.[0] || "";
  // Chromium's XMLSerializer keeps an existing XML declaration, while some
  // DOM implementations do not. Strip it from the body before adding the
  // original one back so the copied nav/NCX never starts with two declarations
  // (which strict reading apps reject as malformed XML).
  const body = new serializer().serializeToString(doc).replace(/^\s*<\?xml[^>]*\?>\s*/i, "");
  return `${declaration}${body}`;
}

function readZipText(zip, path) {
  const file = zip.file(path);
  return file ? file.async("string") : Promise.resolve("");
}

async function spineSections(zip, opfDoc, opfPath, parser) {
  const items = new Map(manifestItems(opfDoc)
    .map((item) => [item.getAttribute("id"), item])
    .filter(([id]) => id));
  const sections = [];
  for (const itemref of findElements(opfDoc, "itemref")) {
    const item = items.get(itemref.getAttribute("idref"));
    if (!item) continue;
    const path = itemPath(opfPath, item);
    const mediaType = String(item.getAttribute("media-type") || "");
    if (!path || (!/xhtml|html/i.test(mediaType) && !/\.x?html?$/i.test(path))) continue;
    const text = await readZipText(zip, path);
    if (!text) continue;
    sections.push({
      index: sections.length,
      id: path,
      doc: parseDocument(text, parser, "application/xhtml+xml"),
    });
  }
  return sections;
}

function findElements(doc, localName) {
  return [...doc.getElementsByTagNameNS("*", localName)];
}

function findOpfPath(zip, parser) {
  return readZipText(zip, "META-INF/container.xml").then((text) => {
    if (text) {
      const doc = parseDocument(text, parser);
      const rootfile = findElements(doc, "rootfile")[0];
      const fullPath = rootfile?.getAttribute("full-path");
      if (fullPath) return normalizeZipPath(fullPath);
    }
    return Object.keys(zip.files).find((name) => /\.opf$/i.test(name)) || "";
  });
}

function manifestItems(opfDoc) {
  return findElements(opfDoc, "item");
}

function itemPath(opfPath, item) {
  const href = item?.getAttribute?.("href");
  return href ? zipPath(directoryOf(opfPath), href) : "";
}

function serializeXhtml(doc, original, serializer) {
  return serializeDocument(doc, original, serializer);
}

function resolveAnchor(doc, entry) {
  const path = Array.isArray(entry.anchorPath) ? entry.anchorPath : [];
  let node = doc.documentElement;
  for (const index of path) {
    node = node?.children?.[Number(index)];
    if (!node) break;
  }
  if (node && entry.anchorText) {
    const expected = String(entry.anchorText).replace(/\s+/g, " ").trim().toLowerCase();
    const actual = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (expected && actual && !actual.startsWith(expected) && !expected.startsWith(actual)) node = null;
  }
  if (node) return node;
  const wanted = String(entry.anchorText || entry.title || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted) return null;
  for (const el of doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,div")) {
    const text = String(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text === wanted || (wanted.length >= 12 && text.startsWith(`${wanted} `))) return el;
  }
  return null;
}

function uniqueAnchorId(doc, preferred, index) {
  const base = String(preferred || `qbr-toc-${index + 1}`).replace(/[^\w:.-]+/g, "-") || `qbr-toc-${index + 1}`;
  let id = base;
  let suffix = 1;
  while (doc.getElementById?.(id)) id = `${base}-${suffix++}`;
  return id;
}

function addNavToOpf(opfDoc, opfPath, navPath) {
  const manifest = findElements(opfDoc, "manifest")[0];
  if (!manifest) return false;
  const id = "qbr-toc-nav";
  if (manifestItems(opfDoc).some((item) => item.getAttribute("id") === id)) return true;
  const item = opfDoc.createElementNS(opfDoc.documentElement.namespaceURI || "", "item");
  item.setAttribute("id", id);
  item.setAttribute("href", relativePath(opfPath, navPath));
  item.setAttribute("media-type", "application/xhtml+xml");
  item.setAttribute("properties", "nav");
  manifest.appendChild(item);
  return true;
}

function replaceNav(doc, entries, navPath) {
  const navs = findElements(doc, "nav");
  let tocNav = navs.find((nav) => {
    const type = nav.getAttributeNS?.(EPUB_NS, "type") || nav.getAttribute("epub:type") || "";
    return type.split(/\s+/).includes("toc");
  }) || navs[0] || null;
  if (!tocNav) {
    const body = findElements(doc, "body")[0] || doc.documentElement;
    tocNav = doc.createElementNS(XHTML_NS, "nav");
    tocNav.setAttributeNS(EPUB_NS, "epub:type", "toc");
    body.appendChild(tocNav);
  }
  for (const old of [...tocNav.children]) {
    if (String(old.localName || old.tagName).toLowerCase() === "ol") old.remove();
  }
  const list = doc.createElementNS(XHTML_NS, "ol");
  for (const entry of entries) {
    const li = doc.createElementNS(XHTML_NS, "li");
    const a = doc.createElementNS(XHTML_NS, "a");
    a.setAttribute("href", hrefFor(navPath, entry.target));
    a.textContent = String(entry.label || entry.title || "");
    li.appendChild(a);
    list.appendChild(li);
  }
  tocNav.appendChild(list);
}

function replaceNcx(doc, entries, ncxPath) {
  const navMap = findElements(doc, "navMap")[0];
  if (!navMap) return;
  navMap.replaceChildren();
  entries.forEach((entry, index) => {
    const point = doc.createElementNS(NCX_NS, "navPoint");
    point.setAttribute("id", `navPoint-${index + 1}`);
    point.setAttribute("playOrder", String(index + 1));
    const label = doc.createElementNS(NCX_NS, "navLabel");
    const text = doc.createElementNS(NCX_NS, "text");
    text.textContent = String(entry.label || entry.title || "");
    label.appendChild(text);
    const content = doc.createElementNS(NCX_NS, "content");
    content.setAttribute("src", hrefFor(ncxPath, entry.target));
    point.append(label, content);
    navMap.appendChild(point);
  });
}

// The source is an EPUB produced from another format (currently AZW3 through
// Calibre). Its section paths and anchors differ from the original book, so
// find the generated chapter titles in the converted spine before writing the
// portable nav/NCX.
export async function buildNavigationEpubFromTitles(bytes, entries, {
  parser = globalThis.DOMParser,
  serializer = globalThis.XMLSerializer,
} = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const opfPath = await findOpfPath(zip, parser);
  if (!opfPath) throw new Error("转换后的 EPUB 没有找到内容清单（OPF）");
  const opfText = await readZipText(zip, opfPath);
  const opfDoc = parseDocument(opfText, parser);
  const sections = await spineSections(zip, opfDoc, opfPath, parser);
  if (!sections.length) throw new Error("转换后的 EPUB 没有可读取的章节");
  const matched = matchTocTitles(sections, entries);
  if (!matched.length) throw new Error("转换后的 EPUB 中没有找到目录标题对应的正文位置");
  return buildNavigationEpub(bytes, matched, { parser, serializer });
}

// Returns a new EPUB byte array. Original bytes and the caller's entries are
// never mutated.
export async function buildNavigationEpub(bytes, entries, {
  parser = globalThis.DOMParser,
  serializer = globalThis.XMLSerializer,
} = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (entry.label || entry.title));
  if (!list.length) throw new Error("没有可写入的目录条目");
  const zip = await JSZip.loadAsync(bytes);
  const opfPath = await findOpfPath(zip, parser);
  if (!opfPath) throw new Error("这本书没有找到 EPUB 内容清单（OPF）");
  const opfText = await readZipText(zip, opfPath);
  const opfDoc = parseDocument(opfText, parser);
  const items = manifestItems(opfDoc);
  let navPath = items
    .filter((item) => String(item.getAttribute("properties") || "").split(/\s+/).includes("nav"))
    .map((item) => itemPath(opfPath, item))[0] || "";
  if (!navPath) {
    const named = items.find((item) => /(^|\/)nav\.xhtml?$/i.test(String(item.getAttribute("href") || "")));
    navPath = itemPath(opfPath, named) || "";
  }
  const ncxPath = items
    .filter((item) => item.getAttribute("media-type") === "application/x-dtbncx+xml" || item.getAttribute("id") === "ncx")
    .map((item) => itemPath(opfPath, item))[0] || "";
  const createdNav = !navPath;
  if (createdNav) navPath = normalizeZipPath(`${directoryOf(opfPath) || ""}/nav.xhtml`);
  const targets = [];
  const modifiedSections = new Map();
  for (const [index, entry] of list.entries()) {
    const item = { ...entry, label: entry.label || entry.title, target: entry.target || entry.href || "" };
    if (entry.sectionId && Array.isArray(entry.anchorPath)) {
      const sectionPath = normalizeZipPath(entry.sectionId);
      const file = zip.file(sectionPath);
      if (file) {
        // Load once; several entries commonly point into the same XHTML file.
        let current = modifiedSections.get(sectionPath);
        if (!current) {
          current = { original: await file.async("string"), doc: null };
          modifiedSections.set(sectionPath, current);
        }
        current.doc ||= parseDocument(current.original, parser, "application/xhtml+xml");
        const el = resolveAnchor(current.doc, entry);
        if (el) {
          let id = String(el.getAttribute("id") || "").trim();
          if (!id) {
            id = uniqueAnchorId(current.doc, entry.anchorId, index);
            el.setAttribute("id", id);
          }
          item.target = `${sectionPath}#${id}`;
        }
      }
    }
    targets.push(item);
  }
  if (!targets.some((entry) => entry.target)) throw new Error("目录条目没有可写入的章节位置");
  for (const [path, current] of modifiedSections) {
    if (current?.doc) zip.file(path, serializeXhtml(current.doc, current.original, serializer));
  }
  if (createdNav) {
    // Make the new nav discoverable in EPUB3 readers.
    addNavToOpf(opfDoc, opfPath, navPath);
    zip.file(opfPath, serializeDocument(opfDoc, opfText, serializer));
  }
  let navText = await readZipText(zip, navPath);
  if (!navText) navText = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}"><head><title>Contents</title></head><body></body></html>`;
  const navDoc = parseDocument(navText, parser, "application/xhtml+xml");
  replaceNav(navDoc, targets, navPath);
  zip.file(navPath, serializeXhtml(navDoc, navText, serializer));
  if (ncxPath) {
    const ncxText = await readZipText(zip, ncxPath);
    if (ncxText) {
      const ncxDoc = parseDocument(ncxText, parser);
      replaceNcx(ncxDoc, targets, ncxPath);
      zip.file(ncxPath, serializeDocument(ncxDoc, ncxText, serializer));
    }
  }
  // A new JSZip keeps mimetype first and uncompressed; that is required by the
  // EPUB container spec and avoids relying on JSZip's handling of an edited
  // archive.
  const out = new JSZip();
  out.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const [name, file] of Object.entries(zip.files)) {
    if (name === "mimetype" || name === navPath) continue;
    if (file.dir) out.folder(name);
    else out.file(name, await file.async("uint8array"), { compression: "DEFLATE", date: file.date });
  }
  if (!out.file(navPath)) {
    // The nav may have been added to `zip` above after the copy loop was
    // enumerated; write it explicitly.
  }
  out.file(navPath, await zip.file(navPath).async("uint8array"), { compression: "DEFLATE" });
  return out.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: "application/epub+zip",
    platform: "UNIX",
  });
}
