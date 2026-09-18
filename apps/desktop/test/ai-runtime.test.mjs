import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";

import { buildPiModel, classifyPiFailure, createAiRuntime, normalizeBaseUrl, toPiContext } from "../src/main/ai-runtime.js";

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
  assert.deepEqual(result, { ok: true, answer: "你好，世界" });
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
