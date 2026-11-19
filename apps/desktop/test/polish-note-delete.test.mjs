import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPolishMarkdown,
  collectNoteTexts,
  deletePolishNote,
  mergePolishNoteIntoNext,
  mergePolishNoteIntoPrevious,
  parsePolishMarkdown,
  refreshPolishBodyMarkers,
} from "../src/shared/polish-markdown.js";

function withManualNote() {
  const base = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "测试章",
      text: [
        "正文一 $^{1}$ 正文二 $^{2}$ 正文三 $^{3}$ 正文四 $^{4}$",
        "",
        "注释:",
        "",
        "1、第一条，1页。",
        "",
        "2、第二条，2页。",
        "",
        "3、第三条，3页。",
      ].join("\n"),
    }],
  }).markdown;
  const first = base.indexOf("<!-- polish:note note-001");
  const insertAt = base.indexOf("\n\n", first);
  const manual = "<!-- polish:note note-manual chapter=ch-001 page=0 label=\"\" linked=false alignment=none -->\n关于曹子猷之为皇室侍卫，参见《艮斋倦稿》。";
  return refreshPolishBodyMarkers(`${base.slice(0, insertAt)}\n\n${manual}${base.slice(insertAt)}`).markdown;
}

test("merging a note appends its text to the previous note and closes the gap", () => {
  const result = mergePolishNoteIntoPrevious(withManualNote(), "note-manual");
  assert.equal(result.ok, true);
  assert.equal(result.previousId, "note-001");
  const parsed = parsePolishMarkdown(result.markdown);
  const texts = collectNoteTexts(result.markdown);
  assert.deepEqual(parsed.notes.map((note) => note.label), ["1", "2", "3"]);
  assert.equal(parsed.notes.some((note) => note.id === "note-manual"), false);
  assert.match(texts.get("note-001") || "", /关于曹子猷之为皇室侍卫/);
  assert.equal(parsed.markers.length, 3);
  assert.deepEqual(parsed.markers.map((marker) => marker.label), ["1", "2", "3"]);
  assert.equal(parsed.markers.some((marker) => marker.note === "note-manual"), false);
});

test("merging the next note appends its text to the current note without touching the previous one", () => {
  const base = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "测试章",
      text: [
        "正文一 $^{1}$ 正文二 $^{2}$ 正文三 $^{3}$ 正文四 $^{4}$",
        "",
        "注释:",
        "",
        "1、第一条，1页。",
        "",
        "2、第二条，2页。",
        "",
        "3、第三条，3页。",
        "",
        "4、第四条，4页。",
      ].join("\n"),
    }],
  }).markdown;
  const result = mergePolishNoteIntoNext(base, "note-001");
  assert.equal(result.ok, true);
  assert.equal(result.removedId, "note-002");
  const parsed = parsePolishMarkdown(result.markdown);
  const texts = collectNoteTexts(result.markdown);
  assert.deepEqual(parsed.notes.map((note) => note.label), ["1", "2", "3"]);
  assert.equal(parsed.notes.some((note) => note.id === "note-002"), false);
  assert.match(texts.get("note-001") || "", /第一条/);
  assert.match(texts.get("note-001") || "", /第二条/);
  assert.doesNotMatch(texts.get("note-003") || "", /第二条/);
  assert.deepEqual(parsed.markers.map((marker) => marker.label), ["1", "2", "3"]);
  assert.equal(parsed.markers[0].note, "note-001");
});

test("deleting a note removes its text and body marker and closes the gap", () => {
  const result = deletePolishNote(withManualNote(), "note-manual");
  assert.equal(result.ok, true);
  const parsed = parsePolishMarkdown(result.markdown);
  const texts = collectNoteTexts(result.markdown);
  assert.deepEqual(parsed.notes.map((note) => note.label), ["1", "2", "3"]);
  assert.equal(parsed.notes.some((note) => note.id === "note-manual"), false);
  assert.doesNotMatch(texts.get("note-001") || "", /关于曹子猷之为皇室侍卫/);
  assert.equal(parsed.markers.length, 3);
  assert.deepEqual(parsed.markers.map((marker) => marker.label), ["1", "2", "3"]);
});

test("merging the first note is refused", () => {
  const result = mergePolishNoteIntoPrevious(withManualNote(), "note-001");
  assert.equal(result.ok, false);
  assert.match(result.error, /第一条/);
});
