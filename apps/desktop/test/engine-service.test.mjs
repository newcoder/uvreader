import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearPid, compareVersions, createEngineService, isAlive, listEngines, pickEngine, portFromUrl, readPid, writePid } from "../src/main/engine-service.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-service-"));
const makeEngine = (root, version, { token = "", manifest = {} } = {}) => {
  const dir = path.join(root, version);
  fs.mkdirSync(path.dirname(path.join(dir, "engine.json")), { recursive: true });
  fs.writeFileSync(path.join(dir, "engine.json"), JSON.stringify({ engineVersion: version, platform: "win32-x64", ...manifest }), "utf8");
  if (token) fs.writeFileSync(path.join(dir, "token.txt"), token, "utf8");
  return dir;
};

test("compareVersions orders numerically, not lexicographically", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0, "0.10 比 0.9 新");
  assert.ok(compareVersions("0.1.2", "0.1.10") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("listEngines only counts directories with a manifest, newest first", () => {
  const root = tempRoot();
  makeEngine(root, "0.1.2");
  makeEngine(root, "0.1.10");
  makeEngine(root, "0.1.9");
  fs.mkdirSync(path.join(root, "download-abc"), { recursive: true }); // 下载临时目录不算
  fs.mkdirSync(path.join(root, "0.2.0"), { recursive: true }); // 没清单也不算
  const versions = listEngines(root).map((entry) => entry.version);
  assert.deepEqual(versions, ["0.1.10", "0.1.9", "0.1.2"], "新在前,且只认有 engine.json 的目录");
  assert.equal(pickEngine(root).version, "0.1.10");
  assert.equal(pickEngine(path.join(root, "nope")), null);
});

test("pid files round-trip and isAlive reads the process table", () => {
  const root = tempRoot();
  const dir = makeEngine(root, "0.1.0");
  assert.equal(readPid(dir), null);
  writePid(dir, { pid: 4242, port: 8760, startedAt: 1 });
  assert.deepEqual(readPid(dir), { pid: 4242, port: 8760, startedAt: 1 });
  clearPid(dir);
  assert.equal(readPid(dir), null);
  assert.equal(isAlive(4242, () => undefined), true);
  const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
  assert.equal(isAlive(4242, () => { throw missing; }), false);
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  assert.equal(isAlive(4242, () => { throw denied; }), true, "EPERM 说明进程在,只是发不了信号");
});

test("portFromUrl reads the port and falls back to 8760", () => {
  assert.equal(portFromUrl("http://127.0.0.1:8790"), 8790);
  assert.equal(portFromUrl("http://127.0.0.1"), 8760);
  assert.equal(portFromUrl(""), 8760);
  assert.equal(portFromUrl("not a url"), 8760);
});

test("status reports what is installed and whether the recorded pid is alive", async () => {
  const root = tempRoot();
  const alive = new Set([4242]);
  const kill = (pid) => { if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  const service = createEngineService({ engineRoot: root, kill });
  assert.deepEqual(await service.status(), { ok: false, installed: false, running: false, detail: "还没装书坊引擎" });

  const dir = makeEngine(root, "0.1.3", { token: "t" });
  const idle = await service.status();
  assert.equal(idle.installed, true);
  assert.equal(idle.running, false);
  assert.match(idle.detail, /未运行/);

  writePid(dir, { pid: 4242, port: 8761 });
  const running = await service.status();
  assert.equal(running.running, true);
  assert.equal(running.pid, 4242);
  assert.equal(running.port, 8761);
  assert.match(running.detail, /运行中/);
});

test("start reuses the token, records the pid and waits for health", async () => {
  const root = tempRoot();
  const dir = makeEngine(root, "0.1.3", { token: "existing-token" });
  const calls = [];
  const service = createEngineService({
    engineRoot: root,
    installer: {
      start: (request) => { calls.push(request); return { pid: 777 }; },
      waitHealthy: async ({ port, token }) => {
        calls.push({ waited: { port, token } });
        return { ok: true, engineVersion: "0.1.3" };
      },
    },
    kill: (pid) => { if (pid !== 777) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
  const started = await service.start({ port: 8762 });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(started.engineUrl, "http://127.0.0.1:8762");
  assert.equal(started.token, "existing-token", "沿用安装时写下的令牌");
  assert.equal(calls[0].engineRoot, dir);
  assert.equal(calls[0].token, "existing-token");
  assert.deepEqual(readPid(dir), { pid: 777, port: 8762, startedAt: readPid(dir).startedAt });
  assert.deepEqual(calls[1].waited, { port: 8762, token: "existing-token" });

  // 已经在跑:不重复拉起
  const again = await service.start({ port: 8762 });
  assert.equal(again.started, false);
  assert.equal(calls.length, 2, "第二个 start 不该再调 installer.start");

  // 没装引擎:说清楚,不去瞎跑
  const empty = createEngineService({ engineRoot: path.join(root, "nope"), installer: { start: () => ({ pid: 1 }) } });
  await assert.rejects(() => empty.start(), /还没装书坊引擎/);
});

test("start generates a token when the bundle has none and fails loudly when health never comes", async () => {
  const root = tempRoot();
  const dir = makeEngine(root, "0.1.3");
  const service = createEngineService({
    engineRoot: root,
    tokenBytes: 4,
    installer: { start: () => ({ pid: 555 }), waitHealthy: async () => null },
  });
  await assert.rejects(() => service.start({ port: 8763 }), /没起来/);
  assert.equal(fs.readFileSync(path.join(dir, "token.txt"), "utf8").length, 8, "令牌长度 = 4 字节的 hex");
  assert.equal(readPid(dir), null, "没起来就不该留下 pid 记录");
});

test("stop only kills engines the app started and says so for foreign ones", async () => {
  const root = tempRoot();
  const dir = makeEngine(root, "0.1.3");
  const killed = [];
  const service = createEngineService({ engineRoot: root, kill: (pid) => { killed.push(pid); } });

  const foreign = await service.stop();
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "foreign");
  assert.match(foreign.detail, /不是应用启动的/);
  assert.deepEqual(killed, [], "没有 pid 记录时绝不猜端口杀进程");

  writePid(dir, { pid: 999, port: 8763 });
  const stopped = await service.stop();
  assert.equal(stopped.ok, true);
  assert.deepEqual(killed, [999]);
  assert.equal(readPid(dir), null, "停完清掉 pid 记录");
});

test("stop treats an already-dead pid as stopped", async () => {
  const root = tempRoot();
  const dir = makeEngine(root, "0.1.3");
  writePid(dir, { pid: 1000, port: 8763 });
  const service = createEngineService({
    engineRoot: root,
    kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
  const stopped = await service.stop();
  assert.equal(stopped.ok, true);
  assert.equal(readPid(dir), null);
});
