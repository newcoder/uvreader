import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkshopQueue, WORKSHOP_HISTORY_LIMIT } from "../src/main/workshop.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等任务跑到终态:固定 sleep 在满载的 CI 上会偶发假失败(实测)。
async function waitForDone(queue, ids, { timeoutMs = 5000 } = {}) {
  const wanted = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tasks = queue.snapshot().tasks.filter((task) => wanted.has(task.id));
    if (tasks.length === wanted.size && tasks.every((task) => task.status !== "running" && task.status !== "queued")) return;
    if (Date.now() > deadline) return; // 超时就把真实状态留给断言
    await sleep(10);
  }
}

function makeQueue(runners = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-workshop-"));
  const file = path.join(dir, "workshop-tasks.json");
  const states = [];
  const queue = createWorkshopQueue({ file, onState: (state) => states.push(state), log: { warn() {} } });
  for (const [kind, runner] of Object.entries(runners)) queue.register(kind, runner);
  return { queue, file, states, dir };
}

test("tasks run serially, report progress and land their output", async () => {
  let concurrent = 0;
  let peak = 0;
  const { queue } = makeQueue({
    slow: async ({ report }) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      report({ total: 2, label: "第一步" });
      await sleep(15);
      report({ done: 1, total: 2 });
      await sleep(15);
      report({ done: 2, total: 2 });
      concurrent -= 1;
      return { output: "ok" };
    },
  });
  const first = queue.start({ kind: "slow", title: "一" });
  const second = queue.start({ kind: "slow", title: "二" });
  await waitForDone(queue, [first, second]);
  const tasks = queue.snapshot().tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(peak, 1, "runners never overlap");
  assert.equal(byId.get(first).status, "done");
  assert.equal(byId.get(second).status, "done");
  assert.equal(byId.get(first).output, "ok");
  assert.equal(byId.get(first).done, 2);
  assert.equal(byId.get(first).total, 2);
  assert.ok(byId.get(first).finishedAt >= byId.get(first).createdAt);
});

test("running tasks expose startedAt so the shell can show an elapsed clock", async () => {
  const { queue } = makeQueue({
    slow: async () => { await sleep(80); return {}; },
  });
  const id = queue.start({ kind: "slow", title: "转换" });
  await sleep(30);
  const running = queue.snapshot().tasks.find((task) => task.id === id);
  assert.equal(running.status, "running");
  assert.ok(running.startedAt > 0, "startedAt is set when the runner starts");
  assert.ok(running.startedAt >= running.createdAt);
  await waitForDone(queue, [id]);
  assert.equal(queue.snapshot().tasks.find((task) => task.id === id).status, "done");
});

test("a queued task can be cancelled before its runner starts", async () => {
  const ran = [];
  const { queue } = makeQueue({
    slow: async () => { await sleep(40); return {}; },
    quick: async () => { ran.push("quick"); return {}; },
  });
  const first = queue.start({ kind: "slow", title: "慢" });
  const second = queue.start({ kind: "quick", title: "快" });
  assert.equal(queue.cancel(second), true);
  await waitForDone(queue, [first]);
  const byId = new Map(queue.snapshot().tasks.map((task) => [task.id, task]));
  assert.equal(byId.get(second).status, "cancelled");
  assert.equal(byId.get(first).status, "done");
  assert.deepEqual(ran, [], "a cancelled task never reaches its runner");
});

test("cancelling a running task aborts its signal", async () => {
  const { queue } = makeQueue({
    waiting: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(resolve, 500);
    }),
  });
  const id = queue.start({ kind: "waiting", title: "等待" });
  await sleep(20);
  assert.equal(queue.cancel(id), true);
  await sleep(40);
  const task = queue.snapshot().tasks.find((entry) => entry.id === id);
  assert.equal(task.status, "cancelled");
  assert.equal(task.error, "", "a cancelled task is not a failure");
});

test("a failing task records the error and retry starts a fresh one", async () => {
  let attempts = 0;
  const { queue } = makeQueue({
    flaky: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("第一次失败");
      return { output: "重试成功" };
    },
  });
  const first = queue.start({ kind: "flaky", title: "试" });
  await sleep(30);
  const failed = queue.snapshot().tasks.find((task) => task.id === first);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /第一次失败/);
  const second = queue.retry(first);
  assert.ok(second && second !== first, "retry returns a new task id");
  await sleep(30);
  const done = queue.snapshot().tasks.find((task) => task.id === second);
  assert.equal(done.status, "done");
  assert.equal(done.output, "重试成功");
  // Running a finished task again is allowed (the UI only offers it for
  // failures, but the queue stays permissive).
  const third = queue.retry(second);
  assert.ok(third && third !== second, "a finished task can be run again");
  await sleep(30);
  assert.equal(queue.snapshot().tasks.find((task) => task.id === third).status, "done");
});

test("history is persisted, reloaded and capped", async () => {
  const { queue, file } = makeQueue({ quick: async () => ({ output: "x" }) });
  for (let i = 0; i < 3; i += 1) queue.start({ kind: "quick", title: `任务${i}` });
  await sleep(60);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.tasks.length, 3);
  assert.equal(WORKSHOP_HISTORY_LIMIT, 20);
  const reloaded = createWorkshopQueue({ file, onState: () => {}, log: { warn() {} } });
  const tasks = reloaded.snapshot().tasks;
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].title, "任务2", "history is newest first");
  assert.ok(tasks.every((task) => task.status === "done"));
  reloaded.clearHistory();
  assert.equal(reloaded.snapshot().tasks.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).tasks, []);
});

test("an unknown kind is rejected before anything runs", () => {
  const { queue } = makeQueue({});
  assert.throws(() => queue.start({ kind: "nope", title: "x" }), /未知的书坊任务类型/);
  assert.equal(queue.snapshot().tasks.length, 0);
});
