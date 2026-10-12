import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FONT_FILES,
  FONT_PAIRINGS,
  collectChars,
  createFontSubsetter,
  ensureFont,
  findPairing,
  fontFileName,
  friendlyFontError,
} from "../src/main/workshop-fonts.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qbr-fonts-"));
}

test("the pairing table stays complete and consistent", () => {
  assert.equal(FONT_PAIRINGS.length, 12);
  for (const pairing of FONT_PAIRINGS) {
    assert.ok(pairing.id && pairing.label, "each pairing needs an id and label");
    for (const role of ["heading", "body", "latin"]) {
      assert.ok(FONT_FILES[pairing[role]], `${pairing.id}.${role} -> ${pairing[role]} must map to a file`);
    }
  }
  assert.equal(findPairing("literary").heading, "zhuque");
  assert.equal(findPairing("nope").id, FONT_PAIRINGS[0].id, "unknown ids fall back to the first pairing");
  assert.equal(fontFileName("notoserif"), "notoserif.woff2");
});

test("collectChars covers the book text plus a base set", () => {
  const chars = collectChars(["犇这个字很少见", "第二段 abc"], "");
  assert.ok(chars.includes("犇") && chars.includes("第") && chars.includes("a"));
  assert.ok(chars.includes("，") && chars.includes("。"), "punctuation is always included");
  assert.equal(new Set(chars).size, chars.length, "no duplicates");
});

test("ensureFont reuses the cache and verifies downloads", async () => {
  const cacheDir = tempDir();
  const file = path.join(cacheDir, "wenkai.woff2");
  fs.writeFileSync(file, "cached-font");
  const cached = await ensureFont("wenkai", { cacheDir, fetchImpl: () => { throw new Error("no network expected"); } });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);

  const empty = tempDir();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("font-bytes").buffer };
  };
  const downloaded = await ensureFont("zhuque", { cacheDir: empty, fetchImpl });
  assert.equal(downloaded.ok, true);
  assert.ok(fs.existsSync(downloaded.path));
  assert.equal(fs.readFileSync(downloaded.path, "utf8"), "font-bytes");
  assert.equal(calls.length, 2, "the first mirror failure falls through to the next");
  assert.match(downloaded.sha256, /^[0-9a-f]{64}$/);
});

test("ensureFont reports friendly errors when every mirror fails", async () => {
  const result = await ensureFont("wenkai", {
    cacheDir: tempDir(),
    fetchImpl: async () => { throw new Error("fetch failed: ENOTFOUND"); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /回退系统字体/);
  assert.match(friendlyFontError("ENOTFOUND"), /网络不可用/);
  assert.equal((await ensureFont("unknown-font", { cacheDir: tempDir() })).ok, false);
});

test("the subsetter runs fontTools and reports failures", async () => {
  const dir = tempDir();
  const fontPath = path.join(dir, "font.ttf");
  fs.writeFileSync(fontPath, "font");
  const out = path.join(dir, "subset.ttf");
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      fs.writeFileSync(out, "subset-bytes");
      child.emit("close", 0);
    });
    return child;
  };
  const subsetter = createFontSubsetter({ spawnImpl });
  const ok = await subsetter.subset({ python: "python", fontPath, chars: "abc犇", outPath: out, family: "QBR Test" });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(out, "utf8"), "subset-bytes");
  assert.equal(calls[0].args[1], fontPath);
  assert.match(fs.readFileSync(path.join(dir, "font-chars.txt"), "utf8"), /犇/);
  assert.match(fs.readFileSync(path.join(dir, "font-subset.py"), "utf8"), /Subsetter/);

  const failing = createFontSubsetter({
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit("data", "fontTools exploded");
        child.emit("close", 1);
      });
      return child;
    },
  });
  const failed = await failing.subset({ python: "python", fontPath, chars: "abc", outPath: path.join(dir, "none.ttf") });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /fontTools exploded/);
  assert.equal((await subsetter.subset({ python: "python", fontPath: path.join(dir, "missing.ttf"), chars: "a", outPath: out })).ok, false);
  assert.equal((await subsetter.subset({ python: "python", fontPath, chars: "", outPath: out })).ok, false);
});
