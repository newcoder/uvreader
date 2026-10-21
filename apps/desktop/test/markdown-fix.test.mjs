import assert from "node:assert/strict";
import test from "node:test";

import { cleanChapterTitle, isProseFence, joinContinuationLines, joinSplitCodeFences, looksLikeHeadingTitle, looksLikeProseBlock, splitMarkdownChapters, stripCodeLineNumbers, unwrapProseFences } from "../src/shared/markdown-fix.js";

test("stripCodeLineNumbers removes PDF margin numbers only when they are sequential", () => {
  const numbered = "```\n22 memset(cnt, 0, sizeof(cnt));\n23 for (int i = 0; i < n; ++i)\n24   cnt[i] += 1;\n```\n";
  const cleaned = stripCodeLineNumbers(numbered);
  assert.match(cleaned, /memset/);
  assert.doesNotMatch(cleaned, /^22 /m, "行号要剥掉");
  assert.match(cleaned, /^for \(int i/m, "代码本身保持原样");

  // 代码里本来就有数字:不乱动
  const plain = "```\nint a[10];\nfor (int i = 0; i < 10; ++i) {\n  a[i] = i * 2;\n}\n```\n";
  assert.equal(stripCodeLineNumbers(plain), plain);

  // 只有两行带号:太少,可能是代码,不动
  const two = "```\na 1\nb 2\n```\n";
  assert.equal(stripCodeLineNumbers(two), two);

  // 不连续的号(22 / 24 / 26):允许 1–3 的小跳号(空行的行号常被提取器漏掉),
  // 但跳太远就当成代码本身,不动。
  const gaps = "```\n22 x\n24 y\n26 z\n```\n";
  assert.doesNotMatch(stripCodeLineNumbers(gaps), /^22 /m, "22,24,26 是页边行号(空行号漏了),要剥");

  // 真实形状:前半代码 + 后半页边行号(跳号)
  const real = "```\nint main() {\n  f();\n22 memset(cnt, 0, sizeof(cnt));\n23 for (int i = 0; i < n; ++i)\n25 for (int i = 0; i < maxs; ++i)\n26   cnt[i] += 1;\n```\n";
  const stripped = stripCodeLineNumbers(real);
  assert.doesNotMatch(stripped, /^\s*2[2-6] /m);
  assert.match(stripped, /^memset/m);
});

test("a program split across pages merges first, then loses its line numbers", () => {
  const md = "```\nint main() {\n  f();\n  // 记录\n```\n\n```\n22 memset(cnt, 0, sizeof(cnt));\n23 for (int i = 0; i < n; ++i)\n24   g();\n```\n";
  const merged = stripCodeLineNumbers(joinSplitCodeFences(md));
  assert.equal((merged.match(/```/g) || []).length, 2, "两段并成一段(只剩一对围栏)");
  assert.doesNotMatch(merged, /^22 /m);
  assert.match(merged, /memset/);
});

test("a program split across a page break is joined back into one fence", () => {
  const md = [
    "```",
    "#include <cstdio>",
    "const int maxs = 1010;",
    "```",
    "",
    "```",
    "22 memset(cnt, 0, sizeof(cnt));",
    "23 for (int i = 0; i < n; ++i)",
    "```",
    "",
    "1）①处应填（ ）",
  ].join("\n");
  const joined = joinSplitCodeFences(md);
  assert.equal((joined.match(/```/g) || []).length, 2, "只剩一对围栏");
  assert.match(joined, /const int maxs = 1010;\n22 memset/);
  assert.match(joined, /23 for \(int i = 0; i < n; \+\+i\)\n```/);
});

test("fences separated by text, or with discontinuous numbering, stay split", () => {
  const withLabel = ["```", "01 int main() {", "```", "", "（2）下面是另一个程序", "", "```", "05 int x;", "```"].join("\n");
  assert.equal(joinSplitCodeFences(withLabel), withLabel, "中间有文字不合并");
  const wrongNumber = ["```", "10 int a;", "```", "", "```", "30 int b;", "```"].join("\n");
  assert.equal(joinSplitCodeFences(wrongNumber), wrongNumber, "行号不连续不合并");
  const typed = ["```cpp", "int a;", "```", "", "```", "12 int b;", "```"].join("\n");
  assert.equal(joinSplitCodeFences(typed), typed, "带语言标记的围栏不动");
});

test("a listing spanning three pages joins across both breaks", () => {
  const md = ["```", "05 int x;", "```", "", "```", "06 int y;", "```", "", "```", "07 int z;", "```"].join("\n");
  const joined = joinSplitCodeFences(md);
  assert.equal((joined.match(/```/g) || []).length, 2);
  assert.match(joined, /05 int x;\n06 int y;\n07 int z;/);
});

test("prose without formulas is still rescued, formulas inside it are not counted as code", () => {
  // 1.DUL+paper.pdf 第 5 页:另一段被误判成 code 的正文(没有公式)。
  const body = "75 μm and 100 μm, respectively. The measured transmission spectra of the bend waveguides with the radii of 75 μm, 100 μm, 125 μm, 150 μm, and 175 μm are given in Fig. 5(c). The transmission spectra were normalized with respect to a straight waveguide with similar length so as to exclude the effects.";
  assert.equal(looksLikeProseBlock(body), true);
  assert.ok(!unwrapProseFences(["```", body, "```"].join("\n")).includes("```"));
  const withMath = "After soft baking at $6 5 ~ ^ { \\circ } \\mathrm { C }$ for 5 min the thickness was measured to be 2.1 µm and the sample was hard-baked afterwards.";
  assert.equal(looksLikeProseBlock(withMath), true, "LaTeX inside $…$ does not look like code");
  assert.equal(looksLikeProseBlock("\\frac{a}{b} &= c \\\\ d"), false, "unwrapped LaTeX stays code");
  assert.equal(looksLikeProseBlock("function x() { return 1; }"), false);
  assert.equal(looksLikeProseBlock("npm test -- --watch"), false, "short snippets stay code");
});

test("a fenced prose paragraph with formulas is unwrapped", () => {
  const markdown = [
    "上一段。",
    "",
    "```",
    "After soft baking at $6 5 ~ ^ { \\circ } \\mathrm { C }$ for 5 min the thickness was",
    "measured to be 2.1 µm. Then the samples were hard-baked for a further 30 min.",
    "```",
    "",
    "下一段。",
  ].join("\n");
  const fixed = unwrapProseFences(markdown);
  assert.ok(!fixed.includes("```"), "the fake fence is gone");
  assert.match(fixed, /After soft baking at \$6 5 ~ \^ \{ \\circ \} \\mathrm \{ C \}\$/);
  assert.equal(isProseFence("", "After soft baking at $65$ for 5 min, the thickness was measured."), true);
});

test("real code fences are kept", () => {
  const language = ["```js", "const a = 1;", "console.log(a);", "```"].join("\n");
  assert.equal(unwrapProseFences(language), language, "a language tag means real code");
  const untagged = ["```", "function sum(a, b) {", "  return a + b;", "}", "```"].join("\n");
  assert.equal(unwrapProseFences(untagged), untagged, "code-looking bodies stay fenced");
  const short = ["```", "npm test", "```"].join("\n");
  assert.equal(unwrapProseFences(short), short, "short blocks stay fenced");
  const indented = ["```", "    indented code", "    more code here for the block to be long enough", "```"].join("\n");
  assert.equal(unwrapProseFences(indented), indented, "indented code stays fenced");
});

test("unclosed prose fences are unwrapped and the rest of the text survives", () => {
  const markdown = ["正文一。", "", "```", "这是一段被围栏吞掉的正文。它以句号结尾,而且足够长,足够到应该被拆回普通段落继续排版。"].join("\n");
  const fixed = unwrapProseFences(markdown);
  assert.ok(!fixed.includes("```"), "an unclosed prose fence is still unwrapped");
  assert.match(fixed, /这是一段被围栏吞掉的正文/);
  assert.ok(fixed.startsWith("正文一。"), "the earlier text is untouched");
  assert.equal(unwrapProseFences("没有围栏的文本。"), "没有围栏的文本。");
});

test("cleanChapterTitle strips footnote markers and inline noise", () => {
  assert.equal(cleanChapterTitle("集合论的一种公理化 $^{①}$"), "集合论的一种公理化 ①");
  assert.equal(cleanChapterTitle("论大规模计算机器的原理 $^{①②}$"), "论大规模计算机器的原理 ①②");
  assert.equal(cleanChapterTitle("**重点** `代码` 与 \\alpha"), "重点 代码 与");
  assert.equal(cleanChapterTitle("  "), "");
});

test("splitMarkdownChapters merges repeated running heads and the book title", () => {
  const md = [
    "# THE ROLE OF MATHEMATICS",
    "",
    "# THE ROLE OF MATHEMATICS",
    "",
    "正文甲。",
    "",
    "# 读读大师",
    "",
    "序言。",
    "",
    "# 读读大师",
    "",
    "序言二。",
    "",
    "# 独立一章",
    "",
    "正文乙。",
  ].join("\n");
  const chapters = splitMarkdownChapters(md, { bookTitle: "THE ROLE OF MATHEMATICS" });
  // 书名标题被并掉后,它下面的正文成了一章「无题」(运行时按「第 N 章」命名,面板里可删)。
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["", "读读大师", "独立一章"], "连续重名与书名标题都并掉");
  assert.match(chapters[0].text, /正文甲。/);
  assert.match(chapters[1].text, /序言二。/, "重复标题下的正文并进上一章");
});

test("splitMarkdownChapters keeps a genuinely repeated section title with content", () => {
  const md = ["# 参考文献", "", "甲。", "", "# 参考文献", "", "乙。"].join("\n");
  const chapters = splitMarkdownChapters(md);
  assert.equal(chapters.length, 1, "连续重名会并成一章(由面板的删除按钮处理)");
});

test("splitMarkdownChapters keeps a title-only chapter when the toc asks for it", () => {
  // 《数学在科学和社会中的作用》:「形式主义的数学基础 ① (1931)」后面紧跟「I」,
  // 中间没有正文 → 空章被丢掉 → 目录条目找不到落点(实测跳到「III」)。目录点名的
  // 标题(keepTitle)要保留成章,就是它的标题页。
  const markdown = [
    "# 形式主义的数学基础 $^{①}$ (1931)",
    "# I",
    "第一节的正文。",
    "# 别的标题",
  ].join("\n");
  const plain = splitMarkdownChapters(markdown);
  assert.deepEqual(plain.map((chapter) => chapter.title), ["I"], "默认仍然丢掉空章(末尾那个没正文的标题也一样)");
  const kept = splitMarkdownChapters(markdown, { keepTitle: (title) => title.startsWith("形式主义的数学基础") });
  assert.deepEqual(kept.map((chapter) => chapter.title), ["形式主义的数学基础 ① (1931)", "I"]);
  assert.equal(kept[0].text, "", "标题页没有正文,但要留在章节表里当落点");
  const levels = splitMarkdownChapters("# 第一章 光学简史\n正文一\n## 1.1 开场白\n正文二", {});
  assert.deepEqual(levels.map((chapter) => chapter.level), [1, 2], "标题层级带出来(h1 → 1、h2 → 2)");
});

test("looksLikeHeadingTitle rejects sentence fragments", () => {
  assert.equal(looksLikeHeadingTitle("的努力？"), false, "句尾被截断的碎片");
  assert.equal(looksLikeHeadingTitle("真的吗？"), false, "很短且以句末标点结尾");
  assert.equal(looksLikeHeadingTitle("与此相反，"), false, "以逗号结尾");
  assert.equal(looksLikeHeadingTitle("he efforts of the committee"), false, "纯英文小写开头");
  assert.equal(looksLikeHeadingTitle("我们能在技术条件下劫后余生吗？"), true, "书名式长标点句仍然是标题");
  assert.equal(looksLikeHeadingTitle("§ 1 有关集合论公理化的基本原则"), true);
  assert.equal(looksLikeHeadingTitle("1. 导引公理"), true);
  assert.equal(looksLikeHeadingTitle("iPhone 使用指南"), true, "含中文的英文开头标题保留");
  assert.equal(looksLikeHeadingTitle(""), false);
});

test("a fragment at the top of a page stays in the text instead of becoming a chapter", () => {
  const md = ["# 第一章 绪论", "", "光线的传播遵从", "### 的努力？", "惠更斯原理。", "", "# 第二章 波动", "", "正文。"].join("\n");
  const chapters = splitMarkdownChapters(md);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["第一章 绪论", "第二章 波动"]);
  assert.match(chapters[0].text, /遵从\s*的努力？/, "碎片留在正文里(接到上一行)");
  assert.ok(!chapters[0].text.includes("###"), "井号去掉,不再当标题");
});

test("joinContinuationLines puts an upstream continuation back into the sentence", () => {
  const md = ["什么样的考虑支配和指引着他", "", "的努力？", "", "那么, 就让我们看一看。"].join("\n");
  const joined = joinContinuationLines(md, ["的努力？"]);
  assert.match(joined, /指引着他的努力？/, "半句接回上一句");
  assert.ok(!/^的努力？$/m.test(joined), "独立那行不再留着");
  assert.match(joined, /那么, 就让我们看一看。/);
  assert.equal(joinContinuationLines(md, []), md, "没有标记时原样返回");
  const english = joinContinuationLines(["the crystal surface was", "", "flat and clean"].join("\n"), ["flat and clean"]);
  assert.match(english, /was flat and clean/, "拉丁文字之间补空格");
  const guarded = joinContinuationLines(["![插图](a.jpg)", "", "flat and clean"].join("\n"), ["flat and clean"]);
  assert.match(guarded, /\n\nflat and clean/, "上一行是图片时不往上粘");
  const question = joinContinuationLines(["4）若输入 n 等于 1，输出（）。A. 1 B. 2 C. 3 D. 4", "", "5）若输入 n 等于 2，输出（）。A. 1 B. 2 C. 3 D. 4"].join("\n"), ["5）若输入 n 等于 2，输出（）。A. 1 B. 2 C. 3 D. 4"]);
  assert.match(question, /\n\n5）若输入/, "新题号即使被标 continuation 也另起一行");
  const afterPage = joinContinuationLines(["4）上一题", "", "<!--page:6-->", "", "5）下一题（）"].join("\n"), ["5）下一题（）"]);
  assert.match(afterPage, /<!--page:6-->\n\n5）下一题/, "页标记后的新题不粘到页标记上");
});
