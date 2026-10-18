import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_TASK_SPECS,
  aiFailureText,
  buildCoverCopyMessages,
  buildMetadataMessages,
  createAiRunner,
  normalizeAiConfig,
  normalizeAiCoverCopy,
  normalizeAiMetadata,
  parseAiJson,
  registerAiRunners,
} from "../src/main/workshop-ai.js";

function fakeRuntime({ answer = '{"title":"纽扣"}' , fail = null, onStream = null } = {}) {  const calls = [];
  return {
    calls,
    aborted: [],
    stream: async (payload, emit) => {
      calls.push(payload);
      if (onStream) onStream(payload);
      void emit;
      if (fail) return fail;
      return { ok: true, answer, toolCalls: [], stopReason: "stop" };
    },
    abort: () => {
      calls.aborted = true;
      return true;
    },
  };
}

test("the metadata prompt asks for JSON and carries the manuscript opening", () => {
  const messages = buildMetadataMessages({ text: "第一章 起风了", fileName: "我的小说.txt" });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只输出一个 JSON/);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /title/);
  assert.match(messages[1].content, /我的小说\.txt/);
  assert.match(messages[1].content, /第一章 起风了/);
});

test("the cover prompt asks for a concrete subtitle", () => {
  const messages = buildCoverCopyMessages({ text: "正文", fileName: "书.md" });
  assert.match(messages[0].content, /封面文案/);
  assert.match(messages[1].content, /subtitle/);
  assert.match(messages[1].content, /空话/);
});

test("parseAiJson survives fences, prose and nested braces", () => {
  assert.deepEqual(parseAiJson('{"title":"甲"}'), { title: "甲" });
  assert.deepEqual(parseAiJson('```json\n{"title":"乙"}\n```'), { title: "乙" });
  assert.deepEqual(parseAiJson('好的,这是结果:\n{"title":"丙","tags":["x"]}\n希望有用'), { title: "丙", tags: ["x"] });
  assert.deepEqual(parseAiJson('{"title":"{嵌套}","author":"丁"}'), { title: "{嵌套}", author: "丁" });
  assert.equal(parseAiJson("没有 JSON"), null);
  assert.equal(parseAiJson(""), null);
  assert.equal(parseAiJson('{"title":'), null);
});

test("metadata normalization trims, lowercases the language and caps the tags", () => {
  const data = normalizeAiMetadata({
    title: "  纽扣  ",
    author: "  作者 ",
    language: " ZH ",
    series: "",
    tags: [" 一 ", "二", "三", "四", "五", "六", ""],
  });
  assert.equal(data.title, "纽扣");
  assert.equal(data.author, "作者");
  assert.equal(data.language, "zh");
  assert.equal(data.series, "");
  assert.deepEqual(data.tags, ["一", "二", "三", "四", "五"], "最多五个标签");
  assert.deepEqual(normalizeAiMetadata(null), { title: "", author: "", language: "", series: "", tags: [] });
});

test("cover copy normalization keeps the three slots short", () => {
  const data = normalizeAiCoverCopy({ title: " 书名 ", subtitle: "  一句话副标题  ", series: "系列" });
  assert.equal(data.title, "书名");
  assert.equal(data.subtitle, "一句话副标题");
  assert.equal(data.series, "系列");
  assert.deepEqual(normalizeAiCoverCopy(undefined), { title: "", subtitle: "", series: "" });
});

test("normalizeAiConfig keeps only the runtime fields", () => {
  const config = normalizeAiConfig({ id: "deepseek", base: "https://x", model: "m", key: "k", extra: "drop", tags: [] });
  assert.equal(config.id, "deepseek");
  assert.equal(config.key, "k");
  assert.equal("extra" in config, false);
  assert.equal("tags" in config, false);
  assert.equal(config.needsKey, false);
});

test("aiFailureText turns reasons into actionable Chinese", () => {
  assert.match(aiFailureText({ reason: "nokey" }), /密钥/);
  assert.match(aiFailureText({ reason: "notconfigured" }), /设置/);
  assert.equal(aiFailureText({ reason: "cancelled" }), "已取消");
  assert.match(aiFailureText({ reason: "http", message: "boom" }), /boom/);
});

test("the runner returns a suggestion instead of touching any file", async () => {
  const runtime = fakeRuntime({ answer: '{"title":"纽扣","author":"乔木","language":"zh","tags":["阅读"]}' });
  const run = createAiRunner({ aiRuntime: runtime });
  const result = await run("ai-metadata", {
    payload: {
      config: { id: "deepseek", base: "https://x", model: "m", key: "k" },
      text: "第一章 起风了。正文从这里开始,写得足够长,超过二十个字,方便测试。",
      fileName: "我的小说.txt",
    },
  });
  assert.equal(result.output, "《纽扣》 · 乔木 · zh");
  assert.deepEqual(result.result, { title: "纽扣", author: "乔木", language: "zh", series: "", tags: ["阅读"] });
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].config.model, "m");
  assert.equal(runtime.calls[0].messages[1].role, "user");
  assert.equal(runtime.calls[0].options.timeoutMs, AI_TASK_SPECS["ai-metadata"].timeoutMs);
});

test("the runner refuses an unconfigured AI or an empty manuscript", async () => {
  const runtime = fakeRuntime();
  const run = createAiRunner({ aiRuntime: runtime });
  await assert.rejects(() => run("ai-metadata", { payload: { config: {}, text: "正文从这里开始,写得足够长,超过二十个字,方便测试。" } }), /AI 还没配置好/);
  await assert.rejects(
    () => run("ai-metadata", { payload: { config: { id: "x", base: "b", model: "m" }, text: "太短" } }),
    /没有可用的正文/,
  );
  await assert.rejects(() => run("nope", { payload: {} }), /未知的 AI 任务/);
  assert.equal(runtime.calls.length, 0, "参数不合格时不发请求");
});

test("the runner reports AI failures and unparseable answers", async () => {
  const failing = createAiRunner({ aiRuntime: fakeRuntime({ fail: { ok: false, reason: "http", message: "503" } }) });
  await assert.rejects(
    () => failing("ai-metadata", { payload: { config: { id: "x", base: "b", model: "m" }, text: "正文从这里开始,写得足够长,超过二十个字,方便测试。" } }),
    /503/,
  );
  const chatty = createAiRunner({ aiRuntime: fakeRuntime({ answer: "抱歉,我不能这么做。" }) });
  await assert.rejects(
    () => chatty("ai-cover-copy", { payload: { config: { id: "x", base: "b", model: "m" }, text: "正文从这里开始,写得足够长,超过二十个字,方便测试。" } }),
    /不是可用的 JSON/,
  );
});

test("cancelling the task aborts the AI request", async () => {
  let abortedId = "";
  const runtime = {
    stream: async () => ({ ok: false, reason: "cancelled" }),
    abort: (requestId) => { abortedId = requestId; return true; },
  };
  const run = createAiRunner({ aiRuntime: runtime });
  const controller = new AbortController();
  const pending = run("ai-metadata", {
    payload: { config: { id: "x", base: "b", model: "m" }, text: "正文从这里开始,写得足够长,超过二十个字,方便测试。" },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => pending, /已取消/);
  assert.ok(abortedId.startsWith("workshop-ai-"), "abort 转发给了 AI 运行时");

  // 排队期间就被取消:不发请求,直接结束。
  const before = new AbortController();
  before.abort();
  let sent = false;
  const quiet = createAiRunner({ aiRuntime: { stream: async () => { sent = true; return { ok: true, answer: "{}" }; }, abort: () => true } });
  await assert.rejects(
    () => quiet("ai-metadata", { payload: { config: { id: "x", base: "b", model: "m" }, text: "正文从这里开始,写得足够长,超过二十个字,方便测试。" }, signal: before.signal }),
    /已取消/,
  );
  assert.equal(sent, false);
});

test("registerAiRunners wires both LLM task kinds", async () => {
  const registered = new Map();
  const workshop = { register: (kind, runner) => { registered.set(kind, runner); return () => registered.delete(kind); } };
  const dispose = registerAiRunners(workshop, { aiRuntime: fakeRuntime() });
  assert.deepEqual([...registered.keys()].sort(), ["ai-cover-copy", "ai-metadata"]);
  dispose();
  assert.equal(registered.size, 0);
});
