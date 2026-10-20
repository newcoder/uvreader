import test from "node:test";
import assert from "node:assert/strict";

import { QUESTION_BANK_SCHEMA, bankFromMarkdown, bankToMarkdown, validateBank } from "../src/shared/question-bank.js";

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
