import test from "node:test";
import assert from "node:assert/strict";

import { buildSolveMessages, buildStructureMessages, normalizeSolve, parseJudgeJson, parseStructureStarts } from "../packages/reader/src/quiz-judge.js";

test("the solve prompt carries the program context and normalises its answer", () => {
  const messages = buildSolveMessages(
    { type: "single_choice", stem: "程序输出什么？（）", options: [{ label: "A", text: "1" }, { label: "B", text: "2" }] },
    { section: "二、阅读程序", context: "int main() { return 0; }" },
  );
  const prompt = messages.map((message) => message.content).join("\n");
  assert.match(prompt, /程序输出什么/);
  assert.match(prompt, /int main\(\) \{ return 0; \}/);
  assert.match(prompt, /二、阅读程序/);
  assert.deepEqual(normalizeSolve({ answer: "B", analysis: "返回 0" }), { answer: "B", analysis: "返回 0" });
  assert.equal(normalizeSolve({}), null);
});

test("the structure prompt asks for question start lines and validates them", () => {
  const messages = buildStructureMessages({ numbered: "1: 1. 第一题\n2:    1. 伪代码", candidates: [1, 2] });
  const prompt = messages.map((message) => message.content).join("\n");
  assert.match(prompt, /真正题干的起始行/);
  assert.match(prompt, /伪代码/);
  assert.deepEqual(parseStructureStarts('{"starts":[1,2,99,0]}', { maxLine: 10, candidates: [1, 2] }), [1, 2]);
  assert.deepEqual(parseStructureStarts("不是 JSON", { maxLine: 10, candidates: [1] }), []);
});

test("judge JSON parsing survives fences and surrounding prose", () => {
  const raw = "好的，结果如下：\n```json\n{\"answer\":\"B\",\"analysis\":\"1+1=2\"}\n```";
  assert.deepEqual(parseJudgeJson(raw), { answer: "B", analysis: "1+1=2" });
  assert.equal(parseJudgeJson("not json"), null);
});
