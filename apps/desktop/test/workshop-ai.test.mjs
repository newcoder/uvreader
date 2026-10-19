import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AI_TASK_SPECS,
  aiFailureText,
  buildChapterMessages,
  buildCoverCopyMessages,
  buildMetadataMessages,
  createAiRunner,
  createChapterRunner,
  createCleanupRunner,
  createSourceReader,
  normalizeAiConfig,
  normalizeAiCoverCopy,
  normalizeAiMetadata,
  parseAiJson,
  registerAiRunners,
  sourceSample,
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

test("registerAiRunners wires the LLM task kinds", async () => {
  const registered = new Map();
  const workshop = { register: (kind, runner) => { registered.set(kind, runner); return () => registered.delete(kind); } };
  const dispose = registerAiRunners(workshop, { aiRuntime: fakeRuntime() });
  assert.deepEqual([...registered.keys()].sort(), ["ai-chapters", "ai-clean", "ai-cover-copy", "ai-metadata"]);
  dispose();
  assert.equal(registered.size, 0);
});

test("the cleanup runner keeps minimal fixes, saves the result and reports the diff", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ai-clean-"));
  const original = `他囚为害怕,口口口口地站着。\n\n${"第二段正文,写得长一点,没有任何问题。".repeat(12)}`;
  const chapter = { index: 2, title: "第三章 起风", text: original };
  const runtime = {
    stream: async () => ({ ok: true, answer: original.replace("囚为", "因为").replace("口口口口", "哆哆嗦嗦") }),
    abort: () => true,
  };
  const run = createCleanupRunner({ aiRuntime: runtime, cacheRoot: dir });
  const result = await run({ payload: { config: { id: "x", base: "b", model: "m" }, chapters: [chapter] } });
  assert.equal(result.result.changed, 1, "只算真正改动的那一段");
  assert.equal(result.result.rejected, 0);
  assert.equal(result.result.chapters[0].index, 2);
  assert.ok(result.result.file && fs.existsSync(result.result.file), "清理结果落盘");
  const saved = JSON.parse(fs.readFileSync(result.result.file, "utf8"));
  assert.match(saved.chapters[0].text, /因为害怕/);
  assert.match(saved.chapters[0].text, /哆哆嗦嗦/);
  assert.doesNotMatch(result.output, /囚为/, "任务输出里只有摘要");
  assert.match(result.result.samples[0].before, /囚为/);
  assert.match(result.result.samples[0].after, /因为/);
});

test("the cleanup runner throws away blocks that were rewritten", async () => {
  const chapter = { index: 0, title: "第一章", text: `第一段正文,写得长一点。\n\n${"第二段正文,也写长一点。".repeat(40)}` };
  const runtime = { stream: async () => ({ ok: true, answer: "这是一段完全重写的文字,和原文没有任何关系。" }), abort: () => true };
  const run = createCleanupRunner({ aiRuntime: runtime, cacheRoot: "" });
  const result = await run({ payload: { config: { id: "x", base: "b", model: "m" }, chapters: [chapter] } });
  assert.equal(result.result.rejected, 1);
  assert.equal(result.result.changed, 0, "护栏把改写丢掉了");
  assert.match(result.output, /丢弃 1 块/);
});

test("the cleanup runner refuses an empty selection and huge batches", async () => {
  const run = createCleanupRunner({ aiRuntime: fakeRuntime(), cacheRoot: "" });
  await assert.rejects(() => run({ payload: { config: { id: "x", base: "b", model: "m" }, chapters: [] } }), /没有选中/);
  const many = Array.from({ length: 250 }, (_value, index) => ({ index, title: `第 ${index} 章`, text: "正文。".repeat(1500) }));
  await assert.rejects(() => run({ payload: { config: { id: "x", base: "b", model: "m" }, chapters: many } }), /一次跑不完/);
});

test("the chapter runner turns an AI rule into a chapter preview", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ai-chapters-"));
  const source = path.join(dir, "书.txt");
  fs.writeFileSync(source, ["12 起风", "", "正文一。".repeat(80), "", "13 下雨", "", "正文二。".repeat(80)].join("\n"), "utf8");
  const runtime = fakeRuntime({ answer: JSON.stringify({ kind: "numbered", number: "arabic", separator: " ", accept: [1, 5], note: "数字 + 空格" }) });
  const run = createChapterRunner({ aiRuntime: runtime, readSource: createSourceReader({}) });
  const result = await run({ payload: { config: { id: "x", base: "b", model: "m" }, source, fileName: "书.txt" } });
  assert.equal(result.result.count, 2);
  assert.deepEqual(result.result.first, ["12 起风", "13 下雨"]);
  assert.match(result.output, /2 章/);
  assert.match(runtime.calls[0].messages[1].content, /12 起风/, "候选行进了提示词");
  assert.match(runtime.calls[0].messages[1].content, /正文一/, "正文片段也在(判断风格用)");
});

test("the chapter runner reads GB18030 sources and rejects unusable rules", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ai-chapters-gbk-"));
  const source = path.join(dir, "凡人.txt");
  // 「第一章 起风了」+ 正文,整份按 GB18030 写盘。
  fs.writeFileSync(source, Buffer.from([
    0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xC6, 0xF0, 0xB7, 0xE7, 0xC1, 0xCB, 0x0D, 0x0A,
    0xD5, 0xFD, 0xCE, 0xC4, 0xA1, 0xA3, 0x0D, 0x0A,
  ]));
  const reader = createSourceReader({});
  const text = await reader(source);
  assert.match(text, /第一章 起风了/, "主进程读书稿也走同一份编码解码");
  assert.match(text, /正文。/);

  const runtime = fakeRuntime({ answer: "抱歉,我不能这么做。" });
  const run = createChapterRunner({ aiRuntime: runtime, readSource: reader });
  const body = "正文。".repeat(80);
  fs.writeFileSync(source, ["12 起风", "", body, "", "13 下雨", "", body].join("\n"), "utf8");
  await assert.rejects(() => run({ payload: { config: { id: "x", base: "b", model: "m" }, source } }), /没给出可用的章名规则/);

  const descending = fakeRuntime({ answer: '{"kind":"numbered","number":"arabic","separator":" "}' });
  fs.writeFileSync(source, [`12 起风`, "", body, "", `9 下雨`, "", body].join("\n"), "utf8");
  const run2 = createChapterRunner({ aiRuntime: descending, readSource: reader });
  await assert.rejects(() => run2({ payload: { config: { id: "x", base: "b", model: "m" }, source } }), /切不出章节/);
});

test("sourceSample takes head, middle and tail so the prompt sees more than the preface", () => {
  const text = `开头说明。${"甲".repeat(900)}${"乙".repeat(900)}结尾。`;
  const sample = sourceSample(text);
  assert.match(sample, /开头说明/);
  assert.match(sample, /结尾/);
  assert.ok(sample.length < text.length);
  assert.match(buildChapterMessages({ candidates: [{ no: 3, text: "12 起风" }], total: 1, sample }).at(-1).content, /12 起风/);
});
