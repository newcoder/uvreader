import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPolishMarkdown,
  buildPolishOutline,
  collectPolishNumbers,
  chapterAtOffset,
  collectNoteTexts,
  decoratePreviewNoterefs,
  derivePolishReport,
  fillEmptyMarkerNumbers,
  inferPolishChapterTitles,
  isNoteHeading,
  noteLabelNumber,
  normalizePolishToc,
  tidyOcrText,
  parsePolishMarkdown,
  refreshPolishBodyMarkers,
  renumberPolishMarkers,
  renumberPolishNotes,
  splitPolishMarkdown,
  stripPolishComments,
} from "../src/shared/polish-markdown.js";

test("the TOC repair restores numbered chapters and demotes their subsections", () => {
  const baseline = [
    "# 书名",
    "## 前言",
    "## 第一章 内务府",
    "## 八旗与包衣",
    "## 曹家的兴起",
    "## 第二章 北京与苏州，诗歌与社交",
    "## 上等阶层",
    "## 曹寅在北京",
    "## 附录一 原丝的价格",
    "## 参考书目",
  ].join("\n");
  const imported = [
    "# 书名",
    "## 第 1 章",
    "## 前言",
    "## 内务府",
    "## 八旗与包衣",
    "## 曹家的兴起",
    "## 北京与苏州， 诗歌与社交",
    "## 上等阶层",
    "## 曹寅在北京",
    "## 附录一 原丝的价格",
    "## 参考书目",
  ].join("\n");
  const expected = inferPolishChapterTitles(baseline);
  assert.deepEqual(expected, ["前言", "第一章 内务府", "第二章 北京与苏州，诗歌与社交", "附录一 原丝的价格", "参考书目"]);
  const normalized = normalizePolishToc(imported, { baselineMarkdown: baseline });
  assert.deepEqual(normalized.chapterTitles, ["封面", ...expected]);
  assert.match(normalized.markdown, /^## 封面$/m);
  assert.match(normalized.markdown, /^## 第一章 内务府$/m);
  assert.match(normalized.markdown, /^### 八旗与包衣$/m);
  assert.match(normalized.markdown, /^## 第二章 北京与苏州，诗歌与社交$/m);
  assert.match(normalized.markdown, /^### 上等阶层$/m);
  assert.match(normalized.markdown, /^## 附录一 原丝的价格$/m);
  assert.match(normalized.markdown, /^## 参考书目$/m);
  assert.doesNotMatch(normalized.markdown, /^## 八旗与包衣$/m);
});

test("the polish preview shows bracketed blue note markers", () => {
  assert.equal(
    decoratePreviewNoterefs("正文<sup>1</sup>与<sup> 12 </sup>。"),
    '正文<sup class="qbr-preview-noteref">[1]</sup>与<sup class="qbr-preview-noteref">[12]</sup>。',
  );
  assert.equal(decoratePreviewNoterefs("<sup>数学</sup>"), "<sup>数学</sup>", "only numeric note markers change");
  assert.equal(
    decoratePreviewNoterefs("正文<sup>1</sup>与<sup>2</sup>。", ["note-001", ""]),
    '正文<button type="button" class="qbr-preview-noteref qbr-preview-noteref-button" data-note-id="note-001" aria-label="查看注释 1">[1]</button>与<sup class="qbr-preview-noteref">[2]</sup>。',
  );
});

test("buildPolishMarkdown keeps pages across paragraphs and wraps notes", () => {
  const { markdown, report, notes, markers } = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "第一章",
      text: [
        "<!--page:52 printed:25-->",
        "正文里有一个上标 $^{㉞}$。",
        "",
        "注释:",
        "",
        "㉞ 《八旗满洲氏族通谱》，74卷，8b页。",
      ].join("\n"),
    }],
  });
  assert.match(markdown, /^# 测试书/m);
  assert.match(markdown, /^## 第一章/m);
  assert.match(markdown, /<sup>1<\/sup><!-- polish:marker marker-001-001 .*label="1"/);
  assert.match(markdown, /<!-- polish:note note-001 chapter=ch-001 page=25 label="1" linked=true/);
  assert.match(markdown, /1、《八旗满洲氏族通谱》，74卷，8b页。/);
  assert.doesNotMatch(markdown, /[①-⑳㉑-㉟㊱-㊿]/);
  assert.doesNotMatch(markdown, /polish:point/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].page, 25);
  assert.equal(notes[0].label, "1");
  assert.equal(notes[0].linked, true);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].canonical, 1);
  assert.equal(report.summary.notes, 1);
  assert.equal(report.summary.autoAccepted, 1);
  assert.equal(report.summary.needsReview, 0);
});

test("buildPolishMarkdown accepts 注 headings, bracketed labels and HTML sup markers", () => {
  const { notes, markers, report } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: [
        "正文一 <sup>1</sup>。正文二 <sup>2</sup>。",
        "",
        "注：",
        "",
        "[1] 第一条资料，1页。",
        "",
        "[2] 第二条资料，2页。",
      ].join("\n"),
    }],
  });
  assert.equal(notes.length, 2);
  assert.equal(markers.length, 2);
  assert.deepEqual(notes.map((note) => note.label), ["1", "2"]);
  assert.equal(notes[0].markerId, "marker-001-001");
  assert.equal(notes[1].markerId, "marker-001-002");
  assert.equal(report.points.length, 0);
});

test("buildPolishMarkdown treats a notes chapter title as a notes block and skips group headings", () => {
  const { notes, markers, report } = buildPolishMarkdown({
    chapters: [
      { title: "第一章 观察者", text: "正文一 $^{1}$。正文二 $^{2}$。" },
      {
        title: "注释",
        text: [
          ".",
          "",
          "## 第一章: 观察者",
          "",
          "1、第一章注一。",
          "",
          "2、第一章注二。",
        ].join("\n"),
      },
    ],
  });
  assert.equal(notes.length, 2);
  assert.equal(markers.length, 2);
  assert.equal(notes[0].markerId, "marker-001-001");
  assert.equal(notes[1].markerId, "marker-001-002");
  assert.equal(report.points.length, 0);
});

test("buildPolishMarkdown aligns each back-of-book note group to its own chapter", () => {
  const { notes, markers, report } = buildPolishMarkdown({
    chapters: [
      { title: "前言", text: "前言正文。" },
      { title: "第一章 观察者", text: "正文一 $^{1}$。正文二 $^{2}$。" },
      { title: "第二章 土地", text: "正文三 $^{1}$。" },
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
          "2、第二章注二没有标记。",
        ].join("\n"),
      },
    ],
  });
  assert.equal(notes.length, 4);
  assert.equal(markers.length, 3);
  assert.deepEqual(notes.map((note) => note.label), ["1", "2", "1", "2"]);
  assert.deepEqual(notes.map((note) => note.markerId), [
    "marker-002-001",
    "marker-002-002",
    "marker-003-001",
    null,
  ]);
  assert.equal(report.points.length, 1);
  assert.equal(report.points[0].noteId, notes[3].id);
  assert.equal(report.sequenceIssues.length, 1);
  assert.equal(report.sequenceIssues[0].chapterTitle, "第二章: 土地");
});

test("derivePolishReport points an unlinked grouped note at its body chapter", () => {
  const markdown = [
    "# 书",
    "",
    "## 前言",
    "",
    "前言正文。",
    "",
    "## 第一章 观察者",
    "",
    '正文 <sup>1</sup><!-- polish:marker marker-002-001 chapter=ch-002 page=0 label="1" note=note-002 -->。',
    "",
    "## 注释",
    "",
    "## 前言",
    "",
    '<!-- polish:note note-001 chapter=ch-003 page=0 label="1" linked=false alignment=none group="前言" -->',
    "1、前言注。",
    "",
    "## 第一章: 观察者",
    "",
    '<!-- polish:note note-002 chapter=ch-003 page=0 label="1" linked=true alignment=group group="第一章: 观察者" -->',
    "1、第一章注。",
  ].join("\n");
  const report = derivePolishReport(markdown, {}, {
    chapters: [
      { id: "ch-001", title: "前言" },
      { id: "ch-002", title: "第一章 观察者" },
      { id: "ch-003", title: "注释" },
    ],
  });
  const point = report.points.find((item) => item.noteId === "note-001");
  assert.equal(point.context.markerChapterId, "ch-001");
  assert.equal(point.context.markerChapterTitle, "前言");
  assert.match(point.title, /^前言：注号 1/);
  assert.match(point.reason, /“前言”分组/);
  assert.match(point.suggestions[0], /“前言”的正文/);
  // 旧报告里的空 markerChapterId 不能把重新计算出的跨章定位冲掉。
  const again = derivePolishReport(markdown, report, {
    chapters: [
      { id: "ch-001", title: "前言" },
      { id: "ch-002", title: "第一章 观察者" },
      { id: "ch-003", title: "注释" },
    ],
  });
  const againPoint = again.points.find((item) => item.noteId === "note-001");
  assert.equal(againPoint.context.markerChapterId, "ch-001");
});

test("buildPolishMarkdown accepts Notes headings", () => {
  const { notes } = buildPolishMarkdown({
    chapters: [{
      title: "Chapter 1",
      text: "Body $^{1}$.\n\nNotes:\n\n[1] First note, p. 1.",
    }],
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].label, "1");
});

test("isNoteHeading accepts Chinese and English footnote headings", () => {
  for (const text of ["注释", "注释：", "注 释", "注文", "注解:", "脚注", "尾注", "Notes", "Footnotes:", "Endnotes", "注释（续）", "【注释】", "[注释]", "## 【注释】"]) {
    assert.equal(isNoteHeading(text), true, text);
  }
  assert.equal(isNoteHeading("注释说明正文"), false);
});

test("buildPolishMarkdown accepts bracket, 注N and full-width labels plus nested sup tags", () => {
  const { notes, markers, report } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: [
        "正文一 <sup class=\"noteref\"><a href=\"#n1\">1</a></sup>。",
        "正文二 <sup>2</sup>。",
        "正文三 <sup>3</sup>。",
        "",
        "注解：",
        "",
        "〔1〕 第一条资料，1页。",
        "",
        "注2 第二条资料，2页。",
        "",
        "３、第三条资料，3页。",
      ].join("\n"),
    }],
  });
  assert.equal(notes.length, 3);
  assert.equal(markers.length, 3);
  assert.deepEqual(notes.map((note) => note.label), ["1", "2", "3"]);
  assert.equal(markers[0].label, "1", "nested sup tags should use the text label");
  assert.equal(report.points.length, 0);
  assert.equal(notes[0].markerId, "marker-001-001");
});

test("buildPolishMarkdown flags only structurally uncertain notes", () => {
  const { markdown, report } = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "第一章",
      text: [
        "<!--page:52-->",
        "正文里有两个上标 $^{㉞}$ 和 $^{㉟}$。",
        "",
        "注释:",
        "",
        "㉞ 《测试资料》，1页。",
        "",
        "㉟ 同一注号出现两次，2页。",
        "",
        "㉟ 重复引用是正常现象，不单独报点，3页。",
        "",
        "㊱ 找不到正文标记的注文，4页。",
      ].join("\n"),
    }],
  });
  assert.equal(report.summary.notes, 4);
  assert.equal(report.summary.needsReview, 2);
  assert.equal(report.summary.autoAccepted, 2);
  assert.equal(report.summary.unlinkedNotes, 2);
  assert.equal(report.points.length, 2);
  assert.equal(report.points[0].kind, "note-unlinked");
  assert.equal(report.points[0].noteId, "note-003");
  assert.match(report.points[0].reason, /本部分正文没有/);
  assert.equal(report.points[0].context.source, "chapter");
  assert.match(report.points[0].context.before, /正文里有两个上标/);
  assert.match(markdown, /<!-- polish:point point-001 kind=note-unlinked note=note-003 page=52 -->/);
});

test("buildPolishMarkdown keeps short notes inside an 注释 block", () => {
  const { notes, report } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: [
        "正文。",
        "",
        "注释:",
        "",
        "① 曹寅档案原件，2711号。",
        "",
        "② 另一条档案。",
      ].join("\n"),
    }],
  });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].label, "1");
  assert.equal(notes[1].label, "2");
  assert.equal(report.summary.needsReview, 2);
});

test("buildPolishMarkdown aligns a notes block to earlier chapters", () => {
  const { notes, report } = buildPolishMarkdown({
    chapters: [
      { title: "第一章", text: "甲 $^{①}$。\n\n乙 $^{②}$。" },
      { title: "第二章", text: "注释:\n\n① 第一条，1页。\n\n② 第二条，2页。" },
    ],
  });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].chapterId, "ch-002");
  assert.equal(notes[0].label, "1");
  assert.equal(notes[0].markerId, "marker-001-001");
  assert.equal(notes[1].markerId, "marker-001-002");
  assert.equal(report.points.length, 0);
});

test("buildPolishMarkdown flags notes beyond the available body markers", () => {
  const { notes, report } = buildPolishMarkdown({
    chapters: [
      { title: "第一章", text: "正文 $^{①}$。" },
      { title: "第二章", text: "注释:\n\n① 第一条，1页。\n\n② 第二条没有正文标记，2页。" },
    ],
  });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].markerId, "marker-001-001");
  assert.equal(report.points.length, 1);
  assert.equal(report.points[0].kind, "note-unlinked");
  assert.equal(report.points[0].noteId, "note-002");
  assert.match(report.points[0].title, /注号 2 没有对应的正文标记/);
  assert.equal(report.summary.chapterIssues, 1);
  assert.equal(report.sequenceIssues.length, 1);
  assert.match(report.sequenceIssues[0].message, /注文 2 条 \/ 正文标记 1 个/);
});

test("derivePolishReport removes a point once its note gets a body marker", () => {
  const markdown = [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文 <sup>1</sup><!-- polish:marker marker-001 chapter=ch-001 page=52 label=\"1\" note=note-001 -->",
    "",
    "<!-- polish:note note-001 chapter=ch-001 page=52 label=\"1\" linked=true alignment=ordinal -->",
    "1、注释。",
  ].join("\n");
  const report = {
    points: [{ id: "point-001", kind: "note-unlinked", noteId: "note-001", title: "旧修正点" }],
    summary: { needsReview: 1, autoAccepted: 0 },
  };
  const next = derivePolishReport(markdown, report, { chapters: [{ id: "ch-001", title: "第一章" }] });
  assert.deepEqual(next.points, []);
  assert.equal(next.summary.needsReview, 0);
  assert.equal(next.summary.unlinkedNotes, 0);
});

test("derivePolishReport keeps the original point id and context while it is still open", () => {
  const markdown = [
    "## 第一章",
    "",
    "<!-- polish:note note-001 chapter=ch-001 page=52 label=\"1\" linked=false -->",
    "1、没有正文标记。",
  ].join("\n");
  const report = {
    points: [{
      id: "point-001",
      kind: "note-unlinked",
      noteId: "note-001",
      title: "旧标题",
      context: { before: "前面的正文", after: "后面的正文", source: "chapter" },
    }],
    summary: {},
  };
  const next = derivePolishReport(markdown, report, { chapters: [{ id: "ch-001", title: "第一章" }] });
  assert.equal(next.points[0].id, "point-001");
  assert.equal(next.points[0].context.before, "前面的正文");
  assert.match(next.points[0].title, /注号 1/);
});

test("derivePolishReport adds a live point when a note loses its marker", () => {
  const markdown = [
    "## 第一章",
    "",
    "<!-- polish:note note-001 chapter=ch-001 page=52 label=\"1\" linked=false -->",
    "1、没有正文标记。",
  ].join("\n");
  const next = derivePolishReport(markdown, { points: [], summary: {} }, { chapters: [{ id: "ch-001", title: "第一章" }] });
  assert.equal(next.points.length, 1);
  assert.equal(next.points[0].id, "point-live-unlinked-note-001");
  assert.equal(next.points[0].kind, "note-unlinked");
  assert.match(next.points[0].suggestions.join("；"), /加标注/);
  assert.equal(next.summary.unlinkedNotes, 1);
});

test("derivePolishReport finds empty notes and duplicate labels", () => {
  const markdown = [
    "## 第一章",
    "",
    "正文 <sup>1</sup><!-- polish:marker marker-001 chapter=ch-001 label=\"1\" note=note-001 -->",
    "正文 <sup>1</sup><!-- polish:marker marker-002 chapter=ch-001 label=\"1\" note=note-002 -->",
    "",
    "<!-- polish:note note-001 chapter=ch-001 label=\"1\" linked=true -->",
    "1、",
    "",
    "<!-- polish:note note-002 chapter=ch-001 label=\"1\" linked=true -->",
    "1、有内容。",
  ].join("\n");
  const next = derivePolishReport(markdown, { points: [], summary: {} }, { chapters: [{ id: "ch-001", title: "第一章" }] });
  const kinds = next.points.map((point) => point.kind).sort();
  assert.deepEqual(kinds, ["note-duplicate", "note-empty"]);
  assert.equal(next.summary.emptyNotes, 1);
  assert.equal(next.summary.duplicateNotes, 1);
});

test("derivePolishReport recomputes chapter issues from the current text", () => {
  const markdown = [
    "## 第一章",
    "",
    "正文 <sup>1</sup><!-- polish:marker marker-001 chapter=ch-001 label=\"1\" -->",
    "",
    "## 第二章",
    "",
    "<!-- polish:note note-001 chapter=ch-002 label=\"1\" -->",
    "1、第一条。",
    "",
    "<!-- polish:note note-002 chapter=ch-002 label=\"2\" -->",
    "2、第二条。",
  ].join("\n");
  const next = derivePolishReport(markdown, { points: [], summary: {} }, { chapters: [{ id: "ch-001", title: "第一章" }, { id: "ch-002", title: "第二章" }] });
  assert.equal(next.sequenceIssues.length, 1);
  assert.equal(next.sequenceIssues[0].chapterId, "ch-002");
  assert.match(next.sequenceIssues[0].message, /相差 1/);
});

test("derivePolishReport flags a notes heading with no recognized note anchors", () => {
  const markdown = [
    "## 第一章",
    "",
    "正文。",
    "",
    "注释：",
    "",
    "1、这段注文没有被识别成注文定位。",
  ].join("\n");
  const next = derivePolishReport(markdown, { points: [], summary: {} }, { chapters: [{ id: "ch-001", title: "第一章" }] });
  const point = next.points.find((item) => item.kind === "notes-empty-block");
  assert.ok(point);
  assert.match(point.suggestions.join("；"), /注文是否带编号/);
  assert.equal(next.summary.emptyNoteBlocks, 1);
});

test("derivePolishReport flags a printed-TOC title that no longer matches a chapter", () => {
  const markdown = [
    "# 书",
    "",
    "## 第一章 内务府",
    "",
    "正文。",
    "",
    "## 曹寅之子曹顯",
    "",
    "正文。",
  ].join("\n");
  const manifest = {
    chapters: [{ id: "ch-001", title: "第一章 内务府" }, { id: "ch-002", title: "曹寅之子曹顯" }],
    nav: [
      { title: "第一章 内务府", file: "chapter-001.xhtml", level: 1 },
      { title: "曹寅之子曹颙", file: "chapter-002.xhtml", level: 1 },
    ],
  };
  const next = derivePolishReport(markdown, { points: [], summary: {} }, manifest);
  const tocPoints = next.points.filter((point) => point.kind.startsWith("toc-"));
  assert.equal(tocPoints.length, 1);
  assert.equal(tocPoints[0].kind, "toc-title-mismatch");
  assert.match(tocPoints[0].reason, /曹寅之子曹顯/);
  assert.equal(next.summary.tocIssues, 1);
});

test("derivePolishReport flags missing TOC entries and level jumps", () => {
  const markdown = [
    "# 书",
    "",
    "## 第一章 内务府",
    "",
    "正文。",
    "",
    "## 第二章 南巡",
    "",
    "正文。",
    "",
    "## 第三章 织造",
    "",
    "正文。",
  ].join("\n");
  const manifest = {
    chapters: [
      { id: "ch-001", title: "第一章 内务府" },
      { id: "ch-002", title: "第二章 南巡" },
      { id: "ch-003", title: "第三章 织造" },
    ],
    nav: [
      { title: "第一章 内务府", file: "chapter-001.xhtml", level: 1 },
      { title: "第二章 南巡", file: "chapter-002.xhtml", level: 3 },
    ],
  };
  const next = derivePolishReport(markdown, { points: [], summary: {} }, manifest);
  const kinds = next.points.filter((point) => point.kind.startsWith("toc-")).map((point) => point.kind);
  assert.ok(kinds.includes("toc-level-jump"));
  assert.ok(kinds.includes("toc-missing-entry"));
  assert.equal(next.summary.tocIssues, 2);
});

test("derivePolishReport accepts a parent TOC title that contains the chapter title", () => {
  const markdown = "# 书\n\n## 内务府\n\n正文。\n";
  const manifest = {
    chapters: [{ id: "ch-001", title: "内务府" }],
    nav: [{ title: "第一章 内务府", file: "chapter-001.xhtml", level: 1 }],
  };
  const next = derivePolishReport(markdown, { points: [], summary: {} }, manifest);
  assert.equal(next.points.filter((point) => point.kind.startsWith("toc-")).length, 0);
  assert.equal(next.summary.tocIssues, 0);
});

test("buildPolishMarkdown flags a first-number offset", () => {
  const { report } = buildPolishMarkdown({
    chapters: [
      { title: "第一章", text: "正文 $^{②}$。" },
      { title: "第二章", text: "注释:\n\n① 注号起始不一致，1页。" },
    ],
  });
  assert.equal(report.points.length, 0);
  assert.equal(report.summary.chapterIssues, 1);
  assert.match(report.sequenceIssues[0].message, /起始注号不一致/);
});

test("buildPolishMarkdown merges unlabeled continuations but keeps a new 同上 note", () => {
  const { notes, report } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: [
        "正文 $^{①}$ 和 $^{②}$。",
        "",
        "注释:",
        "",
        "① 第一条，1页。",
        "",
        "但是这一条还有续写。",
        "",
        "同上书，2页。",
      ].join("\n"),
    }],
  });
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /第一条/);
  assert.match(notes[0].text, /但是这一条还有续写/);
  assert.equal(notes[1].label, "2");
  assert.match(notes[1].text, /2、同上书，2页。/);
  assert.equal(report.points.length, 0);
});

test("buildPolishMarkdown leaves code fences alone", () => {
  const { notes } = buildPolishMarkdown({
    chapters: [{
      title: "代码",
      text: ["```", "① 这不是注文，是代码。", "```"].join("\n"),
    }],
  });
  assert.equal(notes.length, 0);
});

test("buildPolishMarkdown uses the book title for an untitled first chapter", () => {
  const { markdown } = buildPolishMarkdown({
    title: "Deep Learning in Label-free Cell Classification",
    chapters: [
      { title: "", text: "scientificreports\n\nOPEN\n\nAbstract text." },
      { title: "Results", text: "Result text." },
    ],
  });
  assert.match(markdown, /## Deep Learning in Label-free Cell Classification/);
  assert.doesNotMatch(markdown, /## 第 1 章/);
});

test("splitPolishMarkdown returns the book title and chapters", () => {
  const split = splitPolishMarkdown([
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文。",
    "",
    "## 第二章",
    "",
    "更多正文。",
  ].join("\n"));
  assert.equal(split.title, "测试书");
  assert.equal(split.chapters.length, 2);
  assert.equal(split.chapters[0].title, "第一章");
  assert.equal(split.chapters[0].text, "正文。");
  assert.equal(split.chapters[1].title, "第二章");
});

test("splitPolishMarkdown uses manifest chapter titles to ignore front matter and note groups", () => {
  const markdown = [
    "# 王氏之死",
    "",
    "## 前言",
    "",
    "前言正文。",
    "",
    "## 图书在版编目(CIP)数据",
    "",
    "CIP 数据。",
    "",
    "## 第一章 观察者",
    "",
    "正文一。",
    "",
    "## 蒲松龄对家庭争执了如指掌。",
    "",
    "正文二。",
    "",
    "## 注释",
    "",
    "<!-- polish:note note-001 chapter=ch-003 label=\"1\" linked=false -->",
    "1、注文一。",
    "",
    "## 第一章: 观察者",
    "",
    "<!-- polish:note note-002 chapter=ch-003 label=\"2\" linked=false -->",
    "2、注文二。",
    "",
    "## 参考书目",
    "",
    "书目。",
  ].join("\n");
  const split = splitPolishMarkdown(markdown, {
    chapterTitles: ["前言", "第一章 观察者", "注释", "参考书目"],
  });
  assert.deepEqual(split.chapters.map((chapter) => chapter.title), ["前言", "第一章 观察者", "注释", "参考书目"]);
  assert.match(split.chapters[1].text, /蒲松龄对家庭争执了如指掌/);
  assert.match(split.chapters[2].text, /第一章: 观察者/);
});

test("buildPolishOutline follows chapter titles and Markdown levels", () => {
  const markdown = [
    "# 书",
    "",
    "## 图书在版编目(CIP)数据",
    "",
    "## 前言",
    "",
    "### 说明",
    "",
    "## 第一章 观察者",
    "",
    "### 地震",
    "",
    "#### 城墙",
    "",
    "## 彭",
    "",
    "## 注释",
    "",
    "## 前言",
    "",
    '<!-- polish:note note-001 chapter=ch-004 page=0 label="1" linked=false -->',
    "1、注文。",
    "",
    "## 第一章: 观察者",
    "",
    '<!-- polish:note note-002 chapter=ch-004 page=0 label="1" linked=false -->',
    "1、注文。",
    "",
    "## 参考书目",
    "",
  ].join("\n");
  const outline = buildPolishOutline(markdown, {
    chapterTitles: ["前言", "第一章 观察者", "注释", "参考书目"],
  });
  assert.deepEqual(outline.map((item) => [item.title, item.level, item.kind]), [
    ["前言", 1, "chapter"],
    ["说明", 2, "section"],
    ["第一章 观察者", 1, "chapter"],
    ["地震", 2, "section"],
    ["城墙", 3, "section"],
    ["注释", 1, "chapter"],
    ["参考书目", 1, "chapter"],
  ]);
});

test("stripPolishComments keeps page anchors", () => {
  const clean = stripPolishComments([
    "<!--page:52-->",
    "<!-- polish:note note-001 page=52 -->",
    "正文。",
    "<!-- polish:marker marker-001 note=note-001 -->",
  ].join("\n"));
  assert.match(clean, /<!--page:52-->/);
  assert.doesNotMatch(clean, /polish:/);
  assert.match(clean, /正文。/);
});

test("chapterAtOffset finds the current chapter", () => {
  const markdown = [
    "# 书",
    "",
    "## 第一章",
    "",
    "甲。",
    "",
    "## 第二章",
    "",
    "乙。",
  ].join("\n");
  const chapter = chapterAtOffset(markdown, markdown.indexOf("乙。"));
  assert.equal(chapter.title, "第二章");
  assert.equal(chapter.text, "乙。");
});

test("collectNoteTexts reads edited note text and skips point comments", () => {
  const texts = collectNoteTexts([
    "<!-- polish:note note-001 page=52 label=\"㉟\" linked=false -->",
    "<!-- polish:point point-001 kind=note-unlinked note=note-001 page=52 -->",
    "㊱ 《测试资料》，2页。",
    "",
    "<!-- polish:note note-002 page=53 label=\"①\" linked=true -->",
    "① 另一条注文。",
  ].join("\n"));
  assert.equal(texts.get("note-001"), "㊱ 《测试资料》，2页。");
  assert.equal(texts.get("note-002"), "① 另一条注文。");
});

test("renumberPolishNotes updates a note and all following notes and markers", () => {
  const { markdown, notes } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: "正文 $^{①}$ 和 $^{②}$。\n\n注释:\n\n① 第一条，1页。\n\n② 第二条，2页。",
    }],
  });
  const markerByNote = new Map(notes.map((note) => [note.id, note.markerId]));
  const result = renumberPolishNotes(markdown, "note-002", 10, markerByNote);
  assert.equal(result.count, 1);
  assert.equal(result.labels.get("note-002"), 10);
  assert.match(result.markdown, /label="10"/);
  assert.match(result.markdown, /<sup>10<\/sup>/);
  assert.match(result.markdown, /10、第二条/);
  assert.match(result.markdown, /<sup>1<\/sup>/);
  assert.match(result.markdown, /1、第一条/);
  assert.doesNotMatch(result.markdown, /<sup>2<\/sup>/);

  const all = renumberPolishNotes(markdown, "note-001", 5, markerByNote);
  assert.equal(all.count, 2);
  assert.match(all.markdown, /<sup>5<\/sup>/);
  assert.match(all.markdown, /<sup>6<\/sup>/);
  assert.match(all.markdown, /5、第一条/);
  assert.match(all.markdown, /6、第二条/);
});

test("renumberPolishNotes fills a missing number and increments the following notes", () => {
  const markdown = [
    "<!-- polish:note note-001 chapter=ch-001 page=1 label=\"\" linked=false alignment=none -->",
    "同上书，143页。郑天挺，63页。",
    "",
    "<!-- polish:note note-002 chapter=ch-001 page=1 label=\"\" linked=false alignment=none -->",
    "例如《八旗通志》中包衣佐领名单。",
  ].join("\n");
  const result = renumberPolishNotes(markdown, "note-001", 24);
  assert.equal(result.count, 2);
  assert.match(result.markdown, /label="24"/);
  assert.match(result.markdown, /24、同上书，143页。/);
  assert.match(result.markdown, /label="25"/);
  assert.match(result.markdown, /25、例如《八旗通志》/);
});

test("refreshPolishBodyMarkers follows the current note number", () => {
  const { markdown, notes } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: "正文 $^{①}$ 和 $^{②}$。\n\n注释:\n\n① 第一条，1页。\n\n② 第二条，2页。",
    }],
  });
  const markerByNote = new Map(notes.map((note) => [note.id, note.markerId]));
  const renumbered = renumberPolishNotes(markdown, "note-002", 10, new Map()).markdown;
  assert.match(renumbered, /label="10"/);
  assert.match(renumbered, /<sup>2<\/sup>/); // marker 还没动
  const refreshed = refreshPolishBodyMarkers(renumbered);
  assert.equal(refreshed.count, 1);
  assert.match(refreshed.markdown, /<sup>10<\/sup>/);
  assert.match(refreshed.markdown, /polish:marker marker-001-002 .*label="10"/);
  assert.ok(markerByNote.get("note-002"));
});

test("collectPolishNumbers reads the visible note prefix and marker superscript", () => {
  const { markdown } = buildPolishMarkdown({
    chapters: [{
      title: "第一章",
      text: "正文 $^{①}$ 和 $^{②}$。\n\n注释:\n\n① 第一条，1页。\n\n② 第二条，2页。",
    }],
  });
  const numbers = collectPolishNumbers(markdown);
  assert.equal(numbers.notes.get("note-001").label, 1);
  assert.equal(numbers.notes.get("note-002").label, 2);
  assert.equal(numbers.notes.get("note-001").commentNumber, 1);
  assert.equal(numbers.markers.get("marker-001-001").label, 1);
  assert.equal(numbers.markers.get("marker-001-002").label, 2);
  const edited = markdown.replace("\n1、第一条", "\n7、第一条");
  const changed = collectPolishNumbers(edited);
  assert.equal(changed.notes.get("note-001").label, 7);
  assert.equal(changed.notes.get("note-001").commentNumber, 1);
  assert.equal(changed.notes.get("note-001").bodyLabel, "7");
});

test("renumberPolishMarkers shifts later unlinked markers and reuses repeated references", () => {
  const markdown = [
    "正文 <sup>1</sup><!-- polish:marker m1 chapter=ch-001 page=1 label=\"1\" note=note-001 -->",
    "正文 <sup>1</sup><!-- polish:marker m1b chapter=ch-001 page=1 label=\"1\" note=note-001 -->",
    "正文 <sup>2</sup><!-- polish:marker m2 chapter=ch-001 page=2 label=\"2\" note=note-002 -->",
    "正文 <sup>3</sup><!-- polish:marker m3 chapter=ch-001 page=3 label=\"3\" -->",
  ].join("\n");
  const result = renumberPolishMarkers(markdown, "m2", 10);
  assert.equal(result.changed, true);
  assert.match(result.markdown, /<sup>10<\/sup><!-- polish:marker m2 chapter=ch-001 page=2 label="10"/);
  assert.match(result.markdown, /<sup>11<\/sup><!-- polish:marker m3 chapter=ch-001 page=3 label="11"/);
  assert.match(result.markdown, /<sup>1<\/sup><!-- polish:marker m1 chapter=ch-001 page=1 label="1"/);
  const repeated = renumberPolishMarkers(markdown, "m1", 4);
  assert.match(repeated.markdown, /<sup>4<\/sup><!-- polish:marker m1 /);
  assert.match(repeated.markdown, /<sup>4<\/sup><!-- polish:marker m1b /);
  assert.match(repeated.markdown, /<sup>5<\/sup><!-- polish:marker m2 /);
  assert.match(repeated.markdown, /<sup>6<\/sup><!-- polish:marker m3 /);
});

test("parsePolishMarkdown reads note/point/marker comments", () => {
  const parsed = parsePolishMarkdown([
    "<!-- polish:note note-001 page=52 label=\"㉞\" -->",
    "<!-- polish:point point-001 kind=note-label note=note-001 page=52 -->",
    "<!-- polish:marker marker-001 note=note-001 page=25 -->",
  ].join("\n"));
  assert.deepEqual(parsed.notes, [{ id: "note-001", page: "52", label: "㉞" }]);
  assert.equal(parsed.points[0].kind, "note-label");
  assert.equal(parsed.markers[0].note, "note-001");
});

test("noteLabelNumber understands circles, arabic, full-width, 注N and stars", () => {
  assert.equal(noteLabelNumber("㉞"), 34);
  assert.equal(noteLabelNumber("㊶"), 41);
  assert.equal(noteLabelNumber("34"), 34);
  assert.equal(noteLabelNumber("３"), 3);
  assert.equal(noteLabelNumber("注4"), 4);
  assert.equal(noteLabelNumber("*"), null);
});

test("splitPolishMarkdown does not split a repeated running heading into an extra chapter", () => {
  const markdown = [
    "# 纳兰性德传",
    "",
    "## 序",
    "",
    "前面几页。",
    "",
    "## 总 序",
    "",
    "总序正文。",
    "",
    "## 序",
    "",
    "真正的序。",
    "",
    "## 第一章 生平",
    "",
    "正文。",
  ].join("\n");
  const split = splitPolishMarkdown(markdown, { chapterTitles: ["序", "第一章 生平"] });
  assert.deepEqual(split.chapters.map((chapter) => chapter.title), ["序", "第一章 生平"]);
  assert.match(split.chapters[0].text, /总序正文/);
  assert.match(split.chapters[0].text, /真正的序/);
});

test("fillEmptyMarkerNumbers fills a marker run from its explicit neighbour and drops bare brackets", () => {
  assert.equal(
    fillEmptyMarkerNumbers("“多情自古原多病。”[]“而今病向深秋”[]“同是恹恹多病人”[]“身世等浮萍”[]“端的为谁添病也” [5]"),
    "“多情自古原多病。”[1]“而今病向深秋”[2]“同是恹恹多病人”[3]“身世等浮萍”[4]“端的为谁添病也” [5]",
  );
  assert.equal(fillEmptyMarkerNumbers("正文里没有可推断的标记[]。"), "正文里没有可推断的标记。");
  assert.equal(fillEmptyMarkerNumbers("注释:\n\n1、这里[]是注文原文"), "注释:\n\n1、这里[]是注文原文");
});

test("tidyOcrText removes spaces between Chinese characters but keeps Latin spacing and code", () => {
  assert.equal(tidyOcrText("这 是 一句 话。"), "这是一句话。");
  assert.equal(tidyOcrText("AI 技术 is good， 但 不 能 乱 删 空格。"), "AI 技术 is good，但不能乱删空格。");
  assert.equal(tidyOcrText("`代 码 块`\n\n```\n代 码 块\n```"), "`代 码 块`\n\n```\n代 码 块\n```");
  assert.equal(
    tidyOcrText("欧阳修在《六一诗话》里记载了一个故事，说这位诗人写下了\n这样的句子。"),
    "欧阳修在《六一诗话》里记载了一个故事，说这位诗人写下了这样的句子。",
  );
  assert.equal(tidyOcrText("短句\n下一句。"), "短句\n下一句。");
});

test("tidyOcrText drops paragraph-level bold but keeps short emphasis", () => {
  assert.equal(
    tidyOcrText("正常 **重点** 文本，**这是一个很长的加粗句子，包含标点。**结束。"),
    "正常**重点**文本，这是一个很长的加粗句子，包含标点。结束。",
  );
  assert.equal(tidyOcrText("**所有粗体都去掉**", { bold: "all" }), "所有粗体都去掉");
  assert.equal(tidyOcrText("残留**和**单独**", { bold: "all" }), "残留和单独");
});
