import assert from "node:assert/strict";
import test from "node:test";

import { isProseFence, joinSplitCodeFences, looksLikeProseBlock, unwrapProseFences } from "../src/shared/markdown-fix.js";

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
