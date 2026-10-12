import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTextLayerReader, TEXT_LAYER_SCRIPT } from "../src/main/text-layer.js";

function tempDir(prefix = "qbr-layer-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

test("the text layer reader runs PyMuPDF and returns the per-page text", async () => {
  const dir = tempDir();
  const pdf = path.join(dir, "paper.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    fs.writeFileSync(call.args[3], JSON.stringify(["第一页 ﬁ text", "第二页"]));
    child.emit("close", 0);
  });
  const result = await createTextLayerReader({ spawnImpl }).read(pdf, { python: "python", workDir: dir });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.pages, ["第一页 ﬁ text", "第二页"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python");
  assert.equal(calls[0].args[0], "-c");
  assert.equal(calls[0].args[1], TEXT_LAYER_SCRIPT);
  assert.equal(calls[0].args[2], pdf);
  assert.ok(fs.existsSync(path.join(dir, "text-layer.json")), "结果写文件而不是 stdout（控制台编码会破坏连字）");
});

test("the text layer reader reports failures without throwing", async () => {
  const dir = tempDir();
  const pdf = path.join(dir, "scan.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4");
  const missing = await createTextLayerReader({ spawnImpl: fakeSpawn(() => {}).spawnImpl }).read(path.join(dir, "nope.pdf"), { workDir: dir });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /找不到 PDF/);

  const crashed = await createTextLayerReader({
    spawnImpl: fakeSpawn((_call, child) => {
      child.stderr.emit("data", "ModuleNotFoundError: No module named 'fitz'");
      child.emit("close", 1);
    }).spawnImpl,
  }).read(pdf, { workDir: dir });
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /fitz/);

  const broken = await createTextLayerReader({
    spawnImpl: fakeSpawn((call, child) => {
      fs.writeFileSync(call.args[3], "not json");
      child.emit("close", 0);
    }).spawnImpl,
  }).read(pdf, { workDir: dir });
  assert.equal(broken.ok, false);

  const empty = await createTextLayerReader({
    spawnImpl: fakeSpawn((call, child) => {
      fs.writeFileSync(call.args[3], "[]");
      child.emit("close", 0);
    }).spawnImpl,
  }).read(pdf, { workDir: dir });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /文字层为空/);
});
