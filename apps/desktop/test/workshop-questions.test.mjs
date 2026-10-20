import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerQuestionRunners } from "../src/main/workshop-questions.js";
import { QUESTION_BANK_SCHEMA } from "../src/shared/question-bank.js";

const PAPER = `# 试卷

一、选择题

1. 下列哪个不是编程语言?
A. Python B. HTML C. C++ D. Java

2. 关于栈的说法正确的是?
A. 先进先出
B. 后进先出

二、判断题

3. 二叉搜索树的中序遍历有序。( )

参考答案

1. B
2. B
3. 对
`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qbr-questions-"));

const makeRunner = ({ markdown = PAPER, vaultRoot = tempDir() } = {}) => {
  const runners = new Map();
  const calls = [];
  registerQuestionRunners({ register: (kind, runner) => runners.set(kind, runner) }, {
    vaultRoot,
    // 引擎客户端只要非空,runner 就按 settings.engineUrl 标注来源(测试不真调引擎)。
    engine: {},
    extractMarkdown: async (absolute, options) => {
      calls.push({ absolute, options });
      return { ok: true, markdown, path: path.join(path.dirname(absolute), "doc.md") };
    },
  });
  return { runner: runners.get("questions-extract"), calls, vaultRoot };
};

test("questions-extract writes bank json, readable markdown and an audit file", async () => {
  const { runner, calls, vaultRoot } = makeRunner();
  const source = path.join(vaultRoot, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4", "utf8");
  const result = await runner({
    payload: { source: "试卷.pdf", settings: { engineUrl: "http://127.0.0.1:8760" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(calls.length, 1, "先走内容提取");
  assert.equal(calls[0].absolute, source);
  assert.equal(calls[0].options.settings.engineUrl, "http://127.0.0.1:8760");

  assert.match(result.output, /试卷_questions\.json$/, "JSON 落盘路径作为任务产物");
  const bank = JSON.parse(fs.readFileSync(result.output, "utf8"));
  assert.equal(bank.schema, QUESTION_BANK_SCHEMA);
  assert.equal(bank.stats.questions, 3);
  assert.deepEqual(bank.stats.by_type, { single_choice: 2, true_false: 1 });
  assert.deepEqual(bank.questions.map((question) => question.answer), ["B", "B", "对"]);
  assert.equal(bank.source.engine, "engine", "走引擎时如实标注");

  const markdown = fs.readFileSync(result.result.markdown, "utf8");
  assert.match(markdown, /### 1\. 下列哪个不是编程语言\?/);
  assert.match(markdown, /> \*\*答案\*\*：B/);

  const audit = JSON.parse(fs.readFileSync(result.result.audit, "utf8"));
  assert.deepEqual(audit.issues, [], "规则解析出来的题库必须过校验");
  assert.match(result.detail, /3 题/);
});

test("questions-extract fails loudly when nothing parses", async () => {
  const { runner, vaultRoot } = makeRunner({ markdown: "只有一段说明文字,没有题号。" });
  const source = path.join(vaultRoot, "说明.pdf");
  fs.writeFileSync(source, "x", "utf8");
  await assert.rejects(
    () => runner({ payload: { source: "说明.pdf", settings: {} }, report: () => {}, signal: new AbortController().signal }),
    /没有识别出题目/,
  );
  // 审计文件仍然写出来,便于排查
  const audit = JSON.parse(fs.readFileSync(path.join(vaultRoot, "说明_audit.json"), "utf8"));
  assert.ok(audit.warnings.length >= 1);
});

test("questions-extract reports a missing source and a failed extraction", async () => {
  const { runner, vaultRoot } = makeRunner();
  await assert.rejects(
    () => runner({ payload: { source: "不存在.pdf", settings: {} }, report: () => {}, signal: new AbortController().signal }),
    /找不到文件/,
  );
  const failing = new Map();
  registerQuestionRunners({ register: (kind, runner) => failing.set(kind, runner) }, {
    vaultRoot,
    extractMarkdown: async () => ({ ok: false, error: "引擎挂了,本机也没有 pdf_tool" }),
  });
  fs.writeFileSync(path.join(vaultRoot, "a.pdf"), "x", "utf8");
  await assert.rejects(
    () => failing.get("questions-extract")({ payload: { source: "a.pdf", settings: {} }, report: () => {}, signal: new AbortController().signal }),
    /引擎挂了/,
  );
});
