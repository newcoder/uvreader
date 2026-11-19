import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeepseekSearchKey } from "../packages/reader/src/ai-providers.js";

const secrets = {
  "search-key": "search-secret",
  "deepseek-key": "deepseek-secret",
  "other-key": "other-secret",
  "legacy-key": "legacy-secret",
};
const read = (id) => secrets[id] || "";

test("a dedicated DeepSeek Search key wins", () => {
  assert.equal(resolveDeepseekSearchKey({
    aiWebSearchSecret: "search-key",
    aiProvider: "opencode-go",
    aiSecrets: { deepseek: "deepseek-key" },
  }, read), "search-secret");
});

test("the configured DeepSeek key is reused when chat uses another provider", () => {
  assert.equal(resolveDeepseekSearchKey({
    aiProvider: "opencode-go",
    aiSecrets: { deepseek: "deepseek-key", "opencode-go": "other-key" },
  }, read), "deepseek-secret");
});

test("another provider key is never borrowed for DeepSeek Search", () => {
  assert.equal(resolveDeepseekSearchKey({
    aiProvider: "opencode-go",
    aiSecrets: { "opencode-go": "other-key" },
  }, read), "");
});

test("legacy DeepSeek keys keep working", () => {
  assert.equal(resolveDeepseekSearchKey({
    aiProvider: "deepseek",
    aiSecret: "legacy-key",
  }, read), "legacy-secret");
  assert.equal(resolveDeepseekSearchKey({
    aiProvider: "deepseek",
    aiKey: "plaintext-deepseek-key",
  }, read), "plaintext-deepseek-key");
});
