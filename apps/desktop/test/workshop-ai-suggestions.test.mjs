import assert from "node:assert/strict";
import test from "node:test";

import { pickAiSuggestion } from "../src/shared/workshop-ai-suggestions.js";

const done = (overrides = {}) => ({
  id: "task-1",
  kind: "ai-metadata",
  status: "done",
  result: { title: "A" },
  source: "Books/a.epub",
  ...overrides,
});

test("a suggestion is only shown for the source that produced it", () => {
  assert.equal(pickAiSuggestion([done()], { source: "Books/a.epub" })?.id, "task-1");
  assert.equal(pickAiSuggestion([done()], { source: "Books/b.epub" }), null);
  assert.equal(pickAiSuggestion([done({ source: "" })], { source: "Books/a.epub" }), null);
});

test("AI clean suggestions are captured and dismissed tasks stay hidden", () => {
  const clean = done({ id: "clean-1", kind: "ai-clean", result: { chapters: [] } });
  assert.equal(pickAiSuggestion([clean], { source: "Books/a.epub" })?.kind, "ai-clean");
  assert.equal(pickAiSuggestion([clean], { source: "Books/a.epub", dismissed: new Set(["clean-1"]) }), null);
});

test("unfinished, failed or unknown tasks never become suggestions", () => {
  assert.equal(pickAiSuggestion([done({ status: "running" })], { source: "Books/a.epub" }), null);
  assert.equal(pickAiSuggestion([done({ status: "failed" })], { source: "Books/a.epub" }), null);
  assert.equal(pickAiSuggestion([done({ result: null })], { source: "Books/a.epub" }), null);
  assert.equal(pickAiSuggestion([done({ kind: "ocr-export" })], { source: "Books/a.epub" }), null);
});
