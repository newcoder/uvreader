// 书坊文档互转(DocVortex):检测 CLI、构建命令、驱动转换。
// DocVortex 是外部工具(pip install docvortex):候选顺序=自定义路径 →
// PATH 上的 docvortex → 配置的 python -m docvortex。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { uniqueFile } from "./paths.js";
import { DOCVORTEX_FORMATS, docvortexFormatExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

export { DOCVORTEX_FORMATS };

export function docvortexCandidates(settings = {}) {
  const custom = String(settings.docvortexPath || "").trim();
  const python = String(settings.docvortexPython || settings.ocrPython || "").trim() || "python";
  const list = [];
  if (custom) list.push({ command: custom, args: [], kind: "custom" });
  list.push({ command: "docvortex", args: [], kind: "path" });
  list.push({ command: python, args: ["-m", "docvortex"], kind: "python" });
  return list;
}

export function convertArgs(source, target, out, { parseMode = "" } = {}) {
  const args = ["convert", String(source), "--format", String(target || "markdown"), "--output", String(out), "--overwrite"];
  const mode = String(parseMode || "").trim();
  if (mode) args.push("--parse-mode", mode);
  return args;
}

function tail(text, limit = 300) {
  return String(text || "").trim().slice(-limit);
}

export function createDocvortex({ spawnImpl = spawn, timeoutMs = 10 * 60_000, probeTimeoutMs = 8_000 } = {}) {
  // 逐个候选跑 `--version`;第一个成功的即解析结果。
  function probe(settings = {}) {
    const candidates = docvortexCandidates(settings);
    return new Promise((resolve) => {
      let index = 0;
      const attempt = () => {
        const candidate = candidates[index++];
        if (!candidate) {
          resolve({ ok: false, detail: "未找到 docvortex(可 pip install docvortex 或填写路径)" });
          return;
        }
        let child;
        try {
          child = spawnImpl(candidate.command, [...candidate.args, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
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
          if (ok) resolve({ ok: true, detail: out.trim().split("\n")[0] || "docvortex", ...candidate });
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
      child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
      child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : tail(out) || `docvortex 退出码 ${code}` }));
    });
  }

  async function convert(settings, { source, format, out, signal, parseMode = "" } = {}) {
    const resolved = await probe(settings);
    if (!resolved.ok) return { ok: false, error: resolved.detail };
    if (!fs.existsSync(source)) return { ok: false, error: `源文件不存在：${source}` };
    const result = await run(resolved, convertArgs(source, format, out, { parseMode }), { signal });
    if (!result.ok) return result;
    if (!fs.existsSync(out)) return { ok: false, error: "转换完成但没有生成文件" };
    return { ok: true, out };
  }

  return { probe, convert, run };
}

export function registerDocvortexRunners(workshop, { docvortex, vaultRoot = "", log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 检测 DocVortex 是否可用(面板里的「检测」按钮)。
  workshop.register("docvortex-probe", async ({ payload, signal }) => {
    const result = await docvortex.probe(payload?.settings || {});
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.detail || "DocVortex 不可用"));
    return { output: String(result.detail), detail: `${result.kind} · ${result.command}` };
  });

  // 文档互转:source/out 可以是书库相对路径或绝对路径。
  workshop.register("docvortex-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const format = String(payload?.format || "markdown");
    // 同名不覆盖:本地文件也要按 §7 加序号(渲染层的书库判断看不到本地文件)。
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, docvortexFormatExt(format))));
    report({ label: `转换为 ${format}` });
    log("workshop convert", source, "→", out);
    const result = await docvortex.convert(settings, { source, format, out, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "转换失败"));
    return { output: out, detail: `${format} · ${path.basename(out)}` };
  });

  return { convertPath };
}
