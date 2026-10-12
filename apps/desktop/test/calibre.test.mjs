import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { calibreCandidates, createCalibre, ebookConvertArgs, friendlyCalibreError } from "../src/main/calibre.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, killed: false };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { call.killed = true; };
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

function fakeExe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-calibre-"));
  const file = path.join(dir, process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert");
  fs.writeFileSync(file, "");
  return file;
}

test("calibreCandidates prefers the custom path, then common installs, then PATH", () => {
  const custom = "D:/tools/ebook-convert.exe";
  const kinds = calibreCandidates({ calibrePath: custom }).map((entry) => entry.kind);
  assert.equal(kinds[0], "custom");
  assert.equal(kinds.at(-1), "path");
  assert.ok(kinds.includes("common"), "common install locations are probed");
  assert.equal(calibreCandidates({})[0].kind !== "custom", true);
});

test("ebookConvertArgs is input, output, then extras", () => {
  assert.deepEqual(ebookConvertArgs("a.epub", "a.azw3"), ["a.epub", "a.azw3"]);
  assert.deepEqual(ebookConvertArgs("a.epub", "a.azw3", ["--title", "书"]), ["a.epub", "a.azw3", "--title", "书"]);
});

test("friendlyCalibreError explains a missing install and keeps the ERROR line", () => {
  assert.match(friendlyCalibreError("'ebook-convert' is not recognized as an internal or external command"), /找不到 Calibre/);
  const failure = friendlyCalibreError("Convert book 1 of 1\nERROR: Could not convert 'a.epub'\nSome detail");
  assert.match(failure, /ERROR: Could not convert/);
});

test("probe falls through to the PATH candidate and reports its version", async () => {
  const custom = fakeExe();
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    // 绝对路径的候选(自定义 / 常见安装位置)都失败,只有 PATH 上的裸命令可用。
    if (path.isAbsolute(call.command)) {
      child.emit("error", new Error("ENOENT"));
      return;
    }
    child.stdout.emit("data", "ebook-convert (calibre 9.15.0)\n");
    child.emit("close", 0);
  });
  const calibre = createCalibre({ spawnImpl, probeTimeoutMs: 200 });
  const result = await calibre.probe({ calibrePath: custom });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "path");
  assert.match(result.detail, /calibre 9\.15\.0/);
  assert.equal(calls[0].command, custom);
  assert.equal(calls.at(-1).command, "ebook-convert");
});

test("probe reports a hint when nothing answers", async () => {
  const { spawnImpl } = fakeSpawn((_call, child) => child.emit("error", new Error("ENOENT")));
  const calibre = createCalibre({ spawnImpl, probeTimeoutMs: 200 });
  const result = await calibre.probe({ calibrePath: fakeExe() });
  assert.equal(result.ok, false);
  assert.match(result.detail, /未找到 Calibre/);
});

test("convert writes the output and surfaces a failing exit code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-calibre-run-"));
  const source = path.join(dir, "book.epub");
  const out = path.join(dir, "book.azw3");
  fs.writeFileSync(source, "epub");
  const { spawnImpl } = fakeSpawn((call, child) => {
    if (call.args.includes("--version")) {
      child.stdout.emit("data", "ebook-convert (calibre 9.15.0)\n");
      child.emit("close", 0);
      return;
    }
    const output = call.args[1];
    if (output === out) {
      fs.writeFileSync(out, "BOOKMOBI");
      child.emit("close", 0);
      return;
    }
    child.stderr.emit("data", "ERROR: Could not convert 'book.epub'");
    child.emit("close", 1);
  });
  const calibre = createCalibre({ spawnImpl, probeTimeoutMs: 200 });
  const ok = await calibre.convert({ calibrePath: fakeExe() }, { source, out });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(out, "utf8"), "BOOKMOBI");

  const failed = await calibre.convert({ calibrePath: fakeExe() }, { source, out: path.join(dir, "missing.azw3") });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Could not convert/);
});

test("cancelling a conversion kills the child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-calibre-cancel-"));
  const source = path.join(dir, "book.epub");
  fs.writeFileSync(source, "epub");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    if (call.args.includes("--version")) {
      child.stdout.emit("data", "ebook-convert (calibre 9.15.0)\n");
      child.emit("close", 0);
    }
  });
  const calibre = createCalibre({ spawnImpl, probeTimeoutMs: 200 });
  const controller = new AbortController();
  const pending = calibre.convert({ calibrePath: fakeExe() }, { source, out: path.join(dir, "a.azw3"), signal: controller.signal });
  await sleep(30);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(calls.at(-1).killed, true);
});
