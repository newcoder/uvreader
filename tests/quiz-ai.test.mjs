import assert from "node:assert/strict";
import test from "node:test";

import { quizAnalyzePrompt, quizCurrentQuestionId, quizQuestionIdForText } from "../apps/desktop/src/renderer/quiz-ai.js";

const manifest = {
  questions: [
    {
      id: "q1",
      number: "1.",
      stemHtml: "<p>已知集合 M = {x | 2x - 1 > 5}，则 M ∩ N =（ ）</p>",
      options: [{ key: "A", html: "{1, 2, 3}" }, { key: "B", html: "{2, 3}" }],
    },
    {
      id: "q2",
      number: "2.",
      stemHtml: "<p>某人工智能大语言模型训练 N 个单位的数据量需要的时间 T = k log₂N。</p>",
      options: [{ key: "A", html: "2 h" }, { key: "B", html: "4 h" }],
      analysisHtml: "<p>由对数运算可得答案为 B。</p>",
    },
  ],
};

test("a selection maps back to the question that contains it", () => {
  assert.equal(quizQuestionIdForText(manifest, "某人工智能大语言模型训练 N 个单位"), "q2");
  assert.equal(quizQuestionIdForText(manifest, "由对数运算可得答案为 B"), "q2");
  assert.equal(quizQuestionIdForText(manifest, "2x - 1 > 5"), "q1");
  assert.equal(quizQuestionIdForText(manifest, "短"), "");
});

test("composer content wins over a stale selection and the visible question", () => {
  assert.equal(quizCurrentQuestionId({
    manifest,
    inputText: "请解释：某人工智能大语言模型训练 N 个单位",
    selectionId: "q1",
    selectionText: "已知集合",
    visibleId: "q1",
    activeId: "q1",
  }), "q2");
  assert.equal(quizCurrentQuestionId({
    manifest,
    selectionId: "q2",
    selectionText: "某人工智能",
    inputText: "某人工智能大语言模型训练 N 个单位",
    visibleId: "q1",
    activeId: "q1",
  }), "q2");
});

test("an empty composer ignores a stale selection and uses the visible question", () => {
  assert.equal(quizCurrentQuestionId({
    manifest,
    selectionId: "q2",
    selectionText: "某人工智能",
    visibleId: "q1",
    activeId: "q1",
  }), "q1");
  assert.equal(quizCurrentQuestionId({
    manifest,
    selectionId: "missing",
    selectionText: "",
    visibleId: "q2",
  }), "q2");
});

test("selection text retained in the composer still identifies its question", () => {
  assert.equal(quizCurrentQuestionId({
    manifest,
    inputText: "请解释：某人工智能大语言模型训练 N 个单位",
    visibleId: "q1",
  }), "q2");
  assert.equal(quizCurrentQuestionId({
    manifest,
    inputText: "某人工智能大语言模型训练 N 个单位",
    injectedText: "某人工智能大语言模型训练 N 个单位",
    injectedId: "q2",
    visibleId: "q1",
  }), "q2");
});

test("an empty composer falls back to the first visible question", () => {
  assert.equal(quizCurrentQuestionId({ manifest, inputText: "", visibleId: "q2" }), "q2");
  assert.equal(quizCurrentQuestionId({ manifest, inputText: "", visibleId: "", activeId: "q2" }), "q2");
  assert.equal(quizCurrentQuestionId({ manifest, inputText: "", visibleId: "", activeId: "" }), "q1");
});

test("stale ids and short input do not override a visible question", () => {
  assert.equal(quizCurrentQuestionId({ manifest, selectionId: "missing", inputText: "A", visibleId: "q2" }), "q2");
  assert.equal(quizCurrentQuestionId({ manifest, selectionId: "missing", visibleId: "q2" }), "q2");
});

test("the analyze prompt names the question in the user's numbering", () => {
  assert.equal(quizAnalyzePrompt(manifest.questions[0]), "请解析当前题（第 1 题）。");
  assert.equal(quizAnalyzePrompt({ number: "4-5" }), "请解析当前题（第 4-5 题）。");
  assert.equal(quizAnalyzePrompt({ number: "A" }), "请解析当前题（A）。");
  assert.equal(quizAnalyzePrompt(null), "请解析当前题。");
});
