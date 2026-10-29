import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkEngineUpdate,
  createEngineInstaller,
  engineAssetName,
  enginePlatform,
  engineUpdateState,
  parseSha256,
  pickEngineAsset,
  registerEngineComponentRunner,
  registerEngineInstallRunner,
  sha256File,
} from "../src/main/engine-install.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-install-"));
const streamResponse = (buffer) => ({
  ok: true,
  status: 200,
  headers: { get: () => String(buffer.length) },
  body: {
    getReader: () => {
      let sent = false;
      return {
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { value: buffer, done: false };
        },
      };
    },
  },
});

test("enginePlatform and engineAssetName follow the release naming", () => {
  assert.equal(enginePlatform("win32", "x64"), "win32-x64");
  assert.equal(enginePlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(engineAssetName("0.1.0", "win32-x64"), "uvreader-engine-0.1.0-win32-x64.zip");
  assert.equal(engineAssetName("0.1.0", "linux-x64"), "uvreader-engine-0.1.0-linux-x64.tar.gz");
});

test("pickEngineAsset takes the newest engine release for this platform", () => {
  const releases = [
    { tag_name: "v0.7.0", assets: [{ name: "uvreader-0.7.0-setup.exe", browser_download_url: "https://dl/app.exe" }] },
    {
      tag_name: "engine-v0.1.0",
      published_at: "2026-10-19T00:00:00Z",
      assets: [
        { name: "uvreader-engine-0.1.0-win32-x64.zip", browser_download_url: "https://dl/win.zip" },
        { name: "uvreader-engine-0.1.0-win32-x64.zip.sha256", browser_download_url: "https://dl/win.zip.sha256" },
        { name: "uvreader-engine-0.1.0-linux-x64.tar.gz", browser_download_url: "https://dl/linux.tar.gz" },
      ],
    },
  ];
  const linux = pickEngineAsset(releases, "linux-x64");
  assert.equal(linux.name, "uvreader-engine-0.1.0-linux-x64.tar.gz");
  assert.equal(linux.version, "0.1.0");
  // The .sha256 sibling must never be mistaken for the archive itself.
  assert.equal(pickEngineAsset(releases, "win32-x64").url, "https://dl/win.zip");
  // No engine release at all, or nothing for the platform, is not an error here.
  assert.equal(pickEngineAsset([], "win32-x64"), null);
  assert.equal(pickEngineAsset([{ tag_name: "v1.0.0", assets: [] }], "win32-x64"), null);
});

test("engineUpdateState compares the installed engine with the newest bundle", () => {
  const releases = [{
    tag_name: "engine-v0.1.10",
    assets: [{ name: "uvreader-engine-0.1.10-win32-x64.zip", browser_download_url: "https://dl/new.zip" }],
  }];
  assert.deepEqual(engineUpdateState(releases, "win32-x64", "0.1.9"), {
    ok: true,
    installed: "0.1.9",
    latest: "0.1.10",
    available: true,
    assetName: "uvreader-engine-0.1.10-win32-x64.zip",
    detail: "已安装 0.1.9 · 最新 0.1.10",
  });
  assert.equal(engineUpdateState(releases, "win32-x64", "0.1.10").available, false);
  assert.equal(engineUpdateState(releases, "win32-x64", "").available, true);
  assert.equal(engineUpdateState([], "win32-x64", "0.1.10").ok, false);
});

test("checkEngineUpdate fetches releases without downloading an archive", async () => {
  const calls = [];
  const update = await checkEngineUpdate({
    installedVersion: "0.1.0",
    platform: "win32-x64",
    releasesUrl: "https://api.example/releases",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify([{
        tag_name: "engine-v0.1.1",
        assets: [{ name: "uvreader-engine-0.1.1-win32-x64.zip", browser_download_url: "https://dl/engine.zip" }],
      }]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(update.available, true);
  assert.equal(update.latest, "0.1.1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/releases");
});

test("parseSha256 reads the hash out of a .sha256 file", () => {
  const hash = "a".repeat(64);
  assert.equal(parseSha256(`${hash}  uvreader-engine-0.1.0-win32-x64.zip\n`), hash);
  assert.equal(parseSha256(`${"B".repeat(64)}\n`), "b".repeat(64));
  assert.equal(parseSha256("not a hash"), "");
  assert.equal(parseSha256(""), "");
});

test("download streams to a file and reports progress", async () => {
  const dir = tempDir();
  const body = Buffer.from("engine-bytes");
  const installer = createEngineInstaller({ fetchImpl: async () => streamResponse(body) });
  const progress = [];
  const out = path.join(dir, "bundle.zip");
  await installer.download("https://dl/bundle.zip", out, { onProgress: (row) => progress.push(row) });
  assert.equal(fs.readFileSync(out, "utf8"), "engine-bytes");
  assert.deepEqual(progress.at(-1), { done: body.length, total: body.length });
  assert.equal(sha256File(out), crypto.createHash("sha256").update(body).digest("hex"));
});

test("download refuses a non-ok response", async () => {
  const dir = tempDir();
  const installer = createEngineInstaller({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(
    () => installer.download("https://dl/missing.zip", path.join(dir, "x.zip")),
    /HTTP 404/,
  );
});

test("extract unpacks an archive and insists on engine.json", async () => {
  const dir = tempDir();
  const stage = path.join(dir, "stage");
  fs.mkdirSync(path.join(stage, "engine"), { recursive: true });
  fs.writeFileSync(path.join(stage, "engine.json"), JSON.stringify({ engineVersion: "0.1.0" }));
  fs.writeFileSync(path.join(stage, "engine", "__init__.py"), "");
  const archive = path.join(dir, process.platform === "win32" ? "bundle.zip" : "bundle.tar.gz");
  const tarArgs = process.platform === "win32" ? ["-a", "-c", "-f", archive, "-C", stage, "."] : ["-czf", archive, "-C", stage, "."];
  const packed = spawnSync("tar", tarArgs, { encoding: "utf8" });
  assert.equal(packed.status, 0, String(packed.stderr || ""));

  const installer = createEngineInstaller();
  const target = path.join(dir, "installed");
  await installer.extract(archive, target);
  assert.equal(fs.existsSync(path.join(target, "engine.json")), true);
  assert.equal(fs.existsSync(path.join(target, "engine", "__init__.py")), true);

  // A random archive (no engine.json) is rejected instead of half-installed.
  const junk = path.join(dir, "junk");
  fs.mkdirSync(junk, { recursive: true });
  fs.writeFileSync(path.join(junk, "readme.txt"), "nope");
  const junkArchive = path.join(dir, process.platform === "win32" ? "junk.zip" : "junk.tar.gz");
  spawnSync("tar", process.platform === "win32" ? ["-a", "-c", "-f", junkArchive, "-C", junk, "."] : ["-czf", junkArchive, "-C", junk, "."]);
  await assert.rejects(() => installer.extract(junkArchive, path.join(dir, "junk-out")), /不是引擎包/);
});

test("the install runner unpacks a local bundle, starts it and returns the settings", async () => {
  const dir = tempDir();
  const root = path.join(dir, "engine");
  const runners = new Map();
  const workshop = { register: (kind, runner) => runners.set(kind, runner) };
  const started = [];
  const installer = {
    download: async () => { throw new Error("本地包不该走下载"); },
    extract: async (_archive, target) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "engine.json"), "{}");
    },
    start: ({ engineRoot, port, token }) => {
      started.push({ engineRoot, port, token });
      return { pid: 4242 };
    },
    waitHealthy: async () => ({ ok: true, engineVersion: "0.1.0" }),
  };
  registerEngineInstallRunner(workshop, { installer, engineRoot: root, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const archive = path.join(dir, "bundle.zip");
  fs.writeFileSync(archive, "fake-bundle");
  const reports = [];
  const result = await runners.get("engine-install")({
    payload: { archivePath: archive, version: "0.1.0", port: 8899 },
    report: (row) => reports.push(row),
    signal: new AbortController().signal,
  });
  assert.match(result.output, /0\.1\.0/);
  assert.equal(result.result.engineUrl, "http://127.0.0.1:8899");
  assert.equal(result.result.version, "0.1.0");
  assert.equal(result.result.pid, 4242);
  assert.equal(started.length, 1);
  assert.equal(started[0].port, 8899);
  assert.equal(started[0].engineRoot, path.join(root, "0.1.0"));
  assert.equal(started[0].token, result.result.engineToken);
  // The generated token is written next to the bundle and reused afterwards.
  const tokenFile = path.join(root, "0.1.0", "token.txt");
  assert.equal(fs.readFileSync(tokenFile, "utf8"), result.result.engineToken);
  assert.ok(reports.some((row) => /解压/.test(row.label || "")));
});

test("a downloaded bundle with the wrong sha256 is rejected", async () => {
  const dir = tempDir();
  const root = path.join(dir, "engine");
  const platform = enginePlatform();
  const version = "0.1.0";
  const body = Buffer.from("engine-bytes");
  const assetUrl = "https://dl/uvreader-engine-0.1.0.zip";
  const releasesUrl = "https://api.github.com/repos/newcoder/uvreader/releases";
  const fetchImpl = async (url) => {
    if (url === releasesUrl) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          tag_name: `engine-v${version}`,
          assets: [{ name: engineAssetName(version, platform), browser_download_url: assetUrl }],
        }]),
      };
    }
    if (url === assetUrl) return streamResponse(body);
    if (url === `${assetUrl}.sha256`) return { ok: true, status: 200, text: async () => `${"0".repeat(64)}  bundle\n` };
    return { ok: false, status: 404 };
  };
  const real = createEngineInstaller({ fetchImpl });
  const installer = {
    ...real,
    extract: async (_archive, target) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "engine.json"), "{}");
    },
    start: () => ({ pid: 1 }),
    waitHealthy: async () => ({ ok: true }),
  };
  const runners = new Map();
  registerEngineInstallRunner({ register: (kind, runner) => runners.set(kind, runner) }, { installer, engineRoot: root, fetchImpl, releasesUrl });
  await assert.rejects(
    () => runners.get("engine-install")({ payload: { port: 8899 }, report: () => {}, signal: new AbortController().signal }),
    /sha256 不匹配/,
  );
  assert.equal(fs.existsSync(path.join(root, version)), false, "校验失败不能留下半装目录");
});

test("a downloaded bundle with the right sha256 installs and starts", async () => {
  const dir = tempDir();
  const root = path.join(dir, "engine");
  const platform = enginePlatform();
  const version = "0.2.0";
  const body = Buffer.from("engine-bytes-2");
  const assetUrl = "https://dl/uvreader-engine-0.2.0.zip";
  const releasesUrl = "https://api.github.com/repos/newcoder/uvreader/releases";
  const fetchImpl = async (url) => {
    if (url === releasesUrl) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          tag_name: `engine-v${version}`,
          assets: [{ name: engineAssetName(version, platform), browser_download_url: assetUrl }],
        }]),
      };
    }
    if (url === assetUrl) return streamResponse(body);
    if (url === `${assetUrl}.sha256`) {
      return { ok: true, status: 200, text: async () => `${crypto.createHash("sha256").update(body).digest("hex")}  bundle\n` };
    }
    return { ok: false, status: 404 };
  };
  const real = createEngineInstaller({ fetchImpl });
  const installer = {
    ...real,
    extract: async (_archive, target) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "engine.json"), "{}");
    },
    start: () => ({ pid: 7 }),
    waitHealthy: async () => ({ ok: true }),
  };
  const runners = new Map();
  registerEngineInstallRunner({ register: (kind, runner) => runners.set(kind, runner) }, { installer, engineRoot: root, fetchImpl, releasesUrl });
  const result = await runners.get("engine-install")({ payload: { port: 8899 }, report: () => {}, signal: new AbortController().signal });
  assert.equal(result.result.version, version);
  assert.equal(result.result.engineUrl, "http://127.0.0.1:8899");
  assert.equal(fs.existsSync(path.join(root, version, "engine.json")), true);
});

test("the install runner reports a missing local bundle instead of half-installing", async () => {
  const dir = tempDir();
  const runners = new Map();
  registerEngineInstallRunner({ register: (kind, runner) => runners.set(kind, runner) }, { engineRoot: path.join(dir, "engine") });
  await assert.rejects(
    () => runners.get("engine-install")({ payload: { archivePath: path.join(dir, "nope.zip") }, report: () => {}, signal: new AbortController().signal }),
    /找不到安装包/,
  );
});

test("the component runner installs through the engine and forwards its progress", async () => {
  const runners = new Map();
  const calls = [];
  const engine = {
    installComponent: async (settings, name, options) => {
      calls.push({ settings, name, action: options?.action, hasProgress: typeof options?.onProgress === "function" });
      options?.onProgress?.({ label: "装 DocVortex:下载中" });
      options?.onProgress?.({ label: "装好了" });
      if (options?.action === "remove") {
        return { ok: true, result: { removed: true, target: "C:/engine/components" } };
      }
      return { ok: true, result: { installed: ["docvortex"], target: "C:/engine/site-packages" } };
    },
  };
  registerEngineComponentRunner({ register: (kind, runner) => runners.set(kind, runner) }, { engine });
  const reports = [];
  const result = await runners.get("engine-component")({
    payload: { name: "docvortex", settings: { engineUrl: "http://127.0.0.1:8760", engineToken: "t" } },
    report: (row) => reports.push(String(row?.label || "")),
    signal: new AbortController().signal,
  });
  assert.match(result.output, /docvortex/);
  assert.equal(result.result.target, "C:/engine/site-packages");
  assert.equal(calls[0].name, "docvortex");
  assert.equal(calls[0].action, "install");
  assert.equal(calls[0].settings.engineToken, "t");
  assert.ok(reports.includes("装 DocVortex:下载中"), "引擎的进度要转发到任务行");

  // 卸载:同一个 runner,action=remove;结果带 removed。
  const removed = await runners.get("engine-component")({
    payload: { name: "docvortex", action: "remove", settings: { engineUrl: "http://127.0.0.1:8760" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(calls[1].action, "remove");
  assert.match(removed.output, /卸载/);
  assert.equal(removed.result.removed, true);
});

test("the component runner fails loudly instead of pretending", async () => {
  const runners = new Map();
  registerEngineComponentRunner({ register: (kind, runner) => runners.set(kind, runner) }, {
    engine: { installComponent: async () => ({ ok: false, error: "未知组件:requests" }) },
  });
  const runner = runners.get("engine-component");
  await assert.rejects(() => runner({ payload: { name: "requests" }, report: () => {}, signal: new AbortController().signal }), /未知组件/);
  await assert.rejects(() => runner({ payload: {}, report: () => {}, signal: new AbortController().signal }), /没有指定/);
});
