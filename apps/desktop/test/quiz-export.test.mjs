import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildQuizPaper } from "../src/main/quiz-export.js";

const PAPER = `## 一、单项选择题

1. 1+1 等于多少？（）
A. 1 B. 2 C. 3 D. 4

2. 这是判断题。（）

## 二、阅读程序

\`\`\`cpp
int main() {
return 0;
}
\`\`\`

1. 程序会返回 0。（）
`;

test("buildQuizPaper asks the model only for questions without an answer", async () => {
  const asked = [];
  const result = await buildQuizPaper({
    markdown: PAPER,
    baseDir: process.cwd(),
    solve: async (messages) => {
      const prompt = messages[1].content;
      asked.push(prompt);
      if (prompt.includes("1+1")) return JSON.stringify({ answer: "B", analysis: "1+1=2" });
      return JSON.stringify({ answer: "对", analysis: "程序正常结束" });
    },
  });
  assert.equal(asked.length, 3);
  assert.match(result.html, /data-answer="B"/);
  assert.match(result.html, /data-answer="T"/);
  assert.match(result.html, /1\+1=2/);
  assert.equal(result.stats.ai.answers, 3);
  // 阅读程序的代码作为上下文送给模型
  assert.ok(asked.some((prompt) => prompt.includes("int main()")));
});

test("inline answers win and no model call is made", async () => {
  const markdown = `## 一、单项选择题

1. 1+1 等于多少？（）
A. 1 B. 2 C. 3 D. 4
答案：B
解析：1+1=2
`;
  let called = 0;
  const result = await buildQuizPaper({
    markdown,
    baseDir: process.cwd(),
    solve: async () => { called += 1; return "{}"; },
  });
  assert.equal(called, 0);
  assert.match(result.html, /data-answer="B"/);
  assert.match(result.html, /解析/);
  assert.equal(result.stats.ai.answers, 0);
});

test("a code line before the fence is absorbed and entities are unescaped", async () => {
  const markdown = `## 一、单项选择题

1. 程序输出什么（）
01 #include &lt;iostream&gt;
<!--page:2-->
\`\`\`
using namespace std;
int main() { return 0; }
\`\`\`
A. 1 B. 2 C. 3 D. 4
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  const pre = /<pre>[\s\S]*?<\/pre>/.exec(result.html)?.[0] || "";
  const code = pre.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.match(code, /#include <iostream>/);
  assert.match(code, /using namespace std;/);
  assert.doesNotMatch(result.html, /&amp;lt;/);
});

test("section types cover statements without parentheses and inline option A", async () => {
  const markdown = `## 二、阅读程序

- 判断题

1）这段程序在任何输入下都会结束。

## - 单选题

2）下列说法正确的是（）。A. 甲
B. 乙
C. 丙
D. 丁
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  assert.match(result.html, /data-kind="true_false"/);
  assert.doesNotMatch(result.html, /data-kind="short"/);
  const card = /data-q="2"[\s\S]*?<\/section>/.exec(result.html)?.[0] || "";
  assert.match(card, /data-value="A"/);
  assert.match(card, /data-value="D"/);
  assert.doesNotMatch(card, /A\. 甲[\s\S]*A\. 甲/, "A 不应该同时留在题干和选项里");
});

test("markdown tables inside a question render as a real table", async () => {
  const markdown = `## 一、单项选择题

1. 干支对照表如下（）
| 天干 | 甲 | 乙 |
| --- | --- | --- |
| 序号 | 4 | 5 |
A. 1 B. 2 C. 3 D. 4
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  assert.match(result.html, /<table class="q-table">/);
  assert.match(result.html, /<th>天干<\/th>/);
  assert.match(result.html, /<td>4<\/td>/);
});

test("the model structure list stops numbered pseudocode from becoming questions", async () => {
  const markdown = `## 一、单项选择题

1. 冒泡排序伪代码：
2. FLAG = n
3. while FLAG > 1 do
4. 第二题（）
A. 1 B. 2 C. 3 D. 4
`;
  let called = 0;
  const result = await buildQuizPaper({
    markdown,
    baseDir: process.cwd(),
    structure: async () => { called += 1; return '{"starts":[3,6]}'; },
  });
  assert.equal(called, 1);
  assert.equal(result.stats.structure, "ai");
  assert.equal(result.stats.units, 2, "伪代码行不再各算一题");
  assert.match(result.html, /FLAG = n/);
  assert.doesNotMatch(result.html, /data-q="3"/);
});

test("a real question survives when the model omits its start", async () => {
  const markdown = `## 一、单项选择题

1. 第一题（）
A. 1 B. 2
2. 第二题（）
A. 1 B. 2
`;
  const result = await buildQuizPaper({
    markdown,
    baseDir: process.cwd(),
    structure: async () => '{"starts":[3]}',
  });
  assert.equal(result.stats.structure, "ai");
  assert.equal(result.stats.units, 2, "模型漏掉第二题时,规则仍保留它");
});

test("an invalid structure answer falls back to rules", async () => {
  const markdown = "## 一、单项选择题\n\n1. 第一题（）\nA. 1 B. 2\n2. 第二题（）\nA. 1 B. 2\n";
  const result = await buildQuizPaper({
    markdown,
    baseDir: process.cwd(),
    structure: async () => '{"starts":[999]}',
  });
  assert.equal(result.stats.structure, "rules");
  assert.equal(result.stats.units, 2);
});

test("an image after the options becomes a figure, not part of the last option", async () => {
  const markdown = `## 一、单项选择题

1. 一棵二叉树如右图所示，该数组最大下标至少为（） A. 6 B. 10 C. 15
![插图](missing-figure.png)
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  assert.match(result.html, /class="q-fig"/);
  const options = /<div class="opts[\s\S]*?<\/div>/.exec(result.html)[0];
  assert.doesNotMatch(options, /<img/, "插图不能落在选项里");
  assert.match(result.html, /<span class="circled">①<\/span>|<img src="missing-figure.png"/);
});

test("an image between options stays with the option above it", async () => {
  const markdown = `## 一、单项选择题

1. 选择正确的图片（）
A. 第一张
![图一](a.png)
B. 第二张
C. 第三张
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  assert.match(result.html, /第一张[\s\S]*a\.png/);
  assert.doesNotMatch(result.html, /class="q-fig"/, "夹在选项中的图不当题干图");
});

test("an image after the last option without a stem reference stays with that option", async () => {
  const markdown = `## 一、单项选择题

1. 选择（）
A. 甲
B. 乙
C. 丙
![图三](c.png)
`;
  const result = await buildQuizPaper({ markdown, baseDir: process.cwd() });
  assert.match(result.html, /丙[\s\S]*c\.png/);
  assert.doesNotMatch(result.html, /class="q-fig"/);
});

test("circled blanks are wrapped so their digits stay readable", async () => {
  const result = await buildQuizPaper({
    markdown: "## 一、单项选择题\n\n1. ① 处应填（）\nA. 1 B. 2\n",
    baseDir: process.cwd(),
  });
  assert.match(result.html, /<span class="circled">①<\/span>/);
});

test("a small image right after a page break is treated as a header logo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-header-"));
  const png = (width, height) => {
    const buffer = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
  };
  fs.writeFileSync(path.join(dir, "logo.png"), png(252, 172));
  fs.writeFileSync(path.join(dir, "figure.png"), png(800, 600));
  const result = await buildQuizPaper({
    markdown: `## 一、单项选择题

1. 第一题（）
A. 1 B. 2
<!--page:10-->
![插图](logo.png)

## 二、阅读程序
2. 第二题（）
A. 1 B. 2
<!--page:11-->
![大图](figure.png)
3. 第三题（）
A. 1 B. 2
`,
    baseDir: dir,
  });
  assert.equal(result.stats.headerImages, 1);
  assert.equal((result.html.match(/<img /g) || []).length, 1, "只保留正常大图");
  assert.match(result.html, /data:image\/png;base64,iVBORw0KGgo/, "正常大图仍内联");
});

test("the exported page is self-contained: MathML, inlined images, no CDN", async () => {
  const result = await buildQuizPaper({
    markdown: "## 一、单项选择题\n\n1. 公式 $x^2$ 的结果是（）\nA. 1 B. 2\n",
    baseDir: process.cwd(),
  });
  assert.match(result.html, /<math/);
  assert.doesNotMatch(result.html, /https?:\/\//);
  assert.doesNotMatch(result.html, /<link[^>]+katex/);
});
