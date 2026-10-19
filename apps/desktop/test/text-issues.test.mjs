import test from "node:test";
import assert from "node:assert/strict";

import {
  bigramSimilarity,
  describeIssues,
  diffParagraphs,
  guardCleanupBlock,
  scanChapterIssues,
  scanTextIssues,
  splitCleanupBlocks,
  splitParagraphs,
} from "../src/shared/text-issues.js";

test("scanTextIssues finds the five suspicious shapes", () => {
  const text = [
    "他囚为害怕,口口口口地站着。",
    "这是正常的一段话,写得很完整,没有问题。",
    "Â¡Ã© 乱码片段",
    "第十二章 初入宗门 他抬头看见远处的山峦,心里忽然安静下来,想着这些年的经历。",
    "短行一",
    "短行二",
    "短行三",
    "",
  ].join("\n");
  const scan = scanTextIssues(text);
  assert.equal(scan.issues.oddChars.length, 0, "「口」是正常汉字,不算怪字符");
  assert.equal(scan.issues.repeats.length, 1, "口口口口 是重复字");
  assert.equal(scan.issues.mojibake.length, 1, "Â¡Ã© 是乱码片段");
  assert.equal(scan.issues.swallowedHeadings.length, 1, "标题后直接接正文 = 疑似吞标题");
  assert.equal(scan.issues.brokenLines.length, 1, "连续三行短行 = 疑似断行");
  assert.ok(scan.score >= 5);
  assert.match(describeIssues(scan), /重复字/);
});

test("scanTextIssues flags private-use and replacement characters", () => {
  const scan = scanTextIssues("正文里有怪字符 \uE001 和 \uFFFD 各一个。");
  assert.equal(scan.issues.oddChars.length, 2);
  assert.equal(scanTextIssues("干净的一段中文,没有任何可疑之处。").score, 0);
});

test("scanChapterIssues ranks suspects and totals the issues", () => {
  const chapters = [
    { title: "干净", text: "正常的一段话,写得很完整,没有问题。" },
    { title: "可疑", text: "他囚为害怕,口口口口地站着。".repeat(3) },
  ];
  const scan = scanChapterIssues(chapters);
  assert.equal(scan.suspects, 1);
  assert.equal(scan.rows[0].index, 1);
  assert.ok(scan.totals.repeats >= 1);
  assert.match(describeIssues({ issues: scan.totals }), /重复字/);
});

test("splitParagraphs and splitCleanupBlocks keep paragraphs whole", () => {
  assert.deepEqual(splitParagraphs("一\n\n二\n\n三"), ["一", "二", "三"]);
  assert.deepEqual(splitParagraphs("一\n二\n三"), ["一", "二", "三"], "没有空行时按行");
  const blocks = splitCleanupBlocks(["甲".repeat(3000), "乙".repeat(3000), "丙".repeat(3000)].join("\n\n"), { size: 4000 });
  assert.equal(blocks.length, 3, "不切碎段落");
  assert.ok(blocks.every((block) => block.length <= 4000));
  const long = splitCleanupBlocks("句子。".repeat(3000), { size: 4000 });
  assert.ok(long.length > 1, "单段超长时按句号兜底");
  assert.ok(long.every((block) => block.length <= 4100));
});

test("bigramSimilarity drops when text is rewritten", () => {
  assert.ok(bigramSimilarity("他囚为害怕", "他因为害怕") >= 0.5, "改两个错字只掉一点");
  assert.ok(bigramSimilarity("第一段正文,写得长一点。", "完全不同的一句话,长短也不一样。") < 0.3);
});

test("guardCleanupBlock accepts minimal fixes and rejects rewrites", () => {
  const before = "他囚为害怕,口口口口地站着。\n\n第二段正文,写得长一点,没有任何问题。";
  assert.equal(guardCleanupBlock(before, before.replace("囚为", "因为").replace("口口口口", "哆哆嗦嗦")).ok, true);
  assert.match(guardCleanupBlock(before, "太短。").reason, /长度|相似度/);
  assert.match(guardCleanupBlock(before, `${before}\n\n${before}`).reason, /长度|段落/);
  assert.match(guardCleanupBlock(before, "这是一段完全重写的文字,和原文没有任何关系,而且长度也不一样了,真的不一样。").reason, /长度|相似度|改写/);
  assert.match(guardCleanupBlock(before, "第一段被整段换成了别的内容,虽然长度差不多但意思完全不同。\n\n第二段正文,写得长一点,没有任何问题。").reason, /长度|改写|相似度/);
});

test("diffParagraphs shows only the changed parts with shared edges trimmed", () => {
  const before = "第一段。\n\n他囚为害怕,站着。\n\n第三段。";
  const after = "第一段。\n\n他因为害怕,站着。\n\n第三段。";
  const diff = diffParagraphs(before, after);
  assert.equal(diff.total, 1);
  assert.equal(diff.changes[0].kind, "changed");
  assert.equal(diff.changes[0].before, "囚");
  assert.equal(diff.changes[0].after, "因");
  assert.equal(diff.changes[0].prefix, "他");
  assert.equal(diff.changes[0].suffix, "为害怕,站着。");
  const inserted = diffParagraphs("一。\n\n三。", "一。\n\n二。\n\n三。");
  assert.equal(inserted.changes[0].kind, "added");
  assert.equal(inserted.changes[0].after, "二。");
  const removed = diffParagraphs("一。\n\n二。\n\n三。", "一。\n\n三。");
  assert.equal(removed.changes[0].kind, "removed");
  assert.equal(diffParagraphs("一样。", "一样。").total, 0);
});
