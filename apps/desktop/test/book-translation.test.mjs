import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendTranslationSuffix,
  buildBookTranslationMessages,
  directionForSource,
  normalizeBookTranslationDirection,
  normalizeTranslationTarget,
  parseBookTranslationAnswer,
  parseTranslationGlossary,
  scriptOutputSuffix,
  splitTranslationBlocks,
  translationLanguagePair,
  translationOutputSuffix,
} from "../src/shared/book-translation.js";
import { createBookTranslator, translationCacheKey } from "../src/main/book-translate.js";
import { detectBookLanguage, detectSourceLanguage } from "../src/shared/language-detect.js";

test("translation directions and response parsing", () => {
  assert.equal(normalizeBookTranslationDirection("en-zh"), "en-zh");
  assert.equal(normalizeBookTranslationDirection("nope"), "zh-en");
  assert.equal(translationLanguagePair("en-zh").target, "zh-Hans");
  const map = parseBookTranslationAnswer(`\`\`\`json
  {"translations":[{"id":"c0-b1","text":"Hello"},{"id":"c0-b2","text":"World"}]}
  \`\`\``, ["c0-b1", "c0-b2"]);
  assert.deepEqual([...map.entries()], [["c0-b1", "Hello"], ["c0-b2", "World"]]);
  assert.equal(parseBookTranslationAnswer('{"c0-b1":"Only"}', ["c0-b1"]).get("c0-b1"), "Only");
  assert.equal(parseBookTranslationAnswer("not json", ["c0-b1"]).size, 0);
});

test("translation blocks keep code/tables source-only and preserve paragraph order", () => {
  const blocks = splitTranslationBlocks([
    "# Source heading",
    "",
    "First paragraph.",
    "",
    "- one",
    "- two",
    "",
    "```js",
    "const x = 1;",
    "",
    "console.log(x);",
    "```",
    "",
    "Last paragraph.",
  ].join("\n"), { markdown: true, chapterIndex: 2 });
  assert.deepEqual(blocks.map((block) => block.id), ["c2-b1", "c2-b2", "c2-b3", "c2-b4", "c2-b5"]);
  assert.equal(blocks[0].translatable, true, "internal headings are translated");
  assert.equal(blocks[1].translatable, true);
  assert.equal(blocks[2].translatable, true, "lists can be translated while preserving Markdown");
  assert.equal(blocks[3].translatable, false, "fenced code stays source-only");
  assert.equal(blocks[4].translatable, true);
  assert.match(blocks[3].source, /console\.log/);
});

test("block quotes are translated while Markdown tables and HTML stay source-only", () => {
  const blocks = splitTranslationBlocks([
    "> 学而时习之，不亦说乎？",
    "",
    "| 简体 | 繁體 |",
    "| --- | --- |",
    "| 国家 | 國家 |",
    "",
    "<div>raw html</div>",
  ].join("\n"), { markdown: true });
  assert.equal(blocks[0].translatable, true);
  assert.equal(blocks[1].translatable, false);
  assert.equal(blocks[2].translatable, false);
});

test("default translated book names follow the source and target languages", () => {
  assert.equal(translationOutputSuffix({ mode: "translated", direction: "zh-en" }), "（English）");
  assert.equal(translationOutputSuffix({ mode: "translated", direction: "en-zh" }), "（中文）");
  assert.equal(translationOutputSuffix({ mode: "stacked", direction: "zh-en" }), "（中英对照）");
  assert.equal(translationOutputSuffix({ mode: "side", direction: "en-zh" }), "（中英对照）");
  assert.equal(translationOutputSuffix({ mode: "stacked", direction: "wenyan-zh" }), "（文白对照）");
  assert.equal(translationOutputSuffix({ mode: "translated", direction: "wenyan-zh" }), "（白话）");
  assert.equal(translationLanguagePair("wenyan-zh").targetLabel, "现代中文");
  assert.equal(translationOutputSuffix({ mode: "stacked", direction: "de-zh" }), "（中德对照）");
  assert.equal(translationOutputSuffix({ mode: "none" }), "");
  assert.equal(appendTranslationSuffix("Book", "（中文）"), "Book（中文）");
  assert.equal(appendTranslationSuffix("Book（中文）", "（中文）"), "Book（中文）");
  assert.equal(scriptOutputSuffix("t"), "（繁體）");
  assert.equal(scriptOutputSuffix("s"), "（简体）");
  assert.equal(normalizeTranslationTarget("zh-Hans"), "zh");
  assert.equal(normalizeTranslationTarget("auto"), "");
  assert.equal(directionForSource({ language: "zh", target: "de" }), "zh-de");
  assert.equal(directionForSource({ language: "en", target: "de" }), "en-de");
  assert.equal(directionForSource({ language: "de", target: "en" }), "de-en");
  assert.equal(directionForSource({ language: "zh", target: "zh" }), "");
  assert.equal(translationOutputSuffix({ mode: "stacked", direction: "zh-de" }), "（中德对照）");
  assert.equal(translationOutputSuffix({ mode: "stacked", direction: "en-de" }), "（英德对照）");
  assert.equal(translationOutputSuffix({ mode: "translated", direction: "zh-de" }), "（Deutsch）");
  assert.equal(translationOutputSuffix({ mode: "translated", direction: "de-en" }), "（English）");
});

test("glossary terms are normalized, included in the prompt and part of the cache key", () => {
  const glossary = parseTranslationGlossary("道=Dao\n德：De\n# comment\n道=Way\nbad line");
  assert.deepEqual(glossary, [{ source: "道", target: "Dao" }, { source: "德", target: "De" }]);
  const messages = buildBookTranslationMessages({
    blocks: [{ id: "c0-b1", source: "道" }],
    direction: "zh-en",
    glossary,
  });
  const prompt = JSON.stringify(messages);
  assert.match(prompt, /道 → Dao/);
  assert.match(prompt, /德 → De/);
  const base = [{ id: "c0-b1", source: "道" }];
  assert.equal(
    translationCacheKey({ blocks: base, glossary }),
    translationCacheKey({ blocks: base, glossary: "道=Dao\n德=De" }),
  );
  assert.notEqual(
    translationCacheKey({ blocks: base, glossary }),
    translationCacheKey({ blocks: base, glossary: "道=Way\n德=De" }),
  );
});

test("source language detection distinguishes modern Chinese, English, German and classical Chinese", () => {
  assert.equal(detectSourceLanguage("今天我们去图书馆看书。这个周末的天气很好，适合出门。").language, "zh");
  assert.equal(detectSourceLanguage("The weather is good today and we will go to the library together.").language, "en");
  assert.equal(detectSourceLanguage("Der Bibliothekar ist nicht da und wir müssen auf die Straße gehen.").language, "de");
  // Classical Chinese is a manual style choice, not a separate detected language.
  assert.equal(detectSourceLanguage("学而时习之，不亦说乎？有朋自远方来，不亦乐乎？").language, "zh");
});

test("book-level language detection outvotes a large English license chapter", () => {
  const license = "The Project Gutenberg eBook of this ebook is for the use of anyone anywhere in the United States and most other parts of the world at no cost and with almost no restrictions whatsoever. You may copy it, give it away or re-use it under the terms of the Project Gutenberg License included with this ebook or online at www.gutenberg.org.";
  const chapters = [
    { title: "Project Gutenberg License", text: license },
    { title: "第一章", text: "道可道，非常道。名可名，非常名。" },
    { title: "第二章", text: "天下皆知美之为美，斯恶已；皆知善之为善，斯不善已。" },
    { title: "第三章", text: "不尚贤，使民不争；不贵难得之货，使民不为盗。" },
  ];
  assert.equal(detectBookLanguage(chapters).language, "zh");
});

test("translation prompt asks for stable IDs and target language", () => {
  const messages = buildBookTranslationMessages({
    blocks: [{ id: "c0-b1", source: "你好" }],
    direction: "zh-en",
    bookTitle: "测试书",
    chapterTitle: "第一章",
  });
  assert.match(messages[0].content, /中文.*English/);
  assert.match(messages[1].content, /c0-b1/);
  assert.match(messages[1].content, /"translations"/);
  const classical = buildBookTranslationMessages({
    blocks: [{ id: "c0-b1", source: "学而时习之" }],
    direction: "wenyan-zh",
  });
  assert.match(classical[0].content, /文言文/);
  assert.match(classical[0].content, /现代汉语/);
});

test("line alignment translates multiline blocks as stable line jobs", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-translate-lines-"));
  const calls = [];
  const aiRuntime = {
    async stream(request) {
      calls.push(request);
      return {
        ok: true,
        answer: JSON.stringify({
          translations: [
            { id: "c0-b1-l1", text: "Hello" },
            { id: "c0-b1-l2", text: "World" },
            { id: "c0-b2", text: "Plain" },
          ],
        }),
      };
    },
  };
  const config = { id: "local", base: "http://127.0.0.1", model: "test", key: "" };
  const translator = createBookTranslator({ aiRuntime });
  const result = await translator.translateBook({
    chapters: [{ title: "", text: "hello\nworld\n\nplain", markdown: true }],
    translation: { direction: "zh-en", config, lineAlign: true },
    workRoot,
  });
  assert.equal(result.chapters[0].blocks[0].translation, "Hello\nWorld");
  assert.equal(result.chapters[0].blocks[1].translation, "Plain");
  assert.match(JSON.stringify(calls[0].messages), /逐行对齐/);
  assert.match(JSON.stringify(calls[0].messages), /c0-b1-l1/);
  compareLineAlignCacheKeys();
});

function compareLineAlignCacheKeys() {
  const blocks = [{ id: "c0-b1", source: "hello\nworld" }];
  assert.notEqual(
    translationCacheKey({ blocks, lineAlign: true }),
    translationCacheKey({ blocks, lineAlign: false }),
  );
}

test("book translator caches chunks and resumes without another model call", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-translate-"));
  const calls = [];
  const aiRuntime = {
    async stream(request) {
      calls.push(request);
      return {
        ok: true,
        answer: JSON.stringify({
          translations: [
            { id: "c0-title", text: "Chapter" },
            { id: "c0-b1", text: "Hello" },
            { id: "c0-b2", text: "World" },
          ],
        }),
      };
    },
  };
  const config = { id: "local", base: "http://127.0.0.1", model: "test", key: "" };
  const translation = { direction: "zh-en", config, bookTitle: "T", glossary: "你好=Hello" };
  const chapters = [{ title: "Chapter", text: "你好\n\n世界", markdown: false }];
  const translator = createBookTranslator({ aiRuntime });
  const first = await translator.translateBook({ chapters, translation, workRoot });
  assert.equal(first.stats.calls, 1);
  assert.equal(first.chapters[0].translatedTitle, "Chapter");
  assert.equal(first.chapters[0].blocks[0].translation, "Hello");
  assert.equal(first.chapters[0].blocks[1].translation, "World");
  assert.match(JSON.stringify(calls[0].messages), /你好 → Hello/);
  assert.match(translationCacheKey({ blocks: [{ id: "c0-b1", source: "你好" }], direction: "zh-en", model: "test", configId: "local", base: "http://local" }), /^[a-f0-9]{40}$/);
  const second = await translator.translateBook({ chapters, translation, workRoot });
  assert.equal(second.stats.calls, 0);
  assert.equal(calls.length, 1);
  fs.rmSync(workRoot, { recursive: true, force: true });
});
