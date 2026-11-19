import assert from "node:assert/strict";
import test from "node:test";

import { clearWebSearchCache, deepseekFetch, deepseekSearch, WebSearchError } from "../src/main/web-search.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("DeepSeek search sends the query and maps results", async () => {
  clearWebSearchCache();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      results: [{
        title: "DeepSeek V4",
        url: "https://example.com/v4",
        snippet: "short",
        summary: "long summary",
        site_name: "Example",
        date: "2026-01-01",
        authority: 3,
        rerank_score: 2.4,
      }],
    });
  };
  const result = await deepseekSearch({
    apiKey: "secret",
    query: "DeepSeek V4",
    count: 3,
    oriQuestion: "有什么更新？",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].siteName, "Example");
  assert.equal(result.results[0].authority, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    query: "DeepSeek V4",
    count: 3,
    ori_question: "有什么更新？",
    need_content: false,
  });

  const cached = await deepseekSearch({
    apiKey: "secret",
    query: "DeepSeek V4",
    count: 3,
    oriQuestion: "有什么更新？",
    fetchImpl,
  });
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1, "identical searches reuse the cache");
});

test("DeepSeek search reports missing keys and HTTP errors", async () => {
  clearWebSearchCache();
  await assert.rejects(
    () => deepseekSearch({ apiKey: "", query: "x", fetchImpl: async () => jsonResponse({}) }),
    (error) => error instanceof WebSearchError && error.code === "nokey",
  );
  await assert.rejects(
    () => deepseekSearch({
      apiKey: "secret",
      query: "x",
      fetchImpl: async () => jsonResponse({ error: { message: "余额不足" } }, 402),
    }),
    (error) => error instanceof WebSearchError && error.code === "balance" && error.status === 402,
  );
});

test("DeepSeek fetch validates URLs and returns Markdown", async () => {
  clearWebSearchCache();
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(JSON.parse(options.body), { url: "https://example.com/article" });
    return jsonResponse({ title: "Article", content: "# Article\n\nBody." });
  };
  const page = await deepseekFetch({ apiKey: "secret", url: "https://example.com/article", fetchImpl });
  assert.equal(page.title, "Article");
  assert.match(page.content, /Body/);
  await assert.rejects(
    () => deepseekFetch({ apiKey: "secret", url: "file:///etc/passwd", fetchImpl }),
    (error) => error instanceof WebSearchError && error.code === "url",
  );
  await assert.rejects(
    () => deepseekFetch({ apiKey: "secret", url: "https://user:pass@example.com/a", fetchImpl }),
    (error) => error instanceof WebSearchError && error.code === "url",
  );
});
