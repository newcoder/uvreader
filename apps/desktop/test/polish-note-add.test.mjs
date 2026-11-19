import assert from "node:assert/strict";
import test from "node:test";

import { nextPolishNoteNumber, renumberPolishNotes } from "../src/shared/polish-markdown.js";

function note(id, chapter, label, text) {
  return [
    `<!-- polish:note ${id} chapter=${chapter} page=0 label="${label}" linked=false alignment=none -->`,
    text,
  ].join("\n");
}

test("the next note number follows the previous note in the same block", () => {
  const markdown = [
    "## 第一章",
    note("note-001", "ch-001", "23", "23、上一条。"),
    "",
    note("note-manual", "ch-001", "", "无编号的这一条。"),
    "",
    note("note-002", "ch-001", "24", "24、下一条。"),
  ].join("\n");
  const result = nextPolishNoteNumber(markdown, "note-manual");
  assert.deepEqual(result, { ok: true, start: 24, previousId: "note-001" });
});

test("an unnumbered previous note asks the user to fix it first", () => {
  const markdown = [
    "## 第一章",
    note("note-001", "ch-001", "", "上一条也没编号。"),
    "",
    note("note-manual", "ch-001", "", "这一条。"),
  ].join("\n");
  const result = nextPolishNoteNumber(markdown, "note-manual");
  assert.equal(result.ok, false);
  assert.match(result.error, /上一条.*没有编号/);
});

test("the first note in a block starts at 1 and later notes shift", () => {
  const markdown = [
    "## 第一章",
    note("note-manual", "ch-001", "", "第一条。"),
    "",
    note("note-002", "ch-001", "1", "1、原来的第一条。"),
  ].join("\n");
  assert.equal(nextPolishNoteNumber(markdown, "note-manual").start, 1);
  const result = renumberPolishNotes(markdown, "note-manual", 1);
  assert.match(result.markdown, /note-manual[^>]*label="1"/);
  assert.match(result.markdown, /1、第一条。/);
  assert.match(result.markdown, /note-002[^>]*label="2"/);
  assert.match(result.markdown, /2、原来的第一条。/);
});
