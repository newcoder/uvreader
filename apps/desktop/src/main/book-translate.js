// Long-form bilingual translation runner for the ebook builder. It deliberately
// lives beside the workshop runners instead of inside the reader: the source
// book is translated as a background task, with progress, cancellation and a
// resumable per-chunk cache. The actual EPUB rendering stays in workshop-epub.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BOOK_TRANSLATION_MAX_CHARS,
  BOOK_TRANSLATION_VERSION,
  buildBookTranslationMessages,
  parseBookTranslationAnswer,
  parseTranslationGlossary,
  splitTranslationBlocks,
  translationLanguagePair,
} from "../shared/book-translation.js";
import { aiFailureText, normalizeAiConfig } from "./workshop-ai.js";

const MAX_BLOCKS_PER_CALL = 12;
const MAX_CHARS_PER_CALL = 3200;
const MAX_ATTEMPTS = 2;

function packChunks(blocks) {
  const chunks = [];
  let current = [];
  let chars = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    chars = 0;
  };
  for (const block of blocks) {
    const length = String(block.source || "").length;
    if (current.length && (current.length >= MAX_BLOCKS_PER_CALL || chars + length > MAX_CHARS_PER_CALL)) flush();
    current.push(block);
    chars += length;
  }
  flush();
  return chunks;
}

function cachePath(workRoot, key) {
  return path.join(String(workRoot || ""), "translate", `${key}.json`);
}

function readCached(file, expectedIds) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || value.schemaVersion !== BOOK_TRANSLATION_VERSION || !value.translations) return null;
    const wanted = new Set(expectedIds.map(String));
    const result = new Map();
    for (const [id, text] of Object.entries(value.translations)) {
      const value = String(text || "").trim();
      if (wanted.has(String(id)) && value) result.set(String(id), value);
    }
    return result.size === wanted.size ? result : null;
  } catch {
    return null;
  }
}

function writeCached(file, translations) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const value = {
      schemaVersion: BOOK_TRANSLATION_VERSION,
      updatedAt: Date.now(),
      translations: Object.fromEntries(translations),
    };
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temp, file);
  } catch {
    // A cache write failure must not invalidate a successful translation.
  }
}

export function translationCacheKey({ blocks = [], direction = "zh-en", model = "", configId = "", base = "", glossary = "" } = {}) {
  const source = blocks.map((block) => ({
    id: String(block.id || ""),
    text: String(block.source || ""),
  }));
  return crypto.createHash("sha1")
    .update(JSON.stringify({
      version: BOOK_TRANSLATION_VERSION,
      direction,
      model: String(model || ""),
      configId: String(configId || ""),
      base: String(base || ""),
      source,
      glossary: parseTranslationGlossary(glossary),
    }))
    .digest("hex");
}

export function createBookTranslator({ aiRuntime = null, log = () => {} } = {}) {
  async function translateBook({ chapters = [], translation = {}, workRoot = "", signal = null, report = () => {} } = {}) {
    if (!aiRuntime?.stream) throw new Error("翻译需要桌面 AI 运行时");
    const config = normalizeAiConfig(translation.config);
    if (!config.id || !config.base || !config.model) {
      throw new Error("AI 还没配置好：先在「设置 → AI 助读」里选供应商与模型");
    }
    const direction = translationLanguagePair(translation.direction);
    const glossary = parseTranslationGlossary(translation.glossary);
    const chapterBlocks = (Array.isArray(chapters) ? chapters : []).map((chapter, index) => ({
      index,
      title: String(chapter?.title || ""),
      markdown: Boolean(chapter?.markdown),
      source: String(chapter?.text || ""),
      blocks: splitTranslationBlocks(chapter?.text || "", {
        markdown: Boolean(chapter?.markdown),
        chapterIndex: index,
      }),
    }));
    const titleJob = (chapter) => (chapter.title.trim()
      ? {
        id: `c${chapter.index}-title`,
        source: chapter.title,
        markdown: false,
        translatable: true,
        kind: "title",
      }
      : null);
    const allJobs = chapterBlocks.flatMap((chapter) => [
      ...(titleJob(chapter) ? [titleJob(chapter)] : []),
      ...chapter.blocks.filter((block) => block.translatable),
    ]);
    const chars = allJobs.reduce((sum, block) => sum + String(block.source || "").length, 0);
    if (chars > BOOK_TRANSLATION_MAX_CHARS) {
      throw new Error(`正文约 ${chars.toLocaleString()} 字，超过翻译上限 ${BOOK_TRANSLATION_MAX_CHARS.toLocaleString()} 字；请先拆分书稿`);
    }
    if (!allJobs.length) {
      return {
        chapters: chapterBlocks.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          translatedTitle: "",
          blocks: chapter.blocks,
        })),
        stats: {
          chunks: 0,
          cachedChunks: 0,
          calls: 0,
          translatedBlocks: 0,
          chars,
          direction: direction.id,
        },
      };
    }

    const cachedFile = (chunk) => cachePath(workRoot, translationCacheKey({
      blocks: chunk,
      direction: direction.id,
      model: config.model,
      configId: config.id,
      base: config.base,
      glossary,
    }));
    const chunkPlans = [];
    for (const chapter of chapterBlocks) {
      const title = titleJob(chapter);
      const jobs = [...(title ? [title] : []), ...chapter.blocks.filter((block) => block.translatable)];
      for (const chunk of packChunks(jobs)) {
        chunkPlans.push({ chapter, chunk, file: cachedFile(chunk) });
      }
    }

    const translations = new Map();
    let cachedChunks = 0;
    let calls = 0;
    const total = chunkPlans.length;
    for (const [index, plan] of chunkPlans.entries()) {
      if (signal?.aborted) throw new Error("已取消");
      const ids = plan.chunk.map((block) => String(block.id));
      let translated = readCached(plan.file, ids);
      if (translated) {
        cachedChunks += 1;
      } else {
        let lastError = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          if (signal?.aborted) throw new Error("已取消");
          const requestId = `book-translate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${index}-${attempt}`;
          const onAbort = () => aiRuntime.abort(requestId);
          signal?.addEventListener?.("abort", onAbort, { once: true });
          report({
            done: index,
            total,
            label: `翻译 ${index + 1}/${total} 块 · ${plan.chapter.title || "正文"}`,
          });
          let result;
          try {
            result = await aiRuntime.stream({
              requestId,
              config,
              messages: buildBookTranslationMessages({
                blocks: plan.chunk,
                direction: direction.id,
                bookTitle: translation.bookTitle || "",
                chapterTitle: plan.chapter.title,
                glossary,
              }),
              options: { timeoutMs: 180_000, maxTokens: 6000 },
            });
          } finally {
            signal?.removeEventListener?.("abort", onAbort);
          }
          calls += 1;
          if (!result?.ok) {
            lastError = new Error(aiFailureText(result));
            continue;
          }
          const parsed = parseBookTranslationAnswer(result.answer, ids);
          if (parsed.size === ids.length) {
            translated = parsed;
            writeCached(plan.file, translated);
            break;
          }
          lastError = new Error(`AI 返回缺少译文（${parsed.size}/${ids.length} 段）`);
        }
        if (!translated) throw lastError || new Error("AI 没有返回完整译文");
      }
      for (const [id, text] of translated) translations.set(String(id), text);
      report({
        done: index + 1,
        total,
        label: `翻译 ${index + 1}/${total} 块 · ${plan.chapter.title || "正文"}`,
      });
    }

    const output = chapterBlocks.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      translatedTitle: translations.get(`c${chapter.index}-title`) || "",
      blocks: chapter.blocks.map((block) => ({
        ...block,
        translation: translations.get(String(block.id)) || "",
      })),
    }));
    const stats = {
      chunks: total,
      cachedChunks,
      calls,
      translatedBlocks: translations.size,
      chars,
      direction: direction.id,
    };
    log("[book-translate]", stats);
    return { chapters: output, stats };
  }

  return { translateBook };
}
