import assert from "node:assert/strict";
import test from "node:test";

import { chineseNumber, isChapterHeading, markdownToHtml, splitTextChapters, textToChapters, textToHtml, weakHeadingNumber } from "../src/main/text-book.js";

test("chineseNumber and weakHeadingNumber parse the numbers behind numbered titles", () => {
  assert.equal(chineseNumber("一"), 1);
  assert.equal(chineseNumber("十一"), 11);
  assert.equal(chineseNumber("二十三"), 23);
  assert.equal(chineseNumber("一百零八"), 108);
  assert.equal(chineseNumber("2024"), 0, "阿拉伯数字不走中文解析");
  assert.equal(weakHeadingNumber("一、初入宗门"), 1);
  assert.equal(weakHeadingNumber("12. 拜师"), 12);
  assert.equal(weakHeadingNumber("001 起风"), 1);
  assert.equal(weakHeadingNumber("（一）初入宗门"), 0, "带括号的不认(正文里的引用更常见)");
  assert.equal(weakHeadingNumber("2024 年 3 月"), 2024, "单看像编号 —— 靠序列与间距在 splitTextChapters 里挡掉");
  assert.equal(weakHeadingNumber("1."), 0, "编号后面必须有标题");
  assert.equal(weakHeadingNumber("这是一段普通正文,以数字开头也算不上章节标题"), 0);
});

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

test("numbered chapter lines are recognised when they run in sequence", () => {
  // 「一、标题」「1. 标题」「001 标题」这类在中文 TXT 里很常见。
  const chinese = splitTextChapters([
    "一、山边小村",
    "正文一。".repeat(60),
    "二、青牛镇",
    "正文二。".repeat(60),
    "三、七玄门",
    "正文三。".repeat(60),
  ].join("\n"));
  assert.deepEqual(chinese.map((chapter) => chapter.title), ["一、山边小村", "二、青牛镇", "三、七玄门"]);

  const arabic = splitTextChapters([
    "1. 初入宗门",
    "正文。".repeat(80),
    "2. 拜师学艺",
    "正文。".repeat(80),
  ].join("\n"));
  assert.deepEqual(arabic.map((chapter) => chapter.title), ["1. 初入宗门", "2. 拜师学艺"]);

  const padded = splitTextChapters([
    "001 起风",
    "正文。".repeat(80),
    "002 下雨",
    "正文。".repeat(80),
  ].join("\n"));
  assert.deepEqual(padded.map((chapter) => chapter.title), ["001 起风", "002 下雨"]);
});

test("a numbered list is not mistaken for chapters", () => {
  // 相邻两行的编号列表(隔得近、没有成串的章号)必须留在正文里,退回长度分块。
  const text = [
    "安装说明",
    "1. 打开设置",
    "2. 关闭窗口",
    "3. 重启应用",
    "正文继续。".repeat(200),
  ].join("\n");
  const chapters = splitTextChapters(text);
  assert.equal(chapters.length, 1);
  assert.match(chapters[0].body, /1\. 打开设置/);
  assert.equal(chapters[0].title, "第 1 部分", "没有认出来的标题就按长度分块的默认名");
});

test("strong headings win over numbered lines in the same book", () => {
  const text = [
    "第一章 起风了",
    "正文。".repeat(80),
    "1. 打开设置",
    "2. 关闭窗口",
    "3. 重启应用",
    "第二章 下雨",
    "正文。".repeat(80),
  ].join("\n");
  const chapters = splitTextChapters(text);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["第一章 起风了", "第二章 下雨"]);
  assert.match(chapters[0].body, /1\. 打开设置/, "编号列表留在第一章正文里");
});

test("spelled English chapter and part lines are recognised", () => {
  const text = [
    "Chapter One The Boy",
    "Body one.".repeat(60),
    "Chapter Two The Journey",
    "Body two.".repeat(60),
    "Part Three",
    "Body three.".repeat(60),
  ].join("\n");
  const chapters = splitTextChapters(text);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["Chapter One The Boy", "Chapter Two The Journey", "Part Three"]);
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

test("line-aligned rendering preserves single line breaks", () => {
  assert.equal(textToHtml("孤鸿海上来\n池潢不敢顾", { preserveLineBreaks: true }), "<p>孤鸿海上来<br/>池潢不敢顾</p>");
  assert.equal(markdownToHtml("孤鸿海上来\n池潢不敢顾", { preserveLineBreaks: true }), "<p>孤鸿海上来<br/>池潢不敢顾</p>");
});

test("markdownToHtml keeps numbered sections in one list, their bodies in the same item", () => {
  // 「1. 标题 + 紧跟正文 + 空行 + 2. 标题」是最常见的中文技术稿写法。两个坑:
  // 续行掉到列表外(正文丢)、每项各起一个列表(Word 里编号 1.1.1.1.1. 从 1 重来)。
  const html = markdownToHtml([
    "1. General requirements:",
    "High‑performance work station.",
    "",
    "2. CPU",
    "Model: Ultra 9.",
    "",
    "收尾的一段正文。",
  ].join("\n"));
  assert.match(
    html,
    /<ol>\n<li>General requirements: High‑performance work station\.<\/li>\n<li>CPU Model: Ultra 9\.<\/li>\n<\/ol>/,
    "一个列表、两项,续行并进同一项",
  );
  assert.match(html, /<\/ol>\n<p>收尾的一段正文。<\/p>/, "空行之后的顶格正文才是列表外的一段");
  for (const block of html.match(/<(?:ol|ul)>[\s\S]*?<\/(?:ol|ul)>/g) || []) {
    assert.ok(!block.includes("<p>"), `列表里不该出现段落:${block}`);
  }
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

test("a figure caption with formulas keeps its image", () => {
  // 实测《光学》1798 张图里有 169 张的图注带公式,修好前全被丢掉。
  const math = (latex, display) => `<math data-display="${display}">${latex}</math>`;
  const html = markdownToHtml("![图 2.5 $\\psi$ 对 $t$ 的变化](mineru/chunks/0001-0200/images/a.jpg)", { renderMath: math });
  assert.match(html, /<img src="mineru\/chunks\/0001-0200\/images\/a\.jpg"/);
  assert.match(html, /alt="图 2\.5 \$\\psi\$ 对 \$t\$ 的变化"/, "alt 里放纯 LaTeX,不塞 MathML");
  assert.ok(!/alt="[^"]*<math/.test(html), "MathML 不能进属性");
});

test("emphasis and links survive formulas in the middle", () => {
  const math = (latex) => `<math>${latex}</math>`;
  const html = markdownToHtml("**动能 $E_k$ 的推导** 与 [见 $\\alpha$ 节](u.html)", { renderMath: math });
  assert.match(html, /<strong>动能 <math>E_k<\/math> 的推导<\/strong>/);
  assert.match(html, /<a href="u.html">见 <math>\\alpha<\/math> 节<\/a>/);
});

test("a caption with brackets in the alt keeps its image", () => {
  const html = markdownToHtml("![(b) [五] 衍射](mineru/chunks/0201-0400/images/b.jpg)");
  assert.match(html, /<img src="mineru\/chunks\/0201-0400\/images\/b\.jpg"/);
  assert.match(html, /alt="\(b\) \[五\] 衍射"/);
});

test("a display block whose $$ fences sit on their own lines renders", () => {
  // MinerU 偶尔写成 $$ / 空行 / 公式 / 空行 / $$ —— 空行不该结束公式块。
  const math = (latex, display) => `<math data-display="${display}">${latex}</math>`;
  const html = markdownToHtml([
    "上文。",
    "",
    "$$",
    "",
    "\\frac {1}{f} = (1. 5 4 - 1) \\left(\\frac {1}{1 0 0} - \\frac {1}{- 2 0 . 0}\\right)",
    "",
    "$$",
    "",
    "下文。",
  ].join("\n"), { renderMath: math });
  assert.match(html, /<math data-display="true">\\frac \{1\}\{f\}/, "带空行的行间公式也要渲染");
  assert.ok(!html.includes("$$"), "不留原始 $$ 分隔符");
  assert.match(html, /<p>上文。<\/p>/);
  assert.match(html, /<p>下文。<\/p>/);
});

test("markdownToHtml renders pipe tables as real tables", () => {
  const html = markdownToHtml([
    "| Item | Qty | Note |",
    "| --- | ---: | --- |",
    "| 波导 | 1 | 含 $x^2$ |",
    "| 谐振器 | 2 | |",
    "",
    "表后正文。",
  ].join("\n"), { renderMath: (latex) => `<math>${latex}</math>` });
  assert.match(html, /<table><thead><tr><th>Item<\/th><th>Qty<\/th><th>Note<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<tr><td>波导<\/td><td>1<\/td><td>含 <math>x\^2<\/math><\/td><\/tr>/);
  assert.match(html, /<tr><td>谐振器<\/td><td>2<\/td><td><\/td><\/tr>/, "缺的单元格补空");
  assert.match(html, /<\/table>\n<p>表后正文。<\/p>/);
  assert.equal(markdownToHtml("普通段落 | 里有竖线。"), "<p>普通段落 | 里有竖线。</p>", "行内竖线不当表格");
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

test("page anchor comments from pdf_tool are dropped from the text", () => {
  const html = markdownToHtml([
    "<!--page:16-->",
    "上文。",
    "",
    "<!-- page:17 -->",
    "",
    "下文。",
  ].join("\n"));
  assert.match(html, /<p>上文。<\/p>/);
  assert.match(html, /<p>下文。<\/p>/);
  assert.ok(!html.includes("page:16") && !html.includes("page:17"), "锚点不进成品");
  assert.ok(!/<p>\s*<\/p>/.test(html), "不留空段落");
});

test("printed page anchors from pdf_tool are dropped too", () => {
  const html = markdownToHtml([
    "<!--page:16 printed:7-->",
    "上文。",
    "",
    "<!--page:17 printed:8-->",
    "",
    "下文。",
  ].join("\n"));
  assert.match(html, /<p>上文。<\/p>/);
  assert.match(html, /<p>下文。<\/p>/);
  assert.ok(!html.includes("page:16") && !html.includes("printed:7"), "带印刷页码的锚点也不进成品");
});

test("markdownToHtml lets upstream <sup>/<sub> through but still escapes other HTML", () => {
  const html = markdownToHtml("M<sup>ℓ</sup> 与 H<sub>2</sub>O,以及 <script>alert(1)</script> 和 **粗体**");
  assert.match(html, /M<sup>ℓ<\/sup>/, "上游(MinerU)写的上标要保留,不能显示成字面 <sup>");
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.ok(html.includes("&lt;script&gt;"), "其它标签照旧转义");
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.ok(!/&lt;sup&gt;/.test(html), "不再出现字面的 &lt;sup&gt;");
});
