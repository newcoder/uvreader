import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPdfOcr, ocrCommand, resolveOcrOutput } from "../src/main/pdf-ocr.js";

// A fake sidecar process: the test reroutes the configured command to Node so
// the real line protocol is exercised without Python.
function fakeSpawn(script) {
  return (_command, _args, options) => spawn(process.execPath, [script], options);
}

function writeSidecar(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qbr-ocr-${name}-`));
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(script, body);
  return script;
}

const PROTOCOL = `
const fs = await import("node:fs");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === "ping") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, name: "fake-reader" } }) + "\\n");
      continue;
    }
    if (req.method === "ocr.page") {
      const content = {
        items: [{ str: "OCR-" + req.params.page, dir: "ltr", width: 10, height: 10,
                  transform: [10, 0, 0, 10, 5, 5], fontName: "ocr", hasEOL: true }],
        styles: { ocr: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
        lang: null,
      };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id,
        result: { page: req.params.page, dpi: 200, source: "ocr", has_text: true,
                  lines: [["OCR-" + req.params.page, [[5, 5], [15, 5], [15, 15], [5, 15]], 0.9]],
                  content } }) + "\\n");
      continue;
    }
    if (req.method === "convert.start") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { job: "j1" } }) + "\\n");
      SIDECAR_BEHAVIOUR
    }
  }
});
`;

const OK_SIDECAR = PROTOCOL.replace("SIDECAR_BEHAVIOUR", `
      let done = 0;
      const timer = setInterval(() => {
        done += 1;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "convert.progress", params: { job: "j1", done, total: 3, page: done } }) + "\\n");
        if (done >= 3) {
          clearInterval(timer);
          fs.writeFileSync(req.params.out, "%PDF-1.4 fake searchable\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "convert.done", params: { job: "j1", cancelled: false, error: null, stats: { pages: 3, lines_inserted: 9 } } }) + "\\n");
        }
      }, 5);
`);

const FAIL_SIDECAR = PROTOCOL.replace("SIDECAR_BEHAVIOUR", `
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "convert.done", params: { job: "j1", cancelled: false, error: "RuntimeError: boom", stats: null } }) + "\\n");
`);

const CRASH_SIDECAR = PROTOCOL.replace("SIDECAR_BEHAVIOUR", `
      process.stderr.write("[ocr-layer] det failed\\n");
      process.exit(3);
`);

const HANG_SIDECAR = PROTOCOL.replace("SIDECAR_BEHAVIOUR", `
      setInterval(() => {}, 1000);
`);

// Never answers anything, not even ping.
const SILENT_SIDECAR = `setInterval(() => {}, 1000);`;

// The command must resolve (the real spawn is replaced), so point the settings
// at a file that exists.
function settingsFor() {
  const exe = path.join(os.tmpdir(), "qbr-ocr-dummy.exe");
  fs.writeFileSync(exe, "");
  return { ocrSidecarExe: exe };
}

function fakeSource() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ocr-src-")), "scan.pdf");
  fs.writeFileSync(file, "%PDF-1.4 scan\n");
  return file;
}

test("ocrCommand resolves an exe, a pdf_tool checkout, or reports what is missing", () => {
  assert.match(ocrCommand({}).error, /pdf_tool/);
  assert.match(ocrCommand({ ocrSidecarDir: path.join(os.tmpdir(), "does-not-exist") }).error, /没有 pdf_tool/);
  assert.match(ocrCommand({ ocrSidecarExe: path.join(os.tmpdir(), "missing.exe") }).error, /找不到 OCR 程序/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ocr-cmd-"));
  fs.mkdirSync(path.join(root, "pdf_tool", "reader"), { recursive: true });
  fs.writeFileSync(path.join(root, "pdf_tool", "reader", "server.py"), "");
  const resolved = ocrCommand({ ocrSidecarDir: root });
  assert.equal(resolved.command, "python");
  assert.deepEqual(resolved.args, ["-m", "pdf_tool.reader"]);
  assert.equal(resolved.cwd, root);

  const exe = path.join(root, "pdf_tool_reader.exe");
  fs.writeFileSync(exe, "");
  assert.deepEqual(ocrCommand({ ocrSidecarExe: exe }).command, exe);
});

test("resolveOcrOutput keeps generated files inside the vault", () => {
  const vault = path.join(os.tmpdir(), "qbr-vault");
  assert.equal(resolveOcrOutput(vault, path.join(vault, "a", "b.pdf")), path.join(vault, "a", "b.pdf"));
  assert.throws(() => resolveOcrOutput(vault, path.join(os.tmpdir(), "outside.pdf")), /书库目录内/);
});

test("probe reports the sidecar handshake", async () => {
  const ocr = createPdfOcr({ spawnImpl: fakeSpawn(writeSidecar("ok", OK_SIDECAR)) });
  const result = await ocr.probe(settingsFor(), 3000);
  assert.equal(result.ok, true);
  assert.equal(result.detail, "fake-reader");
});

test("probe reports a timeout when the sidecar never answers", async () => {
  const ocr = createPdfOcr({ spawnImpl: fakeSpawn(writeSidecar("silent", SILENT_SIDECAR)) });
  const result = await ocr.probe(settingsFor(), 150);
  assert.equal(result.ok, false);
  assert.match(result.detail, /超时/);
});

test("an export job streams progress and finishes with the output file", async () => {
  const script = writeSidecar("ok", OK_SIDECAR);
  const ocr = createPdfOcr({ spawnImpl: fakeSpawn(script) });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ocr-out-")), "book.searchable.pdf");
  const progress = [];
  const done = await new Promise((resolve) => {
    ocr.start(settingsFor(), { jobId: "job-1", source: fakeSource(), out }, {
      onProgress: (value) => progress.push(value),
      onDone: resolve,
    });
  });
  assert.deepEqual(progress.map((p) => [p.done, p.total]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(done.ok, true);
  assert.equal(done.out, out);
  assert.equal(fs.existsSync(out), true);
  assert.equal(ocr.jobs.size, 0, "the job cleans up after itself");
});

test("a sidecar error and a crash both surface as a failed job", async () => {
  for (const [name, script] of [["fail", FAIL_SIDECAR], ["crash", CRASH_SIDECAR]]) {
    const ocr = createPdfOcr({ spawnImpl: fakeSpawn(writeSidecar(name, script)) });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ocr-out-")), "x.pdf");
    const done = await new Promise((resolve) => {
      ocr.start(settingsFor(), { jobId: `job-${name}`, source: fakeSource(), out }, { onDone: resolve });
    });
    assert.equal(done.ok, false, name);
    assert.equal(fs.existsSync(out), false, name);
    if (name === "fail") assert.match(done.error, /boom/);
    else assert.match(done.error, /退出（代码 3/);
  }
});

test("a reading session fetches pages lazily and closes cleanly", async () => {
  const script = writeSidecar("ok", OK_SIDECAR);
  const ocr = createPdfOcr({ spawnImpl: fakeSpawn(script) });
  const { sessionId } = ocr.openSession(settingsFor(), fakeSource());
  assert.equal(typeof sessionId, "string");
  const first = await ocr.page(sessionId, 3);
  assert.equal(first.page, 3);
  assert.equal(first.hasText, true);
  assert.equal(first.content.items[0].str, "OCR-3");
  assert.equal(ocr.sessions.size, 1);
  assert.equal(ocr.closeSession(sessionId), true);
  assert.equal(ocr.sessions.size, 0);
  await assert.rejects(() => ocr.page(sessionId, 1), /会话不存在/);
});

test("cancel kills a hanging job without reporting done", async () => {
  const ocr = createPdfOcr({ spawnImpl: fakeSpawn(writeSidecar("hang", HANG_SIDECAR)) });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbr-ocr-out-")), "x.pdf");
  let doneCalled = false;
  ocr.start(settingsFor(), { jobId: "job-cancel", source: fakeSource(), out }, {
    onDone: () => { doneCalled = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ocr.cancel("job-cancel"), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(doneCalled, false);
  assert.equal(ocr.jobs.size, 0);
  assert.equal(ocr.cancel("job-cancel"), false);
});
