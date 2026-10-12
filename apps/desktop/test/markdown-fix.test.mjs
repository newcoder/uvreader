import assert from "node:assert/strict";
import test from "node:test";

import { isProseFence, unwrapProseFences } from "../src/shared/markdown-fix.js";

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
