// 书坊:电子书制作向导的构建 runner(txt/md → 章节 → 字体子集 → EPUB)。
// 样式、字体搭配都来自面板;字体下载/子集失败时回退系统字体,不阻断生成。
import fs from "node:fs";
import path from "node:path";

import { buildEpub, BOOK_STYLE_DEFAULTS } from "./epub-build.js";
import { markdownToHtml, textToChapters, textToHtml } from "./text-book.js";
import { collectChars, createFontSubsetter, ensureFont, ensureFontLicense, findPairing, FONT_FAMILIES } from "./workshop-fonts.js";
import { pairingStacks } from "../shared/book-fonts.js";
import { convertPath } from "../shared/workshop-names.js";

// 组装要嵌入的字体:pairing(下载字库)或 files(本机/导入字体)。
export async function prepareFonts({
  cacheDir,
  python = "python",
  pairing = null,
  files = [],
  chars = "",
  workDir = "",
  fetchImpl = fetch,
  subsetter = null,
  log = () => {},
} = {}) {
  const selected = [];
  if (Array.isArray(files) && files.length) {
    for (const file of files) {
      const fontPath = String(file?.path || file?.file || "");
      if (!fontPath) continue;
      selected.push({ path: fontPath, family: `QBR ${String(file.family || path.basename(fontPath, path.extname(fontPath)))}`, id: "" });
    }
  } else if (pairing) {
    for (const id of [...new Set([pairing.heading, pairing.body, pairing.latin])]) {
      const ensured = await ensureFont(id, { cacheDir, fetchImpl, log });
      if (!ensured.ok) {
        log("font skipped", id, ensured.error);
        continue;
      }
      selected.push({ path: ensured.path, family: `QBR ${FONT_FAMILIES[id] || id}`, id });
    }
  }
  const fonts = [];
  for (const font of selected) {
    if (!fs.existsSync(font.path)) continue;
    let data = null;
    let fileName = `${font.family.replace(/[^\w.-]+/g, "-").toLowerCase()}.ttf`;
    const subset = subsetter
      ? await subsetter.subset({ python, fontPath: font.path, chars, outPath: path.join(workDir, fileName), family: font.family, workDir })
      : { ok: false };
    if (subset.ok) {
      data = fs.readFileSync(subset.path);
    } else {
      // 子集化不可用(没有 fontTools / 超时):直接嵌原文件,支持 woff2 的阅读器可用。
      fileName = path.basename(font.path);
      data = fs.readFileSync(font.path);
      log("font subset fallback", font.id || font.family, subset.error || "");
    }
    const licenseText = font.id ? await ensureFontLicense(font.id, { cacheDir, fetchImpl }) : "";
    fonts.push({
      fileName,
      family: font.family,
      data,
      licenseName: "SIL Open Font License 1.1",
      licenseText: licenseText || "本字体以 SIL Open Font License 1.1 授权,见 https://openfontlicense.org",
    });
  }
  return fonts;
}

// Markdown 里的第一张本地图片(AUTO 封面的候选)。
export function firstMarkdownImage(text, sourceDir) {
  const match = String(text || "").match(/!\[[^\]]*\]\(([^)\s]+)/);
  if (!match) return "";
  const raw = match[1];
  if (/^https?:/i.test(raw) || raw.startsWith("data:")) return "";
  return path.isAbsolute(raw) ? raw : path.join(sourceDir, raw.replace(/[\\/]+/g, path.sep));
}

// 封面:指定图片 / 自动首图 / 模板生成(缺图时回退模板)。
export async function resolveCover({ payload = {}, title = "", author = "", markdownText = "", sourceDir = "", pairing = null, cacheDir = "", coverRenderer = null, loadImage = null, log = () => {} } = {}) {
  const cover = payload.cover || {};
  const mode = String(cover.mode || "none");
  if (mode === "none") return null;
  const fromImage = async (imagePath) => {
    const image = loadImage ? await loadImage(imagePath) : null;
    if (!image?.data?.length) return null;
    return { data: image.data, mediaType: image.mediaType || "image/jpeg", fileName: "cover.jpg" };
  };
  if (mode === "image" && cover.imagePath) {
    const picked = await fromImage(cover.imagePath);
    if (picked) return picked;
    log("cover image missing", cover.imagePath);
  }
  if (mode === "auto") {
    const candidate = firstMarkdownImage(markdownText, sourceDir);
    if (candidate) {
      const picked = await fromImage(candidate);
      if (picked) return picked;
    }
  }
  if (!coverRenderer) return null;
  const fonts = [];
  if (pairing) {
    for (const id of [...new Set([pairing.heading, pairing.body])]) {
      const ensured = await ensureFont(id, { cacheDir, log });
      if (ensured.ok) fonts.push({ path: ensured.path, family: `QBR ${FONT_FAMILIES[id] || id}` });
    }
  }
  const stacks = pairingStacks(pairing);
  const rendered = await coverRenderer.render({
    title,
    author,
    subtitle: cover.subtitle,
    palette: cover.palette,
    fonts,
    headingFamily: stacks.heading,
    bodyFamily: stacks.body,
  });
  if (!rendered.ok) {
    log("cover render failed", rendered.error);
    return null;
  }
  return { data: rendered.data, mediaType: rendered.mediaType || "image/jpeg", fileName: "cover.jpg" };
}

export function registerEpubRunners(workshop, { vaultRoot = "", cacheRoot = "", subsetter = createFontSubsetter(), coverRenderer = null, readImage = null, log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };
  // 指定图片:优先用注入的读图器(Electron nativeImage),否则按扩展名直读。
  const loadImage = async (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    if (readImage) {
      const loaded = await readImage(filePath).catch(() => null);
      if (loaded?.data?.length) return loaded;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    return { data: fs.readFileSync(filePath), mediaType, fileName: `cover${ext || ".jpg"}` };
  };

  // txt / md → EPUB(向导的最小可用路径;后续接 Doc JSON 与封面)。
  workshop.register("book-build", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const markdown = /\.(md|markdown)$/i.test(source);
    const styles = { ...BOOK_STYLE_DEFAULTS, ...(payload?.styles || {}) };
    const title = String(payload?.title || "").trim() || path.basename(source).replace(/\.[^.]+$/, "");
    const out = payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, "epub", (candidate) => fs.existsSync(absolute(candidate))));

    report({ label: "读取内容" });
    const text = fs.readFileSync(source, "utf8");
    // 面板里编辑过的目录优先(改名/合并/拆分/排序);否则按标题自动分章。
    const provided = Array.isArray(payload?.chapters) ? payload.chapters : [];
    const chapters = provided.length
      ? provided
        .map((chapter, index) => {
          const body = String(chapter?.text || "");
          return {
            title: String(chapter?.title || `第 ${index + 1} 章`).slice(0, 120),
            text: body,
            html: markdown ? markdownToHtml(body) : textToHtml(body),
          };
        })
        .filter((chapter) => chapter.text.trim())
      : textToChapters(text, { markdown, title });
    if (!chapters.length) throw new Error("没有可写的内容");
    if (signal.aborted) throw new Error("任务已取消");
    log("book build", source, "→", out, `${chapters.length} 章`);

    report({ label: "准备字体" });
    const pairing = payload?.fonts?.pairing ? findPairing(payload.fonts.pairing) : null;
    const chars = collectChars(chapters.map((chapter) => `${chapter.title}${chapter.text}`));
    const workDir = path.join(cacheRoot, "subset", path.basename(source).replace(/[^\w.-]+/g, "_").slice(0, 40) || "book");
    fs.mkdirSync(workDir, { recursive: true });
    const fonts = payload?.fonts?.embed === false
      ? []
      : await prepareFonts({
        cacheDir: path.join(cacheRoot, "library"),
        python: String(settings.ocrPython || "").trim() || "python",
        pairing,
        files: payload?.fonts?.files,
        chars,
        workDir,
        subsetter,
        log,
      });
    if (signal.aborted) throw new Error("任务已取消");

    report({ label: "准备封面" });
    const cover = await resolveCover({
      payload,
      title,
      author: String(payload?.author || "").trim(),
      markdownText: markdown ? text : "",
      sourceDir: path.dirname(source),
      pairing,
      cacheDir: path.join(cacheRoot, "library"),
      coverRenderer,
      loadImage,
      log,
    });
    if (signal.aborted) throw new Error("任务已取消");

    report({ label: "生成 EPUB" });
    const result = await buildEpub({
      book: {
        title,
        author: String(payload?.author || "").trim(),
        language: String(payload?.language || "zh"),
        identifier: String(payload?.identifier || `urn:qbr:${Date.now().toString(36)}`),
        modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      },
      styles,
      chapters,
      fonts,
      cover,
      colophon: String(payload?.colophon || "由 UV Reader 书坊生成"),
    }, out);
    if (signal.aborted) throw new Error("任务已取消");
    return {
      output: out,
      detail: `EPUB · ${result.chapters} 章 · ${Math.round(result.bytes / 1024)} KB${fonts.length ? ` · ${fonts.length} 款字体` : ""}`,
    };
  });
}
