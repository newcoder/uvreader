import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendTranslationSuffix,
  buildBookTranslationMessages,
  normalizeBookTranslationDirection,
  parseBookTranslationAnswer,
  scriptOutputSuffix,
  splitTranslationBlocks,
  translationLanguagePair,
  translationOutputSuffix,
} from "../src/shared/book-translation.js";
import { createBookTranslator, translationCacheKey } from "../src/main/book-translate.js";
import { detectSourceLanguage } from "../src/shared/language-detect.js";

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
});

test("source language detection distinguishes modern Chinese, English, German and classical Chinese", () => {
  assert.equal(detectSourceLanguage("今天我们去图书馆看书。这个周末的天气很好，适合出门。").language, "zh");
  assert.equal(detectSourceLanguage("The weather is good today and we will go to the library together.").language, "en");
  assert.equal(detectSourceLanguage("Der Bibliothekar ist nicht da und wir müssen auf die Straße gehen.").language, "de");
  // Classical Chinese is a manual style choice, not a separate detected language.
  assert.equal(detectSourceLanguage("学而时习之，不亦说乎？有朋自远方来，不亦乐乎？").language, "zh");
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
  const translation = { direction: "zh-en", config, bookTitle: "T" };
  const chapters = [{ title: "Chapter", text: "你好\n\n世界", markdown: false }];
  const translator = createBookTranslator({ aiRuntime });
  const first = await translator.translateBook({ chapters, translation, workRoot });
  assert.equal(first.stats.calls, 1);
  assert.equal(first.chapters[0].translatedTitle, "Chapter");
  assert.equal(first.chapters[0].blocks[0].translation, "Hello");
  assert.equal(first.chapters[0].blocks[1].translation, "World");
  assert.match(translationCacheKey({ blocks: [{ id: "c0-b1", source: "你好" }], direction: "zh-en", model: "test", configId: "local", base: "http://local" }), /^[a-f0-9]{40}$/);
  const second = await translator.translateBook({ chapters, translation, workRoot });
  assert.equal(second.stats.calls, 0);
  assert.equal(calls.length, 1);
  fs.rmSync(workRoot, { recursive: true, force: true });
});
