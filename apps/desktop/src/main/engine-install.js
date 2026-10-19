// 书坊引擎的安装/更新:查最新 engine 资产 → 下载 + 校验 sha256 → 解压到 <userData>/engine/<版本> → 拉起。
// 设计:安装过程本身走任务队列(engine-install),进度用任务行表达;装完把 engineUrl/engineToken 回给面板。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { removeTree } from "./paths.js";

export const ENGINE_RELEASES_API = "https://api.github.com/repos/newcoder/uvreader/releases?per_page=30";

// 平台标识(与打包脚本一致)
export function enginePlatform(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function engineAssetName(version, platform) {
  const ext = platform.startsWith("win32") ? "zip" : "tar.gz";
  return `uvreader-engine-${version}-${platform}.${ext}`;
}

// 从 GitHub releases 列表里挑最新的 engine 资产(engine-v* 标签,优先匹配本机平台)。
export function pickEngineAsset(releases, platform) {
  const candidates = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    const tag = String(release?.tag_name || "");
    if (!/^engine-v\d/.test(tag)) continue;
    const version = tag.replace(/^engine-v/, "");
    for (const asset of release?.assets || []) {
      const name = String(asset?.name || "");
      if (!name.startsWith(`uvreader-engine-${version}-`)) continue;
      if (!name.endsWith(".zip") && !name.endsWith(".tar.gz")) continue;
      candidates.push({ version, name, url: String(asset.browser_download_url || ""), publishedAt: String(release.published_at || "") });
    }
  }
  if (!candidates.length) return null;
  const wanted = engineAssetName(candidates[0].version, platform);
  return candidates.find((item) => item.name === wanted) || candidates[0];
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// 解析 .sha256 文件的内容("<hash>  <name>")。
export function parseSha256(text) {
  const match = /([0-9a-f]{64})/i.exec(String(text || ""));
  return match ? match[1].toLowerCase() : "";
}

export function createEngineInstaller({
  fetchImpl = (...args) => fetch(...args),
  spawnImpl = spawn,
  log = () => {},
} = {}) {
  // 下载(流式,报进度):写临时文件,完成后返回路径。
  async function download(url, outPath, { onProgress = () => {}, signal = null } = {}) {
    const response = await fetchImpl(url, { redirect: "follow", signal });
    if (!response?.ok) throw new Error(`下载失败:HTTP ${response?.status || "?"}`);
    const total = Number(response.headers?.get?.("content-length")) || 0;
    const handle = await response.body?.getReader?.();
    if (!handle) {
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outPath, buffer);
      onProgress({ done: buffer.length, total: total || buffer.length });
      return outPath;
    }
    const chunks = [];
    let done = 0;
    for (;;) {
      const { value, done: finished } = await handle.read();
      if (finished) break;
      chunks.push(Buffer.from(value));
      done += value.length;
      onProgress({ done, total });
      if (signal?.aborted) throw new Error("已取消");
    }
    fs.writeFileSync(outPath, Buffer.concat(chunks));
    return outPath;
  }

  // 解压(用系统 tar:Windows 是 bsdtar,能解 zip;macOS/Linux 解 tar.gz)。
  async function extract(archivePath, targetDir, { signal = null } = {}) {
    fs.mkdirSync(targetDir, { recursive: true });
    const result = await new Promise((resolve) => {
      const child = spawnImpl("tar", ["-xf", archivePath, "-C", targetDir], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => resolve({ ok: false, error: String(error?.message || error) }));
      child.on("close", (code) => resolve({ ok: code === 0, error: code === 0 ? "" : output.trim().slice(-200) }));
      signal?.addEventListener("abort", () => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: "已取消", cancelled: true }); }, { once: true });
    });
    if (!result.ok) throw new Error(`解压失败:${result.error}`);
    if (!fs.existsSync(path.join(targetDir, "engine.json"))) throw new Error("解压后没有 engine.json(不是引擎包?)");
    return targetDir;
  }

  // 拉起引擎(脱离进程;日志落 engine.log),返回 { pid, port }。
  function start({ engineRoot, port = 8760, token = "", engineConfig = "" }) {
    const python = process.platform === "win32"
      ? path.join(engineRoot, "python", "python.exe")
      : path.join(engineRoot, "python", "bin", "python3");
    if (!fs.existsSync(python)) throw new Error(`引擎包里没有解释器:${python}`);
    const logFile = path.join(engineRoot, "engine.log");
    const fd = fs.openSync(logFile, "a");
    const env = { ...process.env, PYTHONPATH: engineRoot };
    if (engineConfig) env.ENGINE_CONFIG = engineConfig;
    const child = spawnImpl(python, ["-m", "engine", "serve", "--port", String(port), "--token", token], {
      cwd: engineRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref?.();
    log("[engine-install] started", python, "port", port);
    return { pid: child.pid, port, python };
  }

  async function waitHealthy({ port, token, timeoutMs = 90_000, fetchImpl: probeFetch = fetchImpl } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await probeFetch(`http://127.0.0.1:${port}/v1/health`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return await response.json();
      } catch { /* 还在起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return null;
  }

  return { download, extract, start, waitHealthy };
}

// 任务队列里的 engine-install:查最新资产(或本地 zip)→ 下载 → sha256 → 解压 → 拉起 → 回传 engineUrl/engineToken。
export function registerEngineInstallRunner(workshop, {
  installer = createEngineInstaller(),
  engineRoot = "",
  fetchImpl = (...args) => fetch(...args),
  releasesUrl = ENGINE_RELEASES_API,
  log = () => {},
} = {}) {
  workshop.register("engine-install", async ({ payload = {}, report = () => {}, signal }) => {
    const platform = enginePlatform();
    const localZip = String(payload?.archivePath || "").trim();
    let asset = null;
    if (localZip) {
      if (!fs.existsSync(localZip)) throw new Error(`找不到安装包:${localZip}`);
      asset = { name: path.basename(localZip), url: "", version: String(payload?.version || "local"), local: true };
    } else {
      report({ label: "查询最新引擎版本…" });
      const response = await fetchImpl(releasesUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "uvreader-engine-install" },
        signal,
      });
      if (!response?.ok) throw new Error(`查询发布列表失败:HTTP ${response?.status || "?"}`);
      asset = pickEngineAsset(await response.json(), platform);
      if (!asset) throw new Error(`还没有发布 ${platform} 的引擎包(engine-v* Release)`);
    }

    const root = engineRoot || path.join(process.cwd(), "engine");
    fs.mkdirSync(root, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(root, "download-"));
    const archivePath = asset.local ? localZip : path.join(tempDir, asset.name);
    try {
      if (!asset.local) {
        report({ label: `下载引擎 ${asset.version}…` });
        await installer.download(asset.url, archivePath, {
          signal,
          onProgress: ({ done, total }) => {
            const mb = (value) => (value / 1024 / 1024).toFixed(0);
            report({ label: `下载引擎 ${asset.version} · ${mb(done)}/${total ? mb(total) : "?"} MB` });
          },
        });
        report({ label: "校验 sha256…" });
        const shaResponse = await fetchImpl(`${asset.url}.sha256`, { signal });
        const expected = shaResponse?.ok ? parseSha256(await shaResponse.text()) : "";
        if (!expected) throw new Error("没有拿到 sha256,拒绝安装");
        const actual = sha256File(archivePath);
        if (actual !== expected) throw new Error(`sha256 不匹配(期望 ${expected.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…)`);
      }
      const target = path.join(root, asset.version);
      removeTree(target);
      report({ label: "解压引擎…" });
      await installer.extract(archivePath, target, { signal });
      const tokenFile = path.join(target, "token.txt");
      let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
      if (!token) {
        token = crypto.randomBytes(24).toString("hex");
        fs.writeFileSync(tokenFile, token, "utf8");
      }
      const port = Number(payload?.port) || 8760;
      report({ label: `启动引擎(端口 ${port})…` });
      const started = installer.start({ engineRoot: target, port, token });
      const health = await installer.waitHealthy({ port, token });
      if (!health) throw new Error("引擎装好了但没起来(看引擎目录里的 engine.log)");
      const engineUrl = `http://127.0.0.1:${port}`;
      log("[engine-install] ready", asset.version, engineUrl);
      return {
        output: `引擎 ${asset.version} 已安装并启动 · ${engineUrl}`,
        detail: `http://127.0.0.1:${port} · ${asset.version}`,
        result: { engineUrl, engineToken: token, version: asset.version, platform, pid: started.pid },
      };
    } finally {
      removeTree(tempDir);
    }
  });
}
