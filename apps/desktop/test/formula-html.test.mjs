import assert from "node:assert/strict";
import test from "node:test";

import { blocksFromDoc, blocksToHtml, blockToHtml, escapeHtml, stripMathDelimiters, wrapInlineMath } from "../src/main/formula-html.js";

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml('<b>"a" & b</b>'), "&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;");
  assert.equal(escapeHtml(null), "");
});

test("stripMathDelimiters unwraps the MinerU delimiters", () => {
  assert.equal(stripMathDelimiters("$$\n\\nu_ {0}\n$$"), "\\nu_ {0}");
  assert.equal(stripMathDelimiters("$v = v_{0} + at$"), "v = v_{0} + at");
  assert.equal(stripMathDelimiters("\\[x^2\\]"), "x^2");
  assert.equal(stripMathDelimiters("\\(a+b\\)"), "a+b");
  assert.equal(stripMathDelimiters("plain text"), "plain text");
  assert.equal(stripMathDelimiters("$"), "$");
});

test("wrapInlineMath turns $…$ and $$…$$ into math script carriers", () => {
  const html = wrapInlineMath("速度 $v = v_{0} + at$ ，单位 $2\\mathrm{m}/{\\mathrm{s}}^{2}$ 。");
  assert.match(html, /速度 <script type="math\/tex">v = v_\{0\} \+ at<\/script>/);
  assert.match(html, /<script type="math\/tex">2\\mathrm\{m\}\/\{\\mathrm\{s\}\}\^\{2\}<\/script>/);
  assert.equal((html.match(/<script/g) || []).length, 2);
  assert.equal(wrapInlineMath("a < b & c"), "a &lt; b &amp; c");
  assert.match(wrapInlineMath("$$x^2$$"), /<script type="math\/tex; mode=display">x\^2<\/script>/);
  assert.equal(wrapInlineMath("价格 5$ 一件"), "价格 5$ 一件");
});

test("blockToHtml renders headings, formulas, tables, images and code", () => {
  assert.equal(blockToHtml({ type: "heading", level: 3, text: "标题" }), "<h3>标题</h3>");
  assert.equal(
    blockToHtml({ type: "equation", text: "$$\nx = \\frac{a}{b}\n$$" }),
    '<p><script type="math/tex; mode=display">x = \\frac{a}{b}</script></p>',
  );
  assert.equal(
    blockToHtml({ type: "equation", image: { src: "mineru/equations/eq_1.jpg", alt: "公式" } }),
    '<p><img src="mineru/equations/eq_1.jpg" alt="公式"></p>',
  );
  assert.equal(
    blockToHtml({ type: "table", table: { headers: ["h"], rows: [["$x_1$"]] } }),
    "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td><script type=\"math/tex\">x_1</script></td></tr></tbody></table>",
  );
  assert.equal(
    blockToHtml({ type: "image", image: { src: "mineru/images/a.jpg", alt: "图" } }),
    '<figure><img src="mineru/images/a.jpg" alt="图"></figure>',
  );
  assert.equal(blockToHtml({ type: "code", content: "a < b" }), "<pre><code>a &lt; b</code></pre>");
  assert.equal(blockToHtml({ type: "text", text: "  " }), "");
  assert.match(blockToHtml({ type: "question", number: "1", stem: "求 $x$", options: ["A. 1"], answer: "$x=1$" }), /答案：<script type="math\/tex">x=1<\/script>/);
});

test("blocksToHtml walks a Doc v1 payload and keeps relative image sources", () => {
  const doc = {
    schema_version: 1,
    pages: [
      { page: 1, blocks: [{ type: "heading", level: 1, text: "试卷" }, { type: "text", text: "公式 $v_{0}$" }] },
      { page: 2, blocks: [{ type: "image", image: { src: "mineru/images/fig.jpg", alt: "图" } }] },
    ],
  };
  const html = blocksToHtml(blocksFromDoc(doc), { title: "testpdf2" });
  assert.match(html, /<title>testpdf2<\/title>/);
  assert.match(html, /<h1>试卷<\/h1>/);
  assert.match(html, /<script type="math\/tex">v_\{0\}<\/script>/);
  assert.match(html, /<img src="mineru\/images\/fig.jpg"/);
  assert.equal(blocksFromDoc({}).length, 0);
});
