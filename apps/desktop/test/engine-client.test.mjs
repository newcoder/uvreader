import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ENGINE_URL, createEngineClient, describeEngineHealth, normalizeEngineUrl } from "../src/main/engine-client.js";

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
  assert.equal(describeEngineHealth({ engineVersion: "0.1.0", capabilities: { pdfTool: true, docvortex: true, jobKinds: ["a", "b"] } }), "引擎 0.1.0 · pdf_tool / DocVortex · 2 类作业");
  assert.equal(describeEngineHealth({}), "引擎 未知版本");
});

test("the client reads /v1/health and sends the token", async () => {
  const seen = [];
  const { server, url } = await startServer((req, res) => {
    seen.push({ url: req.url, token: req.headers.authorization || "" });
    if (req.url === "/v1/health") {
      json(res, 200, { ok: true, engineVersion: "0.1.0", capabilities: { pdfTool: true, jobKinds: ["text-layer"] } });
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

test("a missing engine is reported instead of thrown", async () => {
  const client = createEngineClient({ timeoutMs: 1500 });
  // 127.0.0.1:1 基本不会有人监听;连不上要变成 { ok:false }。
  const health = await client.health({ engineUrl: "http://127.0.0.1:1" });
  assert.equal(health.ok, false);
  assert.ok(health.error, "带上可读原因");
});

// 真跑一次引擎(需要 python + fastapi/uvicorn/latex2mathml):没有就跳过,CI 不受影响。
test("the real engine answers /v1/health and /v1/math", async (t) => {
  const probe = spawnSync("python", ["-c", "import fastapi, uvicorn, latex2mathml"], { cwd: repoRoot, timeout: 30_000 });
  if (probe.status !== 0) {
    t.skip("python 里没有 fastapi / uvicorn / latex2mathml");
    return;
  }
  const port = 8700 + Math.floor(Math.random() * 200);
  const engineRoot = path.join(repoRoot, "engine");
  const child = spawn("python", ["-m", "engine", "serve", "--port", String(port), "--token", "test-token"], {
    cwd: engineRoot,
    env: { ...process.env, PYTHONPATH: engineRoot },
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
  } finally {
    child.kill();
  }
});
