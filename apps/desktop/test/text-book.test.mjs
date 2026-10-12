import assert from "node:assert/strict";
import test from "node:test";

import { isChapterHeading, markdownToHtml, splitTextChapters, textToChapters, textToHtml } from "../src/main/text-book.js";

test("isChapterHeading recognises Chinese and English chapter lines", () => {
  for (const line of ["第一章 起风了", "第12回", "  ## 第三卷 ", "Chapter 3 The Return", "序章", "楔子：远行", "后记"]) {
    assert.equal(isChapterHeading(line), true, `${line} should be a heading`);
  }
  for (const line of ["", "这是一段很长的正文，不是标题，也不是任何章节的开始，只是一段普通的话，用来测试判断逻辑是否正确。", "第一章 起风了，然后呢，还有很多内容继续写着这一行变得很长很长超过四十个字符限制"]) {
    assert.equal(isChapterHeading(line), false, `${line.slice(0, 12)}… should not be a heading`);
  }
});

test("splitTextChapters cuts before headings and keeps their titles", () => {
  const text = `第一章 起风了

第一段正文。

第二章 雨
第二段正文。`;
  const chapters = splitTextChapters(text);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "第一章 起风了");
  assert.equal(chapters[0].body, "第一段正文。");
  assert.equal(chapters[1].title, "第二章 雨");
  assert.equal(chapters[1].body, "第二段正文。");
});

test("splitTextChapters falls back to length chunks without headings", () => {
  const text = "甲".repeat(9000);
  const chapters = splitTextChapters(text);
  assert.ok(chapters.length >= 2, "long text without headings still splits");
  assert.equal(chapters[0].title, "第 1 部分");
  assert.ok(chapters[0].body.length >= 1000);
});

test("textToHtml turns blank-line separated blocks into paragraphs", () => {
  assert.equal(textToHtml("第一段\n继续\n\n第二段"), "<p>第一段继续</p>\n<p>第二段</p>");
  assert.equal(textToHtml('<script>x</script>'), "<p>&lt;script&gt;x&lt;/script&gt;</p>");
});

test("markdownToHtml handles headings, lists, quotes, code and inline markup", () => {
  const html = markdownToHtml([
    "# 标题",
    "",
    "段落里有 **粗体**、*斜体* 和 `代码`。",
    "",
    "- 一",
    "- 二",
    "",
    "1. 首先",
    "2. 其次",
    "",
    "> 引用一句话",
    "",
    "```js",
    "const a = 1 < 2;",
    "```",
    "",
    "![图](images/a.jpg)",
    "[链接](https://example.com)",
    "",
    "---",
  ].join("\n"));
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<p>段落里有 <strong>粗体<\/strong>、<em>斜体<\/em> 和 <code>代码<\/code>。<\/p>/);
  assert.match(html, /<ul>\n<li>一<\/li>\n<li>二<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>首先<\/li>\n<li>其次<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote><p>引用一句话<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<img src="images\/a\.jpg" alt="图"\/>/);
  assert.match(html, /<a href="https:\/\/example\.com">链接<\/a>/);
  assert.match(html, /<hr\/>/);
});

test("markdownToHtml renders math through the renderMath callback and keeps LaTeX otherwise", () => {
  const math = (latex, display) => `<math data-display="${display}">${latex}</math>`;
  const html = markdownToHtml([
    "# 公式章",
    "",
    "行内 $E = mc^2$ 与 \\(x_1\\)。",
    "",
    "$$",
    "a^2 + b^2 = c^2",
    "$$",
    "",
    "\\[y^2\\]",
  ].join("\n"), { renderMath: math });
  assert.match(html, /行内 <math data-display="false">E = mc\^2<\/math> 与 <math data-display="false">x_1<\/math>。/);
  assert.match(html, /<math data-display="true">a\^2 \+ b\^2 = c\^2<\/math>/);
  assert.ok(!/<p><math data-display="true">/.test(html), "a paragraph that is only a display formula is not wrapped in <p>");
  assert.match(html, /<math data-display="true">y\^2<\/math>/);
  const plain = markdownToHtml("行内 $E = mc^2$。");
  assert.match(plain, /<p>行内 \$E = mc\^2\$。<\/p>/, "without renderMath the LaTeX stays readable");
});

test("markdownToHtml falls back to the escaped LaTeX when a formula fails to render", () => {
  const html = markdownToHtml("结果是 $\\frac{1}{2}$ 的。", { renderMath: () => "" });
  assert.match(html, /结果是 \$\\frac\{1\}\{2\}\$ 的。/);
});

test("textToChapters maps both plain text and markdown inputs", () => {
  const plain = textToChapters("第一章 一\n\n正文。\n\n第二章 二\n\n更多。");
  assert.equal(plain.length, 2);
  assert.equal(plain[0].title, "第一章 一");
  assert.equal(plain[0].html, "<p>正文。</p>");
  const md = textToChapters("# 第一章\n\n**重点**内容。", { markdown: true });
  assert.equal(md.length, 1);
  assert.equal(md[0].title, "第一章");
  assert.equal(md[0].html, "<p><strong>重点</strong>内容。</p>");
});
