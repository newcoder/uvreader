import test from "node:test";
import assert from "node:assert/strict";

import { QUESTION_BANK_SCHEMA, bankForAnswering, bankFromMarkdown, bankToMarkdown, validateBank } from "../src/shared/question-bank.js";

const PAPER = `# 2024 年信息学初赛

一、选择题(每题 2 分)

1. 下列哪个不是编程语言?
A. Python B. HTML C. C++ D. Java

2. 关于栈的说法正确的是?
A. 先进先出
B. 后进先出
C. 只能存数字
D. 不支持删除

二、多项选择题(每题 3 分)

3. 以下哪些是排序算法?
A. 冒泡 B. 快速 C. 二分查找 D. 归并

三、判断题

4. 二叉搜索树的中序遍历是有序的。( )

四、填空题

5. 栈的特点是 ______。

五、简答题

6. 简述递归的两个必要条件。

参考答案

1. B
2. B
3. ABD
4. 对
5. 后进先出
6. 递归要有终止条件,并且每次递归都向终止条件靠近。
`;

test("bankFromMarkdown turns a paper into uvreader.question-bank/v1", () => {
  const { bank, warnings } = bankFromMarkdown(PAPER, { file: "试卷.pdf" });
  assert.equal(bank.schema, QUESTION_BANK_SCHEMA);
  assert.equal(bank.source.file, "试卷.pdf");
  assert.equal(bank.stats.questions, 6, JSON.stringify(warnings));
  assert.deepEqual(bank.stats.by_type, {
    single_choice: 2,
    multiple_choice: 1,
    true_false: 1,
    fill_blank: 1,
    short_answer: 1,
  });

  const [q1, q2, q3, q4, q5, q6] = bank.questions;
  assert.equal(q1.id, "q1");
  assert.equal(q1.number, "1");
  assert.equal(q1.type, "single_choice");
  assert.match(q1.stem, /不是编程语言/);
  assert.deepEqual(q1.options.map((option) => `${option.label}${option.text}`), ["APython", "BHTML", "CC++", "DJava"], "同一行的并排选项要拆开");
  assert.equal(q1.answer, "B");

  assert.equal(q2.type, "single_choice", "多行选项");
  assert.deepEqual(q2.options.map((option) => option.text), ["先进先出", "后进先出", "只能存数字", "不支持删除"]);
  assert.equal(q2.answer, "B");

  assert.equal(q3.type, "multiple_choice", "多选小节 + 多字母答案");
  assert.equal(q3.answer, "ABD");

  assert.equal(q4.type, "true_false", "判断题小节");
  assert.equal(q4.answer, "对");

  assert.equal(q5.type, "fill_blank", "下划线 → 填空");
  assert.equal(q5.answer, "后进先出");

  assert.equal(q6.type, "short_answer");
  assert.match(q6.answer, /终止条件/);
});

test("bankFromMarkdown keeps answers/analysis written inline and picks up images", () => {
  const md = `## 选择题

7. 如图,求面积。![](assets/p7.png)
A. 1 ![](assets/a.png) B. 2 C. 3 D. 4
答案:A
解析:底乘高除以二。
`;
  const { bank } = bankFromMarkdown(md, { file: "x.md" });
  const [q] = bank.questions;
  assert.equal(q.type, "single_choice");
  assert.equal(q.answer, "A");
  assert.match(q.analysis, /底乘高/);
  assert.deepEqual(q.images.map((image) => image.role), ["stem", "option"], "题干图 / 选项图各归各位");
});

test("bankFromMarkdown warns instead of inventing questions or answers", () => {
  const none = bankFromMarkdown("这只是一段没有题号的说明文字。", {});
  assert.equal(none.bank.questions.length, 0);
  assert.match(none.warnings.join(" "), /没有识别出题目/);

  const thin = bankFromMarkdown("1. 只有题干没有选项的选择题\n", {});
  assert.equal(thin.bank.questions[0].type, "short_answer", "没有选项就不是选择题");
  assert.equal(thin.bank.questions[0].answer, "", "没有答案就留空,不猜");

  const oneOption = bankFromMarkdown("## 选择题\n\n2. 题目\nA. 只有一个选项\n", {});
  assert.match(oneOption.warnings.join(" "), /只找到 1 个选项/);
});

test("bankToMarkdown renders questions, options, answers and analysis", () => {
  const { bank } = bankFromMarkdown(PAPER, { file: "试卷.pdf" });
  const md = bankToMarkdown(bank);
  assert.match(md, /### 1\. 下列哪个不是编程语言\?/);
  assert.match(md, /- \*\*A\.\*\* Python/);
  assert.match(md, /> \*\*答案\*\*：B/);
  assert.match(md, /共 6 题/);
});

test("bankFromMarkdown understands 参考答案 / 标准答案 and duplicates", () => {
  const md = `## 选择题

1. 题目一
A. 甲 B. 乙 C. 丙 D. 丁
参考答案:C
标准答案:C

2. 题目二
A. 甲 B. 乙
标准答案:A
`;
  const { bank } = bankFromMarkdown(md, {});
  assert.equal(bank.questions.length, 2);
  assert.deepEqual(bank.questions.map((question) => question.answer), ["C", "A"], "参考答案 / 标准答案 两种写法都要认");
});

test("bankToMarkdown renders the images it stored", () => {
  const md = `## 选择题

8. 如图,选出正确图形。![](images/p8.png)
A. 1 B. 2
答案:A
`;
  const { bank } = bankFromMarkdown(md, {});
  const rendered = bankToMarkdown(bank);
  assert.ok(rendered.includes("![](images/p8.png)"), "题干图要出现在 Markdown 里(否则看得到题、看不到图)");
});

test("answers do not swallow 试题难度, and fold tags are stripped", () => {
  const md = `## 选择题

1. 题目
A. 甲 B. 乙
参考答案:C
试题难度:一星
试题解析:因为……
`;
  const { bank } = bankFromMarkdown(md, {});
  const [q] = bank.questions;
  assert.equal(q.answer, "C", "难度不是答案");
  assert.match(q.analysis, /因为/);

  const folded = bankFromMarkdown("## 选择题\n\n2. 如图<details><summary>展开</summary>看下图</details>\nA. 1 B. 2\n答案:A\n", {});
  assert.doesNotMatch(folded.bank.questions[0].stem, /<\/?details>|<\/?summary>/);
  assert.match(folded.bank.questions[0].stem, /看下图/, "折叠块里的文字要留下");
});

test("the answering view never carries answers or analysis", () => {
  const { bank } = bankFromMarkdown(PAPER, { file: "试卷.pdf" });
  const view = bankForAnswering(bank);
  assert.equal(view.questions.length, bank.questions.length);
  for (const question of view.questions) {
    assert.equal("answer" in question, false, "答题视图不能有 answer 字段");
    assert.equal("analysis" in question, false, "答题视图不能有 analysis 字段");
    // 连序列化之后也不能出现答案内容
    const text = JSON.stringify(question);
    assert.doesNotMatch(text, /"(answer|analysis)"/);
  }
  const original = bank.questions.find((question) => question.number === "1");
  assert.equal(original.answer, "B", "完整 bank 里答案当然还在(判题用)");
  assert.equal(view.questions[0].stem, original.stem, "题干/选项/图片照常给");
  assert.deepEqual(view.questions[0].options, original.options);
});

test("bankToMarkdown keeps inline images where they were, with the text between them", () => {
  const md = `## 编程题

37. 画图。
要求:
(1) 画圆。
![](images/a.png)
(2) 再画一个。
![](images/b.png)
(3) 最后画一个。
![](images/c.png)
答案:参考程序略
`;
  const { bank } = bankFromMarkdown(md, {});
  const [q] = bank.questions;
  // 契约:文本里的内联链接原样保留(图片位置就是语义的一部分)
  const order = ["要求:", "![](images/a.png)", "(2) 再画一个。", "![](images/b.png)", "(3) 最后画一个。", "![](images/c.png)"];
  let cursor = -1;
  for (const piece of order) {
    const at = q.stem.indexOf(piece);
    assert.ok(at > cursor, `题干里「${piece}」的位置不对:${q.stem}`);
    cursor = at;
  }
  assert.deepEqual(q.images.map((image) => image.src), ["images/a.png", "images/b.png", "images/c.png"], "images[] 只是汇总");

  const rendered = bankToMarkdown(bank);
  assert.equal((rendered.match(/!\[/g) || []).length, 3, "Markdown 里每张图只出现一次(不重复堆叠)");
  assert.ok(rendered.indexOf("![](images/a.png)") < rendered.indexOf("(2) 再画一个。"), "Markdown 也保持原顺序");
});

test("validateBank catches broken banks before they reach disk", () => {
  assert.deepEqual(validateBank(bankFromMarkdown(PAPER, {}).bank), [], "规则解析出来的必须自洽");
  const issues = validateBank({
    schema: "wrong",
    questions: [
      { id: "q1", number: "1", type: "single_choice", stem: "x", options: [{ label: "Z", text: "" }] },
      { id: "q1", number: "2", type: "nope", stem: "" },
    ],
  });
  assert.ok(issues.some((issue) => /schema/.test(issue)));
  assert.ok(issues.some((issue) => /id 重复/.test(issue)));
  assert.ok(issues.some((issue) => /未知题型/.test(issue)));
  assert.ok(issues.some((issue) => /缺题干/.test(issue)));
  assert.ok(issues.some((issue) => /选项标签/.test(issue)));
  assert.ok(issues.some((issue) => /是空的/.test(issue)));
});
