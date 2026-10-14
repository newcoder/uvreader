import assert from "node:assert/strict";
import test from "node:test";

import { blocksFromDoc, blocksToHtml, blockToHtml, blockToMarkdown, escapeHtml, joinProseLines, stripMathDelimiters, wrapInlineMath } from "../src/main/formula-html.js";

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

test("a prose paragraph mislabelled as code becomes a paragraph with its formulas", () => {
  // 两栏论文实测(1.DUL+paper.pdf 第 3 页):MinerU 把这段正文标成了 code 块。
  const block = {
    type: "code",
    content: "30 s to promote the adhesion between SU-8 and silica. Then SU-8 2005 (Kayaku Advanced Materials, Inc.) was spin-coated at the speed of 4000 rpm for 1 min. The thickness of the SU-8 layer was measured to be 2.1 μm. After soft baking at $6 5 ~ ^ { \\circ } \\mathrm { C }$ for 5 min and $9 5 ^ { \\circ } \\mathrm { C }$ for\n10 min, optical exposure was conducted under the light intensity of 61.\n91 $\\mathrm { n W } / \\mathrm { c m } ^ { 2 }$ to inscribe the designed patterns into the $\\operatorname { S U } - 8$ . Then the samples were post-baked at $6 5 ~ ^ { \\circ } \\mathrm { C }$ for\n15 min and $9 5 ~ ^ { \\circ } \\mathrm { C }$ for\n30 min.",
  };
  const html = blockToHtml(block);
  assert.match(html, /^<p>30 s to promote the adhesion/);
  assert.ok(!html.includes("<pre>"), "the paragraph is not a code block any more");
  assert.match(html, /After soft baking at <script type="math\/tex">6 5 ~ \^ \{ \\circ \} \\mathrm \{ C \}<\/script> for 5 min/);
  assert.match(html, /light intensity of 61\.91 <script/, "hard-broken numbers are glued back");
  assert.match(html, /and <script type="math\/tex">9 5 ~ \^ \{ \\circ \} \\mathrm \{ C \}<\/script> for 30 min\.<\/p>$/);
});

test("joinProseLines joins PDF hard breaks but keeps broken numbers together", () => {
  assert.equal(joinProseLines("for\n10 min"), "for 10 min");
  assert.equal(joinProseLines("of 61.\n91 nW"), "of 61.91 nW");
  assert.equal(joinProseLines("  a  \n\n b  "), "a b");
  assert.equal(joinProseLines("单行"), "单行");
});

test("real code and LaTeX blocks stay code", () => {
  assert.equal(blockToHtml({ type: "code", content: "def simulate(cfg):\n    return cfg" }), "<pre><code>def simulate(cfg):\n    return cfg</code></pre>");
  assert.equal(blockToHtml({ type: "code", content: "\\begin{aligned}\nE &= mc^2\n\\end{aligned}" }), "<pre><code>\\begin{aligned}\nE &amp;= mc^2\n\\end{aligned}</code></pre>");
  assert.equal(blockToHtml({ type: "code", content: "npm test -- --watch" }), "<pre><code>npm test -- --watch</code></pre>");
  assert.equal(blockToHtml({ type: "code", content: "for (let i = 0; i < 10; i++) {\n  sum += i;\n}" }), "<pre><code>for (let i = 0; i &lt; 10; i++) {\n  sum += i;\n}</code></pre>");
});

test("a code block whose caption holds the paragraph lead-in keeps both halves", () => {
  // 1.DUL+paper.pdf 实测:MinerU 把正文前半段放进了 caption,只读 content 就会缺一段。
  const html = blockToHtml({
    type: "code",
    caption: "In the experiments, the silicon wafer capped with a 4-μm thick $\\mathrm { S i O _ { 2 } }$ layer was used as the substrate. Before spin coating of SU-8, an adhesion promoter Omnicoat was spun on the wafer at the speed of",
    content: "30 s to promote the adhesion between SU-8 and silica. Then SU-8 2005 was spin-coated at the speed of 4000 rpm for 1 min.",
  });
  assert.match(html, /^<p>In the experiments/);
  assert.match(html, /at the speed of 30 s to promote the adhesion/, "caption and content are joined into one paragraph");
  assert.match(html, /<script type="math\/tex">\\mathrm \{ S i O _ \{ 2 \} \}<\/script>/);
  assert.ok(!html.includes("<pre>"), "the rescued paragraph is not a code block");
});

test("a real code block keeps its caption as a paragraph above the code", () => {
  const html = blockToHtml({ type: "code", caption: "算法 1 伪代码。", content: "def run(cfg):\n    return cfg" });
  assert.match(html, /^<p>算法 1 伪代码。<\/p>\n<pre><code>def run\(cfg\):\n    return cfg<\/code><\/pre>$/);
});

test("tables can be emitted as their MinerU screenshot for DOCX/PDF targets", () => {
  const block = { type: "table", headers: ["a"], rows: [["1"]], image: { src: "mineru/images/t.jpg", alt: "表格" } };
  assert.match(blockToHtml(block), /^<table>/, "默认给真表格(HTML / LaTeX 目标)");
  assert.equal(blockToHtml(block, { tableMode: "image" }), '<figure><img src="mineru/images/t.jpg" alt="表格"></figure>');
  assert.equal(
    blockToHtml({ type: "table", headers: ["a"], rows: [["1"]] }, { tableMode: "image" }),
    "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
    "没有截图就退回真表格",
  );
  assert.equal(blockToMarkdown(block, { tableMode: "image" }), "![表格](mineru/images/t.jpg)");
  assert.match(blockToMarkdown(block), /^\| a \|/);
});

test("image captions become figcaption", () => {
  assert.equal(
    blockToHtml({ type: "image", image: { src: "mineru/images/a.jpg", alt: "图" }, caption: "图 1. $x^2$ 的示意图" }),
    '<figure><img src="mineru/images/a.jpg" alt="图"><figcaption>图 1. <script type="math/tex">x^2</script> 的示意图</figcaption></figure>',
  );
  assert.equal(blockToHtml({ type: "image", image: { src: "a.jpg" } }), '<figure><img src="a.jpg" alt=""></figure>');
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

test("page footnotes render as quotes instead of being dropped", () => {
  const block = { type: "page_footnote", text: "① 原题: An Axiomatization of Set Theory。", page: 17 };
  const html = blockToHtml(block);
  assert.match(html, /^<blockquote class="docvortex-footnote">① 原题/);
  const md = blockToMarkdown(block);
  assert.match(md, /^> ① 原题: An Axiomatization of Set Theory。（第 17 页）$/);
  assert.equal(blockToHtml({ type: "page_footnote", text: "   " }), "");
});
