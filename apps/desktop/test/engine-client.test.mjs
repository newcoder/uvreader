import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ENGINE_URL, createEngineClient, describeEngineHealth, engineCapabilityRows, normalizeEngineUrl } from "../src/main/engine-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

test("normalizeEngineUrl fills the scheme and the default", () => {
  assert.equal(normalizeEngineUrl(""), DEFAULT_ENGINE_URL);
  assert.equal(normalizeEngineUrl("127.0.0.1:9999/"), "http://127.0.0.1:9999");
  assert.equal(normalizeEngineUrl("https://box.local:8760"), "https://box.local:8760");
});

test("describeEngineHealth summarises version and capabilities", () => {
  const health = {
    engineVersion: "0.1.0",
    capabilities: { pdfTool: { ok: true, detail: "pdf_tool · x" }, docvortex: { ok: true }, mineru: { ok: false }, jobKinds: ["a", "b"] },
  };
  assert.equal(describeEngineHealth(health), "引擎 0.1.0 · pdf_tool / DocVortex · 2 类作业");
  assert.equal(describeEngineHealth({}), "引擎 未知版本");
});

test("engineCapabilityRows lists the engine's own findings", () => {
  const rows = engineCapabilityRows({
    capabilities: {
      python: { ok: true, detail: "3.12.0" },
      pdfTool: { ok: false, detail: "没配置 pdf_tool 目录" },
      docvortex: { ok: true, detail: "文档互转" },
      jobKinds: ["text-layer"],
    },
  });
  assert.deepEqual(rows.map((row) => row.key), ["python", "pdfTool", "docvortex"]);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].detail, /pdf_tool/);
  assert.deepEqual(engineCapabilityRows({}), []);
});

test("the client reads /v1/health and sends the token", async () => {
  const seen = [];
  const { server, url } = await startServer((req, res) => {
    seen.push({ url: req.url, token: req.headers.authorization || "" });
    if (req.url === "/v1/health") {
      json(res, 200, { ok: true, engineVersion: "0.1.0", capabilities: { pdfTool: { ok: true }, jobKinds: ["text-layer"] } });
      return;
    }
    json(res, 404, { detail: "没有这个接口" });
  });
  try {
    const client = createEngineClient();
    const health = await client.health({ engineUrl: url, engineToken: "s3cret" });
    assert.equal(health.ok, true);
    assert.match(describeEngineHealth(health.data), /引擎 0\.1\.0/);
    assert.equal(seen[0].token, "Bearer s3cret");
    const missing = await client.status({ engineUrl: url }, "nope");
    assert.equal(missing.ok, false);
    assert.match(missing.error, /没有这个接口/);
  } finally {
    server.close();
  }
});

test("the client submits, polls and cancels a job", async () => {
  const calls = [];
  const { server, url } = await startServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/v1/jobs") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        assert.equal(parsed.kind, "text-layer");
        assert.equal(parsed.args.source, "D:/book.pdf");
        json(res, 200, { jobId: "job-1" });
      });
      return;
    }
    if (req.url === "/v1/jobs/job-1") {
      if (req.method === "DELETE") return json(res, 200, { cancelled: true });
      return json(res, 200, { id: "job-1", status: "running", done: 3, total: 10, label: "读取文字层…" });
    }
    if (req.url === "/v1/jobs/job-1/result") return json(res, 200, { ok: true, status: "done", result: { pages: 10 } });
    json(res, 404, {});
  });
  try {
    const client = createEngineClient();
    const settings = { engineUrl: url };
    const submitted = await client.submit(settings, "text-layer", { source: "D:/book.pdf" });
    assert.equal(submitted.data.jobId, "job-1");
    const status = await client.status(settings, "job-1");
    assert.equal(status.data.done, 3);
    const result = await client.result(settings, "job-1");
    assert.equal(result.data.result.pages, 10);
    const cancelled = await client.cancel(settings, "job-1");
    assert.equal(cancelled.data.cancelled, true);
    assert.deepEqual(calls, ["POST /v1/jobs", "GET /v1/jobs/job-1", "GET /v1/jobs/job-1/result", "DELETE /v1/jobs/job-1"]);
  } finally {
    server.close();
  }
});

test("the client reads and patches the engine config", async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/config") {
      return json(res, 200, { config: { pdfToolDir: "D:/pdf_tool", mineruToken: "", hasMineruToken: true }, path: "C:/Users/x/.uvreader-engine/config.json" });
    }
    if (req.method === "PATCH" && req.url === "/v1/config") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        assert.equal(parsed.patch.calibrePath, "C:/Calibre/ebook-convert.exe");
        json(res, 200, { config: { ...parsed.patch, hasMineruToken: true }, capabilities: { calibre: { ok: true, detail: "found" } } });
      });
      return;
    }
    json(res, 404, {});
  });
  try {
    const client = createEngineClient();
    const settings = { engineUrl: url };
    const config = await client.config(settings);
    assert.equal(config.data.config.pdfToolDir, "D:/pdf_tool");
    assert.equal(config.data.config.hasMineruToken, true, "令牌只回 has");
    const saved = await client.saveConfig(settings, { calibrePath: "C:/Calibre/ebook-convert.exe" });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.capabilities.calibre.ok, true);
  } finally {
    server.close();
  }
});

test("a missing engine is reported instead of thrown", async () => {
  const client = createEngineClient({ timeoutMs: 1500 });
  // 127.0.0.1:1 基本不会有人监听;连不上要变成 { ok:false }。
  const health = await client.health({ engineUrl: "http://127.0.0.1:1" });
  assert.equal(health.ok, false);
  assert.ok(health.error, "带上可读原因");
});

// 真跑一次引擎(需要 python + fastapi/uvicorn/latex2mathml):没有就跳过,CI 不受影响。
// 本机想真跑:设 QBR_ENGINE_PYTHON 指向装了依赖的解释器(如临时 venv)。
test("the real engine answers /v1/health and /v1/math", async (t) => {
  const enginePython = process.env.QBR_ENGINE_PYTHON || "python";
  const probe = spawnSync(enginePython, ["-c", "import fastapi, uvicorn, latex2mathml"], { cwd: repoRoot, timeout: 30_000 });
  if (probe.status !== 0) {
    t.skip("python 里没有 fastapi / uvicorn / latex2mathml");
    return;
  }
  const port = 8700 + Math.floor(Math.random() * 200);
  const engineRoot = path.join(repoRoot, "engine");
  const configFile = path.join(os.tmpdir(), `qbr-engine-config-${Date.now()}.json`);
  const child = spawn(enginePython, ["-m", "engine", "serve", "--port", String(port), "--token", "test-token"], {
    cwd: engineRoot,
    // 配置写到临时文件:不污染用户主目录里的 ~/.uvreader-engine/config.json
    env: { ...process.env, PYTHONPATH: engineRoot, ENGINE_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const client = createEngineClient({ timeoutMs: 4000 });
  try {
    let health = null;
    for (let i = 0; i < 40; i += 1) {
      health = await client.health({ engineUrl: `http://127.0.0.1:${port}`, engineToken: "test-token" });
      if (health.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(health?.ok, true, `引擎没起来:${health?.error || "超时"}`);
    assert.match(describeEngineHealth(health.data), /引擎/);
    const noToken = await client.health({ engineUrl: `http://127.0.0.1:${port}` });
    assert.equal(noToken.ok, false, "设了令牌就必须带");
    const math = await client.math({ engineUrl: `http://127.0.0.1:${port}`, engineToken: "test-token" }, ["x^2 + y^2 = z^2"]);
    assert.equal(math.ok, true);
    assert.match(math.data.mathml["x^2 + y^2 = z^2"] || "", /<math/);

    // 引擎自己的配置:读 → 改 → 再读(令牌不回显)。
    const settings = { engineUrl: `http://127.0.0.1:${port}`, engineToken: "test-token" };
    const before = await client.config(settings);
    assert.equal(before.ok, true);
    assert.equal(before.data.config.hasMineruToken, false);
    const saved = await client.saveConfig(settings, { calibrePath: "C:/nope/ebook-convert.exe", mineruToken: "secret-token" });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.config.hasMineruToken, true, "令牌只回 has");
    assert.equal(saved.data.config.mineruToken, "", "不回显原值");
    assert.equal(saved.data.capabilities.calibre.ok, false, "路径不存在就是不可用");
    const after = await client.config(settings);
    assert.equal(after.data.config.calibrePath, "C:/nope/ebook-convert.exe");
    const disk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(disk.mineruToken, "secret-token", "配置落在引擎侧(ENGINE_CONFIG)");
    assert.ok(fs.existsSync(configFile));
  } finally {
    child.kill();
    fs.rmSync(configFile, { force: true });
  }
});
