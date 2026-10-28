import assert from "node:assert/strict";
import test from "node:test";

import { shouldAdoptBookBuildOutput } from "../src/shared/workshop-outputs.js";

const sessionStartedAt = 2_000;
const root = "C:/Users/reader/AppData/Roaming/uvreader/library";
const task = (overrides = {}) => ({
  kind: "book-build",
  status: "done",
  output: "C:/Users/reader/Downloads/novel.epub",
  finishedAt: 1_000,
  ...overrides,
});

test("historical ebook outputs are not re-imported on the next app launch", () => {
  assert.equal(shouldAdoptBookBuildOutput(task(), { sessionStartedAt, vaultRoot: root }), false);
  assert.equal(shouldAdoptBookBuildOutput(task({ finishedAt: sessionStartedAt + 1 }), { sessionStartedAt, vaultRoot: root }), true);
});

test("outputs already inside the library are remembered without importing", () => {
  assert.equal(shouldAdoptBookBuildOutput(task({
    output: `${root}/Books/novel.epub`,
    finishedAt: 1,
  }), { sessionStartedAt, vaultRoot: root }), true);
  assert.equal(shouldAdoptBookBuildOutput(task({ output: "Books/novel.epub", finishedAt: 1 }), { sessionStartedAt, vaultRoot: root }), true);
});

test("only completed ebook builds are adopted", () => {
  assert.equal(shouldAdoptBookBuildOutput(task({ kind: "ebook-convert" }), { sessionStartedAt, vaultRoot: root }), false);
  assert.equal(shouldAdoptBookBuildOutput(task({ status: "failed" }), { sessionStartedAt, vaultRoot: root }), false);
  assert.equal(shouldAdoptBookBuildOutput(task({ output: "" }), { sessionStartedAt, vaultRoot: root }), false);
});
