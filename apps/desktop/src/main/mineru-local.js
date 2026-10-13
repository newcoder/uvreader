// 本地 MinerU 常驻服务(mineru-kit api-server)的生命周期:
// 应用启动时按设置自动拉起(默认开,可在面板关掉),书坊里可以检测运行状态;
// 退出时只收自己拉起的进程——已经手动起的服务只探测、不接管、不杀。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MINERU_PORT = 8123;
export const MINERU_HEALTH_TIMEOUT = 2500;
export const MINERU_START_TIMEOUT = 45_000;

// 设置里的地址优先;没填就用本机默认端口。
export function mineruServiceUrl(settings = {}) {
  const raw = String(settings.mineruLocalUrl || "").trim().replace(/\/+$/, "");
  if (raw) return raw;
  return `http://127.0.0.1:${DEFAULT_MINERU_PORT}`;
}

export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function servicePort(url) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0) return port;
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_MINERU_PORT;
  }
}

// mineru-kit 的候选路径:设置 → 环境变量 → sidecar python 的同目录 → pdf_tool 目录下常见的 venv 布局。
export function mineruKitCandidates(settings = {}, { env = process.env } = {}) {
  const list = [];
  const add = (value) => {
    const trimmed = String(value || "").trim();
    if (trimmed && !list.includes(trimmed)) list.push(trimmed);
  };
  add(settings.mineruLocalExe);
  add(env?.MINERU_LOCAL_CMD);
  const python = String(settings.ocrPython || "").trim();
  if (python) {
    const dir = path.dirname(python);
    add(path.join(dir, "mineru-kit.exe"));
    add(path.join(dir, "mineru-kit"));
  }
  const sidecar = String(settings.ocrSidecarDir || "").trim();
  if (sidecar) {
    for (const name of ["mineru-kit.exe", "mineru-kit"]) {
      add(path.join(sidecar, ".venv", "Scripts", name));
      add(path.join(sidecar, "venv", "Scripts", name));
      add(path.join(sidecar, ".venv", "bin", name));
    }
  }
  return list;
}

// 找到就用完整路径;裸名字也返回(让 spawn 去 PATH 找,ENOENT 时给可操作提示)。
export function resolveMineruKit(settings = {}, { env = process.env, exists = fs.existsSync } = {}) {
  for (const candidate of mineruKitCandidates(settings, { env })) {
    if (candidate === "mineru-kit" || candidate === "mineru-kit.exe") return candidate;
    if (exists(candidate)) return candidate;
  }
  return "";
}

export function mineruStartArgs(url, uploadDir, { tier = "standard" } = {}) {
  return [
    "api-server",
    "--host", "127.0.0.1",
    "--port", String(servicePort(url)),
    "--tier", String(tier || "standard"),
    // 必须指定:不给的话 blobs/ 与锁文件会落在启动目录。
    "--upload-dir", String(uploadDir),
  ];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 探测常驻服务是否健康(给转换链路用:健康才把地址交给 pdf_tool,避免把死地址传下去)。
export async function probeMineruService(url, { fetchImpl = (...args) => fetch(...args), timeoutMs = MINERU_HEALTH_TIMEOUT } = {}) {
  try {
    const response = await fetchImpl(`${String(url).replace(/\/+$/, "")}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) return { ok: false, error: `HTTP ${response?.status ?? "?"}` };
    const data = await response.json().catch(() => ({}));
    return { ok: true, version: String(data?.version || "") };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// 递归算目录大小(清理时报告释放了多少)。
function directorySize(target, fsImpl) {
  let total = 0;
  for (const entry of fsImpl.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += directorySize(child, fsImpl);
    else {
      try { total += fsImpl.statSync(child).size; } catch { /* 已经没了 */ }
    }
  }
  return total;
}

// 清理 MinerU 相关缓存目录:公式链路的解析缓存 / 本地服务的上传目录 / 文本型工作目录等。
// 逐个删,删不掉的(被服务占用)跳过;返回清掉的路径与总字节数。
export function clearMineruCaches(paths = [], { fsImpl = fs } = {}) {
  const cleared = [];
  const skipped = [];
  let totalBytes = 0;
  for (const target of paths) {
    const value = String(target || "").trim();
    if (!value || !fsImpl.existsSync(value)) continue;
    let bytes = 0;
    try { bytes = directorySize(value, fsImpl); } catch { bytes = 0; }
    try {
      fsImpl.rmSync(value, { recursive: true, force: true });
      cleared.push({ path: value, bytes });
      totalBytes += bytes;
    } catch {
      skipped.push(value);
    }
  }
  return { cleared, skipped, totalBytes };
}

export function createMineruLocalService({
  spawnImpl = spawn,
  fetchImpl = (...args) => fetch(...args),
  exists = fs.existsSync,
  env = process.env,
  uploadDir = "",
  startTimeoutMs = MINERU_START_TIMEOUT,
  healthTimeoutMs = MINERU_HEALTH_TIMEOUT,
  log = (...args) => console.log("[mineru-local]", ...args),
} = {}) {
  let child = null;
  let managed = false;
  let tail = "";
  let state = { status: "idle", url: "", version: "", detail: "" };

  async function probe(url) {
    return probeMineruService(url, { fetchImpl, timeoutMs: healthTimeoutMs });
  }

  // 检测:如实探测 /v1/health,再叠加已知状态(不猜)。
  async function status(settings = {}) {
    const url = mineruServiceUrl(settings);
    const tried = mineruKitCandidates(settings, { env });
    const health = await probe(url);
    if (health.ok) {
      state = { status: "running", url, version: health.version || state.version, detail: managed ? "由应用启动" : "已在运行" };
    } else if (state.status === "starting" && state.url === url) {
      // 启动中:保持原状态,detail 里带上探测错误
      state = { ...state, detail: state.detail || health.error || "" };
    } else if (state.status !== "missing" && state.status !== "error") {
      state = { status: "stopped", url, version: "", detail: health.error || "" };
    }
    return { ...state, tried, url, managed };
  }

  async function ensure(settings = {}) {
    const url = mineruServiceUrl(settings);
    const health = await probe(url);
    if (health.ok) {
      state = { status: "running", url, version: health.version || "", detail: managed ? "由应用启动" : "已在运行" };
      return { ...state, managed };
    }
    if (!isLoopbackUrl(url)) {
      state = { status: "external", url, detail: "非本机地址,由外部维护" };
      return { ...state, managed: false };
    }
    if (settings.autoStart === false) {
      state = { status: "stopped", url, detail: "已关闭自动启动" };
      return { ...state, managed };
    }
    if (!child) {
      const tried = mineruKitCandidates(settings, { env });
      const exe = resolveMineruKit(settings, { env, exists })
        || String(settings.mineruLocalExe || "").trim()
        || String(env?.MINERU_LOCAL_CMD || "").trim()
        || "mineru-kit";
      const dir = String(uploadDir || path.join(os.tmpdir(), "uv-reader-mineru"));
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch { /* 目录建不了就让服务自己报错 */ }
      const args = mineruStartArgs(url, dir, { tier: settings.tier });
      try {
        child = spawnImpl(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        child = null;
        state = { status: "error", url, tried, detail: String(error?.message || error) };
        return { ...state, managed: false };
      }
      managed = true;
      tail = "";
      const collect = (chunk) => { tail = (tail + String(chunk)).slice(-500); };
      child.stdout?.on?.("data", collect);
      child.stderr?.on?.("data", collect);
      child.on?.("error", (error) => {
        const missing = String(error?.code || "") === "ENOENT";
        state = {
          status: missing ? "missing" : "error",
          url,
          tried,
          tail: tail.slice(-200),
          detail: missing
            ? `没找到 ${exe}:在「转换设置 → 本地 MinerU 程序」里填完整路径(例如 <venv>\\Scripts\\mineru-kit.exe),或设环境变量 MINERU_LOCAL_CMD`
            : String(error?.message || error),
        };
        child = null;
        managed = false;
      });
      child.on?.("close", (code) => {
        if (state.status === "running" || state.status === "starting") {
          state = { status: "stopped", url, tried, tail: tail.slice(-200), detail: `服务已退出(退出码 ${code})${tail ? `:${tail.slice(-120)}` : ""}` };
        }
        child = null;
        managed = false;
      });
      state = { status: "starting", url, tried, tail: "", detail: "" };
      log("starting", exe, args.join(" "));
    }
    const deadline = Date.now() + Math.max(1000, Number(startTimeoutMs) || MINERU_START_TIMEOUT);
    while (Date.now() < deadline) {
      if (state.status === "missing" || state.status === "error" || (!child && state.status !== "starting")) {
        return { ...state, url, managed };
      }
      const check = await probe(url);
      if (check.ok) {
        state = { status: "running", url, version: check.version || "", detail: "由应用启动" };
        log("ready", url, state.version || "");
        return { ...state, managed };
      }
      await sleep(1000);
    }
    state = { status: "error", url, tried, tail: tail.slice(-200), detail: `启动超时(${Math.round((Number(startTimeoutMs) || MINERU_START_TIMEOUT) / 1000)}s):${(tail || "没有健康响应").slice(-160)}` };
    return { ...state, managed };
  }

  // 只收自己拉起的进程;手动起的服务不碰。
  function stop() {
    if (managed && child) {
      try { child.kill(); } catch { /* 已经没了 */ }
      log("stopped", state.url);
    }
    child = null;
    managed = false;
    tail = "";
    state = { status: "stopped", url: state.url, version: "", detail: "" };
    return true;
  }

  return { ensure, status, stop };
}