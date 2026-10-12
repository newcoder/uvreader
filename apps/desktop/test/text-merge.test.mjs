import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorText,
  blockFullText,
  buildSquashIndex,
  mergeBlocksWithTextLayer,
  mergeParagraph,
  proseChunks,
  splitMathSegments,
  squashKey,
  stripRepeatedLines,
} from "../src/main/text-merge.js";

test("squashKey folds ligatures, case, spaces and hyphens; the index maps back", () => {
  assert.equal(squashKey("De- signed ﬁelds"), "designedfields");
  assert.equal(squashKey("1 × 2"), "12");
  const index = buildSquashIndex("The 1 × 2 splitter\nwas spun at 3000 rpm");
  assert.equal(index.key, "the1×2splitterwasspunat3000rpm".replace(/[^a-z0-9\u4e00-\u9fff]/gu, "").replace("×2", "2"));
  const range = anchorText(index, "1 2 splitter was spun");
  assert.ok(range, "squash 后能对上 × 号差异");
  assert.equal(index.text.slice(range.start, range.end), "1 × 2 splitter\nwas spun");
  assert.equal(anchorText(index, "nothing here at all"), null);
});

test("splitMathSegments keeps the delimiters and alternates prose and math", () => {
  const segments = splitMathSegments("speed $v = v_{0}$ and\nthen $$a^2 + b^2$$ text");
  assert.deepEqual(segments.map((segment) => segment.kind), ["prose", "math", "prose", "math", "prose"]);
  assert.equal(segments[1].raw, "$v = v_{0}$");
  assert.equal(segments[1].latex, "v = v_{0}");
  assert.equal(segments[3].raw, "$$a^2 + b^2$$");
});

test("proseChunks splits by words and caps very long single words", () => {
  const chunks = proseChunks("one two three four five six seven eight nine ten eleven", 4);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].trim(), "one two three four");
  const cjk = proseChunks("甲".repeat(120), 4);
  assert.ok(cjk.length >= 3, "长中文按压缩键长度切块");
  assert.ok(cjk.every((chunk) => squashKey(chunk).length <= 60));
});

test("stripRepeatedLines drops repeated headers, footers and watermarks only", () => {
  const pages = [
    "JOURNAL OF X, VOL. 1\nbody one line\nAuthorized licensed use limited to: University",
    "JOURNAL OF X, VOL. 1\nbody two line\nAuthorized licensed use limited to: University",
    "JOURNAL OF X, VOL. 1\nbody three line\nAuthorized licensed use limited to: University",
    "JOURNAL OF X, VOL. 1\nbody four line\nAuthorized licensed use limited to: University",
  ];
  const cleaned = stripRepeatedLines(pages);
  assert.ok(cleaned.every((page) => !page.includes("JOURNAL OF X")), "页眉删掉");
  assert.ok(cleaned.every((page) => !page.includes("Authorized licensed")), "水印删掉");
  assert.ok(cleaned[0].includes("body one line") && cleaned[3].includes("body four line"), "正文保留");
  const unique = stripRepeatedLines(["只有一页的正文", "第二页正文"]);
  assert.deepEqual(unique, ["只有一页的正文", "第二页正文"]);
  // 长文档里只重复两三次的行多半是正文里的公式/句子,不删(阈值 = 页数 × 0.3)
  const book = Array.from({ length: 20 }, (_value, index) => `body line ${index}${index < 3 ? "\nsame formula line here" : ""}`);
  const cleanedBook = stripRepeatedLines(book);
  assert.ok(cleanedBook.slice(0, 3).every((page) => page.includes("same formula line here")), "3/20 页的重复不当噪声");
});

test("mergeParagraph recovers words MinerU dropped and keeps its LaTeX", () => {
  const layer = "In the experiments, the silicon wafer was spun on the wafer at the speed of 3000 rpm for 30 s to promote the adhesion between SU-8 and silica. Then the wafer was baked.";
  const mineru = "In the experiments, the silicon wafer was spun on the wafer at the speed of 30 s to promote the adhesion between SU-8 and silica. Then the wafer was baked.";
  const merged = mergeParagraph(mineru, buildSquashIndex(layer));
  assert.ok(merged, "能定位");
  assert.match(merged.text, /at the speed of 3000 rpm for 30 s/, "补回 MinerU 丢掉的 3000 rpm for");
  assert.ok(!merged.text.includes("of 30 s"), "不再缺字");
});

test("mergeParagraph prefers the text layer for prose but keeps formulas as LaTeX", () => {
  const layer = "Fig. 7(c) is the SEM image of a fabricated 1×2 Y-branch splitter. After soft baking at 65 °C for 5 min, the sample was hard-baked.";
  const mineru = "Fig. 7(c) is the SEM image of a fabricated 1 2 Y-branch splitter. After soft baking at $6 5 ~ ^ { \\circ } \\mathrm { C }$ for 5 min, the sample was hard-baked.";
  const merged = mergeParagraph(mineru, buildSquashIndex(layer));
  assert.ok(merged);
  assert.match(merged.text, /1×2 Y-branch/, "乘号从文字层补回");
  assert.match(merged.text, /\$6 5 ~ \^ \{ \\circ \} \\mathrm \{ C \}\$ for 5 min/, "公式仍是 MinerU 的 LaTeX");
  assert.ok(!/65 °C/.test(merged.text), "公式字形没有重复出现");
});

test("mergeParagraph joins PDF hyphenation and keeps trailing punctuation", () => {
  const layer = "…to inscribe the de-\nsigned patterns into the SU-8. Then the samples were post-baked.";
  const mineru = "…to inscribe the de- signed patterns into the $\\operatorname { S U } - 8$ Then the samples were post-baked.";
  const merged = mergeParagraph(mineru, buildSquashIndex(layer));
  assert.ok(merged);
  assert.match(merged.text, /designed patterns/);
  assert.match(merged.text, /\$\\operatorname \{ S U \} - 8\$\. Then/, "公式后的句号补回");
});

test("mergeParagraph bails out instead of guessing", () => {
  const merged = mergeParagraph("完全不同的段落内容，用来测试回退路径。", buildSquashIndex("这里的文字和它毫无关系，也没有共同片段。"));
  assert.equal(merged, null, "定位不上就返回 null，调用方保留 MinerU 原文");
});

test("mergeBlocksWithTextLayer merges prose blocks, captions and mislabelled code blocks", () => {
  const pages = [
    "The wafer was cleaned first. In the experiments, the wafer was spun at the speed of 3000 rpm for 30 s to promote adhesion.\nFig. 1. A picture.",
  ];
  const blocks = [
    { id: "b1", type: "text", text: "The wafer was cleaned first.", page: 1 },
    { id: "b2", type: "code", caption: "In the experiments, the wafer was spun at the speed of", content: "30 s to promote adhesion.", page: 1 },
    { id: "b3", type: "image", image: { src: "mineru/images/a.jpg" }, caption: "Fig. 1. A picture.", page: 1 },
    { id: "b4", type: "equation", text: "$$x^2$$", page: 1 },
  ];
  const merged = mergeBlocksWithTextLayer(blocks, pages, { log: () => {} });
  assert.equal(merged.length, 4);
  assert.equal(merged[0].text, "The wafer was cleaned first.", "正文用文字层");
  assert.equal(merged[1].type, "text", "被判成 code 的正文改回 text");
  assert.equal(merged[1].caption, undefined);
  assert.match(merged[1].text, /the speed of 3000 rpm for 30 s to promote adhesion/, "caption + content 拼回整段并补回丢字");
  assert.deepEqual(merged[2], blocks[2], "图片块不动");
  assert.deepEqual(merged[3], blocks[3], "公式块不动");
  assert.equal(blockFullText(blocks[1]), "In the experiments, the wafer was spun at the speed of\n30 s to promote adhesion.");
  // 空页 / 空块表不报错
  assert.deepEqual(mergeBlocksWithTextLayer([], []), []);
  assert.deepEqual(mergeBlocksWithTextLayer([{ type: "text", text: "x" }], [""]).length, 1);
});
