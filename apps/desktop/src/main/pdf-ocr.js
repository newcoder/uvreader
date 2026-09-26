// Scanned-PDF text layer: drives the pdf_tool reader sidecar from the main
// process. The sidecar speaks line-delimited JSON-RPC over stdio
// (see pdf_tool/reader/README.md).
//
// Two ways in:
//   - a short-lived one-shot job (probe / full export) that spawns, works and
//     exits;
//   - a reading session that stays alive while a scan is open so single pages
//     can be fetched lazily and land in the sidecar's page cache for later
//     reads (ms on a cache hit).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OCR_PROBE_TIMEOUT = 8000;

function log(...args) {
  try { console.error("[qbr-ocr]", ...args); } catch { /* stderr may be gone */ }
}

// Where the sidecar comes from: a packaged executable wins, then a pdf_tool
// checkout run through the configured Python.
export function ocrCommand(settings = {}) {
  const exe = String(settings.ocrSidecarExe || "").trim();
  if (exe) {
    if (!fs.existsSync(exe)) return { error: `找不到 OCR 程序：${exe}` };
    return { command: exe, args: [], cwd: path.dirname(exe) };
  }
  const python = String(settings.ocrPython || "").trim() || "python";
  const dir = String(settings.ocrSidecarDir || "").trim();
  if (dir) {
    if (!fs.existsSync(path.join(dir, "pdf_tool", "reader", "server.py"))) {
      return { error: `这个目录里没有 pdf_tool：${dir}` };
    }
    return { command: python, args: ["-m", "pdf_tool.reader"], cwd: dir };
  }
  // A development checkout can point at the sidecar without touching settings.
  const fromEnv = String(process.env.QBR_OCR_SIDECAR || "").trim();
  if (fromEnv) {
    if (fs.existsSync(fromEnv) && fromEnv.toLowerCase().endsWith(".exe")) {
      return { command: fromEnv, args: [], cwd: path.dirname(fromEnv) };
    }
    if (fs.existsSync(path.join(fromEnv, "pdf_tool", "reader", "server.py"))) {
      return { command: python, args: ["-m", "pdf_tool.reader"], cwd: fromEnv };
    }
  }
  return { error: "还没有配置 pdf_tool 目录" };
}

// The generated copy must stay inside the vault so it syncs and can be opened
// through the vault like any other file.
export function resolveOcrOutput(vaultRoot, target) {
  const root = path.resolve(String(vaultRoot || ""));
  const resolved = path.resolve(String(target || ""));
  if (!root) throw new Error("缺少书库目录");
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("OCR 输出必须位于书库目录内");
  }
  return resolved;
}

function childErrorMessage(error, fallback = "OCR 进程启动失败") {
  const code = String(error?.code || "");
  if (code === "ENOENT") return "找不到 Python 可执行文件，请在阅读设置里填写完整路径";
  return String(error?.message || error || fallback);
}

// One spawned sidecar process: line protocol, pending requests, one exit hook.
function spawnSession({ command, args, cwd, spawnImpl, onNotification, onExit }) {
  let child;
  try {
    child = spawnImpl(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(childErrorMessage(error));
  }
  const pending = new Map();
  const stderrTail = [];
  let nextId = 1;
  let dead = false;

  const settleAll = (error) => {
    for (const entry of pending.values()) entry.reject(new Error(error));
    pending.clear();
  };
  child.on("error", (error) => {
    dead = true;
    const message = childErrorMessage(error);
    log("spawn error:", message, command);
    settleAll(message);
    onExit?.({ error: message });
  });
  child.on("exit", (code) => {
    dead = true;
    const tail = stderrTail.filter((line) => /error|失败/i.test(line)).slice(-1)[0] || stderrTail.slice(-1)[0] || "";
    const message = `OCR 进程退出（代码 ${code}）${tail ? ` · ${tail}` : ""}`;
    log("exit", code, tail.slice(0, 160), command);
    settleAll(message);
    onExit?.({ code, error: message });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) stderrTail.push(line.trim());
    while (stderrTail.length > 12) stderrTail.shift();
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || "OCR 请求被拒绝"));
        else entry.resolve(message.result);
        continue;
      }
      onNotification?.(message);
    }
  });

  return {
    get dead() { return dead; },
    request(method, params = {}, timeoutMs = 0) {
      if (dead) return Promise.reject(new Error("OCR 进程已退出"));
      const id = nextId++;
      const payload = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`OCR 请求超时：${method}`));
          }, timeoutMs);
        }
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try {
          child.stdin.write(`${JSON.stringify(payload)}\n`);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error(childErrorMessage(error)));
        }
      });
    },
    kill() {
      try { child.stdin.end(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}

export function createPdfOcr({ spawnImpl = spawn } = {}) {
  const jobs = new Map();
  const sessions = new Map();

  // Liveness/config check used by the settings row.
  function probe(settings = {}, timeoutMs = OCR_PROBE_TIMEOUT) {
    const target = ocrCommand(settings);
    if (target.error) return Promise.resolve({ ok: false, detail: target.error });
    let session;
    try {
      session = spawnSession({ ...target, spawnImpl });
    } catch (error) {
      return Promise.resolve({ ok: false, detail: String(error?.message || error) });
    }
    return session.request("ping", {}, timeoutMs)
      .then((result) => ({ ok: Boolean(result?.ok), detail: String(result?.name || "pdf_tool.reader") }))
      .catch((error) => ({ ok: false, detail: String(error?.message || error) }))
      .finally(() => session.kill());
  }

  // A reading session: one sidecar process that stays warm while a scan is
  // open. `page` fetches (or computes and caches) one page's text layer.
  function openSession(settings = {}, sourcePath = "") {
    const target = ocrCommand(settings);
    if (target.error) throw new Error(target.error);
    const source = path.resolve(String(sourcePath || ""));
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source || "(空)"}`);
    log("session open", target.command, target.args.join(" "), "cwd", target.cwd);
    const session = spawnSession({ ...target, spawnImpl });
    const sessionId = `s${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sessions.set(sessionId, { session, source });
    return { sessionId };
  }

  function page(sessionId, pageNo, options = {}) {
    const entry = sessions.get(String(sessionId || ""));
    if (!entry) return Promise.reject(new Error("OCR 会话不存在或已关闭"));
    const params = { path: entry.source, page: Number(pageNo) || 0 };
    if (options.force) params.force = true;
    if (Number.isFinite(Number(options.dpi)) && Number(options.dpi) > 0) params.dpi = Number(options.dpi);
    return entry.session.request("ocr.page", params).then((result) => ({
      page: Number(result?.page) || params.page,
      hasText: Boolean(result?.has_text),
      source: String(result?.source || "ocr"),
      lines: Number(result?.lines?.length) || 0,
      content: result?.content || null,
    }));
  }

  function closeSession(sessionId) {
    const entry = sessions.get(String(sessionId || ""));
    if (!entry) return false;
    sessions.delete(String(sessionId));
    entry.session.kill();
    return true;
  }

  function closeAll() {
    for (const entry of sessions.values()) entry.session.kill();
    sessions.clear();
  }

  // One-shot export job: OCR text layer → a new searchable PDF at `out`.
  function start(settings = {}, request = {}, handlers = {}) {
    const target = ocrCommand(settings);
    if (target.error) throw new Error(target.error);
    const source = path.resolve(String(request.source || ""));
    const out = path.resolve(String(request.out || ""));
    if (!source || !fs.existsSync(source)) throw new Error(`源文件不存在：${source || "(空)"}`);
    if (!out) throw new Error("缺少输出路径");
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const jobId = String(request.jobId || "");
    if (!jobId) throw new Error("缺少任务 id");
    if (jobs.has(jobId)) throw new Error(`任务已存在：${jobId}`);

    const job = { jobId, finished: false, sidecarJob: "" };
    jobs.set(jobId, job);
    log("export job start", jobId, source, "→", out);

    const finish = (result) => {
      if (job.finished) return;
      job.finished = true;
      jobs.delete(jobId);
      job.session?.kill();
      handlers.onDone?.(result);
    };
    const fail = (detail) => finish({ ok: false, jobId, error: String(detail || "OCR 失败").slice(0, 300) });

    let session;
    try {
      session = spawnSession({
        ...target,
        spawnImpl,
        onNotification: (message) => {
          if (job.finished) return;
          const params = message.params || {};
          if (message.method === "convert.progress" && params.job === job.sidecarJob) {
            handlers.onProgress?.({ jobId, done: Number(params.done) || 0, total: Number(params.total) || 0, page: Number(params.page) || 0 });
          } else if (message.method === "convert.done" && params.job === job.sidecarJob) {
            if (params.error) { fail(params.error); return; }
            if (!fs.existsSync(out)) { fail("OCR 完成但没有生成文件"); return; }
            finish({ ok: true, jobId, out, stats: params.stats || null });
          }
        },
        onExit: ({ error }) => {
          if (!job.finished) fail(error || "OCR 进程退出");
        },
      });
    } catch (error) {
      jobs.delete(jobId);
      throw error;
    }
    job.session = session;
    const payload = { path: source, mode: "export", out, workers: 1 };
    if (Number.isFinite(Number(request.timeout)) && Number(request.timeout) > 0) payload.timeout = Number(request.timeout);
    session.request("convert.start", payload)
      .then((result) => { job.sidecarJob = String(result?.job || ""); })
      .catch((error) => fail(error));
    return { jobId };
  }

  function cancel(jobId) {
    const job = jobs.get(String(jobId || ""));
    if (!job) return false;
    job.finished = true;
    jobs.delete(job.jobId);
    // The sidecar stops at a page boundary; killing the process is the reliable
    // cancel and leaves no partial file (it is written at the end).
    try { job.session?.request("convert.cancel", { job: job.sidecarJob }).catch(() => {}); } catch { /* gone */ }
    job.session?.kill();
    return true;
  }

  function cancelAll() {
    for (const job of [...jobs.values()]) {
      job.finished = true;
      job.session?.kill();
    }
    jobs.clear();
    closeAll();
  }

  return { probe, start, cancel, cancelAll, openSession, page, closeSession, closeAll, jobs, sessions };
}
