import assert from "node:assert/strict";
import test from "node:test";

import { buildPolishMarkdown, refreshPolishBodyMarkers, renumberPolishNotes } from "../src/shared/polish-markdown.js";

test("an implicit notes block keeps an unnumbered note before the next numbered note", () => {
  const { markdown, notes, markers, report } = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "测试章",
      text: [
        "正文一 $^{1}$ 正文二 $^{2}$ 正文三 $^{3}$ 正文四 $^{4}$ 正文五 $^{5}$ 正文六 $^{6}$",
        "",
        "1、第一条注文，1页。",
        "",
        "2、第二条注文，2页。",
        "",
        "3、第三条注文，3页。",
        "",
        "无编号的第四条注文，4页。",
        "",
        "4、第五条注文，5页。",
        "",
        "5、第六条注文，6页。",
      ].join("\n"),
    }],
  });

  assert.equal(notes.length, 6);
  assert.equal(markers.length, 6);
  assert.equal(notes[3].label, "4");
  assert.match(notes[3].text, /4、无编号的第四条注文/);
  assert.equal(notes[3].markerId, "marker-001-004");
  assert.equal(notes[4].label, "5");
  assert.equal(notes[4].markerId, "marker-001-005");
  assert.equal(report.summary.unlinkedNotes, 0);
  assert.match(markdown, /4、无编号的第四条注文/);
});

test("refreshing body markers pairs manually inserted notes in reading order", () => {
  const base = buildPolishMarkdown({
    title: "测试书",
    chapters: [{
      title: "测试章",
      text: [
        "正文一 $^{1}$ 正文二 $^{2}$ 正文三 $^{3}$ 正文四 $^{4}$",
        "",
        "注释:",
        "",
        "1、第一条注文，1页。",
        "",
        "2、第二条注文，2页。",
        "",
        "3、第三条注文，3页。",
        "",
        "4、第四条注文，4页。",
      ].join("\n"),
    }],
  });
  const markerByNote = new Map(base.notes.map((note) => [note.id, note.markerId]));
  const note1 = base.markdown.indexOf("<!-- polish:note note-001");
  const insertAt = base.markdown.indexOf("\n\n", note1);
  const manualComment = "<!-- polish:note note-manual-test chapter=ch-001 page=0 label=\"\" linked=false alignment=none -->\n无编号的插入注文，2页。";
  const withManual = `${base.markdown.slice(0, insertAt)}\n\n${manualComment}${base.markdown.slice(insertAt)}`;
  const renumbered = renumberPolishNotes(withManual, "note-manual-test", 2, markerByNote).markdown;
  const refreshed = refreshPolishBodyMarkers(renumbered);

  assert.equal(refreshed.count, 3);
  assert.match(refreshed.markdown, /<sup>2<\/sup><!-- polish:marker marker-001-002 .*label="2" note="note-manual-test"/);
  assert.match(refreshed.markdown, /<sup>3<\/sup><!-- polish:marker marker-001-003 .*label="3" note="note-002"/);
  assert.match(refreshed.markdown, /<sup>4<\/sup><!-- polish:marker marker-001-004 .*label="4" note="note-003"/);
  assert.match(refreshed.markdown, /<!-- polish:note note-manual-test .*linked="true"/);
  assert.match(refreshed.markdown, /<!-- polish:note note-004 .*linked="false"/);
});

test("an implicit notes block still folds a continuation into the previous note", () => {
  const { notes } = buildPolishMarkdown({
    chapters: [{
      title: "测试章",
      text: [
        "正文一 $^{1}$ 正文二 $^{2}$ 正文三 $^{3}$",
        "",
        "1、第一条注文，1页。",
        "",
        "2、第二条注文没有句号",
        "",
        "换了行但仍是第二条，2页。",
        "",
        "3、第三条注文，3页。",
      ].join("\n"),
    }],
  });

  assert.equal(notes.length, 3);
  assert.match(notes[1].text, /换了行但仍是第二条/);
  assert.equal(notes[2].label, "3");
});
