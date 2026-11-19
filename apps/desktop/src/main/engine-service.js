// 引擎进程的启停与状态:
// - 应用装过的引擎在 <engineRoot>/<版本>/(有 engine.json);取版本号最大的那个;
// - **只停自己起的**:起的时候写 <版本>/engine.pid,停的时候读它 —— 手工用 run-engine.cmd
//   起的引擎没有 pid 记录,应用明确说「不是应用启动的」,不去猜端口杀进程;
// - 令牌沿用安装时写下的 <版本>/token.txt,不存在就生成。
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { engineArchiveInfo } from "./engine-bundle.js";
import { removeFile, removeTree } from "./paths.js";

const PID_FILE = "engine.pid";

export function compareVersions(a, b) {
  const parse = (value) => String(value || "0").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 装好的引擎(新在前)。下载临时目录、components/ 这类没有 engine.json 的目录不算。
export function listEngines(engineRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(engineRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(engineRoot, entry.name);
    const manifestPath = path.join(dir, "engine.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      found.push({ dir, version: String(manifest.engineVersion || entry.name), platform: String(manifest.platform || "") });
    } catch { /* 清单坏了就跳过这个目录 */ }
  }
  return found.sort((left, right) => compareVersions(right.version, left.version));
}

export function pickEngine(engineRoot) {
  return listEngines(engineRoot)[0] || null;
}

// Paths the OCR sidecar needs when it runs from an installed engine bundle:
// the bundled pdf_tool checkout plus the private interpreter.
export function engineOcrPaths(engineDir) {
  const base = String(engineDir || "").trim();
  if (!base) return { ocrSidecarDir: "", ocrPython: "" };
  return {
    ocrSidecarDir: path.join(base, "pdf-tool"),
    ocrPython: process.platform === "win32"
      ? path.join(base, "python", "python.exe")
      : path.join(base, "python", "bin", "python3"),
  };
}

function enginePythonPath(engineDir) {
  return process.platform === "win32"
    ? path.join(engineDir, "python", "python.exe")
    : path.join(engineDir, "python", "bin", "python3");
}

function enginePythonVersion(engineDir, { spawnSyncImpl = spawnSync } = {}) {
  const python = enginePythonPath(engineDir);
  if (!python || !fs.existsSync(python)) return "";
  try {
    const result = spawnSyncImpl(python, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return result?.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

// DocVortex 装在 <引擎版本>/components 里。引擎升级到新版本目录后，旧组件不会
// 自动出现；这里优先从旧引擎直接复制（约 250 MB，本地复制远快于重新 pip install）。
// Python 主次版本不同的组件不复制，避免 cp311 的扩展模块被 cp312 加载。
export function migrateEngineComponents(engineRoot, targetDir, {
  copyImpl = (from, to) => fs.cpSync(from, to, { recursive: true, force: true }),
  pythonVersionOf = enginePythonVersion,
  log = () => {},
} = {}) {
  const target = path.resolve(String(targetDir || ""));
  const targetComponents = path.join(target, "components");
  try {
    if (fs.existsSync(targetComponents) && fs.readdirSync(targetComponents).length) {
      return { copied: false, reason: "already-present" };
    }
  } catch { /* treat unreadable as missing */ }
  const engines = listEngines(engineRoot);
  const targetEngine = engines.find((engine) => path.resolve(engine.dir) === target);
  const targetPython = pythonVersionOf(target);
  let candidates = engines.filter((engine) => path.resolve(engine.dir) !== target);
  if (targetEngine?.platform) {
    const samePlatform = candidates.filter((engine) => !engine.platform || engine.platform === targetEngine.platform);
    if (samePlatform.length) candidates = samePlatform;
  }
  for (const candidate of candidates) {
    const source = path.join(candidate.dir, "components");
    let entries = [];
    try {
      entries = fs.readdirSync(source);
    } catch {
      continue;
    }
    if (!entries.length) continue;
    const sourcePython = pythonVersionOf(candidate.dir);
    if (targetPython && sourcePython && targetPython !== sourcePython) {
      log("[engine-components] skip", candidate.version, `python ${sourcePython} -> ${targetPython}`);
      continue;
    }
    try {
      copyImpl(source, targetComponents);
      if (!fs.readdirSync(targetComponents).length) {
        removeTree(targetComponents);
        continue;
      }
      log("[engine-components] reused", candidate.version, "->", path.basename(target));
      return { copied: true, from: candidate.dir, version: candidate.version, python: sourcePython };
    } catch (error) {
      try { removeTree(targetComponents); } catch { /* keep trying other versions */ }
      log("[engine-components] copy failed", candidate.version, String(error?.message || error));
    }
  }
  return { copied: false, reason: "no-cache" };
}

function engineSitePackages(engineDir) {
  const dirs = [];
  if (process.platform === "win32") {
    dirs.push(path.join(engineDir, "site-packages"));
    return dirs;
  }
  const lib = path.join(engineDir, "python", "lib");
  try {
    for (const entry of fs.readdirSync(lib, { withFileTypes: true })) {
      if (entry.isDirectory() && /^python3\.\d+$/.test(entry.name)) {
        dirs.push(path.join(lib, entry.name, "site-packages"));
      }
    }
  } catch { /* not an engine bundle */ }
  return dirs;
}

// The OCR sidecar is only usable when the engine ships both the pdf_tool
// checkout and a RapidOCR backend. Older engine bundles have pdf_tool but no
// OCR deps; they should fall back to the manual settings with a clear hint
// instead of spawning a Python that will fail on `import rapidocr`.
export function engineOcrReady(engineDir) {
  const paths = engineOcrPaths(engineDir);
  if (!paths.ocrSidecarDir || !paths.ocrPython) return false;
  if (!fs.existsSync(path.join(paths.ocrSidecarDir, "pdf_tool", "reader", "server.py"))) return false;
  if (!fs.existsSync(paths.ocrPython)) return false;
  // OCR is bundled in the interpreter's site-packages. Components/ is not on
  // the sidecar's sys.path (only the engine process adds it), so do not treat a
  // rapidocr installed there as ready.
  return engineSitePackages(engineDir).some((dir) =>
    fs.existsSync(path.join(dir, "rapidocr")) || fs.existsSync(path.join(dir, "rapidocr_onnxruntime")));
}

// Resolve the newest installed engine's bundled OCR sidecar, if it is ready.
// Used by pdf-ocr as a fallback when the user has not configured a local
// pdf_tool checkout (the common case on a fresh machine).
export function engineOcrSettings(engineRoot) {
  const engine = pickEngine(engineRoot);
  if (!engine || !engineOcrReady(engine.dir)) return null;
  return engineOcrPaths(engine.dir);
}

export function readPid(engineDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(engineDir, PID_FILE), "utf8"));
    const pid = Number(info?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port: Number(info?.port) || 0, startedAt: Number(info?.startedAt) || 0 };
  } catch {
    return null;
  }
}

export function readToken(engineDir) {
  try {
    return fs.readFileSync(path.join(engineDir, "token.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

export function writePid(engineDir, info) {
  fs.writeFileSync(path.join(engineDir, PID_FILE), JSON.stringify(info, null, 2), "utf8");
}

export function clearPid(engineDir) {
  removeFile(path.join(engineDir, PID_FILE));
}

export function isAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在,只是没权限给它发信号(Windows 上对系统进程会这样)。
    return error?.code === "EPERM";
  }
}

export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("无法分配空闲端口"))));
    });
  });
}

export function portFromUrl(url, fallback = 8760) {
  try {
    const port = Number(new URL(String(url || "")).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
  } catch {
    // 空串 / 半截地址 / 用户手填的怪东西:一律回退,别让「启动引擎」因此炸掉。
    return fallback;
  }
}

export function createEngineService({ engineRoot = "", installer = null, bundleArchive = "", tokenBytes = 24, log = () => {}, kill = process.kill } = {}) {
  // 主进程把日志函数当参数传进来;传错了(比如引用了不存在的变量)不能让**启停**跟着失败。
  const logSafe = (...args) => {
    try {
      log(...args);
    } catch { /* logging must never break start/stop */ }
  };
  let preparing = null;
  const bundled = Boolean(bundleArchive);

  // A Store build ships the engine zip inside resources/engine. Extract it
  // once into the writable engine root before the first start. A normal build
  // has no archive and keeps the existing install/update flow unchanged.
  async function prepare() {
    const installed = pickEngine(engineRoot);
    const bundledInfo = bundleArchive ? engineArchiveInfo(bundleArchive) : null;
    // An already-newer external engine is fine; an older one should not shadow
    // the engine that shipped with this Store build.
    if (installed && (!bundledInfo || compareVersions(installed.version, bundledInfo.version) >= 0)) {
      migrateEngineComponents(engineRoot, installed.dir, { log: logSafe });
      return installed;
    }
    if (!bundleArchive || !fs.existsSync(bundleArchive)) {
      if (installed) migrateEngineComponents(engineRoot, installed.dir, { log: logSafe });
      return installed;
    }
    if (!installer?.extract) throw new Error("内置引擎包存在,但当前引擎服务没有配置解压器");
    if (preparing) return preparing;
    preparing = (async () => {
      if (!bundledInfo) throw new Error(`内置引擎包文件名无法识别:${path.basename(bundleArchive)}`);
      const target = path.join(engineRoot, bundledInfo.version);
      if (!fs.existsSync(path.join(target, "engine.json"))) {
        logSafe("[engine-service] extracting bundled engine", bundleArchive, target);
        await installer.extract(bundleArchive, target);
      }
      const prepared = pickEngine(engineRoot);
      if (prepared) migrateEngineComponents(engineRoot, prepared.dir, { log: logSafe });
      return prepared;
    })().finally(() => { preparing = null; });
    return preparing;
  }

  async function status() {
    const engine = pickEngine(engineRoot);
    if (!engine) {
      return {
        ok: false,
        installed: false,
        running: false,
        bundled,
        detail: bundled ? "内置书坊引擎准备中" : "还没装书坊引擎",
      };
    }
    const info = readPid(engine.dir);
    const running = Boolean(info && isAlive(info.pid, kill));
    const ocr = engineOcrReady(engine.dir) ? engineOcrPaths(engine.dir) : null;
    const token = running ? readToken(engine.dir) : "";
    // A fresh profile shares the engine install with the previous profile. When
    // that engine is already running, status is the only place that knows its
    // port/token; return them so the renderer can fill the settings instead of
    // leaving engineUrl/engineToken empty.
    const live = running && info.port > 0
      ? { engineUrl: `http://127.0.0.1:${info.port}`, ...(token ? { engineToken: token } : {}) }
      : {};
    return {
      ok: true,
      installed: true,
      running,
      bundled,
      version: engine.version,
      platform: engine.platform,
      dir: engine.dir,
      pid: running ? info.pid : 0,
      port: running ? info.port : 0,
      ocrReady: Boolean(ocr),
      ...(ocr || {}),
      ...live,
      detail: running ? `运行中 · ${engine.version} · 端口 ${info.port}` : `未运行 · ${engine.version}`,
    };
  }

  async function start({ port = 8760 } = {}) {
    if (!installer?.start) throw new Error("引擎服务没有配置启动器");
    const engine = await prepare();
    if (!engine) throw new Error(bundled ? "内置书坊引擎准备失败:引擎包不存在或无法解压" : "还没装书坊引擎:先点上面的「下载并安装引擎」");
    const current = await status();
    if (current.running) return { ...current, started: false };
    const tokenFile = path.join(engine.dir, "token.txt");
    let token = readToken(engine.dir);
    if (!token) {
      token = crypto.randomBytes(tokenBytes).toString("hex");
      fs.writeFileSync(tokenFile, token, "utf8");
    }
    logSafe("[engine-service] starting", engine.dir, "port", port);
    const started = installer.start({ engineRoot: engine.dir, port, token });
    writePid(engine.dir, { pid: started.pid, port, startedAt: Date.now() });
    const health = await installer.waitHealthy({ port, token });
    if (!health) {
      clearPid(engine.dir);
      throw new Error("引擎没起来(看引擎目录里的 engine.log)");
    }
    const ocr = engineOcrReady(engine.dir) ? engineOcrPaths(engine.dir) : null;
    return {
      ok: true,
      installed: true,
      running: true,
      started: true,
      bundled,
      version: engine.version,
      platform: engine.platform,
      dir: engine.dir,
      pid: started.pid,
      port,
      token,
      engineUrl: `http://127.0.0.1:${port}`,
      ocrReady: Boolean(ocr),
      ...(ocr || {}),
      health,
    };
  }

  async function stop() {
    const engine = pickEngine(engineRoot);
    if (!engine) return { ok: false, installed: false, running: false, detail: "还没装书坊引擎" };
    const info = readPid(engine.dir);
    if (!info) {
      return {
        ok: false,
        installed: true,
        running: false,
        reason: "foreign",
        detail: "这个引擎不是应用启动的(没有 pid 记录):请用启动它的方式停掉(比如关掉 run-engine.cmd 的窗口)",
      };
    }
    try {
      kill(info.pid);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    clearPid(engine.dir);
    logSafe("[engine-service] stopped", engine.dir, "pid", info.pid);
    return { ok: true, installed: true, running: false, version: engine.version, pid: info.pid };
  }

  return { status, start, stop, prepare };
}
