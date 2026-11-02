import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { engineArchiveInfo, findBundledEngineArchive } from "../src/main/engine-bundle.js";

test("engine archive names expose the version and platform", () => {
  assert.deepEqual(engineArchiveInfo("uvreader-engine-0.1.11-win32-x64.zip"), {
    version: "0.1.11",
    platform: "win32-x64",
    archivePath: "uvreader-engine-0.1.11-win32-x64.zip",
  });
  assert.equal(engineArchiveInfo("uvreader-engine-0.1.11-win32-x64.zip.sha256"), null);
  assert.equal(engineArchiveInfo("something-else.zip"), null);
});

test("the Store bundle picks the newest archive for this platform", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-bundle-"));
  const engineDir = path.join(root, "engine");
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, "uvreader-engine-0.1.9-win32-x64.zip"), "old");
  fs.writeFileSync(path.join(engineDir, "uvreader-engine-0.1.11-win32-x64.zip"), "new");
  fs.writeFileSync(path.join(engineDir, "uvreader-engine-0.1.20-darwin-arm64.tar.gz"), "other");
  fs.writeFileSync(path.join(engineDir, "uvreader-engine-0.1.11-win32-x64.zip.sha256"), "hash");

  assert.equal(
    path.basename(findBundledEngineArchive(root, "win32", "x64")),
    "uvreader-engine-0.1.11-win32-x64.zip",
  );
  assert.equal(findBundledEngineArchive(path.join(root, "missing"), "win32", "x64"), "");
});
