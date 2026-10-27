// Bilingual book translation helpers. Translation is paragraph/block based:
// the source book stays intact and the translation is rendered beside each
// translatable block. Headings, code, images and tables are kept as source-only
// blocks so that a model response can never silently delete them.
export const BOOK_TRANSLATION_VERSION = 1;
export const BOOK_TRANSLATION_MAX_CHARS = 1_200_000;

export const BOOK_TRANSLATION_DIRECTIONS = Object.freeze([
  { id: "zh-en", source: "zh", target: "en", sourceLabel: "中文", targetLabel: "English" },
  { id: "en-zh", source: "en", target: "zh-Hans", sourceLabel: "English", targetLabel: "简体中文" },
  {
    id: "de-zh",
    source: "de",
    target: "zh-Hans",
    sourceLabel: "Deutsch",
    targetLabel: "简体中文",
  },
  {
    id: "wenyan-zh",
    source: "lzh",
    target: "zh-Hans",
    sourceLabel: "文言文",
    targetLabel: "现代中文",
    style: "把文言文翻译成准确、通顺的现代汉语。保留人名、地名、书名和原意；不要改成注释、评论或学术论文；逐段翻译，不增删。",
  },
]);

export const BOOK_TRANSLATION_MODES = Object.freeze([
  { id: "none", label: "不翻译" },
  { id: "translated", label: "仅译文" },
  { id: "stacked", label: "上下对照" },
  { id: "side", label: "左右对照" },
  { id: "script", label: "简繁转换" },
]);

export function normalizeBookTranslationDirection(value) {
  const id = String(value || "").trim();
  return BOOK_TRANSLATION_DIRECTIONS.some((item) => item.id === id) ? id : "zh-en";
}

export function translationLanguagePair(value) {
  const id = normalizeBookTranslationDirection(value);
  return BOOK_TRANSLATION_DIRECTIONS.find((item) => item.id === id) || BOOK_TRANSLATION_DIRECTIONS[0];
}

// Default file/display suffix for generated books. A translated-only edition
// is named after the target language; bilingual editions use one shared
// label. A no-op translation keeps the original name.
export function translationOutputSuffix({ mode = "none", direction = "zh-en" } = {}) {
  const pair = translationLanguagePair(direction);
  if (mode === "stacked" || mode === "side") {
    if (pair.id === "wenyan-zh") return "（文白对照）";
    if (pair.id === "de-zh") return "（中德对照）";
    return "（中英对照）";
  }
  if (mode !== "translated") return "";
  if (pair.target === pair.source) return "";
  if (pair.id === "wenyan-zh") return "（白话）";
  if (pair.target === "en") return "（English）";
  if (String(pair.target).toLowerCase().startsWith("zh")) return "（中文）";
  return `（${pair.targetLabel}）`;
}

// The source language is detected automatically; whether a Chinese source is
// literary Chinese remains a manual choice. This keeps a detected Chinese
// novel from being forced into the 文白 pipeline by a character heuristic.
export function directionForSource({ language = "", classical = false } = {}) {
  const value = String(language || "").toLowerCase();
  if (classical) {
    if (value !== "zh") return "";
    return "wenyan-zh";
  }
  if (value === "zh") return "zh-en";
  if (value === "en") return "en-zh";
  if (value === "de") return "de-zh";
  return "";
}

export function scriptOutputSuffix(script = "t") {
  return script === "s" ? "（简体）" : "（繁體）";
}

export function appendTranslationSuffix(base, suffix) {
  const value = String(base || "").trim();
  const tail = String(suffix || "").trim();
  if (!value || !tail || value.endsWith(tail)) return value;
  return `${value}${tail}`;
}

function cleanText(value) {
  return String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
}

function plainBlocks(text) {
  const source = cleanText(text);
  if (!source) return [];
  const parts = source.split(/\n{2,}/);
  const list = parts.length > 1 ? parts : source.split("\n");
  return list.map((item) => item.trim()).filter(Boolean);
}

function markdownBlocks(text) {
  const source = cleanText(text);
  if (!source) return [];
  const lines = source.split("\n");
  const blocks = [];
  let current = [];
  let fence = "";
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (line.trim().startsWith(fence) && line.trim().length >= 3) {
        fence = "";
        flush();
      }
      continue;
    }
    const open = line.match(/^\s*(```+|~~~+)/);
    if (open) {
      flush();
      fence = open[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function markdownTranslatable(block) {
  const text = String(block || "").trim();
  if (!text) return false;
  // Internal headings are translated together with their following paragraphs;
  // the TOC itself still uses the original chapter titles.
  if (/^(```|~~~)/.test(text)) return false;
  // Markdown tables and raw HTML cannot be translated safely block-by-block.
  // A leading ">" is a block quote, not HTML, and should be translated.
  if (/^\s*\|/.test(text)) return false;
  if (/^\s*<[a-zA-Z!/]/.test(text)) return false;
  if (/!\[[^\]]*\]\([^)]*\)|<img\b/i.test(text)) return false;
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(text)) return false;
  if (/^\s*(?:\$\$|\\\[)/.test(text)) return false;
  return true;
}

// Returns stable block IDs plus a translatable flag. Blank-line separation is
// preserved for plain text; Markdown fenced code blocks are kept intact even
// when they contain blank lines.
export function splitTranslationBlocks(text, { markdown = false, chapterIndex = 0 } = {}) {
  const values = markdown ? markdownBlocks(text) : plainBlocks(text);
  return values.map((source, index) => ({
    id: `c${chapterIndex}-b${index + 1}`,
    source,
    markdown: Boolean(markdown),
    translatable: markdown ? markdownTranslatable(source) : true,
  }));
}

export function buildBookTranslationMessages({
  blocks = [],
  direction = "zh-en",
  bookTitle = "",
  chapterTitle = "",
} = {}) {
  const pair = translationLanguagePair(direction);
  const rows = blocks.map((block) => ({
    id: String(block.id || ""),
    text: String(block.source || ""),
  }));
  return [
    {
      role: "system",
      content: [
        "你是一名专业的文学与学术图书译者。",
        pair.style || `把每一段从${pair.sourceLabel}翻译成${pair.targetLabel}。`,
        "保持段落边界和 Markdown 结构（标题/列表/引用等）；不增删内容，不总结，不解释，不加引号。",
        "专有名词、人名、地名和术语在整本书中保持一致；不确定的专名保留原文并在必要时音译。",
        "只输出 JSON，不要 Markdown 代码围栏。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `书籍：${String(bookTitle || "(未命名)")}`,
        chapterTitle ? `章节：${chapterTitle}` : "",
        `目标语言：${pair.targetLabel}`,
        "逐段翻译下面的 JSON 数组。每项必须返回相同 id。JSON 形状：{\"translations\":[{\"id\":\"c0-b1\",\"text\":\"译文\"}]}",
        "",
        JSON.stringify(rows, null, 2),
      ].filter(Boolean).join("\n"),
    },
  ];
}

function parseJsonObject(value) {
  let text = String(value == null ? "" : value).replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Accepts either the documented {translations:[...]} shape or a plain
// {blockId: text} map. Missing IDs are returned as an error by the caller.
export function parseBookTranslationAnswer(answer, expectedIds = []) {
  const data = parseJsonObject(answer);
  if (!data) return new Map();
  const wanted = new Set((Array.isArray(expectedIds) ? expectedIds : []).map(String));
  const rows = Array.isArray(data.translations)
    ? data.translations
    : (Array.isArray(data) ? data : null);
  const result = new Map();
  if (rows) {
    for (const row of rows) {
      const id = String(row?.id ?? row?.blockId ?? "");
      const text = String(row?.text ?? row?.translation ?? row?.content ?? "").trim();
      if (!wanted.has(id) || !text) continue;
      result.set(id, text);
    }
    return result;
  }
  if (data && typeof data === "object") {
    for (const [id, text] of Object.entries(data)) {
      if (!wanted.has(String(id)) || typeof text !== "string" || !text.trim()) continue;
      result.set(String(id), text.trim());
    }
  }
  return result;
}
