import assert from "node:assert/strict";
import test from "node:test";

import { createPiTransport } from "../packages/reader/src/ai-pi.js";

function setup(overrides = {}) {
  const calls = { stream: [], aborted: [] };
  const bridge = {
    stream(payload, onEvent) {
      calls.stream.push(payload);
      onEvent({ requestId: payload.requestId, content: "你", answer: "你", reasoningText: "" });
      onEvent({ requestId: payload.requestId, content: "好", answer: "你好", reasoningText: "" });
      return Promise.resolve(overrides.result || { ok: true, answer: "你好" });
    },
    abort(requestId) {
      calls.aborted.push(requestId);
      return true;
    },
  };
  const cfg = {
    id: "deepseek",
    provider: { label: "DeepSeek", supportsThinking: true, compat: { thinkingFormat: "deepseek" } },
    base: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking: true,
    key: "sk-test",
    needsKey: true,
    ...overrides.cfg,
  };
  const transport = createPiTransport({
    bridge,
    aiConfig: () => cfg,
    aiMessages: (text, settings, turns, book) => [
      { role: "system", content: "sys" },
      { role: "user", content: `${text}|${book}` },
    ],
  });
  return { calls, bridge, transport };
}

test("aiExplain forwards config, messages and deltas through the bridge", async () => {
  const { calls, transport } = setup();
  const deltas = [];
  const answer = await transport.aiExplain("问", { settings: {} }, [], "书", {
    onDelta: (delta) => deltas.push(delta),
    sessionKey: "s1",
  });
  assert.equal(answer, "你好");
  assert.deepEqual(deltas.map((delta) => delta.content), ["你", "好"]);
  assert.equal(deltas.at(-1).answer, "你好");
  const payload = calls.stream[0];
  assert.equal(payload.config.id, "deepseek");
  assert.equal(payload.config.base, "https://api.deepseek.com");
  assert.equal(payload.config.thinking, true);
  assert.equal(payload.config.supportsThinking, true);
  assert.deepEqual(payload.config.compat, { thinkingFormat: "deepseek" });
  assert.equal(payload.config.key, "sk-test");
  assert.equal(payload.options.sessionKey, "s1");
  assert.deepEqual(payload.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "问|书" },
  ]);
});

test("missing configuration and keys keep the reader reasons", async () => {
  const noProvider = setup({ cfg: { provider: null } });
  await assert.rejects(noProvider.transport.aiExplain("q", { settings: {} }, [], ""), (error) => error.qiaomuReaderReason === "notconfigured");
  const noKey = setup({ cfg: { key: "" } });
  await assert.rejects(noKey.transport.aiExplain("q", { settings: {} }, [], ""), (error) => error.qiaomuReaderReason === "nokey");
  const noBase = setup({ cfg: { base: "" } });
  await assert.rejects(noBase.transport.aiExplain("q", { settings: {} }, [], ""), (error) => error.qiaomuReaderReason === "notconfigured");
});

test("bridge failures become reader errors with the partial flag", async () => {
  const { transport } = setup({ result: { ok: false, reason: "auth", message: "bad key", received: true } });
  await assert.rejects(transport.aiExplain("q", { settings: {} }, [], ""), (error) => {
    assert.equal(error.qiaomuReaderReason, "auth");
    assert.equal(error.qiaomuReaderReceived, true);
    return true;
  });
});

test("aborting the caller signal aborts the bridge request", async () => {
  const controller = new AbortController();
  const calls = { stream: [], aborted: [] };
  let resolveStream;
  const bridge = {
    stream(payload, onEvent) {
      calls.stream.push(payload);
      return new Promise((resolve) => {
        resolveStream = resolve;
        controller.signal.addEventListener("abort", () => {
          onEvent({ requestId: payload.requestId, content: "", answer: "", reasoningText: "" });
          resolve({ ok: false, reason: "cancelled", received: false });
        }, { once: true });
      });
    },
    abort(requestId) { calls.aborted.push(requestId); return true; },
  };
  const transport = createPiTransport({
    bridge,
    aiConfig: () => ({ id: "x", provider: { label: "X" }, base: "https://x", model: "m", thinking: false, key: "k", needsKey: true }),
    aiMessages: () => [{ role: "user", content: "q" }],
  });
  const pending = transport.aiExplain("q", { settings: {} }, [], "", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.qiaomuReaderReason === "cancelled");
  assert.equal(calls.aborted.length, 1);
  assert.equal(calls.stream[0].requestId, calls.aborted[0]);
});

test("a missing bridge fails with the desktop reason", async () => {
  const transport = createPiTransport({ bridge: null, aiConfig: () => ({}), aiMessages: () => [] });
  await assert.rejects(transport.aiExplain("q", { settings: {} }, [], ""), (error) => error.qiaomuReaderReason === "desktop");
});
