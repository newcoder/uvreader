// 书坊:电子书制作向导的构建 runner(txt/md → 章节 → 字体子集 → EPUB)。
// 样式、字体搭配都来自面板;字体下载/子集失败时回退系统字体,不阻断生成。
import fs from "node:fs";
import path from "node:path";

import { buildEpub, BOOK_STYLE_DEFAULTS } from "./epub-build.js";
import { textToChapters } from "./text-book.js";
import { collectChars, createFontSubsetter, ensureFont, ensureFontLicense, findPairing, FONT_FAMILIES } from "./workshop-fonts.js";
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

export function registerEpubRunners(workshop, { vaultRoot = "", cacheRoot = "", subsetter = createFontSubsetter(), log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
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
    const chapters = textToChapters(text, { markdown, title });
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
      colophon: String(payload?.colophon || "由 UV Reader 书坊生成"),
    }, out);
    if (signal.aborted) throw new Error("任务已取消");
    return {
      output: out,
      detail: `EPUB · ${result.chapters} 章 · ${Math.round(result.bytes / 1024)} KB${fonts.length ? ` · ${fonts.length} 款字体` : ""}`,
    };
  });
}
