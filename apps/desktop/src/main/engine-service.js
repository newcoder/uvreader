// 引擎进程的启停与状态:
// - 应用装过的引擎在 <engineRoot>/<版本>/(有 engine.json);取版本号最大的那个;
// - **只停自己起的**:起的时候写 <版本>/engine.pid,停的时候读它 —— 手工用 run-engine.cmd
//   起的引擎没有 pid 记录,应用明确说「不是应用启动的」,不去猜端口杀进程;
// - 令牌沿用安装时写下的 <版本>/token.txt,不存在就生成。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { removeFile } from "./paths.js";

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

export function portFromUrl(url, fallback = 8760) {
  try {
    const port = Number(new URL(String(url || "")).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
  } catch {
    // 空串 / 半截地址 / 用户手填的怪东西:一律回退,别让「启动引擎」因此炸掉。
    return fallback;
  }
}

export function createEngineService({ engineRoot = "", installer = null, tokenBytes = 24, log = () => {}, kill = process.kill } = {}) {
  // 主进程把日志函数当参数传进来;传错了(比如引用了不存在的变量)不能让**启停**跟着失败。
  const logSafe = (...args) => {
    try {
      log(...args);
    } catch { /* logging must never break start/stop */ }
  };
  async function status() {
    const engine = pickEngine(engineRoot);
    if (!engine) return { ok: false, installed: false, running: false, detail: "还没装书坊引擎" };
    const info = readPid(engine.dir);
    const running = Boolean(info && isAlive(info.pid, kill));
    return {
      ok: true,
      installed: true,
      running,
      version: engine.version,
      platform: engine.platform,
      dir: engine.dir,
      pid: running ? info.pid : 0,
      port: running ? info.port : 0,
      detail: running ? `运行中 · ${engine.version} · 端口 ${info.port}` : `未运行 · ${engine.version}`,
    };
  }

  async function start({ port = 8760 } = {}) {
    if (!installer?.start) throw new Error("引擎服务没有配置启动器");
    const engine = pickEngine(engineRoot);
    if (!engine) throw new Error("还没装书坊引擎:先点上面的「下载并安装引擎」");
    const current = await status();
    if (current.running) return { ...current, started: false };
    const tokenFile = path.join(engine.dir, "token.txt");
    let token = "";
    try {
      token = fs.readFileSync(tokenFile, "utf8").trim();
    } catch { /* 没有就生成 */ }
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
    return {
      ok: true,
      installed: true,
      running: true,
      started: true,
      version: engine.version,
      platform: engine.platform,
      dir: engine.dir,
      pid: started.pid,
      port,
      token,
      engineUrl: `http://127.0.0.1:${port}`,
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

  return { status, start, stop };
}
