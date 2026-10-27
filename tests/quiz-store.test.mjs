import assert from "node:assert/strict";
import test from "node:test";

import { gradeQuizAttempt } from "../packages/reader/src/quiz-grade.js";
import { createQuizStore, quizPaperKey, quizQuestionKey } from "../packages/reader/src/quiz-store.js";

function memoryAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    async exists(path) { return files.has(path) || dirs.has(path); },
    async read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    async write(path, value) { files.set(path, value); },
    async process(path, update) { files.set(path, String(update(files.get(path) ?? ""))); },
    async mkdir(path) { dirs.add(path); },
    async list(path) {
      const prefix = `${path}/`;
      const names = new Set();
      for (const file of files.keys()) if (file.startsWith(prefix)) {
        const rest = file.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
  };
}

const manifest = {
  schema: "uvreader.quiz-page/v1",
  paperId: "paper-1",
  title: "试卷一",
  questions: [
    { id: "q1", number: "1", type: "choice", stemHtml: "<p>1+1</p>", options: [{ key: "A", html: "1" }, { key: "B", html: "2" }], answer: "B" },
    { id: "q2", number: "2", type: "true_false", stemHtml: "<p>地球是圆的</p>", options: [], answer: "T" },
  ],
};

test("quiz store keeps attempts and drafts without a wrong-question index", async () => {
  const adapter = memoryAdapter();
  const store = createQuizStore({ adapter, root: "reading", now: () => 1000 });
  const paperKey = quizPaperKey({ htmlPath: "paper.html", manifest });
  await store.ensurePaper(paperKey, {
    title: manifest.title,
    htmlPath: "paper.html",
    manifestHash: "hash-1",
  });
  assert.equal(await store.saveDraft(paperKey, { startedAt: 10, answers: { q1: "B" }, manifestHash: "hash-1" }), true);
  assert.equal((await store.loadPaper(paperKey)).paper.draft.answers.q1, "B");
  assert.equal((await store.readIndex()).papers[paperKey].hasDraft, true);
  const graded = gradeQuizAttempt({
    manifest,
    answers: { q1: "A", q2: "T" },
    questionKeys: { q1: quizQuestionKey(manifest.questions[0]), q2: quizQuestionKey(manifest.questions[1]) },
  });
  assert.deepEqual(graded.summary, { total: 2, correct: 1, wrong: 1, unanswered: 0, ungraded: 0, score: 50, gradedTotal: 2 });
  const saved = await store.submitAttempt(paperKey, {
    attemptId: "a1",
    startedAt: 10,
    submittedAt: 2000,
    durationSec: 25,
    manifestHash: "hash-1",
    answers: graded.answers,
    summary: graded.summary,
  });
  assert.equal(saved.draft, null);
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.wrong, undefined);
  const summary = (await store.readIndex()).papers[paperKey];
  assert.equal(summary.attempts, 1);
  assert.equal(summary.lastScore, 50);
  assert.equal(summary.lastDurationSec, 25);
  assert.equal(summary.lastPageScore, null);
  assert.equal(summary.hasDraft, false);
  assert.equal(await store.updateAttemptResult(paperKey, { attemptId: "a1", pageScore: 9, pageScoreTotal: 50 }), true);
  const updatedSummary = (await store.readIndex()).papers[paperKey];
  assert.equal(updatedSummary.lastPageScore, 9);
  assert.equal(updatedSummary.lastPageScoreTotal, 50);
  const updatedPaper = (await store.loadPaper(paperKey)).paper;
  assert.equal(updatedPaper.attempts[0].pageScore, 9);
  assert.equal(updatedPaper.attempts[0].pageScoreTotal, 50);
  assert.equal(updatedPaper.attempts.length, 1);
});

test("quiz identity keys are stable for the same source and question content", () => {
  const a = quizQuestionKey(manifest.questions[0]);
  const b = quizQuestionKey({ ...manifest.questions[0], stemHtml: "<p>  1+1 </p>" });
  assert.equal(a, b);
  assert.notEqual(quizPaperKey({ htmlPath: "a.html" }), quizPaperKey({ htmlPath: "b.html" }));
});
