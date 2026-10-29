import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {
  buildAutoTagMessages,
  normalizeAutoTagVocabulary,
  parseAutoTagAnswer,
} from "../packages/reader/src/library-auto-tag.js";
import { readEpubInfo } from "../packages/reader/src/library-book-info.js";

test("auto-tag vocabulary trims, deduplicates and limits tags", () => {
  assert.deepEqual(normalizeAutoTagVocabulary([" 历史 ", "历史", "", "文学", null]), ["历史", "文学"]);
  assert.equal(normalizeAutoTagVocabulary(Array.from({ length: 100 }, (_, index) => `tag-${index}`)).length, 80);
  assert.deepEqual(normalizeAutoTagVocabulary(null), []);
});

test("auto-tag prompt only offers the confirmed vocabulary", () => {
  const messages = buildAutoTagMessages({
    book: {
      basename: "活著.epub",
      title: "活著",
      author: "余华",
      description: "一个普通人在时代里的命运。",
      extension: "epub",
    },
    allowedTags: ["文学", "历史", "文学"],
    existingTags: ["导入"],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /只能使用给定标签/);
  assert.match(messages[1].content, /书名：活著/);
  assert.match(messages[1].content, /作者：余华/);
  assert.match(messages[1].content, /简介：一个普通人在时代里的命运。/);
  assert.match(messages[1].content, /- 文学/);
  assert.match(messages[1].content, /- 历史/);
  assert.equal((messages[1].content.match(/- 文学/g) || []).length, 1);
  assert.match(messages[1].content, /已有标签：导入/);
});

test("auto-tag parser accepts fenced or chatty JSON and filters bad tags", () => {
  assert.deepEqual(
    parseAutoTagAnswer('```json\n{"tags":["文学","不存在","历史","文学"]}\n```', ["文学", "历史"]),
    ["文学", "历史"],
  );
  assert.deepEqual(parseAutoTagAnswer('建议如下：{"tags":["历史"]} 完毕', ["历史"]), ["历史"]);
  assert.deepEqual(parseAutoTagAnswer('{"tags":[]}', ["历史"]), []);
  assert.deepEqual(parseAutoTagAnswer('{"tags":"历史"}', ["历史"]), ["历史"]);
  assert.deepEqual(parseAutoTagAnswer("not json", ["历史"]), []);
  assert.deepEqual(parseAutoTagAnswer('{"tags":["文学","历史","哲学","科学"]}', ["文学", "历史", "哲学", "科学"]), ["文学", "历史", "哲学"]);
});

test("auto-tag parser rejects tags not in the confirmed vocabulary", () => {
  assert.deepEqual(parseAutoTagAnswer('{"tags":["玄幻"]}', ["文学", "历史"]), []);
  assert.deepEqual(parseAutoTagAnswer('{"tags":[" 历史 "] }', ["历史"]), ["历史"]);
  assert.deepEqual(parseAutoTagAnswer('{"tags":["#历史"]}', ["历史"]), ["历史"]);
});

test("EPUB metadata is read from the container and OPF without opening a chapter", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata>
        <dc:title>Example &amp; Co</dc:title>
        <dc:creator>Ada Lovelace</dc:creator>
        <dc:creator>Charles Babbage</dc:creator>
        <dc:description><![CDATA[<p>A short <b>description</b>.</p>]]></dc:description>
        <dc:subject>Computing</dc:subject>
      </metadata>
    </package>`);
  zip.file("OEBPS/chapter.xhtml", "<html><body>Secret body text</body></html>");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  assert.deepEqual(await readEpubInfo(bytes), {
    title: "Example & Co",
    author: "Ada Lovelace / Charles Babbage",
    description: "A short description.",
    subjects: "Computing",
  });
});

test("EPUB metadata falls back to the first OPF in the archive", async () => {
  const zip = new JSZip();
  zip.file("book.opf", `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>No container</dc:title></metadata></package>`);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  assert.deepEqual(await readEpubInfo(bytes), {
    title: "No container",
    author: "",
    description: "",
    subjects: "",
  });
});
