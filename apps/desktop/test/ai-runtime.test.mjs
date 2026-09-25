import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

import { buildPiModel, classifyCapabilityFailure, classifyPiFailure, createAiRuntime, normalizeBaseUrl, toPiContext } from "../src/main/ai-runtime.js";

const CONFIG = { id: "test-ai", model: "test-model", base: "http://localhost:11434/v1", thinking: true, key: "" };

function fauxRuntime(options = {}) {
  const faux = fauxProvider({ provider: "test-ai", models: [{ id: "test-model", reasoning: true }], ...options });
  const runtime = createAiRuntime({
    modelsFor: () => {
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
  });
  return { faux, runtime };
}

function collect() {
  const deltas = [];
  return { deltas, emit: (delta) => deltas.push(delta) };
}

test("stream maps text and thinking deltas into the reader delta contract", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage([fauxThinking("想一下"), fauxText("你好，世界")])]);
  const { deltas, emit } = collect();
  const result = await runtime.stream({ requestId: "r1", config: CONFIG, messages: [{ role: "user", content: "hi" }] }, emit);
  assert.deepEqual(result, { ok: true, answer: "你好，世界", toolCalls: [], stopReason: "stop" });
  assert.equal(deltas.every((delta) => delta.requestId === "r1" && delta.type === "delta"), true);
  assert.equal(deltas.map((delta) => delta.content || "").join(""), "你好，世界");
  assert.equal(deltas.map((delta) => delta.reasoning || "").join(""), "想一下");
  const last = deltas.at(-1);
  assert.equal(last.answer, "你好，世界");
  assert.equal(last.reasoningText, "想一下");
});

test("stream reports an empty answer without inventing content", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage([])]);
  const result = await runtime.stream({ requestId: "r2", config: CONFIG, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(result, { ok: false, reason: "empty", received: false });
});

test("abort cancels an in-flight stream and keeps the partial flag", async () => {
  const { faux, runtime } = fauxRuntime({ tokensPerSecond: 2 });
  faux.setResponses([fauxAssistantMessage(fauxText("one two three four five six seven eight nine ten"))]);
  let firstDelta;
  const seen = new Promise((resolve) => { firstDelta = resolve; });
  const pending = runtime.stream({ requestId: "r3", config: CONFIG, messages: [{ role: "user", content: "hi" }] }, () => firstDelta());
  await seen;
  assert.equal(runtime.abort("r3"), true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.received, true);
  assert.equal(runtime.abort("r3"), false, "the controller is released after the stream settles");
});

test("connection test returns the answer and latency", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage("连接成功")]);
  const result = await runtime.test(CONFIG);
  assert.equal(result.ok, true);
  assert.equal(result.answer, "连接成功");
  assert.equal(typeof result.latency, "number");
});

test("failure classification maps provider errors onto reader reasons", () => {
  assert.equal(classifyPiFailure({ errorMessage: "401 Unauthorized" }), "auth");
  assert.equal(classifyPiFailure({ errorMessage: "403 Forbidden" }), "forbidden");
  assert.equal(classifyPiFailure({ errorMessage: "429 Too Many Requests" }), "limit");
  assert.equal(classifyPiFailure({ errorMessage: "request timed out" }), "timeout");
  assert.equal(classifyPiFailure({ errorMessage: "ECONNREFUSED" }, { base: "http://127.0.0.1:11434/v1" }), "local");
  assert.equal(classifyPiFailure({ errorMessage: "ECONNREFUSED" }, { base: "https://api.deepseek.com" }), "http");
  assert.equal(classifyPiFailure(new Error("boom")), "http");
});

test("history assistant turns keep the full message shape pi expects", () => {
  const context = toPiContext([
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
  ], { id: "ollama", model: "hy-mt2" });
  assert.equal(context.systemPrompt, "sys");
  assert.equal(context.messages.length, 3);
  const assistant = context.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [{ type: "text", text: "a1" }]);
  assert.equal(assistant.provider, "ollama");
  assert.equal(assistant.model, "hy-mt2");
  assert.equal(assistant.stopReason, "stop");
  assert.equal(typeof assistant.usage.totalTokens, "number");
  assert.equal(typeof assistant.timestamp, "number");
  const empty = toPiContext([{ role: "user", content: "hi" }], {});
  assert.equal("systemPrompt" in empty, false);
});

test("image input is declared only when the request may carry images", () => {
  assert.deepEqual(buildPiModel(CONFIG).input, ["text"]);
  assert.deepEqual(buildPiModel({ ...CONFIG, vision: true }).input, ["text", "image"]);
  assert.deepEqual(buildPiModel(CONFIG, { imageInput: true }).input, ["text", "image"], "a probe must exercise the endpoint");
});

test("user turns keep image parts and text blocks while staying strings when plain", () => {
  const context = toPiContext([
    { role: "user", content: "plain" },
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "" },
      ],
    },
  ], CONFIG);
  assert.equal(context.messages[0].content, "plain");
  assert.deepEqual(context.messages[1].content, [
    { type: "text", text: "看图" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ], "an image without data is dropped instead of breaking the request");
});

test("capability failures become distinct reasons instead of generic transport errors", () => {
  assert.equal(classifyCapabilityFailure("image", { errorMessage: "unsupported content type image_url" }), "novision");
  assert.equal(classifyCapabilityFailure("image", { errorMessage: "this model does not support vision" }), "novision");
  assert.equal(classifyCapabilityFailure("tools", { errorMessage: "tools are not supported" }), "notools");
  assert.equal(classifyCapabilityFailure("tools", { errorMessage: "function calling not available" }), "notools");
  assert.equal(classifyCapabilityFailure("tools", { errorMessage: "invalid function name in tools" }), "notools");
  assert.equal(classifyCapabilityFailure("image", { errorMessage: "401 Unauthorized" }), "auth");
  assert.equal(classifyCapabilityFailure("tools", { errorMessage: "request timed out" }), "timeout");
});

test("the image probe sends the image part and reports the answer", async () => {
  const { faux, runtime } = fauxRuntime();
  let received = null;
  faux.setResponses([(context) => {
    received = context.messages.at(-1);
    return fauxAssistantMessage("7");
  }]);
  const result = await runtime.probe({
    config: CONFIG,
    kind: "image",
    image: { data: "aGVsbG8=", mimeType: "image/png" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "image");
  assert.equal(result.answer, "7");
  assert.deepEqual(received.content[1], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
});

test("the image probe keeps provider rejections as a reason", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "image input is not supported by this model" })]);
  const result = await runtime.probe({ config: CONFIG, kind: "image", image: { data: "AA==", mimeType: "image/png" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "novision");
});

test("the tools probe passes a tool and reports the returned call", async () => {
  const { faux, runtime } = fauxRuntime();
  let toolNames = [];
  faux.setResponses([(context) => {
    toolNames = (context.tools || []).map((tool) => tool.name);
    return fauxAssistantMessage([fauxToolCall("probe_number", { n: 7 })], { stopReason: "toolUse" });
  }]);
  const result = await runtime.probe({ config: CONFIG, kind: "tools", expected: "7" });
  assert.deepEqual(toolNames, ["probe_number"]);
  assert.equal(result.ok, true);
  assert.equal(result.toolCalled, true);
  assert.equal(result.toolArguments.n, 7);
});

test("probes pass their image-input requirement to the model builder", async () => {
  const seen = [];
  const faux = fauxProvider({ provider: "test-ai", models: [{ id: "test-model", reasoning: true }] });
  faux.setResponses([fauxAssistantMessage("7"), fauxAssistantMessage("7")]);
  const runtime = createAiRuntime({
    modelsFor: (config, options) => {
      seen.push(options?.imageInput === true);
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
  });
  await runtime.probe({ config: CONFIG, kind: "image", image: { data: "AA==", mimeType: "image/png" } });
  await runtime.probe({ config: CONFIG, kind: "tools", expected: "7" });
  assert.deepEqual(seen, [true, false], "only the image probe needs image input declared");
});

test("the tools probe reports a refusal as notools", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "tools parameter is not supported" })]);
  const result = await runtime.probe({ config: CONFIG, kind: "tools", expected: "7" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "notools");
});

test("tool definitions, assistant calls and tool results survive the context mapping", () => {
  const context = toPiContext([
    { role: "user", content: "第三页讲了什么？" },
    { role: "assistant", content: "我查一下。", toolCalls: [{ id: "call_1", name: "read_page", arguments: { page: 3 } }], stopReason: "toolUse" },
    { role: "tool", toolCallId: "call_1", toolName: "read_page", content: "第 3 页正文", isError: false },
  ], CONFIG, { tools: [{ name: "read_page", description: "Read a page", parameters: { type: "object", properties: { page: { type: "number" } } } }] });
  assert.deepEqual(context.tools.map((tool) => tool.name), ["read_page"]);
  const assistant = context.messages[1];
  assert.deepEqual(assistant.content, [
    { type: "text", text: "我查一下。" },
    { type: "toolCall", id: "call_1", name: "read_page", arguments: { page: 3 } },
  ]);
  assert.equal(assistant.stopReason, "toolUse");
  assert.deepEqual(context.messages[2], {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read_page",
    content: [{ type: "text", text: "第 3 页正文" }],
    isError: false,
    timestamp: context.messages[2].timestamp,
  });
  const plain = toPiContext([{ role: "user", content: "hi" }], CONFIG);
  assert.equal("tools" in plain, false, "no tools are advertised unless requested");
});

test("tool results keep image blocks so a vision model can read a page", () => {
  const context = toPiContext([
    { role: "user", content: "看看第 26 页" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_pages", arguments: { start: 26 } }], stopReason: "toolUse" },
    {
      role: "tool",
      toolCallId: "call_1",
      toolName: "read_pages",
      content: [
        { type: "text", text: "【第 26 页】文字层较差" },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ],
      isError: false,
    },
  ], CONFIG);
  assert.deepEqual(context.messages[2].content, [
    { type: "text", text: "【第 26 页】文字层较差" },
    { type: "image", data: "AAAA", mimeType: "image/jpeg" },
  ]);
});

test("stream forwards tool calls and treats a call-only turn as complete", async () => {
  const { faux, runtime } = fauxRuntime();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("read_page", { page: 3 })], { stopReason: "toolUse" })]);
  const { deltas, emit } = collect();
  const result = await runtime.stream({ requestId: "r4", config: CONFIG, messages: [{ role: "user", content: "p3?" }], options: { tools: [{ name: "read_page", description: "Read a page", parameters: { type: "object" } }] } }, emit);
  assert.equal(result.ok, true);
  assert.equal(result.answer, "");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_page");
  assert.deepEqual(result.toolCalls[0].arguments, { page: 3 });
  assert.equal(deltas.some((delta) => delta.toolCall?.id), true, "the renderer sees the same call");
});

test("provider construction keeps the request shape stable", () => {
  assert.equal(normalizeBaseUrl("https://api.deepseek.com///"), "https://api.deepseek.com");
  const model = buildPiModel({ id: "deepseek", model: "deepseek-chat", base: "https://api.deepseek.com", thinking: true, supportsThinking: true, compat: { thinkingFormat: "deepseek" } });
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "deepseek");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.thinkingFormat, "deepseek");
  assert.equal(model.maxTokens, 2400);
  // The capability flag stays on when the user disables thinking, so the
  // request can carry an explicit "thinking disabled" field.
  assert.equal(buildPiModel({ id: "deepseek", model: "deepseek-chat", base: "https://api.deepseek.com", thinking: false, supportsThinking: true }).reasoning, true);
  // Local models that do not declare thinking support must not advertise it.
  assert.equal(buildPiModel({ id: "ollama", model: "hy-mt2", base: "http://localhost:11434/v1", thinking: true }).reasoning, false);
  assert.equal(buildPiModel({ id: "x", model: "m", base: "b" }, { connectionTest: true }).maxTokens, 16);
});
