import assert from "node:assert/strict";
import test from "node:test";

import { QUIZ_PAGE_MANIFEST_HEAD_BYTES, quizPageScanKey, readQuizPageManifest } from "../packages/reader/src/quiz-page-scan.js";

function pageHtml(manifest, padding = "") {
  return `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>${padding}</body></html>`;
}

function fakeAdapter(html, calls) {
  return {
    async readHead(_path, bytes) {
      calls.head += 1;
      return html.slice(0, bytes);
    },
    async read() {
      calls.full += 1;
      return html;
    },
  };
}

test("quiz page scan reads only the manifest prefix and caches it by stat", async () => {
  const html = pageHtml({ title: "A", questions: [{ id: "q1" }] }, "x".repeat(QUIZ_PAGE_MANIFEST_HEAD_BYTES * 2));
  const calls = { head: 0, full: 0 };
  const cache = new Map();
  const stat = { mtime: 10, size: html.length };
  const first = await readQuizPageManifest({ adapter: fakeAdapter(html, calls), path: "a.html", stat, cache });
  assert.equal(first.title, "A");
  assert.deepEqual(calls, { head: 1, full: 0 });
  const second = await readQuizPageManifest({ adapter: fakeAdapter(html, calls), path: "a.html", stat, cache });
  assert.equal(second.title, "A");
  assert.deepEqual(calls, { head: 1, full: 0 });
  await readQuizPageManifest({ adapter: fakeAdapter(html, calls), path: "a.html", stat: { ...stat, mtime: 11 }, cache });
  assert.deepEqual(calls, { head: 2, full: 0 });
});

test("quiz page scan falls back to the full file when the prefix cuts the manifest", async () => {
  const html = pageHtml({ title: "Long", questions: [{ id: "q1", stem: "y".repeat(1000) }] });
  const calls = { head: 0, full: 0 };
  const manifest = await readQuizPageManifest({
    adapter: fakeAdapter(html, calls),
    path: "long.html",
    stat: { mtime: 1, size: html.length },
    cache: new Map(),
    headBytes: 80,
  });
  assert.equal(manifest.title, "Long");
  assert.deepEqual(calls, { head: 1, full: 1 });
});

test("quiz page scan can probe the full file only for known answer pages", async () => {
  const html = `<html><head></head><body>${"x".repeat(1000)}<script id="quiz-manifest" type="application/json">{"title":"Late","questions":[{"id":"q1"}]}</script></body></html>`;
  const calls = { head: 0, full: 0 };
  const missed = await readQuizPageManifest({
    adapter: fakeAdapter(html, calls),
    path: "notes.html",
    stat: { mtime: 1, size: html.length },
    cache: new Map(),
    headBytes: 100,
  });
  assert.equal(missed, null);
  assert.deepEqual(calls, { head: 1, full: 0 });
  const found = await readQuizPageManifest({
    adapter: fakeAdapter(html, calls),
    path: "notes.html",
    stat: { mtime: 1, size: html.length },
    cache: new Map(),
    headBytes: 100,
    fullReadOnHeadMiss: true,
  });
  assert.equal(found.title, "Late");
  assert.deepEqual(calls, { head: 2, full: 1 });
});

test("quiz page scan does not read or cache a prefix-only non-answer result", async () => {
  const html = `<html><body>${"x".repeat(1000)}</body></html>`;
  const calls = { head: 0, full: 0 };
  const cache = new Map();
  const result = await readQuizPageManifest({
    adapter: fakeAdapter(html, calls),
    path: "notes.html",
    stat: { mtime: 1, size: html.length },
    cache,
    headBytes: 100,
  });
  assert.equal(result, null);
  assert.deepEqual(calls, { head: 1, full: 0 });
  assert.equal(cache.has("notes.html"), false);
});

test("quiz page scan key normalizes backslashes without changing case", () => {
  assert.equal(quizPageScanKey("C:\\Books\\Page.html"), "C:/Books/Page.html");
  assert.equal(quizPageScanKey("  "), "");
});
