import assert from "node:assert/strict";
import test from "node:test";

import { collectNoteTexts, mergePolishNoteTexts, parsePolishMarkdown } from "../src/shared/polish-markdown.js";

function markdownWithNotes(notes) {
  return [
    "# 测试书",
    "",
    "## 第一章 观察者",
    "",
    '正文 <sup>1</sup><!-- polish:marker marker-001-001 chapter=ch-001 page=0 label="1" note=note-001 -->。',
    '正文 <sup>2</sup><!-- polish:marker marker-001-002 chapter=ch-001 page=0 label="2" note=note-002 -->。',
    "",
    "## 注释",
    "",
    "## 第一章: 观察者",
    "",
    ...notes.flatMap((note) => [
      `<!-- polish:note ${note.id} chapter=ch-002 page=0 label="${note.label}" linked=true alignment=group group="第一章: 观察者" -->`,
      `<!-- polish:point point-${note.id} kind=note-unlinked note=${note.id} page=0 -->`,
      `${note.label}、${note.text}`,
      "",
    ]),
  ].join("\n");
}

test("mergePolishNoteTexts brings corrected note text into the new polish file", () => {
  const oldMarkdown = markdownWithNotes([
    { id: "note-001", label: "1", text: "旧注一，已校对。" },
    { id: "note-002", label: "2", text: "旧注二，已校对。" },
  ]);
  const newMarkdown = markdownWithNotes([
    { id: "note-001", label: "1", text: "新注一，OCR。" },
    { id: "note-002", label: "2", text: "新注二，OCR。" },
  ]);
  const result = mergePolishNoteTexts(oldMarkdown, newMarkdown);
  const texts = collectNoteTexts(result.markdown);
  assert.equal(texts.get("note-001"), "1、旧注一，已校对。");
  assert.equal(texts.get("note-002"), "2、旧注二，已校对。");
  assert.equal(result.updates, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(parsePolishMarkdown(result.markdown).points.length, 2, "修正点注释不能丢");
  assert.deepEqual(
    parsePolishMarkdown(result.markdown).markers.map((marker) => marker.note),
    ["note-001", "note-002"],
    "新文件的正文链接不能变",
  );
});

test("mergePolishNoteTexts splits an old merged note back into the two new notes", () => {
  const oldMarkdown = markdownWithNotes([
    { id: "note-001", label: "1", text: "旧注一，已校对。旧注二，已校对。" },
  ]);
  const newMarkdown = markdownWithNotes([
    { id: "note-001", label: "1", text: "新注一，OCR。" },
    { id: "note-002", label: "2", text: "旧注二，已校对。" },
  ]);
  const result = mergePolishNoteTexts(oldMarkdown, newMarkdown);
  const texts = collectNoteTexts(result.markdown);
  assert.equal(texts.get("note-001"), "1、旧注一，已校对。");
  assert.equal(texts.get("note-002"), "2、旧注二，已校对。");
  assert.equal(result.updates, 2);
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(texts.get("note-001"), /旧注二/);
});
