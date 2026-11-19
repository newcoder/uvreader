import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPolishMarkdown,
  deletePolishMarker,
  insertPolishMarker,
  parsePolishMarkdown,
  refreshPolishBodyMarkers,
} from "../src/shared/polish-markdown.js";

function sample() {
  return buildPolishMarkdown({
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
}

test("inserting a marker renumbers the following body markers and links the note", () => {
  const markdown = sample();
  const missing = /<sup>2<\/sup><!-- polish:marker marker-001-002[^>]*-->/.exec(markdown);
  assert.ok(missing);
  const offset = missing.index;
  const broken = `${markdown.slice(0, offset)}${markdown.slice(offset + missing[0].length)}`;
  const result = insertPolishMarker(broken, offset, { id: "marker-manual-test" });
  assert.equal(result.ok, true);
  assert.equal(result.label, "2");
  assert.equal(result.id, "marker-manual-test");

  const parsed = parsePolishMarkdown(result.markdown);
  assert.equal(parsed.markers.length, 4);
  assert.deepEqual(parsed.markers.map((marker) => marker.label), ["1", "2", "3", "4"]);
  assert.equal(parsed.markers[1].note, "note-002");
  assert.equal(parsed.notes.filter((note) => !parsed.markers.some((marker) => marker.note === note.id)).length, 0);
});

test("inserting a marker into a grouped notes book renumbers that chapter's later markers", () => {
  const { markdown } = buildPolishMarkdown({
    title: "测试书",
    chapters: [
      { title: "第一章 观察者", text: "正文一 $^{1}$。正文二 $^{2}$。" },
      { title: "第二章 土地", text: "正文三 $^{1}$。正文四 $^{2}$。" },
      {
        title: "注释",
        text: [
          "## 第一章: 观察者",
          "",
          "1、第一章注一。",
          "",
          "2、第一章注二。",
          "",
          "## 第二章: 土地",
          "",
          "1、第二章注一。",
          "",
          "2、第二章注二。",
          "",
          "3、第二章注三。",
        ].join("\n"),
      },
    ],
  });
  const second = /<sup>2<\/sup><!-- polish:marker marker-002-002[^>]*-->/.exec(markdown);
  assert.ok(second);
  const result = insertPolishMarker(markdown, second.index - 1, { id: "marker-manual-grouped" });
  assert.equal(result.ok, true);
  const parsed = parsePolishMarkdown(result.markdown);
  const chapterTwo = parsed.markers.filter((marker) => marker.chapter === "ch-002");
  assert.deepEqual(chapterTwo.map((marker) => marker.label), ["1", "2", "3"], "这一章后面的标注也要顺延");
  assert.deepEqual(chapterTwo.map((marker) => marker.note), ["note-003", "note-004", "note-005"]);
  assert.equal(chapterTwo[1].id, "marker-manual-grouped");
});

test("refreshPolishBodyMarkers maps a note group across page-internal headings", () => {
  const { markdown } = buildPolishMarkdown({
    title: "测试书",
    chapters: [
      { title: "前言", text: "前言正文 $^{1}$。" },
      { title: "第三章 寡妇", text: "正文一 $^{1}$。\n\n## 彭\n\n正文二 $^{2}$。" },
      {
        title: "注释",
        text: [
          "## 前言",
          "",
          "1、前言注。",
          "",
          "## 第三章: 寡妇",
          "",
          "1、寡妇注一。",
          "",
          "2、寡妇注二。",
        ].join("\n"),
      },
    ],
  });
  const broken = markdown
    .replace(/ note=note-\d+/g, "")
    .replace(/linked=true alignment=group/g, "linked=false alignment=none");
  const result = refreshPolishBodyMarkers(broken, {
    chapterTitles: ["前言", "第三章 寡妇", "注释"],
  });
  const parsed = parsePolishMarkdown(result.markdown);
  assert.deepEqual(parsed.markers.map((marker) => marker.note), [undefined, "note-002", "note-003"]);
});

test("deleting a marker renumbers the following markers and unlinks the extra note", () => {
  const markdown = sample();
  const marker = /<sup>2<\/sup><!-- polish:marker marker-001-002[^>]*-->/.exec(markdown);
  assert.ok(marker);
  const result = deletePolishMarker(markdown, marker.index + 8);
  assert.equal(result.ok, true);
  assert.equal(result.label, "2");

  const parsed = parsePolishMarkdown(result.markdown);
  assert.equal(parsed.markers.length, 3);
  assert.deepEqual(parsed.markers.map((item) => item.label), ["1", "2", "3"]);
  const linked = new Set(parsed.markers.map((item) => item.note));
  assert.equal(linked.has("note-002"), true);
  assert.equal(linked.has("note-003"), true);
  assert.equal(linked.has("note-004"), false);
});

test("refreshing fills an unnumbered note before it duplicates the next number", () => {
  const broken = sample()
    .replace('<!-- polish:note note-002 chapter=ch-001 page=0 label="2"', '<!-- polish:note note-002 chapter=ch-001 page=0 label=""')
    .replace('<!-- polish:note note-003 chapter=ch-001 page=0 label="3"', '<!-- polish:note note-003 chapter=ch-001 page=0 label="2"')
    .replace('<!-- polish:note note-004 chapter=ch-001 page=0 label="4"', '<!-- polish:note note-004 chapter=ch-001 page=0 label="3"')
    .replace('label="3" note=note-003', 'label="2" note=note-003')
    .replace('label="4" note=note-004', 'label="3" note=note-004');
  const result = refreshPolishBodyMarkers(broken);
  assert.equal(result.count, 2, "the duplicate marker and the following marker are both updated");
  const parsed = parsePolishMarkdown(result.markdown);
  assert.deepEqual(parsed.notes.map((note) => note.label), ["1", "2", "3", "4"]);
  assert.deepEqual(parsed.markers.map((marker) => marker.label), ["1", "2", "3", "4"]);
  assert.equal(parsed.markers[1].note, "note-002");
  assert.equal(new Set(parsed.markers.map((marker) => marker.label)).size, 4);
});

test("marker editing refuses a position with no marker or inside an existing one", () => {
  const markdown = sample();
  assert.equal(deletePolishMarker(markdown, 0).ok, false);
  const marker = /<sup>2<\/sup><!-- polish:marker marker-001-002[^>]*-->/.exec(markdown);
  assert.ok(marker);
  assert.equal(insertPolishMarker(markdown, marker.index + 10).ok, false);
});
