import assert from "node:assert/strict";
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

test("circled blanks are wrapped so their digits stay readable", async () => {
  const result = await buildQuizPaper({
    markdown: "## 一、单项选择题\n\n1. ① 处应填（）\nA. 1 B. 2\n",
    baseDir: process.cwd(),
  });
  assert.match(result.html, /<span class="circled">①<\/span>/);
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
