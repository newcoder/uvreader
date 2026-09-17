import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as shim from "../src/index.js";

const mainSource = fs.readFileSync(new URL("../../../packages/reader/src/main.js", import.meta.url), "utf8");

test("the shim exports every symbol src/main.js imports from obsidian", () => {
  const match = /import\s*\{([^{}]*)\}\s*from\s*"obsidian";/.exec(mainSource);
  assert.ok(match, "src/main.js must import from obsidian");
  const names = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.ok(names.length >= 20, `expected the full import list, got ${names.length}`);
  for (const name of names) {
    assert.ok(name in shim, `host-shim is missing the "${name}" export`);
    assert.notEqual(shim[name], undefined, `host-shim export "${name}" is undefined`);
  }
});

test("main.js still exports the plugin class as its default export", () => {
  assert.match(mainSource, /export default QiaomuBookReader;/);
});
