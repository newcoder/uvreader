import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import { translateEpub } from "../src/main/epub-translate.js";
import { isChapterHeading } from "../src/main/text-book.js";
import { splitTranslationBlocks } from "../src/shared/book-translation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const starterRoot = path.resolve(here, "../../../assets/starter-books");

function fakeTranslator() {
  return {
    async translateBook({ chapters = [] } = {}) {
      let translatedBlocks = 0;
      const translated = chapters.map((chapter, chapterIndex) => ({
        index: chapterIndex,
        title: chapter.title,
        translatedTitle: "",
        blocks: splitTranslationBlocks(chapter.text, {
          markdown: chapter.markdown,
          chapterIndex,
        }).map((block) => {
          translatedBlocks += 1;
          return {
            ...block,
            // Keep chapter titles identical so the title de-duplication path
            // is exercised without spending real AI tokens.
            translation: isChapterHeading(block.source) ? block.source : `【译】${block.source}`,
          };
        }),
      }));
      return {
        chapters: translated,
        stats: { translatedBlocks, cachedChunks: 0, chunks: chapters.length, calls: 0, chars: 0 },
      };
    },
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findNavName(names) {
  return names.find((name) => /(?:^|\/)nav\.xhtml$/i.test(name)) || "";
}

function findChapters(bookDir) {
  return fs.readdirSync(bookDir)
    .filter((name) => /\.epub$/i.test(name))
    .sort();
}

test("real starter books survive the EPUB translation structure matrix", async () => {
  const books = findChapters(starterRoot);
  assert.ok(books.length >= 5, "the repository should have starter books to test");
  const outDir = tempDir("qbr-translation-acceptance-");
  const reports = [];
  const outputs = new Map();

  for (const name of books) {
    const source = path.join(starterRoot, name);
    const sourceBytes = fs.readFileSync(source);
    const out = path.join(outDir, name.replace(/\.epub$/i, "-stacked.epub"));
    outputs.set(name, out);
    const result = await translateEpub({
      source,
      out,
      translator: fakeTranslator(),
      mode: "stacked",
      direction: "auto",
      config: {},
    });
    assert.ok(fs.existsSync(out), name);
    assert.deepEqual(fs.readFileSync(source), sourceBytes, `${name} source must stay untouched`);

    const sourceZip = await JSZip.loadAsync(sourceBytes);
    const outputZip = await JSZip.loadAsync(fs.readFileSync(out));
    assert.deepEqual(Object.keys(outputZip.files).sort(), Object.keys(sourceZip.files).sort(), `${name} keeps the same EPUB entries`);
    assert.equal(result.spineCount, (await sourceZip.file(Object.keys(sourceZip.files).find((entry) => entry.endsWith(".opf"))).async("string")).match(/<itemref\b/gi)?.length || 0, `${name} keeps its spine`);

    const opfName = Object.keys(outputZip.files).find((entry) => entry.endsWith(".opf"));
    const opf = await outputZip.file(opfName).async("string");
    assert.match(opf, /（中英对照）/, `${name} gets a bilingual title suffix`);
    const navName = findNavName(Object.keys(outputZip.files));
    if (navName) {
      const sourceNav = await sourceZip.file(navName).async("string");
      const outputNav = await outputZip.file(navName).async("string");
      assert.equal(outputNav, sourceNav, `${name} nav is copied without injected translation blocks`);
    }
    reports.push({ name, spine: result.spineCount, blocks: result.stats.translatedBlocks });
  }

  const daodejing = path.join(starterRoot, "7337.epub");
  const daodejingOut = outputs.get("7337.epub");
  const daodejingZip = await JSZip.loadAsync(fs.readFileSync(daodejingOut));
  const s4 = await daodejingZip.file("EPUB/s4.xhtml").async("string");
  assert.match(s4, /<p>第五章<\/p>/);
  assert.doesNotMatch(s4, /class="qbr-epub-title-translation"/, "a same-script chapter title is not duplicated");
  assert.match(s4, /class="qbr-epub-translation"/, "body translations are still inserted");
  assert.ok(fs.existsSync(daodejing));

  const tang = path.join(starterRoot, "52323.epub");
  const tangOut = outputs.get("52323.epub");
  const preview = await translateEpub({
    source: daodejing,
    translator: fakeTranslator(),
    mode: "stacked",
    direction: "auto",
    config: {},
    preview: true,
    previewFiles: 2,
  });
  assert.equal(preview.output, "");
  assert.equal(preview.previewFiles, 2);
  assert.match(preview.previewHtml, /<!doctype html>/);
  assert.match(preview.previewHtml, /class="qbr-epub-translation"/);
  assert.doesNotMatch(preview.previewHtml, /class="qbr-epub-title-translation"/);

  const tangSource = await JSZip.loadAsync(fs.readFileSync(tang));
  const tangOutput = await JSZip.loadAsync(fs.readFileSync(tangOut));
  const s0Name = Object.keys(tangSource.files).find((entry) => /s0\.xhtml$/i.test(entry));
  assert.ok(s0Name);
  const sourceS0 = await tangSource.file(s0Name).async("string");
  const outputS0 = await tangOutput.file(s0Name).async("string");
  const poemStart = sourceS0.indexOf("<p>唐詩三百首");
  const poemEnd = sourceS0.indexOf("</p>", poemStart);
  const sourcePoem = poemStart >= 0 && poemEnd >= 0 ? sourceS0.slice(poemStart, poemEnd + 4) : "";
  assert.ok(sourcePoem, "fixture contains a line-broken poem paragraph");
  assert.ok(outputS0.includes(sourcePoem), "the original poem paragraph and its line breaks are preserved");
  assert.match(outputS0, /class="qbr-epub-translation"/);

  assert.ok(reports.length >= 5);
});
