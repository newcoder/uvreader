import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
// ai-cli resolves Node built-ins through the host window; the test provides the
// same surface the Electron renderer has.
globalThis.window = { process, require, setTimeout, clearTimeout };
const { resolveCliPath } = await import("../packages/reader/src/ai-cli.js");

function tempShim(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-cli-"));
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, content, "utf8");
  return shim;
}

test("a configured .cmd shim resolves to the executable it launches", async () => {
  const shim = tempShim(`@ECHO off\r\n"${process.execPath}" %*\r\n`);
  const resolved = await resolveCliPath("claude-cli", shim);
  assert.equal(resolved, process.execPath, "npm shims are followed to the real binary");
});

test("a plain executable path still resolves without the shim hop", async () => {
  const resolved = await resolveCliPath("claude-cli", process.execPath);
  assert.equal(resolved, process.execPath);
});
