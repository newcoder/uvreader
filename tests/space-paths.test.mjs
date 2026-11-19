import assert from "node:assert/strict";
import test from "node:test";

import { isQuizOutput, spaceCategoryDir, spaceOutputPath, spaceRootForSource } from "../packages/reader/src/space-paths.js";

test("space paths are found for absolute, relative and Windows source paths", () => {
  assert.equal(spaceRootForSource("D:/library/Spaces/论文研究/books/a.pdf"), "D:/library/Spaces/论文研究");
  assert.equal(spaceRootForSource("Spaces/论文研究/books/a.pdf"), "Spaces/论文研究");
  assert.equal(spaceRootForSource("D:\\library\\Spaces\\论文研究\\books\\a.pdf"), "D:/library/Spaces/论文研究");
  assert.equal(spaceRootForSource("D:/library/Books/a.pdf"), "");
  assert.equal(spaceRootForSource("D:/library/Spaces/论文研究/a.pdf"), "");
});

test("space outputs use the category directory and avoid (1) on collisions", () => {
  const source = "D:/library/Spaces/论文研究/books/试卷.pdf";
  assert.equal(spaceCategoryDir(source, "quizzes"), "D:/library/Spaces/论文研究/quizzes");
  assert.equal(spaceOutputPath(source, "quizzes", "AI答题页.html"), "D:/library/Spaces/论文研究/quizzes/试卷.AI答题页.html");
  assert.equal(spaceOutputPath(source, "quizzes", "普通答题页.html"), "D:/library/Spaces/论文研究/quizzes/试卷.普通答题页.html");
  const existing = new Set([
    "D:/library/Spaces/论文研究/quizzes/试卷.md",
    "D:/library/Spaces/论文研究/quizzes/试卷 - 20261109-2000.md",
  ]);
  const out = spaceOutputPath(source, "quizzes", "md", {
    exists: (value) => existing.has(value),
    now: new Date(2026, 10, 9, 20, 0),
  });
  assert.equal(out, "D:/library/Spaces/论文研究/quizzes/试卷 - 20261109-2000-2.md");
  assert.doesNotMatch(out, /\(1\)/);
});

test("non-space sources keep the existing fallback", () => {
  assert.equal(spaceOutputPath("D:/library/Books/a.pdf", "quizzes", "html"), "");
  assert.equal(spaceCategoryDir("D:/library/Books/a.pdf", "quizzes"), "");
});

test("only quiz HTML outputs open in the reader's quiz view", () => {
  assert.equal(isQuizOutput({ name: "试卷.AI答题页.html", relativePath: "quizzes/试卷.AI答题页.html" }), true);
  assert.equal(isQuizOutput({ name: "试卷.普通答题页.html", relativePath: "quizzes/试卷.普通答题页.html" }), true);
  assert.equal(isQuizOutput({ name: "试卷.html", relativePath: "quizzes/试卷.html", category: "quizzes" }), true);
  assert.equal(isQuizOutput({ name: "试卷.HTM", relativePath: "quizzes/试卷.HTM" }), true);
  assert.equal(isQuizOutput({ name: "试卷.html", relativePath: "exports/试卷.html" }), false);
  assert.equal(isQuizOutput({ name: "阅读笔记.md", relativePath: "quizzes/阅读笔记.md" }), false);
  assert.equal(isQuizOutput({ name: "封面.png", category: "quizzes" }), false);
  assert.equal(isQuizOutput(null), false);
});
