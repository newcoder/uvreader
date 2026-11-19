import assert from "node:assert/strict";
import test from "node:test";

import { buildQuizAiGradeMessages, parseQuizAiGradeReply } from "../packages/reader/src/quiz-ai-grade.js";

const manifest = {
  schema: "uvreader.quiz-page/v1",
  paperId: "p1",
  title: "测试试卷",
  grading: "ai",
  questions: [
    {
      id: "q1",
      number: "1.",
      type: "choice",
      stemHtml: "已知 <b>x</b>，选择正确答案。",
      options: [{ key: "A", html: "甲" }, { key: "B", html: "乙" }],
    },
    {
      id: "q2",
      number: "2.",
      type: "short",
      stemHtml: "写出计算过程。",
    },
    {
      id: "q3",
      number: "3.",
      type: "true_false",
      stemHtml: "这个说法正确。",
    },
  ],
};

test("grading messages contain the paper and user answers, not the correct answers", () => {
  const messages = buildQuizAiGradeMessages({
    manifest: { ...manifest, questions: manifest.questions.map((question) => ({ ...question, answer: "A", analysisHtml: "secret" })) },
    answers: { q1: "B", q2: "过程", q3: "" },
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只输出 JSON/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.title, "测试试卷");
  assert.equal(payload.questions.length, 3);
  assert.equal(payload.questions[0].userAnswer, "B");
  assert.equal(payload.questions[1].userAnswer, "过程");
  assert.equal(payload.questions[2].userAnswer, "");
  assert.equal("analysisHtml" in payload.questions[0], false);
  assert.doesNotMatch(messages[1].content, /secret/);
});

test("AI grading replies become store answers, details and a summary", () => {
  const graded = parseQuizAiGradeReply(JSON.stringify({
    results: [
      { id: "q1", state: "correct", feedback: "选对了", referenceAnswer: "B" },
      { id: "q2", state: "reference", feedback: "步骤基本正确", referenceAnswer: "先算再化简" },
      { id: "q3", state: "wrong", feedback: "应判为对" },
    ],
  }), {
    manifest,
    answers: { q1: "B", q2: "过程", q3: "" },
    questionKeys: { q1: "k1", q2: "k2", q3: "k3" },
  });
  assert.deepEqual(graded.summary, {
    total: 3,
    correct: 1,
    wrong: 0,
    unanswered: 1,
    ungraded: 1,
    gradedTotal: 2,
    score: 50,
    ai: true,
  });
  assert.deepEqual(graded.answers.k1, { value: "B", state: "correct" });
  assert.deepEqual(graded.answers.k2, { value: "过程", state: "reference" });
  assert.deepEqual(graded.answers.k3, { value: "", state: "unanswered" });
  assert.equal(graded.details[1].feedback, "步骤基本正确");
  assert.equal(graded.details[1].referenceAnswer, "先算再化简");
});

test("fenced or noisy JSON replies are still parsed, and missing results become references", () => {
  const graded = parseQuizAiGradeReply([
    "判分结果如下：",
    "```json",
    JSON.stringify({ results: [{ id: "q1", state: "correct", feedback: "ok" }] }),
    "```",
  ].join("\n"), {
    manifest,
    answers: { q1: "B", q2: "x", q3: "对" },
  });
  assert.equal(graded.summary.total, 3);
  assert.equal(graded.summary.correct, 1);
  assert.equal(graded.summary.ungraded, 2);
  assert.equal(graded.details[1].state, "reference");
  assert.match(graded.details[1].feedback, /未返回/);
});

test("an empty answer stays unanswered even when the model returns another state", () => {
  const graded = parseQuizAiGradeReply(JSON.stringify({
    results: [{ id: "q1", state: "correct", feedback: "ok" }],
  }), { manifest: { ...manifest, questions: [manifest.questions[0]] }, answers: { q1: "" }, questionKeys: { q1: "k1" } });
  assert.equal(graded.answers.k1.state, "unanswered");
  assert.equal(graded.summary.unanswered, 1);
  assert.equal(graded.summary.correct, 0);
});

test("unparseable grading replies fail with a retryable message", () => {
  assert.throws(() => parseQuizAiGradeReply("not json", { manifest, answers: {} }), /无法解析/);
  assert.throws(() => parseQuizAiGradeReply('{"results":[]}', { manifest, answers: {} }), /没有题目/);
});
