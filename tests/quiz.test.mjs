import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { createAttempt, gradeAttempt, gradeQuestion, isAnswered, setAnswer } from "../packages/reader/src/quiz-attempt.js";
import { renderQuizPanel } from "../packages/reader/src/quiz-panel.js";

const BANK = {
  schema: "uvreader.question-bank/v1",
  source: { file: "试卷.pdf" },
  questions: [
    { id: "q1", number: "1", type: "single_choice", stem: "选择题", options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }] },
    { id: "q2", number: "2", type: "multiple_choice", stem: "多选题", options: [{ label: "A", text: "甲" }, { label: "B", text: "乙" }, { label: "C", text: "丙" }] },
    { id: "q3", number: "3", type: "true_false", stem: "判断题" },
    { id: "q4", number: "4", type: "short_answer", stem: "简答题" },
  ],
};

const FULL = {
  ...BANK,
  questions: BANK.questions.map((question) => ({
    ...question,
    answer: { q1: "B", q2: "A、C", q3: "对", q4: "略" }[question.id],
  })),
};

test("an attempt starts empty and keeps the bank identity", () => {
  const attempt = createAttempt(BANK, { now: () => 1000 });
  assert.equal(attempt.schema, "uvreader.quiz-attempt/v1");
  assert.equal(attempt.bank.file, "试卷.pdf");
  assert.deepEqual(attempt.answers, {});
  assert.equal(attempt.submittedAt, null);
  assert.equal(attempt.startedAt, new Date(1000).toISOString());
});

test("setAnswer drops empty answers instead of keeping blank entries", () => {
  let attempt = createAttempt(BANK);
  attempt = setAnswer(attempt, "q1", "A");
  assert.equal(attempt.answers.q1, "A");
  attempt = setAnswer(attempt, "q1", "");
  assert.equal("q1" in attempt.answers, false);
  attempt = setAnswer(attempt, "q2", []);
  assert.equal("q2" in attempt.answers, false);
});

test("objective questions are graded exactly, everything else stays ungraded", () => {
  assert.equal(gradeQuestion(FULL.questions[0], "B").status, "correct");
  assert.equal(gradeQuestion(FULL.questions[0], "A").status, "wrong");
  assert.equal(gradeQuestion(FULL.questions[1], ["C", "A"]).status, "correct", "多选顺序无关");
  assert.equal(gradeQuestion(FULL.questions[1], ["A"]).status, "wrong");
  assert.equal(gradeQuestion(FULL.questions[2], "T").status, "correct");
  assert.equal(gradeQuestion(FULL.questions[2], "错").status, "wrong");
  assert.equal(gradeQuestion(FULL.questions[3], "随便写").status, "ungraded");
  assert.equal(gradeQuestion(BANK.questions[0], "").status, "unavailable", "答题视图没有参考答案时不下判断");
});

test("gradeAttempt counts correct, wrong and pending questions", () => {
  const attempt = { ...createAttempt(BANK), answers: { q1: "B", q2: ["A"], q3: "T", q4: "略" } };
  const result = gradeAttempt(FULL, attempt);
  assert.equal(result.correct, 2);
  assert.equal(result.wrong, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.total, 4);
});

test("isAnswered treats blanks and empty lists as unanswered", () => {
  const attempt = { ...createAttempt(BANK), answers: { q1: "A", q2: [], q3: "  ", q4: "x" } };
  assert.equal(isAnswered(attempt, BANK.questions[0]), true);
  assert.equal(isAnswered(attempt, BANK.questions[1]), false);
  assert.equal(isAnswered(attempt, BANK.questions[2]), false);
  assert.equal(isAnswered(attempt, BANK.questions[3]), true);
});

function mount() {
  const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>");
  return dom.window.document.getElementById("host");
}

test("the panel records answers and submits once the missing ones are confirmed", () => {
  const host = mount();
  let attempt = createAttempt(BANK);
  const changes = [];
  const submits = [];
  const draw = () => renderQuizPanel(host, {
    bank: BANK,
    attempt,
    onChange: (next) => { attempt = next; changes.push(next); },
    onSubmit: (next) => submits.push(next),
    renderText: (node, text) => { node.textContent = text; },
  });
  draw();

  const options = host.querySelectorAll('[data-qid="q1"] [data-option]');
  assert.equal(options.length, 2);
  options[1].dispatchEvent(new host.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(attempt.answers.q1, "B");
  assert.equal(options[1].classList.contains("is-selected"), true);
  assert.equal(host.querySelector(".qiaomu-reader-quiz-progress").textContent, "已答 1 / 4");

  // 还有 3 题没答:第一次提交只提示,不发请求
  const submit = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "提交");
  submit().dispatchEvent(new host.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(submits.length, 0);
  assert.match(host.querySelector(".qiaomu-reader-quiz-hint").textContent, /还有 3 题没答/);
  submit().dispatchEvent(new host.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(submits.length, 1);
  assert.ok(submits[0].submittedAt);
});

test("a submitted attempt locks inputs and shows the per-question result", () => {
  const host = mount();
  const attempt = { ...createAttempt(BANK), answers: { q1: "A" }, submittedAt: new Date().toISOString() };
  const results = gradeAttempt(FULL, attempt);
  renderQuizPanel(host, { bank: BANK, attempt, results, renderText: (node, text) => { node.textContent = text; } });
  const options = host.querySelectorAll('[data-qid="q1"] [data-option]');
  assert.equal([...options].every((button) => button.disabled), true, "提交后不能改答案");
  const badge = host.querySelector('[data-qid="q1"] .qiaomu-reader-quiz-badge');
  assert.equal(badge.textContent, "错误");
  assert.match(host.querySelector(".qiaomu-reader-quiz-summary").textContent, /答对 0/);
});
