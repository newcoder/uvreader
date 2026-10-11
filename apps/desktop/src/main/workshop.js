// 书坊任务队列:串行执行、进度事件、取消/重试、历史落盘(最近 20 条)。
// Tools register a runner per kind (W0-3+ plug OCR / DocVortex / Calibre in);
// the queue itself never touches the vault — runners own their inputs/outputs.
import fs from "node:fs";
import path from "node:path";

export const WORKSHOP_HISTORY_LIMIT = 20;

const TERMINAL = new Set(["done", "failed", "cancelled"]);

class CancelledError extends Error {
  constructor() {
    super("任务已取消");
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

export function createWorkshopQueue({ file = "", onState = () => {}, log = console } = {}) {
  const tasks = []; // newest first
  const byId = new Map();
  const queue = []; // ids waiting to run
  const runners = new Map();
  let running = null;
  let seq = 0;

  function publicTask(task) {
    return {
      id: task.id,
      kind: task.kind,
      title: task.title,
      detail: task.detail,
      status: task.status,
      done: task.done,
      total: task.total,
      label: task.label,
      output: task.output,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }

  function snapshot() {
    return { running: Boolean(running), tasks: tasks.map(publicTask) };
  }

  function persist() {
    if (!file) return;
    try {
      const history = tasks.filter((task) => TERMINAL.has(task.status)).slice(0, WORKSHOP_HISTORY_LIMIT);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks: history.map(publicTask) }, null, 2));
    } catch (error) {
      log.warn?.("workshop history could not be saved", error);
    }
  }

  function emit() {
    persist();
    try {
      onState(snapshot());
    } catch (error) {
      log.warn?.("workshop state listener failed", error);
    }
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const entry of (data?.tasks || []).slice(0, WORKSHOP_HISTORY_LIMIT)) {
        if (!entry?.id || !TERMINAL.has(entry.status)) continue;
        tasks.push({
          ...entry,
          detail: String(entry.detail || ""),
          label: String(entry.label || ""),
          output: String(entry.output || ""),
          error: String(entry.error || ""),
          done: Number(entry.done) || 0,
          total: Number(entry.total) || 0,
          payload: null,
          controller: null,
        });
        byId.set(entry.id, tasks[tasks.length - 1]);
      }
    } catch (error) {
      log.warn?.("workshop history could not be read", error);
    }
  }

  function register(kind, runner) {
    runners.set(String(kind), runner);
    return () => runners.delete(String(kind));
  }

  function hasRunner(kind) {
    return runners.has(String(kind));
  }

  function start(request = {}) {
    const kind = String(request.kind || "");
    const runner = runners.get(kind);
    if (!runner) throw new Error(`未知的书坊任务类型：${kind || "(空)"}`);
    seq += 1;
    const task = {
      id: `w${Date.now().toString(36)}-${seq.toString(36)}`,
      kind,
      title: String(request.title || kind),
      detail: String(request.detail || ""),
      payload: request.payload ?? null,
      status: "queued",
      done: 0,
      total: 0,
      label: "",
      output: "",
      error: "",
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      controller: new AbortController(),
    };
    tasks.unshift(task);
    byId.set(task.id, task);
    queue.push(task.id);
    emit();
    void drain();
    return task.id;
  }

  async function drain() {
    if (running) return;
    while (queue.length) {
      const task = byId.get(queue.shift());
      if (!task || task.status !== "queued") continue;
      running = task;
      task.status = "running";
      task.startedAt = Date.now();
      emit();
      try {
        const result = await runners.get(task.kind)({
          payload: task.payload,
          signal: task.controller.signal,
          report: (progress = {}) => {
            if (typeof progress.done === "number") task.done = progress.done;
            if (typeof progress.total === "number") task.total = progress.total;
            if (progress.label) task.label = String(progress.label);
            emit();
          },
        });
        if (task.controller.signal.aborted) throw new CancelledError();
        task.status = "done";
        task.output = String(result?.output || "");
        if (result?.detail) task.detail = String(result.detail);
      } catch (error) {
        const cancelled = task.controller.signal.aborted || error?.cancelled === true || error?.name === "CancelledError";
        task.status = cancelled ? "cancelled" : "failed";
        task.error = cancelled ? "" : String(error?.message || error).slice(0, 300);
      } finally {
        task.finishedAt = Date.now();
        running = null;
        emit();
      }
    }
  }

  function cancel(id) {
    const task = byId.get(String(id || ""));
    if (!task) return false;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.finishedAt = Date.now();
      task.controller.abort();
      emit();
      return true;
    }
    if (task.status === "running") {
      task.controller.abort();
      return true; // the runner settles it and drain marks it cancelled
    }
    return false;
  }

  function retry(id) {
    const task = byId.get(String(id || ""));
    if (!task || !TERMINAL.has(task.status)) return "";
    return start({ kind: task.kind, title: task.title, detail: task.detail, payload: task.payload });
  }

  function clearHistory() {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      if (!TERMINAL.has(tasks[i].status)) continue;
      byId.delete(tasks[i].id);
      tasks.splice(i, 1);
    }
    emit();
  }

  load();
  emit();
  return {
    start,
    cancel,
    retry,
    snapshot,
    register,
    hasRunner,
    clearHistory,
    get running() {
      return running ? publicTask(running) : null;
    },
  };
}
