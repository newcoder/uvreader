import test from "node:test";
import assert from "node:assert/strict";

import {
  applyChapterRule,
  chineseNumber,
  collectChapterCandidates,
  describeChapterRule,
  normalizeChapterRule,
  parseChapterNumber,
} from "../src/shared/chapter-rules.js";

const BOOK = [
  "卷一 风起",
  "",
  "12 起风",
  "",
  "正文一。".repeat(80),
  "",
  "13 下雨",
  "",
  "正文二。".repeat(80),
  "",
  "14 转晴",
  "",
  "正文三。".repeat(80),
].join("\n");

test("collectChapterCandidates keeps short standalone lines and drops prose", () => {
  const { lines, total } = collectChapterCandidates(BOOK);
  const texts = lines.map((item) => item.text);
  assert.ok(texts.includes("12 起风"));
  assert.ok(texts.includes("卷一 风起"));
  assert.equal(total, texts.length, "小书不做采样");
  assert.ok(!texts.some((text) => text.includes("正文一")), "长正文不进候选");
  assert.ok(!texts.some((text) => /。$/.test(text)), "句末标点的不进候选");
});

test("collectChapterCandidates samples long books evenly", () => {
  const lines = [];
  for (let i = 1; i <= 500; i += 1) lines.push(`${i} 标题${i}`, "", `正文${i}。`);
  const { lines: sampled, total, truncated } = collectChapterCandidates(lines.join("\n"), { max: 50 });
  assert.equal(total, 500);
  assert.equal(truncated, true);
  assert.ok(sampled.length <= 50 && sampled.length >= 45, `采样 ${sampled.length} 条`);
  assert.ok(sampled[0].text.startsWith("1 "), "保留开头");
  assert.ok(sampled[sampled.length - 1].no > 400, "采样覆盖到书末");
});

test("normalizeChapterRule only accepts the closed set", () => {
  assert.equal(normalizeChapterRule({ kind: "regex", pattern: ".*" }), null, "模型不能给正则");
  assert.equal(normalizeChapterRule({ kind: "prefixed", prefix: "", suffix: "" }), null, "前后缀都空等于没规则");
  assert.equal(normalizeChapterRule(null), null);
  const loose = normalizeChapterRule({ kind: "numbered", number: "weird", separator: "    " });
  assert.equal(loose.number, "arabic", "认不出的编号风格退回数字");
  assert.equal(loose.separator, "", "过长的分隔符丢掉");
  assert.match(describeChapterRule({ kind: "prefixed", prefix: "第", suffix: "章", separator: " " }), /「第」/);
  assert.match(describeChapterRule({ kind: "numbered", separator: "." }), /分隔符/);
});

test("parseChapterNumber handles arabic, padded and Chinese numbers", () => {
  assert.equal(parseChapterNumber("12"), 12);
  assert.equal(parseChapterNumber("007"), 7);
  assert.equal(parseChapterNumber("十二"), 12);
  assert.equal(chineseNumber("二十三"), 23);
});

test("applyChapterRule cuts the book and reports the preview", () => {
  const applied = applyChapterRule(BOOK, { kind: "numbered", number: "arabic", separator: " " });
  assert.equal(applied.error, undefined);
  assert.equal(applied.count, 4, "卷首那段(没匹配规则)单独成章,标题用默认节名");
  assert.deepEqual(applied.chapters.map((chapter) => chapter.title), ["第 1 节", "12 起风", "13 下雨", "14 转晴"]);
  assert.deepEqual(applied.first, ["第 1 节", "12 起风", "13 下雨", "14 转晴"]);
  assert.match(applied.chapters[1].body, /正文一/);
  assert.equal(applied.chapters[1].title, "12 起风");
});

test("applyChapterRule rejects rules that would shred prose", () => {
  const body = "正文。".repeat(80);
  const descending = `1 开头\n\n${body}\n\n3 中间\n\n${body}\n\n2 结束\n\n${body}`;
  assert.match(applyChapterRule(descending, { kind: "numbered", separator: " " }).error, /递增/);
  const jumpy = `1 开头\n\n${body}\n\n40 中间\n\n${body}`;
  assert.match(applyChapterRule(jumpy, { kind: "numbered", separator: " " }).error, /跳号/);
  const list = ["1 打开", "2 关闭", "3 重启", "正文。".repeat(200)].join("\n");
  assert.match(applyChapterRule(list, { kind: "numbered", separator: " " }).error, /挨得太近|切不出/);
  const single = `1 开头\n\n${body}`;
  assert.match(applyChapterRule(single, { kind: "numbered", separator: " " }).error, /太少/);
  assert.match(applyChapterRule(BOOK, { kind: "regex" }).error, /规则不可用/);
});

test("prefixed rules handle 第X章 and Chapter N", () => {
  const body = "正文。".repeat(80);
  const chinese = `第1章 起风\n\n${body}\n\n第2章 下雨\n\n${body}`;
  const applied = applyChapterRule(chinese, { kind: "prefixed", prefix: "第", suffix: "章", separator: " ", number: "arabic" });
  assert.deepEqual(applied.first, ["第1章 起风", "第2章 下雨"]);
  const english = `Chapter 1 The Boy\n\n${"Body one. ".repeat(60)}\n\nChapter 2 The Journey\n\n${"Body two. ".repeat(60)}`;
  const en = applyChapterRule(english, { kind: "prefixed", prefix: "Chapter", suffix: "", separator: " ", number: "arabic" });
  assert.deepEqual(en.first, ["Chapter 1 The Boy", "Chapter 2 The Journey"]);
});
