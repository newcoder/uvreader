import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectLatex, createMathRenderer, shareFormulaHtml } from "../src/main/math-render.js";

function tempDir(prefix = "qbr-math-") {
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

test("collectLatex finds display and inline formulas in document order without duplicates", () => {
  const text = "行内 $E = mc^2$ 重复 $E = mc^2$、\\(x_1\\)、\\[y^2\\] 与\n\n$$\na+b\n$$";
  assert.deepEqual(collectLatex(text), ["E = mc^2", "x_1", "y^2", "a+b"]);
  assert.deepEqual(collectLatex("没有公式"), []);
  assert.deepEqual(collectLatex(""), []);
});

test("shareFormulaHtml upgrades display formulas and passes empty values through", () => {
  const inline = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>a</mi></math>';
  assert.equal(shareFormulaHtml(inline, false), inline);
  assert.match(shareFormulaHtml(inline, true), /display="block"/);
  assert.equal(shareFormulaHtml("", true), "");
  assert.equal(shareFormulaHtml(undefined, false), "");
});

test("renderMap drives the python helper and returns the MathML map", async () => {
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const [, inFile, outFile] = call.args;
    const latexes = JSON.parse(fs.readFileSync(inFile, "utf8"));
    fs.writeFileSync(outFile, JSON.stringify({ ok: true, mathml: Object.fromEntries(latexes.map((latex) => [latex, `<math>${latex}</math>`])) }));
    child.emit("close", 0);
  });
  const renderer = createMathRenderer({ spawnImpl });
  const result = await renderer.renderMap(["a+b", "c"], { python: "python", workDir: tempDir() });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.map, { "a+b": "<math>a+b</math>", c: "<math>c</math>" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python");
  assert.ok(String(calls[0].args[0]).endsWith("math-render.py"));
  const empty = await renderer.renderMap([], { workDir: tempDir() });
  assert.deepEqual(empty, { ok: true, map: {} }, "no formulas means no python call");
});

test("renderMap reports a missing latex2mathml or a failing interpreter instead of throwing", async () => {
  const missing = createMathRenderer({
    spawnImpl: fakeSpawn((call, child) => {
      fs.writeFileSync(call.args[2], JSON.stringify({ ok: false, error: "latex2mathml missing" }));
      child.emit("close", 0);
    }).spawnImpl,
  });
  const missingResult = await missing.renderMap(["x"], { workDir: tempDir() });
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error, /latex2mathml/);

  const broken = createMathRenderer({
    spawnImpl: fakeSpawn((_call, child) => child.emit("error", new Error("python not found"))).spawnImpl,
  });
  const brokenResult = await broken.renderMap(["x"], { workDir: tempDir() });
  assert.equal(brokenResult.ok, false);
  assert.match(brokenResult.error, /python not found/);

  const crashed = createMathRenderer({
    spawnImpl: fakeSpawn((_call, child) => {
      child.stderr.emit("data", "Traceback: boom");
      child.emit("close", 1);
    }).spawnImpl,
  });
  const crashedResult = await crashed.renderMap(["x"], { workDir: tempDir() });
  assert.equal(crashedResult.ok, false);
  assert.match(crashedResult.error, /boom/);
});
