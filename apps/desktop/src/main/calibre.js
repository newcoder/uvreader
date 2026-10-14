// 书坊电子书产物(EPUB/MOBI/AZW3…):Calibre 的 ebook-convert 集成。
// 候选顺序:自定义路径 → 常见安装位置 → PATH。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function calibreCandidates(settings = {}) {
  const custom = String(settings.calibrePath || "").trim();
  const list = [];
  if (custom) list.push({ command: custom, args: [], kind: "custom" });
  const exe = process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert";
  const roots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Calibre2"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Calibre2"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Calibre2"),
  ].filter(Boolean);
  for (const root of roots) list.push({ command: path.join(root, exe), args: [], kind: "common" });
  if (process.platform === "darwin") {
    list.push({ command: "/Applications/calibre.app/Contents/MacOS/ebook-convert", args: [], kind: "common" });
  }
  if (process.platform === "linux") {
    // Calibre 的官方 Linux 安装脚本落在 /opt/calibre,snap 包在 /snap/bin
    // (发行版包管理器装的直接进 PATH)。
    list.push({ command: "/opt/calibre/ebook-convert", args: [], kind: "common" });
    list.push({ command: "/snap/bin/ebook-convert", args: [], kind: "common" });
  }
  list.push({ command: "ebook-convert", args: [], kind: "path" });
  return list;
}

// ebook-convert <输入> <输出> [选项];选项留空即纯转换。
export function ebookConvertArgs(source, out, extraArgs = []) {
  return [String(source), String(out), ...extraArgs.map((arg) => String(arg))];
}

function tail(text, limit = 300) {
  return String(text || "").trim().slice(-limit);
}

export function friendlyCalibreError(text) {
  const raw = String(text || "");
  if (/not recognized|不是内部或外部命令|No such file|ENOENT/i.test(raw)) {
    return "找不到 Calibre 的 ebook-convert：安装 Calibre 或在上面的路径里填写完整路径";
  }
  if (/Failed to convert|Conversion failed|ERROR:/i.test(raw)) {
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    return (lines.find((line) => /ERROR:/i.test(line)) || lines[lines.length - 1] || raw).slice(0, 300);
  }
  return tail(raw);
}

export function createCalibre({ spawnImpl = spawn, timeoutMs = 20 * 60_000, probeTimeoutMs = 8_000 } = {}) {
  // 逐个候选跑 `--version`;第一个成功的即解析结果。
  function probe(settings = {}) {
    const candidates = calibreCandidates(settings);
    return new Promise((resolve) => {
      let index = 0;
      const attempt = () => {
        const candidate = candidates[index++];
        if (!candidate) {
          resolve({ ok: false, detail: "未找到 Calibre(ebook-convert);安装后重试或填写路径" });
          return;
        }
        if (candidate.kind !== "path" && !fs.existsSync(candidate.command)) {
          attempt();
          return;
        }
        let child;
        try {
          child = spawnImpl(candidate.command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        } catch {
          attempt();
          return;
        }
        let out = "";
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch { /* already gone */ }
          if (ok) resolve({ ok: true, detail: out.trim().split("\n").pop() || "ebook-convert", ...candidate });
          else attempt();
        };
        const timer = setTimeout(() => finish(false), probeTimeoutMs);
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
      };
      attempt();
    });
  }

  function run(candidate, args, { signal } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(candidate.command, [...candidate.args, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
        return;
      }
      let out = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, cancelled: true, error: "任务已取消" });
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, error: `转换超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.on("error", (error) => finish({ ok: false, error: friendlyCalibreError(String(error?.message || error)) }));
      child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : friendlyCalibreError(out) }));
    });
  }

  // 电子书格式转换(EPUB → AZW3/MOBI/EPUB…)。
  async function convert(settings, { source, out, extraArgs = [], signal } = {}) {
    const resolved = await probe(settings);
    if (!resolved.ok) return { ok: false, error: resolved.detail };
    if (!fs.existsSync(source)) return { ok: false, error: `源文件不存在：${source}` };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const result = await run(resolved, ebookConvertArgs(source, out, extraArgs), { signal });
    if (!result.ok) return result;
    if (!fs.existsSync(out)) return { ok: false, error: "转换完成但没有生成文件" };
    return { ok: true, out };
  }

  return { probe, convert, run };
}
