import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { findPairing } from "../src/main/workshop-fonts.js";
import { prepareFonts, registerEpubRunners } from "../src/main/workshop-epub.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(prefix = "qbr-epub-run-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fontBytesFetch(payload = "woff2-bytes") {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(payload).buffer, text: async () => "SIL OFL 1.1 许可文本" });
}

test("prepareFonts subsets local files and keeps the license", async () => {
  const dir = tempDir();
  const fontPath = path.join(dir, "MyFont.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    files: [{ path: fontPath, family: "My Font" }],
    chars: "甲乙丙",
    workDir: tempDir("qbr-subset-"),
    subsetter: {
      subset: async ({ outPath }) => {
        fs.writeFileSync(outPath, "subset-ttf");
        return { ok: true, path: outPath };
      },
    },
  });
  assert.equal(fonts.length, 1);
  assert.equal(fonts[0].fileName, "qbr-my-font.ttf");
  assert.equal(fonts[0].family, "QBR My Font");
  assert.equal(fonts[0].data.toString(), "subset-ttf");
  assert.match(fonts[0].licenseText, /SIL Open Font License/);
});

test("prepareFonts falls back to the original file when subsetting fails", async () => {
  const dir = tempDir();
  const fontPath = path.join(dir, "WenKai.woff2");
  fs.writeFileSync(fontPath, "full-woff2");
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    files: [{ path: fontPath, family: "WenKai" }],
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    subsetter: { subset: async () => ({ ok: false, error: "no fontTools" }) },
    log: () => {},
  });
  assert.equal(fonts[0].fileName, "WenKai.woff2", "the original file is embedded under its own name");
  assert.equal(fonts[0].data.toString(), "full-woff2");
});

test("prepareFonts downloads a pairing and skips fonts that fail", async () => {
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    pairing: findPairing("quiet"),
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    fetchImpl: fontBytesFetch(),
    subsetter: { subset: async ({ outPath }) => { fs.writeFileSync(outPath, "ttf"); return { ok: true, path: outPath }; } },
    log: () => {},
  });
  assert.equal(fonts.length, 3, "heading + body + latin");
  for (const font of fonts) assert.match(font.family, /^QBR /);
  const skipped = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    pairing: findPairing("quiet"),
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    fetchImpl: async () => { throw new Error("offline"); },
    log: () => {},
  });
  assert.deepEqual(skipped, [], "no network means no embedded fonts, not a failure");
});

function makeQueue(cacheRoot, subsetter) {
  const dir = tempDir("qbr-epub-queue-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot, subsetter, log: () => {} });
  return { queue, dir };
}

test("the book-build runner turns a txt into a readable EPUB", async () => {
  const vault = tempDir("qbr-epub-vault-");
  const source = path.join(vault, "我的小说.txt");
  fs.writeFileSync(source, "第一章 起风了\n\n第一段正文。\n\n第二章 雨\n\n第二段正文。", "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-cache-"), null);
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, styles: { theme: "warm", fontSize: 18 } },
  });
  await sleep(80);
  const task = queue.snapshot().tasks.find((entry) => entry.id === id);
  assert.equal(task.status, "done");
  const out = path.join(vault, "我的小说.epub");
  assert.equal(task.output.replace(/\\/g, "/"), out.replace(/\\/g, "/"));
  assert.ok(fs.existsSync(task.output));
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title>我的小说<\/dc:title>/);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /第一章 起风了/);
  const css = await zip.file("OEBPS/styles.css").async("string");
  assert.match(css, /background: #faf6ef/, "the warm theme reached the stylesheet");
  assert.match(task.detail, /EPUB · 2 章/);
});

test("the book-build runner embeds subsetted fonts", async () => {
  const vault = tempDir("qbr-epub-vault2-");
  const source = path.join(vault, "有字体.md");
  fs.writeFileSync(source, "# 第一章\n\n正文 犇。", "utf8");
  const fontPath = path.join(vault, "Font.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const { queue } = makeQueue(tempDir("qbr-epub-cache2-"), {
    subset: async ({ outPath, chars }) => {
      fs.writeFileSync(outPath, `subset:${chars.includes("犇") ? "has-" : ""}chars`);
      return { ok: true, path: outPath };
    },
  });
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, fonts: { files: [{ path: fontPath, family: "Test Font" }] } },
  });
  await sleep(80);
  const task = queue.snapshot().tasks.find((entry) => entry.id === id);
  assert.equal(task.status, "done");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /media-type="font\/ttf"/);
  const fontFiles = Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/") && name.endsWith(".ttf"));
  assert.equal(fontFiles.length, 1);
  assert.match(await zip.file(fontFiles[0]).async("string"), /has-chars/);
  assert.match(task.detail, /1 款字体/);
});
