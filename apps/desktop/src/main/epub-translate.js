// EPUB-preserving bilingual translation. The normal translator extracts each
// chapter to Markdown and rebuilds the book, which flattens poetry line breaks
// and source chapter files. This path leaves every original XHTML element in
// place and inserts the AI translation next to each translatable block.
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { detectBookLanguage } from "../shared/language-detect.js";
import {
  appendTranslationSuffix,
  directionForSource,
  normalizeTranslationTarget,
  translationLanguagePair,
  translationOutputSuffix,
} from "../shared/book-translation.js";
import {
  decodeEntities,
  escapeXml,
  findOpfName,
  replaceLanguage,
  replaceTitle,
  sourceTitle,
  textContent,
} from "./epub-script.js";
import { isChapterHeading } from "./text-book.js";

const BLOCK_RE = /<(p|h[1-6]|blockquote|li|td|th|figcaption)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const BLOCK_CHILD_RE = /<(?:p|h[1-6]|ul|ol|li|table|pre|code|img|svg|math|figure|figcaption)\b/i;
const INSIDE_TAGS = new Set(["li", "td", "th", "figcaption"]);

function blockText(inner) {
  const value = String(inner || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function documentTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return textContent(match?.[1] || "").replace(/\s+/g, " ").trim();
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function isTitleBlock(block, title) {
  if (!block || !block.text) return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  if (title && text === title) return true;
  return block.tag === "p" ? isChapterHeading(text) : /^h[1-6]$/.test(block.tag);
}

function extractBlocks(html, name) {
  const blocks = [];
  for (const match of String(html).matchAll(BLOCK_RE)) {
    const original = match[0];
    const tag = match[1].toLowerCase();
    const inner = match[3];
    // Do not translate an outer paragraph that contains another block. Lists,
    // table cells and blockquotes may contain nested elements and are handled
    // inside their own element.
    if ((tag === "p" || /^h[1-6]$/.test(tag)) && BLOCK_CHILD_RE.test(inner)) continue;
    const text = blockText(inner);
    if (!text) continue;
    const end = (match.index || 0) + original.length;
    blocks.push({
      file: name,
      tag,
      open: original.slice(0, original.indexOf(">") + 1),
      close: `</${tag}>`,
      original,
      inner,
      start: match.index || 0,
      end,
      text,
    });
  }
  return blocks;
}

function parseAttributes(source) {
  const result = {};
  for (const match of String(source || "").matchAll(/([\w:-]+)="([^"]*)"/g)) {
    result[match[1]] = decodeEntities(match[2]);
  }
  return result;
}

function spineFiles(zip, opfName, opf) {
  const opfDir = path.posix.dirname(opfName).replace(/^\.$/, "");
  const items = new Map();
  for (const match of String(opf || "").matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.id && attrs.href) items.set(attrs.id, attrs);
  }
  const files = [];
  for (const match of String(opf || "").matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    const item = items.get(attrs.idref);
    if (!item || item["media-type"] !== "application/xhtml+xml") continue;
    if (String(item.properties || "").split(/\s+/).includes("nav")) continue;
    const href = decodeEntities(item.href);
    const resolved = path.posix.normalize(opfDir ? `${opfDir}/${href}` : href);
    if (!files.includes(resolved) && zip.file(resolved)) files.push(resolved);
  }
  if (files.length) return files;
  return Object.keys(zip.files).filter((name) => {
    if (!/\.(?:xhtml|html|htm)$/i.test(name)) return false;
    if (/nav\.xhtml$/i.test(name)) return false;
    return Boolean(zip.file(name));
  });
}

function shouldTranslate(text, pair) {
  if (pair.source === "zh" || pair.source === "lzh") return /\p{Script=Han}/u.test(text);
  if (pair.source === "en" || pair.source === "de") return /\p{Script=Latin}/u.test(text);
  return true;
}

function translationBody(text) {
  return escapeXml(String(text || "")).replace(/\n/g, "<br/>");
}

function translationHtml(text, lang) {
  return `<div class="qbr-epub-translation" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">${translationBody(text)}</div>`;
}

function titleTranslationHtml(text, lang) {
  return `<div class="qbr-epub-title-translation" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">${translationBody(text)}</div>`;
}

const BILINGUAL_CSS = `
.qbr-epub-translation { margin: .45em 0 .9em; padding-left: .9em; border-left: 2px solid rgba(128,128,128,.35); opacity: .86; }
.qbr-epub-title-translation { margin: .2em 0 .85em; font-size: .92em; opacity: .78; }
.qbr-epub-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.3em; align-items: start; margin: .8em 0; }
.qbr-epub-pair > .qbr-epub-translation { margin: 0; padding-left: .9em; }
@media (max-width: 740px) {
  .qbr-epub-pair { display: block; }
  .qbr-epub-pair > .qbr-epub-translation { margin-top: .65em; }
}
`;

function addStyle(html) {
  if (!html.includes("qbr-epub-translation") && !html.includes("qbr-epub-title-translation")) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `<style>${BILINGUAL_CSS}</style></head>`);
  return `<style>${BILINGUAL_CSS}</style>${html}`;
}

function injectTranslations(html, blocks, mode, targetLang) {
  let output = String(html);
  for (const block of [...blocks].sort((left, right) => right.start - left.start)) {
    if (!block.translation) continue;
    if (block.titleLike && mode !== "translated") {
      // A title paragraph must not become a second body paragraph with a
      // translation border. If the title is identical in the target script
      // (common for 文白), leave it once; otherwise add a subtitle line.
      if (normalizedText(block.translation) === normalizedText(block.text)) continue;
      const titleTranslation = titleTranslationHtml(block.translation, targetLang);
      output = output.slice(0, block.start) + `${block.original}\n${titleTranslation}` + output.slice(block.end);
      continue;
    }
    const translated = translationHtml(block.translation, targetLang);
    let replacement;
    if (mode === "translated") {
      // Keep the original block element (and its classes/styles), replacing
      // only its text. This preserves paragraph/heading formatting.
      replacement = `${block.open}${translationBody(block.translation)}${block.close}`;
    } else if (mode === "side" && !INSIDE_TAGS.has(block.tag)) {
      replacement = `<div class="qbr-epub-pair">${block.original}${translated}</div>`;
    } else if (INSIDE_TAGS.has(block.tag)) {
      // A <div> cannot be a direct child of <ul> or <tr>; put the translation
      // inside the list item / table cell and keep the table/list valid.
      replacement = `${block.open}${block.inner}${translated}${block.close}`;
    } else {
      replacement = `${block.original}\n${translated}`;
    }
    output = output.slice(0, block.start) + replacement + output.slice(block.end);
  }
  return addStyle(output);
}

function sourceLanguage(opf, fallback) {
  const match = /<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i.exec(String(opf || ""));
  return textContent(match?.[1] || "").trim() || fallback;
}

export async function translateEpub({
  source,
  out = "",
  outputPath = () => "",
  translator = null,
  mode = "stacked",
  direction = "",
  target = "",
  classical = false,
  glossary = "",
  lineAlign = false,
  customTitle = "",
  config = null,
  workRoot = "",
  preview = false,
  previewFiles = 2,
  signal = null,
  report = () => {},
  log = () => {},
} = {}) {
  if (!translator) throw new Error("翻译需要桌面 AI 运行时");
  if (!source || !fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const names = Object.keys(zip.files);
  const containerEntry = zip.file("META-INF/container.xml");
  const container = containerEntry ? await containerEntry.async("string") : "";
  const rootfile = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(container)?.[1] || "";
  const opfName = decodeEntities(rootfile) || findOpfName(zip);
  if (!opfName || !zip.file(opfName)) throw new Error("EPUB 缺少 content.opf，无法翻译");
  const opf = await zip.file(opfName).async("string");
  const fileNames = spineFiles(zip, opfName, opf);
  if (!fileNames.length) throw new Error("EPUB 没有可翻译的正文文件");

  const files = [];
  for (const name of fileNames) {
    const html = await zip.file(name).async("string");
    files.push({ name, html, blocks: [] });
  }
  for (const file of files) {
    const title = documentTitle(file.html);
    file.blocks = extractBlocks(file.html, file.name);
    if (file.blocks[0]) file.blocks[0].titleLike = isTitleBlock(file.blocks[0], title);
  }
  if (!files.some((file) => file.blocks.length)) {
    throw new Error("EPUB 中没有可翻译的正文");
  }
  const detected = detectBookLanguage(files.map((file) => ({
    // File names are Latin and can dominate a short poem block; detect from
    // the actual translated text only.
    title: "",
    text: file.blocks.map((block) => block.text).join("\n"),
  })));
  let directionId = String(direction || "").trim();
  if (directionId === "auto") directionId = "";
  if (!directionId) {
    const requestedTarget = normalizeTranslationTarget(target);
    if (classical) {
      if (detected.language === "ja" || detected.language === "ko") {
        throw new Error("已勾选文言文，但识别到的不是中文书稿；请检查书稿或取消勾选");
      }
      if (requestedTarget && requestedTarget !== "zh") {
        throw new Error("文白对照的目标固定为现代中文，不能选择其它目标语言");
      }
      directionId = "wenyan-zh";
    } else {
      if (requestedTarget && detected.language === requestedTarget) {
        if (requestedTarget === "zh") {
          throw new Error("原文已经是中文。翻译目标不能与原文相同；如需简繁转换，请使用「简繁转换（本机）」或「转为简体/繁体」快捷按钮");
        }
        throw new Error(`原文已经是 ${requestedTarget === "en" ? "English" : "Deutsch"}，请选择其它目标语言`);
      }
      directionId = directionForSource({ language: detected.language, classical: false, target: requestedTarget });
      if (!directionId) {
        throw new Error(`无法自动识别可翻译的原文语言（识别为 ${detected.language || "未知"}）；目前支持中文、英文、德文`);
      }
    }
  } else if (classical && directionId !== "wenyan-zh") {
    throw new Error("勾选了文言文，但翻译方向不是文白对照");
  }
  const pair = translationLanguagePair(directionId);
  const suffix = customTitle ? "" : translationOutputSuffix({ mode, direction: directionId });
  if (!preview) {
    if (!out) out = outputPath(suffix);
    if (path.resolve(out) === path.resolve(source)) {
      throw new Error("输出路径不能覆盖原 EPUB，请换一个文件名");
    }
  }
  const selectedFiles = preview
    ? files.slice(0, Math.max(1, Math.min(5, Number(previewFiles) || 2)))
    : files;

  const chapters = selectedFiles.map((file) => {
    file.blocks = file.blocks.filter((block) => shouldTranslate(block.text, pair));
    return {
      title: "",
      // Markdown block parsing keeps the single newlines inside a poem line
      // block; plain-text parsing would split every line into a separate job.
      markdown: true,
      text: file.blocks.map((block) => block.text).join("\n\n"),
    };
  });
  report({ label: `翻译正文 · ${pair.sourceLabel} → ${pair.targetLabel}` });
  const translated = await translator.translateBook({
    chapters,
    translation: {
      direction: directionId,
      classical,
      glossary,
      lineAlign,
      config,
      bookTitle: customTitle || sourceTitle(opf, path.basename(source).replace(/\.[^.]+$/, "")),
    },
    workRoot,
    signal,
    report,
  });
  if (signal?.aborted) throw new Error("任务已取消");

  for (const [fileIndex, file] of selectedFiles.entries()) {
    const translatedBlocks = translated.chapters[fileIndex]?.blocks || [];
    if (translatedBlocks.length !== file.blocks.length) {
      throw new Error("译文段落数与原文不一致，请重试");
    }
    for (const [index, block] of file.blocks.entries()) {
      block.translation = translatedBlocks[index]?.translation || "";
    }
  }

  const sourceBase = path.basename(source).replace(/\.[^.]+$/, "");
  const title = customTitle
    ? customTitle
    : appendTranslationSuffix(sourceTitle(opf, sourceBase), suffix);
  const targetLanguage = mode === "translated" ? pair.target : sourceLanguage(opf, pair.source);
  const spineCount = (opf.match(/<itemref\b/gi) || []).length;

  if (preview) {
    const css = (await Promise.all(
      names.filter((name) => /\.css$/i.test(name)).map((name) => zip.file(name).async("string")),
    )).join("\n");
    const body = selectedFiles.map((file) => {
      const injected = injectTranslations(file.html, file.blocks, mode, pair.target);
      const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(injected);
      return bodyMatch?.[1] || injected;
    }).join("\n<hr/>\n");
    const previewHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<style>${css}
${BILINGUAL_CSS}
body { padding: 1.2em; }
</style></head><body>${body}</body></html>`;
    log("[epub-translate] preview", { direction: pair.id, mode, files: selectedFiles.length, blocks: translated.stats.translatedBlocks });
    return {
      output: "",
      previewHtml,
      title,
      pair,
      spineCount,
      previewFiles: selectedFiles.length,
      chapters: translated.chapters,
      stats: translated.stats,
    };
  }

  const outputZip = new JSZip();
  const mimetype = zip.file("mimetype");
  if (!mimetype) throw new Error("EPUB 缺少 mimetype，无法保留原格式翻译");
  outputZip.file("mimetype", await mimetype.async("string"), { compression: "STORE" });
  const translatedFiles = new Set(files.map((file) => file.name));
  for (const [index, name] of names.entries()) {
    if (name === "mimetype") continue;
    if (signal?.aborted) throw new Error("任务已取消");
    const entry = zip.files[name];
    if (entry.dir) {
      outputZip.folder(name);
      continue;
    }
    if (name === opfName) {
      let changed = await entry.async("string");
      changed = replaceTitle(changed, title);
      changed = replaceLanguage(changed, targetLanguage);
      outputZip.file(name, changed);
    } else if (translatedFiles.has(name)) {
      const file = files.find((item) => item.name === name);
      outputZip.file(name, injectTranslations(file.html, file.blocks, mode, pair.target));
    } else {
      outputZip.file(name, await entry.async("nodebuffer"));
    }
    report({
      done: index + 1,
      total: names.length,
      label: `写入 EPUB · ${index + 1}/${names.length}`,
    });
  }
  if (signal?.aborted) throw new Error("任务已取消");
  const data = await outputZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, out);
  log("[epub-translate]", { direction: pair.id, mode, blocks: translated.stats.translatedBlocks });
  return {
    output: out,
    title,
    pair,
    spineCount,
    chapters: translated.chapters,
    stats: translated.stats,
  };
}
