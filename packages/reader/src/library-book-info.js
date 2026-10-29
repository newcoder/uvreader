// Bibliographic metadata for AI library tagging. Only the OPF/PDF metadata is
// read here; book text stays out of the request.
import JSZip from "jszip";

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const value = parseInt(code, 16);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

function elementText(xml, name) {
  const match = String(xml || "").match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function elementTexts(xml, name) {
  const result = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, "gi");
  for (const match of String(xml || "").matchAll(re)) {
    const value = decodeXml(match[1]);
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function attribute(xml, name) {
  const match = String(xml || "").match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function metaContent(xml, property) {
  const re = /<meta\b[^>]*>/gi;
  for (const match of String(xml || "").matchAll(re)) {
    const tag = match[0];
    if (attribute(tag, "property").toLowerCase() !== property.toLowerCase()) continue;
    const value = attribute(tag, "content");
    if (value) return value;
  }
  return "";
}

function trim(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeZipPath(value) {
  const parts = [];
  for (const part of String(value || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function htmlExcerpt(html) {
  return decodeXml(String(html || "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " "));
}

function opfItems(opf) {
  const manifest = new Map();
  for (const match of String(opf || "").matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = attribute(tag, "id");
    const href = attribute(tag, "href");
    if (id && href) manifest.set(id, { href, mediaType: attribute(tag, "media-type").toLowerCase() });
  }
  const spine = [];
  for (const match of String(opf || "").matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attribute(match[0], "idref");
    if (idref) spine.push(idref);
  }
  return { manifest, spine };
}

// Read title/creator/description/subjects from an EPUB without opening a
// chapter. `includeExcerpt` is an explicit opt-in; it reads only the first few
// spine documents and returns a short plain-text opening. Malformed containers
// simply yield an empty object; the caller falls back to the file name.
export async function readEpubDetails(bytes, { includeExcerpt = false, maxChars = 800 } = {}) {
  const zip = await JSZip.loadAsync(bytes);
  let opfPath = "";
  const container = zip.file("META-INF/container.xml");
  if (container) {
    const xml = await container.async("string");
    const rootfile = String(xml).match(/<rootfile\b[^>]*>/i)?.[0] || "";
    opfPath = attribute(rootfile, "full-path").replace(/^\/+/, "");
  }
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find((name) => /\.opf$/i.test(name)) || "";
  }
  if (!opfPath) return {};
  const entry = zip.file(opfPath);
  if (!entry) return {};
  const opf = await entry.async("string");
  const title = elementText(opf, "title");
  const authors = elementTexts(opf, "creator");
  const description = elementText(opf, "description") || metaContent(opf, "dcterms:description");
  const subjects = elementTexts(opf, "subject");
  const info = {
    title: trim(title, 200),
    author: trim(authors.join(" / "), 160),
    description: trim(description, 800),
    subjects: trim(subjects.join(" / "), 200),
  };
  if (!includeExcerpt) return info;

  const { manifest, spine } = opfItems(opf);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const candidates = spine
    .map((id) => manifest.get(id))
    .filter((item) => item && /xhtml|html/i.test(item.mediaType || ""));
  if (!candidates.length) {
    for (const item of manifest.values()) {
      if (/xhtml|html/i.test(item.mediaType || "")) candidates.push(item);
    }
  }
  const parts = [];
  let length = 0;
  for (const item of candidates.slice(0, 4)) {
    if (length >= maxChars) break;
    const href = String(item.href || "").split("#")[0];
    const file = zip.file(normalizeZipPath(`${base}${href}`));
    if (!file) continue;
    const text = htmlExcerpt(await file.async("string"));
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return { ...info, excerpt: trim(parts.join(" "), maxChars) };
}

export async function readEpubInfo(bytes) {
  return readEpubDetails(bytes);
}

export async function readEpubExcerpt(bytes, { maxChars = 800 } = {}) {
  const details = await readEpubDetails(bytes, { includeExcerpt: true, maxChars });
  return String(details.excerpt || "");
}
