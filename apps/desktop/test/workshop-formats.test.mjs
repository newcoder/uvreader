import assert from "node:assert/strict";
import test from "node:test";

import { DOCVORTEX_FORMATS, DOCVORTEX_INPUTS, EBOOK_TARGETS, TEXT_SOURCE_EXTENSIONS, WORKSHOP_PICK_EXTENSIONS, docvortexFormatExt, ebookTargetExt, textSourceKind } from "../src/shared/workshop-formats.js";
import { extractionKind } from "../src/shared/extract-formats.js";

test("the pick dialog offers Office/ODF/OFD/text/image documents", () => {
  for (const ext of ["docx", "pptx", "xlsx", "odt", "ods", "odp", "ofd", "epub", "pdf", "txt", "md", "png"]) {
    assert.ok(WORKSHOP_PICK_EXTENSIONS.includes(ext), `${ext} should be pickable`);
  }
  assert.equal(new Set(WORKSHOP_PICK_EXTENSIONS).size, WORKSHOP_PICK_EXTENSIONS.length, "no duplicates");
});

test("format conversion keeps document targets only", () => {
  const ids = DOCVORTEX_FORMATS.map((format) => format.id);
  assert.ok(ids.includes("docx") && ids.includes("pdf") && ids.includes("markdown"));
  assert.ok(!ids.includes("structured_content"), "JSON belongs to 内容提取");
  assert.ok(!ids.includes("epub"), "e-book outputs belong to 电子书制作");
  assert.equal(docvortexFormatExt("markdown"), "md");
  assert.equal(docvortexFormatExt("structured_content"), "structured_content", "unknown ids fall back to the raw value");
  assert.ok(DOCVORTEX_INPUTS.includes("ofd") && DOCVORTEX_INPUTS.includes("epub"), "books can still be conversion inputs");
});

test("textSourceKind spots Markdown and plain text, and nothing else", () => {
  assert.equal(textSourceKind("D:/downloads/System control computer_rev1.md"), "markdown");
  assert.equal(textSourceKind("Books/书稿.MARKDOWN"), "markdown");
  assert.equal(textSourceKind("D:/notes/说明.txt"), "text");
  assert.equal(textSourceKind("Books/论文.docx"), "");
  assert.equal(textSourceKind("Books/无扩展名"), "");
  assert.deepEqual(TEXT_SOURCE_EXTENSIONS, ["md", "markdown", "txt"]);
  // 这两个源 DocVortex 收不了(见 main/docvortex.js 的 textSourceHtml),但不是「提取不了」:
  assert.equal(extractionKind("a.md"), "text", "提取走桥接而不是报「不支持」");
  assert.equal(extractionKind("a.txt"), "text");
});

test("ebook targets include KFX, and its label says boko is needed", () => {
  const ids = EBOOK_TARGETS.map((target) => target.id);
  assert.deepEqual(ids, ["azw3", "kfx", "mobi"], "AZW3 与 KFX 走 boko,MOBI 仍归 Calibre");
  const kfx = EBOOK_TARGETS.find((target) => target.id === "kfx");
  assert.match(kfx.label, /boko/, "KFX 的标签要说明它需要 boko(Calibre 写 KFX 要 Kindle Previewer)");
  assert.equal(ebookTargetExt("kfx"), "kfx");
  assert.equal(ebookTargetExt("azw3"), "azw3");
  assert.equal(ebookTargetExt("nope"), "nope", "未知目标退化成原样,不抛错");
});
