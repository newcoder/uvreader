import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityKey,
  capabilityMode,
  capabilityOf,
  capabilityStateHint,
  capabilityStateLabel,
  effectiveCapability,
  interpretImageProbe,
  interpretToolsProbe,
  makeProbeImage,
  normalizeAiCapabilities,
  rememberCapability,
} from "../packages/reader/src/ai-capability.js";

const CONFIG = { id: "openrouter", base: "https://openrouter.ai/api/v1", model: "qwen/qwen3-vl-8b" };

test("capability keys bind a result to the exact provider, endpoint and model", () => {
  assert.equal(capabilityKey(CONFIG), "openrouter|https://openrouter.ai/api/v1|qwen/qwen3-vl-8b");
  assert.notEqual(capabilityKey(CONFIG), capabilityKey({ ...CONFIG, model: "other" }));
  assert.notEqual(capabilityKey(CONFIG), capabilityKey({ ...CONFIG, base: "http://localhost:1234/v1" }));
});

test("stored capabilities are sanitized on load", () => {
  const normalized = normalizeAiCapabilities({
    "a|b|c": { image: { state: "yes", at: 5 }, tools: { state: "maybe" }, junk: { state: "yes" } },
    "": { image: { state: "no" } },
    "d|e|f": "nope",
  });
  assert.deepEqual(normalized, { "a|b|c": { image: { state: "yes", at: 5 } } });
});

test("remembering a capability replaces the same kind and keeps the map bounded", () => {
  const settings = { aiCapabilities: {} };
  for (let i = 0; i < 45; i += 1) rememberCapability(settings, { id: "p", base: "b", model: `m${i}` }, "image", "yes", i);
  assert.equal(Object.keys(settings.aiCapabilities).length, 40);
  assert.equal(capabilityOf(settings, { id: "p", base: "b", model: "m44" }, "image").state, "yes");
  assert.equal(capabilityOf(settings, { id: "p", base: "b", model: "m0" }, "image"), null);
  rememberCapability(settings, { id: "p", base: "b", model: "m44" }, "tools", "no", 100);
  assert.deepEqual(settings.aiCapabilities["p|b|m44"], { image: { state: "yes", at: 44 }, tools: { state: "no", at: 100 } });
});

test("an unchecked model reads as unknown and a manual override wins", () => {
  const settings = { aiCapabilities: {} };
  assert.deepEqual(effectiveCapability(settings, CONFIG, "image"), { state: "unknown", source: "none", at: 0 });
  rememberCapability(settings, CONFIG, "image", "no", 7);
  assert.deepEqual(effectiveCapability(settings, CONFIG, "image"), { state: "no", source: "probe", at: 7 });
  settings.aiVisionMode = "yes";
  assert.deepEqual(effectiveCapability(settings, CONFIG, "image"), { state: "yes", source: "manual", at: 0 });
  assert.equal(capabilityMode(settings, "image"), "yes");
  assert.equal(capabilityMode(settings, "tools"), "auto");
});

test("the image probe only counts a correct digit as support", () => {
  assert.equal(interpretImageProbe({ ok: false, reason: "novision" }, "7"), "no");
  assert.equal(interpretImageProbe({ ok: false, reason: "auth" }, "7"), "unknown");
  assert.equal(interpretImageProbe({ ok: true, answer: "7" }, "7"), "yes");
  assert.equal(interpretImageProbe({ ok: true, answer: "图中的数字是 ７。" }, "7"), "yes", "full-width digits count");
  assert.equal(interpretImageProbe({ ok: true, answer: "3" }, "7"), "unknown");
  assert.equal(interpretImageProbe({ ok: true, answer: "" }, "7"), "unknown");
});

test("the tools probe needs the requested call and its argument", () => {
  assert.equal(interpretToolsProbe({ ok: false, reason: "notools" }, "7"), "no");
  assert.equal(interpretToolsProbe({ ok: true, answer: "7", toolCalled: false }, "7"), "unknown");
  assert.equal(interpretToolsProbe({ ok: true, toolCalled: true, toolArguments: { n: 7 } }, "7"), "yes");
  assert.equal(interpretToolsProbe({ ok: true, toolCalled: true, toolArguments: { n: 3 } }, "7"), "unknown");
  assert.equal(interpretToolsProbe({ ok: true, toolCalled: true, toolArguments: null }, "7"), "unknown");
});

test("the probe image is a random digit drawn to PNG data", () => {
  const calls = [];
  const ctx = {
    fillRect: (...args) => calls.push(["rect", ...args]),
    fillText: (text) => calls.push(["text", text]),
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,QUJD" };
  const probe = makeProbeImage({ document: { createElement: () => canvas } }, () => 0.3);
  assert.equal(probe.digits, "3");
  assert.deepEqual(probe.image, { data: "QUJD", mimeType: "image/png" });
  assert.deepEqual(calls.find(([kind]) => kind === "text"), ["text", "3"]);
  assert.equal(makeProbeImage({}, () => 0.3), null, "a host without canvas reports no probe image");
});

test("state labels and hints stay translatable keys", () => {
  const t = (key) => `t:${key}`;
  assert.equal(capabilityStateLabel(t, "yes"), "t:capability-supported");
  assert.equal(capabilityStateLabel(t, "no"), "t:capability-not-supported");
  assert.equal(capabilityStateLabel(t, "unknown"), "t:capability-unclear");
  assert.equal(capabilityStateLabel(t, undefined), "t:capability-unchecked");
  assert.equal(capabilityStateHint(t, { state: "yes", source: "probe" }), "");
  assert.equal(capabilityStateHint(t, { state: "unknown", source: "none" }), "t:capability-unchecked-hint");
  assert.equal(capabilityStateHint(t, { state: "unknown", source: "probe" }), "t:capability-unclear-hint");
});
