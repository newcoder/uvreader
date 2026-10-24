import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPdfFormService } from "../src/main/pdf-form.js";

test("pdf form output names distinguish filled and signed copies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdf-form-"));
  const source = path.join(dir, "form.pdf");
  fs.writeFileSync(source, "pdf");
  const service = createPdfFormService();
  const unsigned = service.uniqueOutput(source);
  assert.match(unsigned, /_filled\.pdf$/);
  const firstSigned = service.uniqueOutput(source, true);
  assert.match(firstSigned, /_filled_signed\.pdf$/);
  fs.writeFileSync(unsigned, "filled");
  fs.writeFileSync(firstSigned, "signed");
  assert.match(service.uniqueOutput(source), /_filled-2\.pdf$/);
  assert.match(service.uniqueOutput(source, true), /_filled_signed-2\.pdf$/);
  assert.match(service.defaultOutput({ path: "form.pdf", root: dir }), /_filled-2\.pdf$/);
  assert.match(service.defaultOutput({ path: "form.pdf", root: dir, signatures: [{ page: 1 }] }), /_filled_signed-2\.pdf$/);
  assert.equal(service.hasSignatures({ signatures: [] }), false);
  assert.equal(service.hasSignatures({ signatures: [{ page: 1 }] }), true);
});

test("a signed copy cannot overwrite the source PDF", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdf-form-"));
  const source = path.join(dir, "form.pdf");
  fs.writeFileSync(source, "pdf");
  const service = createPdfFormService();
  const result = await service.save({
    path: source,
    out: source,
    signatures: [{ page: 1, data: "data:image/png;base64,AAAA" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /签名后不能覆盖/);
});

test("pdf form python resolution prefers the installed engine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdf-form-python-"));
  const python = path.join(dir, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "");
  const service = createPdfFormService({ engineService: { status: async () => ({ dir }) } });
  assert.equal(await service.resolvePython({}), python);
});
