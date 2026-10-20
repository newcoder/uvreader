import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { buildJudgeMessages, judgeAttempt, mergeJudge, normalizeJudge, parseJudgeJson } from "../packages/reader/src/quiz-judge.js";
import { createAttempt, gradeQuestion } from "../packages/reader/src/quiz-attempt.js";
import { renderQuizPanel } from "../packages/reader/src/quiz-panel.js";

const QUESTION = {
  id: "q1",
  number: "1",
  type: "single_choice",
  stem: "1+1=?",
  options: [{ label: "A", text: "1" }, { label: "B", text: "2" }],
};

test("the judge prompt carries the question, the answer and any standard answer", () => {
  const plain = buildJudgeMessages(QUESTION, "A").map((message) => message.content).join("\n");
  assert.match(plain, /1\+1=\?/);
  assert.match(plain, /A\. 1/);
  assert.match(plain, /学生作答：\nA/);
  assert.match(plain, /没有标准答案时，请自己解题/);
  assert.doesNotMatch(plain, /标准答案：/);

  const withStandard = buildJudgeMessages({ ...QUESTION, answer: "B", analysis: "因为 1+1=2" }, "A")
    .map((message) => message.content)
    .join("\n");
  assert.match(withStandard, /标准答案：\nB/);
  assert.match(withStandard, /标准解析：\n因为 1\+1=2/);
});

test("judge JSON parsing survives fences and surrounding prose", () => {
  const raw = "好的，结果如下：\n```json\n{\"verdict\":\"wrong\",\"score\":0,\"answer\":\"B\",\"analysis\":\"1+1=2\"}\n```";
  const parsed = normalizeJudge(parseJudgeJson(raw));
  assert.equal(parsed.verdict, "wrong");
  assert.equal(parsed.answer, "B");
  assert.equal(parsed.analysis, "1+1=2");
  assert.equal(parseJudgeJson("not json"), null);
  assert.equal(normalizeJudge({ verdict: "maybe" }), null);
  assert.equal(normalizeJudge({ verdict: "partial", score: 7 }).score, 1, "分数夹在 0–1");
});

test("a standard answer keeps the deterministic verdict while the model supplies analysis", () => {
  const question = { ...QUESTION, answer: "B" };
  const deterministic = gradeQuestion(question, "A");
  const merged = mergeJudge(deterministic, { verdict: "correct", score: 1, answer: "A", analysis: "其实 1+1=2" });
  assert.equal(merged.status, "wrong", "有标准答案时不信模型的判定");
  assert.equal(merged.source, "standard");
  assert.equal(merged.analysis, "其实 1+1=2", "解析仍用模型的");

  const noStandard = mergeJudge(gradeQuestion({ ...QUESTION, answer: "" }, "A"), {
    verdict: "correct", score: 1, answer: "A", analysis: "对",
  });
  assert.equal(noStandard.status, "correct");
  assert.equal(noStandard.source, "ai", "没有标准答案时以模型判定为准");

  const blank = mergeJudge(gradeQuestion({ ...QUESTION, answer: "" }, ""), { verdict: "blank" });
  assert.equal(blank.status, "unanswered");
});

test("judgeAttempt only asks for answered questions and keeps partial results", async () => {
  const bank = {
    ...QUESTION,
    questions: [
      QUESTION,
      { id: "q2", number: "2", type: "short_answer", stem: "说明理由" },
      { id: "q3", number: "3", type: "single_choice", stem: "未答", options: [{ label: "A", text: "x" }] },
    ],
  };
  const attempt = { ...createAttempt(bank), answers: { q1: "A", q2: "因为 2" } };
  const asked = [];
  const progress = [];
  const result = await judgeAttempt({
    bank,
    attempt,
    complete: async (messages) => {
      asked.push(messages[1].content);
      if (messages[1].content.includes("说明理由")) return "{\"verdict\":\"partial\",\"score\":0.5,\"analysis\":\"要点不全\"}";
      return "```json\n{\"verdict\":\"correct\",\"score\":1,\"answer\":\"A\",\"analysis\":\"对\"}\n```";
    },
    concurrency: 2,
    onProgress: (done, total, snapshot) => progress.push({ done, total, keys: Object.keys(snapshot) }),
  });
  assert.equal(asked.length, 2, "未作答的题不送去判");
  assert.equal(result.judged, 2);
  assert.equal(result.judgements.q1.status, "correct");
  assert.equal(result.judgements.q2.status, "partial");
  assert.equal(result.judgements.q2.score, 0.5);
  assert.deepEqual(progress.at(-1).keys.sort(), ["q1", "q2"]);
});

test("a broken model reply is counted as a failure instead of poisoning the attempt", async () => {
  const bank = { ...QUESTION, questions: [QUESTION] };
  const attempt = { ...createAttempt(bank), answers: { q1: "A" } };
  const result = await judgeAttempt({ bank, attempt, complete: async () => "抱歉，我无法回答" });
  assert.equal(result.judged, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.judgements, {});
});

test("the panel shows the AI verdict and explanation after judging", () => {
  const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>");
  const host = dom.window.document.getElementById("host");
  const bank = { schema: "uvreader.question-bank/v1", source: { file: "p.pdf" }, questions: [QUESTION] };
  const attempt = { ...createAttempt(bank), answers: { q1: "A" }, submittedAt: new Date().toISOString() };
  renderQuizPanel(host, {
    bank,
    attempt,
    results: null,
    judgements: { q1: { status: "wrong", source: "ai", score: 0, answer: "B", analysis: "1+1 等于 2" } },
    renderText: (node, text) => { node.textContent = text; },
  });
  const badge = host.querySelector('[data-qid="q1"] .qiaomu-reader-quiz-badge');
  assert.equal(badge.textContent, "错误（AI）");
  assert.match(host.querySelector(".qiaomu-reader-quiz-analysis").textContent, /参考答案：B/);
  assert.match(host.querySelector(".qiaomu-reader-quiz-analysis").textContent, /1\+1 等于 2/);
});
