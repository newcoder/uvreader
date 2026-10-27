import assert from "node:assert/strict";
import test from "node:test";

import { docvortexTaskSettings, formulaTaskSettings, taskAiConfig } from "../packages/reader/src/workshop-settings.js";

test("the workshop owns one formula/OCR settings shape", () => {
  const settings = {
    docvortexPath: "D:/docvortex",
    ocrPython: "python",
    ocrSidecarDir: "D:/sidecar",
    mineruToken: "token",
    mineruLocalAutoStart: false,
    engineUrl: "http://127.0.0.1:9000",
  };
  assert.deepEqual(docvortexTaskSettings(settings), {
    docvortexPath: "D:/docvortex",
    docvortexPython: "python",
  });
  const formula = formulaTaskSettings(settings);
  assert.equal(formula.ocrSidecarDir, "D:/sidecar");
  assert.equal(formula.mineruToken, "token");
  assert.equal(formula.mineruLocalAutoStart, false);
  assert.equal(formula.engineUrl, "http://127.0.0.1:9000");
});

test("task AI config keeps provider thinking and compatibility flags", () => {
  const config = taskAiConfig({
    id: "provider-a",
    base: "https://example.test/v1",
    model: "reasoner",
    thinking: true,
    key: "secret",
    needsKey: true,
    provider: {
      label: "Provider A",
      supportsThinking: true,
      compat: { supportsFinishReason: false },
    },
  });
  assert.deepEqual(config, {
    id: "provider-a",
    name: "Provider A",
    base: "https://example.test/v1",
    model: "reasoner",
    thinking: true,
    supportsThinking: true,
    compat: { supportsFinishReason: false },
    key: "secret",
    needsKey: true,
  });
  assert.equal(taskAiConfig({ id: "missing-provider" }), null);
});
