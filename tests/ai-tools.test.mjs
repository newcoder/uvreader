import assert from "node:assert/strict";
import test from "node:test";

import { AI_TOOL_DEFINITIONS, createAiTools } from "../packages/reader/src/ai-tools.js";

function setup(state = {}) {
  return createAiTools({
    state: {
      pageCount: 120,
      position: () => ({ label: "第三章", page: 42, percent: 0.35 }),
      outline: () => [{ label: "第一章 起点", page: 1 }, { label: "第二章 转折" }],
      highlights: () => [{ label: "第 12 页", text: "重要的句子", comment: "记住这里" }],
      ...state,
    },
  });
}

test("the schemas stay minimal and are advertised as-is", () => {
  assert.deepEqual(AI_TOOL_DEFINITIONS.map((tool) => tool.name), [
    "get_reading_position", "get_book_outline", "read_pages", "search_book", "list_highlights",
  ]);
  const { definitions } = setup();
  assert.deepEqual(definitions, AI_TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.equal(definitions.every((tool) => tool.parameters.type === "object"), true);
});

test("the reading position and outline answer in Chinese", async () => {
  const tools = setup();
  const position = await tools.run("get_reading_position", {});
  assert.match(position.text, /当前：第三章/);
  assert.match(position.text, /第 42 页 \/ 共 120 页/);
  assert.match(position.text, /35%/);
  const outline = await tools.run("get_book_outline", {});
  assert.equal(outline.isError, false);
  assert.match(outline.text, /1\. 第一章 起点（第 1 页）/);
  assert.match(outline.text, /2\. 第二章 转折$/m);
  const empty = await createAiTools({ state: {} }).run("get_book_outline", {});
  assert.match(empty.text, /没有可用的目录/);
});

test("read_pages clamps the range and explains scanned pages", async () => {
  const calls = [];
  const tools = setup({
    pageCount: 10,
    readPages: (start, count) => {
      calls.push([start, count]);
      return [{ page: start, text: "第一段" }, { page: start + 1, text: "" }];
    },
  });
  const result = await tools.run("read_pages", { start: 3, count: 99 });
  assert.deepEqual(calls, [[3, 3]], "at most three pages per call");
  assert.match(result.text, /【第 3 页】\n第一段/);
  assert.match(result.text, /【第 4 页】\n（此页没有可提取的文字/);
  const clamped = setup({ pageCount: 10, readPages: (start, count) => { calls.push([start, count]); return []; } });
  await clamped.run("read_pages", { start: -5, count: -1 });
  assert.deepEqual(calls.at(-1), [1, 1]);
});

test("read_pages falls back to the current section for non-paged formats", async () => {
  const tools = setup({
    readPages: null,
    readCurrent: () => ({ label: "第四章", text: "当前段落文字" }),
  });
  const result = await tools.run("read_pages", { start: 1 });
  assert.match(result.text, /【第四章】/);
  assert.match(result.text, /当前段落文字/);
  const none = await createAiTools({ state: {} }).run("read_pages", { start: 1 });
  assert.match(none.text, /暂不支持按页读取/);
});

test("search_book reports hits, emptiness and unsupported formats", async () => {
  const hits = await setup({
    search: (query, limit) => {
      assert.equal(query, "熵");
      assert.equal(limit, 4);
      return [{ page: 42, snippet: "……熵增……" }];
    },
  }).run("search_book", { query: "熵", limit: 4 });
  assert.match(hits.text, /1\. 第 42 页：……熵增……/);

  const asyncHits = await setup({
    search: async () => [{ label: "第三章", snippet: "……异步命中……" }],
  }).run("search_book", { query: "熵" });
  assert.match(asyncHits.text, /1\. 第三章：……异步命中……/, "an async (engine) search answers too");

  const empty = await setup({ search: () => [] }).run("search_book", { query: "不存在" });
  assert.match(empty.text, /没有找到「不存在」/);
  const unsupported = await setup({ search: () => null }).run("search_book", { query: "熵" });
  assert.match(unsupported.text, /暂不支持全书检索/);
  const missing = await setup().run("search_book", {});
  assert.match(missing.text, /请提供检索关键词/);
});

test("list_highlights renders the page, text and comment", async () => {
  const result = await setup().run("list_highlights", {});
  assert.match(result.text, /1\. \[第 12 页\] 重要的句子（批注：记住这里）/);
  const none = await createAiTools({ state: { highlights: () => [] } }).run("list_highlights", {});
  assert.match(none.text, /还没有保存划线/);
});

test("results are truncated, unknown tools and failures are errors", async () => {
  const tools = createAiTools({ state: { outline: () => [{ label: "长".repeat(5000) }] }, maxChars: 100 });
  const long = await tools.run("get_book_outline", {});
  assert.equal(long.text.length, 101);
  assert.equal(long.text.endsWith("…"), true);

  const unknown = await tools.run("delete_everything", {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /未知工具/);

  const failing = createAiTools({ state: { position: () => { throw new Error("boom"); } } });
  const failure = await failing.run("get_reading_position", {});
  assert.equal(failure.isError, true);
  assert.match(failure.text, /工具执行失败：boom/);
});
