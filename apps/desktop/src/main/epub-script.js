// Direct Simplified/Traditional conversion for EPUB sources. The regular
// book builder extracts text and rebuilds the book, which cannot preserve
// poetry line breaks or the original chapter files. This path keeps every
// XHTML/CSS/image/nav file and converts only text nodes.
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { convertChineseScript } from "./book-script.js";
import { appendTranslationSuffix, scriptOutputSuffix } from "../shared/book-translation.js";

const MARKUP_RE = /\.(?:xhtml|html|htm|opf|ncx|xml|svg)$/i;

function decodeEntities(value) {
  return String(value == null ? "" : value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)));
}

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textContent(value) {
  return decodeEntities(String(value == null ? "" : value).replace(/<[^>]*>/g, " "));
}

// Convert only text nodes. Tags, comments and CDATA stay byte-for-byte so the
// EPUB's structure, links, media and CSS references are untouched.
export function convertMarkupText(markup, convert) {
  const source = String(markup || "");
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
  let output = "";
  let last = 0;
  for (const match of source.matchAll(tokens)) {
    output += convert(source.slice(last, match.index));
    output += match[0];
    last = (match.index || 0) + match[0].length;
  }
  output += convert(source.slice(last));
  return output;
}

function findOpfName(zip) {
  return Object.keys(zip.files).find((name) => name.toLowerCase().endsWith(".opf")) || "";
}

function sourceTitle(opf, fallback) {
  const match = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(String(opf || ""));
  return textContent(match?.[1] || "").trim() || fallback;
}

function replaceTitle(opf, title) {
  const value = `<dc:title>${escapeXml(title)}</dc:title>`;
  if (/<dc:title\b[^>]*>[\s\S]*?<\/dc:title>/i.test(opf)) {
    return opf.replace(/<dc:title\b[^>]*>[\s\S]*?<\/dc:title>/i, value);
  }
  return opf.replace(/(<metadata\b[^>]*>)/i, `$1\n    ${value}`);
}

function replaceLanguage(opf, target) {
  const language = target === "s" ? "zh-Hans" : "zh-Hant";
  if (/<dc:language\b[^>]*>[\s\S]*?<\/dc:language>/i.test(opf)) {
    return opf.replace(/<dc:language\b[^>]*>[\s\S]*?<\/dc:language>/gi, `<dc:language>${language}</dc:language>`);
  }
  return opf.replace(/(<metadata\b[^>]*>)/i, `$1\n    <dc:language>${language}</dc:language>`);
}

export async function convertEpubScript({
  source,
  out,
  target = "t",
  title = "",
  report = () => {},
  signal = null,
} = {}) {
  if (!source || !fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const names = Object.keys(zip.files);
  const containerEntry = zip.file("META-INF/container.xml");
  const container = containerEntry ? await containerEntry.async("string") : "";
  const rootfile = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(container)?.[1] || "";
  const opfName = decodeEntities(rootfile) || findOpfName(zip);
  if (!opfName || !zip.file(opfName)) throw new Error("EPUB 缺少 content.opf，无法转换");
  const opf = await zip.file(opfName).async("string");
  const suffix = title ? "" : scriptOutputSuffix(target);
  const outputTitle = title
    ? convertChineseScript(title, target)
    : appendTranslationSuffix(convertChineseScript(sourceTitle(opf, path.basename(source).replace(/\.[^.]+$/, "")), target), suffix);
  const mimetype = zip.file("mimetype");
  if (!mimetype) throw new Error("EPUB 缺少 mimetype，无法保持原格式转换");
  const outputZip = new JSZip();
  outputZip.file("mimetype", await mimetype.async("string"), { compression: "STORE" });
  let hasHan = false;
  let convertedFiles = 0;
  for (const [index, name] of names.entries()) {
    if (name === "mimetype") continue;
    if (signal?.aborted) throw new Error("任务已取消");
    const entry = zip.files[name];
    if (entry.dir) {
      outputZip.folder(name);
      continue;
    }
    if (MARKUP_RE.test(name)) {
      const original = await entry.async("string");
      hasHan = hasHan || /\p{Script=Han}/u.test(textContent(original));
      let converted = convertMarkupText(original, (value) => convertChineseScript(value, target));
      if (name === opfName) {
        converted = replaceTitle(converted, outputTitle);
        converted = replaceLanguage(converted, target);
      }
      outputZip.file(name, converted);
      convertedFiles += 1;
    } else {
      outputZip.file(name, await entry.async("nodebuffer"));
    }
    report({
      done: index + 1,
      total: names.length,
      label: `转换 EPUB · ${index + 1}/${names.length}`,
    });
  }
  if (!hasHan) throw new Error("简繁转换只支持中文书稿，EPUB 中没有识别到中文文字");
  if (signal?.aborted) throw new Error("任务已取消");
  const data = await outputZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (signal?.aborted) throw new Error("任务已取消");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, out);
  const spineCount = (opf.match(/<itemref\b/gi) || []).length;
  return { title: outputTitle, spineCount, convertedFiles, files: names.length };
}
