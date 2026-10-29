import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COVER_PALETTES, COVER_SIZE, coverHtml, createCoverRenderer, normalizeCoverOptions } from "../src/main/cover-render.js";
import { firstMarkdownImage, resolveCover } from "../src/main/workshop-epub.js";

test("normalizeCoverOptions clamps and defaults", () => {
  assert.equal(Object.keys(COVER_PALETTES).length, 4, "four cover palettes ship with the template");
  assert.ok(COVER_PALETTES.celadon.label);
  const cover = normalizeCoverOptions({ title: "书".repeat(80), palette: "nope", quality: 200 });
  assert.equal(cover.title.length, 60);
  assert.equal(cover.palette, "warm");
  assert.equal(cover.quality, 95);
  assert.equal(normalizeCoverOptions({}).title, "未命名");
});

test("coverHtml lays out a 1600x2400 template with the palette and fonts", () => {
  const html = coverHtml({
    title: "萤窗小语",
    author: "向阳乔木",
    subtitle: "散文集",
    palette: "celadon",
    headingFamily: "'QBR Wenkai', serif",
    bodyFamily: "'QBR Noto', serif",
  }, { fonts: [{ family: "QBR Wenkai", data: "AAAA" }] });
  assert.match(html, new RegExp(`width: ${COVER_SIZE.width}px; height: ${COVER_SIZE.height}px`));
  assert.match(html, /background: #eef3ee/);
  assert.match(html, /<h1>萤窗小语<\/h1>/);
  assert.match(html, /<div class="subtitle">散文集<\/div>/);
  assert.match(html, /<div class="author">向阳乔木<\/div>/);
  assert.match(html, /@font-face \{ font-family: 'QBR Wenkai'; src: url\(data:font\/woff2;base64,AAAA\)/);
  assert.match(html, /font-family: 'QBR Wenkai', serif/);
  const withFile = coverHtml({ title: "书" }, { fonts: [{ family: "QBR Wenkai", file: "font-0.woff2" }] });
  assert.match(withFile, /src: url\('font-0\.woff2'\)/, "large fonts travel as files next to the html");
  const long = coverHtml({ title: "标".repeat(30) });
  assert.match(long, /font-size: 150px/, "longer titles shrink");
  const escaped = coverHtml({ title: `<img onerror="x">` });
  assert.match(escaped, /&lt;img onerror=&quot;x&quot;&gt;/);
});

test("the cover renderer drives an offscreen window and returns JPEG bytes", async () => {
  const calls = { loaded: [], destroyed: 0, captured: 0 };
  const fontDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-cover-font-"));
  const fontPath = path.join(fontDir, "Wenkai.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const renderer = createCoverRenderer({
    settleMs: 1,
    tempRoot: fontDir,
    createWindow: (options) => {
      assert.equal(options.show, false);
      assert.ok(options.width <= 1600 && options.height <= 900, "the window is created small so Windows cannot clamp it");
      return {
        setContentSize: (w, h) => { calls.contentSize = [w, h]; },
        loadURL: async (url) => {
          calls.loaded.push(url);
          const htmlPath = fileURLToPath(url);
          calls.html = fs.readFileSync(htmlPath, "utf8");
          calls.font = fs.readFileSync(path.join(path.dirname(htmlPath), "font-0.woff2"), "utf8");
        },
        webContents: {
          executeJavaScript: async () => true,
          capturePage: async () => { calls.captured += 1; return { toJPEG: () => Buffer.from("jpeg-bytes") }; },
        },
        destroy: () => { calls.destroyed += 1; },
      };
    },
  });
  const result = await renderer.render({ title: "书", palette: "ink", fonts: [{ path: fontPath, family: "QBR Wenkai" }] });
  assert.equal(result.ok, true);
  assert.equal(result.mediaType, "image/jpeg");
  assert.equal(result.data.toString(), "jpeg-bytes");
  assert.equal(calls.loaded.length, 1);
  assert.match(calls.loaded[0], /^file:\/\/.*cover\.html$/, "the html is loaded from a temp file");
  assert.equal(calls.font, "font-bytes", "the cover font is written next to the html");
  assert.match(calls.html, /@font-face \{ font-family: 'QBR Wenkai'; src: url\('font-0\.woff2'\)/);
  assert.equal(calls.destroyed, 1);
  assert.deepEqual(calls.contentSize, [COVER_SIZE.width, COVER_SIZE.height], "the window grows to the full cover size");
  assert.ok(!fs.existsSync(fileURLToPath(calls.loaded[0])), "the temp cover html is cleaned up");

  const failing = createCoverRenderer({
    settleMs: 1,
    createWindow: () => ({
      loadURL: async () => { throw new Error("no window"); },
      webContents: { executeJavaScript: async () => true, capturePage: async () => ({ toJPEG: () => Buffer.alloc(0) }) },
      destroy: () => {},
    }),
  });
  const failed = await failing.render({ title: "书" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /no window/);
  assert.equal((await createCoverRenderer({}).render({})).ok, false);
});

test("markdown auto covers use the first local image", () => {
  assert.equal(
    firstMarkdownImage("正文 ![图](images/a.jpg) 后面", "D:/vault/Books").replace(/\\/g, "/"),
    "D:/vault/Books/images/a.jpg",
  );
  assert.equal(firstMarkdownImage("![远程](https://x/a.jpg)", "D:/vault"), "");
  assert.equal(firstMarkdownImage("没有图片", "D:/vault"), "");
});

test("resolveCover picks image, auto and template sources", async () => {
  const loadImage = async (file) => ({ data: Buffer.from(`img:${file}`), mediaType: "image/jpeg" });
  const image = await resolveCover({ payload: { cover: { mode: "image", imagePath: "D:/covers/a.png", fit: "cover" } }, loadImage });
  assert.equal(image.data.toString(), "img:D:/covers/a.png");
  assert.equal(image.mediaType, "image/jpeg");
  assert.equal(image.fit, "cover");

  const auto = await resolveCover({
    payload: { cover: { mode: "auto" } },
    markdownText: "![首图](figs/one.png)",
    sourceDir: "D:/vault/Books",
    loadImage,
  });
  assert.match(auto.data.toString(), /one\.png$/);
  assert.equal(auto.fit, "contain");

  const rendered = [];
  const template = await resolveCover({
    payload: { cover: { mode: "template", palette: "paper", subtitle: "副" } },
    title: "书名",
    author: "作者",
    coverRenderer: { render: async (options) => { rendered.push(options); return { ok: true, data: Buffer.from("cover"), mediaType: "image/jpeg" }; } },
  });
  assert.equal(template.data.toString(), "cover");
  assert.equal(rendered[0].title, "书名");
  assert.equal(rendered[0].palette, "paper");

  assert.equal(await resolveCover({ payload: { cover: { mode: "none" } } }), null);
  assert.equal(await resolveCover({ payload: { cover: { mode: "image", imagePath: "D:/missing.png" } }, loadImage: async () => null }), null);
  assert.equal(await resolveCover({ payload: { cover: { mode: "template" } }, coverRenderer: { render: async () => ({ ok: false, error: "boom" }) } }), null);
});
