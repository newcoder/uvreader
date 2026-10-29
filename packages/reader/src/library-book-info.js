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

// Read title/creator/description/subjects from an EPUB without opening a
// chapter. Malformed containers simply yield an empty object; the caller falls
// back to the file name.
export async function readEpubInfo(bytes) {
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
  return {
    title: trim(title, 200),
    author: trim(authors.join(" / "), 160),
    description: trim(description, 800),
    subjects: trim(subjects.join(" / "), 200),
  };
}
