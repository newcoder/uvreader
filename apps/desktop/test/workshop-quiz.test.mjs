import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerQuizRunners } from "../src/main/workshop-quiz.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-"));
}

function makeRunner({ aiRuntime = null } = {}) {
  const runners = new Map();
  const vaultRoot = tempDir();
  const cacheRoot = tempDir();
  registerQuizRunners(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      extractMarkdown: async () => ({
        ok: true,
        markdown: "## 一、单项选择题\n\n1. 1+1 等于多少？（）\nA. 1 B. 2 C. 3 D. 4\n",
        path: path.join(cacheRoot, "paper.md"),
      }),
      aiRuntime,
      vaultRoot,
      cacheRoot,
    },
  );
  return { runner: runners.get("quiz-export"), vaultRoot };
}

test("quiz-export writes an answering page next to the source", async () => {
  const calls = [];
  const aiRuntime = {
    stream: async (payload) => {
      calls.push(payload.messages[1].content);
      return { ok: true, answer: JSON.stringify({ answer: "B", analysis: "1+1=2" }) };
    },
    abort: () => {},
  };
  const { runner, vaultRoot } = makeRunner({ aiRuntime });
  fs.writeFileSync(path.join(vaultRoot, "试卷.pdf"), "x", "utf8");
  const result = await runner({
    payload: {
      source: "试卷.pdf",
      out: "试卷.答题页.html",
      settings: {},
      config: { id: "p", name: "P", base: "http://127.0.0.1:1", model: "m" },
    },
    report: () => {},
    signal: new AbortController().signal,
  });
  const out = path.join(vaultRoot, "试卷.答题页.html");
  assert.equal(result.output, out);
  assert.ok(fs.existsSync(out));
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /data-answer="B"/);
  assert.match(html, /1\+1=2/);
  assert.equal(calls.length, 1);
  assert.match(result.detail, /AI 补答案 1/);
});

test("quiz-export still works without AI: raw answers only", async () => {
  const { runner, vaultRoot } = makeRunner();
  fs.writeFileSync(path.join(vaultRoot, "卷.pdf"), "x", "utf8");
  const result = await runner({
    payload: { source: "卷.pdf", out: "卷.答题页.html", settings: {}, config: null },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.ok(fs.existsSync(result.output));
  assert.match(result.detail, /未配置 AI/);
});
