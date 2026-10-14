import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clearMineruCaches, createMineruLocalService, mineruKitCandidates, mineruServiceUrl, mineruStartArgs, resolveMineruKit, servicePort } from "../src/main/mineru-local.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0);
  };
  return child;
}

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = fakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

const jsonResponse = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const quiet = { log: () => {} };

test("url, port and start arguments follow the configured service", () => {
  assert.equal(mineruServiceUrl({}), "http://127.0.0.1:8123");
  assert.equal(mineruServiceUrl({ mineruLocalUrl: "http://127.0.0.1:9000/" }), "http://127.0.0.1:9000");
  assert.equal(servicePort("http://127.0.0.1:9000"), 9000);
  assert.equal(servicePort("nonsense"), 8123);
  const args = mineruStartArgs("http://127.0.0.1:9000", "D:/tmp/m");
  assert.deepEqual(args.slice(0, 2), ["api-server", "--host"]);
  assert.equal(args[args.indexOf("--port") + 1], "9000");
  assert.equal(args[args.indexOf("--tier") + 1], "standard");
  assert.equal(args[args.indexOf("--upload-dir") + 1], "D:/tmp/m", "must pass --upload-dir");
});

test("resolveMineruKit prefers the setting, then the environment", () => {
  const exists = (value) => value === "D:/kit/mineru-kit.exe";
  assert.equal(resolveMineruKit({ mineruLocalExe: "D:/kit/mineru-kit.exe" }, { exists }), "D:/kit/mineru-kit.exe");
  assert.equal(resolveMineruKit({ mineruLocalExe: "D:/nope.exe" }, { exists }), "", "a stale path counts as unset");
  assert.equal(resolveMineruKit({}, { exists, env: { MINERU_LOCAL_CMD: "D:/kit/mineru-kit.exe" } }), "D:/kit/mineru-kit.exe");
  assert.equal(resolveMineruKit({}, { exists, env: {} }), "");
  // 候选现在包含「常见安装位置」(用户目录 / 各盘 mineru_env),所以按包含关系断言。
  const candidates = mineruKitCandidates({ ocrPython: "python" });
  assert.ok(!candidates.includes("mineru-kit.exe") && !candidates.includes("mineru-kit"), "裸名 python 不产生裸名候选");
  const venv = mineruKitCandidates({ ocrPython: "D:\\mineru_env\\Scripts\\python.exe" });
  assert.ok(venv.includes("D:\\mineru_env\\Scripts\\mineru-kit.exe"), "venv python → 同目录 mineru-kit");
});

test("status probes /v1/health and never starts anything", async () => {
  const probes = [];
  const service = createMineruLocalService({
    ...quiet,
    fetchImpl: async (url) => { probes.push(url); return jsonResponse({ status: "ok", version: "4.0.12" }); },
    spawnImpl: () => { throw new Error("must not start"); },
  });
  const result = await service.status({ mineruLocalUrl: "http://127.0.0.1:8123" });
  assert.equal(result.status, "running");
  assert.equal(result.version, "4.0.12");
  assert.equal(result.managed, false);
  assert.deepEqual(probes, ["http://127.0.0.1:8123/v1/health"]);
});

test("ensure adopts an already running service and never kills it", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const service = createMineruLocalService({ ...quiet, spawnImpl, fetchImpl: async () => jsonResponse({ status: "ok", version: "4.0.12" }) });
  const result = await service.ensure({});
  assert.equal(result.status, "running");
  assert.equal(result.detail, "已在运行");
  assert.equal(calls.length, 0, "already running: no second process");
  service.stop();
  assert.equal(calls.length, 0, "a manually started service is never adopted/killed");
});

test("ensure starts the service and waits until health is ok", async () => {
  let healthy = false;
  const { spawnImpl, calls } = fakeSpawn(() => { setTimeout(() => { healthy = true; }, 30); });
  const service = createMineruLocalService({
    ...quiet,
    spawnImpl,
    uploadDir: "D:/tmp/mineru",
    healthTimeoutMs: 50,
    startTimeoutMs: 4000,
    fetchImpl: async () => (healthy ? jsonResponse({ status: "ok", version: "4.0.12" }) : jsonResponse({}, false, 503)),
  });
  // 用真实存在的文件当 stub:自动查找现在会命中机器上真装的 mineru-kit,非存在的路径会被越过。
  const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-kit-"));
  const exePath = path.join(exeDir, "mineru-kit.exe");
  fs.writeFileSync(exePath, "stub");
  const result = await service.ensure({ mineruLocalExe: exePath, mineruLocalUrl: "http://127.0.0.1:9000" });
  assert.equal(result.status, "running", JSON.stringify(result));
  assert.equal(result.version, "4.0.12");
  assert.equal(result.managed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, exePath);
  assert.equal(calls[0].args[calls[0].args.indexOf("--port") + 1], "9000");
  assert.equal(calls[0].args[calls[0].args.indexOf("--upload-dir") + 1], "D:/tmp/mineru");
  assert.equal(service.stop(), true);
  assert.equal(calls[0].child.killed, true, "quit only stops the one we started");
});

test("ensure turns a missing mineru-kit into an actionable state", async () => {
  const { spawnImpl } = fakeSpawn((_call, child) => {
    const error = new Error("spawn mineru-kit ENOENT");
    error.code = "ENOENT";
    child.emit("error", error);
  });
  const service = createMineruLocalService({ ...quiet, spawnImpl, fetchImpl: async () => jsonResponse({}, false, 503), healthTimeoutMs: 30, startTimeoutMs: 1500 });
  const result = await service.ensure({});
  assert.equal(result.status, "missing");
  assert.match(String(result.detail), /mineru-kit/);
  assert.match(String(result.detail), /MINERU_LOCAL_CMD/);
  assert.ok(Array.isArray(result.tried), "the status carries what was searched (for the ASCII console line)");
});

test("ensure leaves foreign urls alone and honours autoStart=false", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const service = createMineruLocalService({ ...quiet, spawnImpl, fetchImpl: async () => jsonResponse({}, false, 503) });
  const external = await service.ensure({ mineruLocalUrl: "http://10.0.0.5:8123" });
  assert.equal(external.status, "external");
  assert.equal(external.managed, false);
  const off = await service.ensure({ autoStart: false });
  assert.equal(off.status, "stopped");
  assert.equal(off.detail, "已关闭自动启动");
  assert.equal(calls.length, 0, "neither case spawns");
});

test("clearMineruCaches removes the caches and reports the freed bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-clear-"));
  const formula = path.join(root, "formula-cache");
  fs.mkdirSync(path.join(formula, "paper-abc"), { recursive: true });
  fs.writeFileSync(path.join(formula, "paper-abc", "doc.json"), "x".repeat(2048));
  const serviceDir = path.join(root, "mineru-service");
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, "blob.bin"), "y".repeat(1024));
  const absent = path.join(root, "nope");
  const result = clearMineruCaches([formula, serviceDir, absent, ""]);
  assert.equal(fs.existsSync(formula), false);
  assert.equal(fs.existsSync(serviceDir), false);
  assert.equal(result.cleared.length, 2, JSON.stringify(result));
  assert.equal(result.totalBytes, 3072);
  assert.deepEqual(result.skipped, []);
});

test("a started service that dies is reported as stopped with the tail", async () => {
  const { spawnImpl } = fakeSpawn((_call, child) => {
    setImmediate(() => {
      child.stderr.emit("data", "boom: cuda out of memory");
      child.emit("close", 1);
    });
  });
  const service = createMineruLocalService({ ...quiet, spawnImpl, fetchImpl: async () => jsonResponse({}, false, 503), healthTimeoutMs: 30, startTimeoutMs: 1500 });
  const result = await service.ensure({});
  assert.equal(result.status, "stopped");
  assert.match(String(result.detail), /退出码 1/);
  assert.match(String(result.detail), /cuda out of memory/);
});
