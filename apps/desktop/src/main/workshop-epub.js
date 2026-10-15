// 书坊:电子书制作向导的构建 runner(txt/md → 章节 → 字体子集 → EPUB)。
// 样式、字体搭配都来自面板;字体下载/子集失败时回退系统字体,不阻断生成。
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { buildEpub, BOOK_STYLE_DEFAULTS, collectBookImages } from "./epub-build.js";
import { collectMathFromMarkdown, countRawFormulas, markdownToHtml, textToChapters, textToHtml } from "./text-book.js";
import { extractMarkdown, extractionKind, splitMarkdownChapters } from "./extract-doc.js";
import { createMathRenderer, shareFormulaHtml } from "./math-render.js";
import { createTextLayerReader } from "./text-layer.js";
import { cleanChapterTitle, joinInlineFragment, looksLikeHeadingTitle, unwrapProseFences } from "../shared/markdown-fix.js";
import { buildNavPlan, chapterKey, chapterStartPages, fillPageGaps, isPrintedTocChapter, lastPrintedPageOf, normalizeNavLevels, parsePrintedTocEntries, printedPageOf, stripPageMarkers, stripPrintedToc, tocKey } from "../shared/printed-toc.js";
import { outlineToTocEntries } from "./pdf-outline.js";
import { collectChars, createFontSubsetter, ensureFont, ensureFontLicense, findPairing, FONT_FAMILIES } from "./workshop-fonts.js";
import { pairingStacks } from "../shared/book-fonts.js";
import { convertPath } from "../shared/workshop-names.js";

// 公式表的键:同一道公式在中间稿里有多种写法(MinerU 的 `s _ {o} = f` 与文字层
// 合并后的 `s_o=f`;`\tag{…}` 有时还会是被截断的 `\tag{5.16`),而渲染时编号本来就
// 会被去掉。键统一成「去掉 \tag + 忽略全部空白」,两侧用同一套(实测《光学》有
// 2542 条跨行公式、上千条两种写法,不归一会成片回退成原始 LaTeX)。
export const mathKey = (latex) => String(latex || "")
  .replace(/\\tag\{[^}]*\}?/g, "")
  .replace(/\s+/g, "");

export function normalizeMathMap(map) {
  const normalized = new Map();
  for (const [latex, mathml] of Object.entries(map || {})) {
    const key = mathKey(latex);
    if (key && !normalized.has(key)) normalized.set(key, mathml);
  }
  return normalized;
}

// 章节的「正文量」:去掉页锚点注释、图片、Markdown 标记后的字数。
function bodyChars(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#*`>|\s]/g, "").length;
}

// 版次/出版信息这类封面碎片(如「(第五版)」「第 2 版」「版权所有」):书首才有,别的地方别碰。
const FRONT_MATTER_TITLE = /^[（(][^）)]{1,12}[）)]$|第\s*\d+\s*版|版次|印刷|出版|ISBN|定价|版权|开本|字数|书号/i;

// 章节标题去噪 + 去掉「页眉/扉页」造成的重复短章:
//   - 标题清成纯文本(脚注标记 $^{①}$ 之类不进导航);
//   - 标题重复且正文很短(扉页/页眉/版权页)→ 丢掉;标题等于书名的也丢(书名页);
//   - 标题重复但正文够长 → 保留(真章节同名是可能的)。
export function normalizeBookChapters(chapters, bookTitle = "", { keepKeys = null } = {}) {
  const book = cleanChapterTitle(bookTitle).replace(/\s+/g, "").toLowerCase();
  const list = Array.isArray(chapters) ? chapters : [];
  const clean = list.map((chapter) => ({ chapter, title: cleanChapterTitle(chapter?.title || "") }));
  // 同名章节里「又有短页又有长章」的:短的那页是扉页/重复标题页,丢掉。
  const lengths = new Map();
  for (const { title, chapter } of clean) {
    const key = title.replace(/\s+/g, "").toLowerCase();
    if (!key) continue;
    const list = lengths.get(key) || [];
    list.push(String(chapter?.text || "").length);
    lengths.set(key, list);
  }
  const out = [];
  let dropped = 0;
  let frontMatter = 0;
  let index = 0;
  for (const { chapter, title } of clean) {
    const key = title.replace(/\s+/g, "").toLowerCase();
    const text = String(chapter?.text || "");
    const group = key ? lengths.get(key) || [] : [];
    const titlePage = key && group.length > 1 && text.trim().length < 200 && group.some((length) => length >= 200);
    // 封面/版次这类碎片:书首前 3 章里、标题看着像版次/出版信息、且正文几乎没内容(如「(第五版)」)。
    const junkFront = index < 3 && FRONT_MATTER_TITLE.test(title) && bodyChars(text) < 60;
    // 目录(大纲/目录页)认领过的章节一律保留 —— 否则「第13章」这类章节会被过滤掉,
    // 目录条目跟着变成「丢弃」(用户实测的缺章就是这么来的)。
    const claimed = keepKeys && key ? keepKeys.has(key) : false;
    if (!claimed && (titlePage || (book && key === book) || junkFront)) {
      dropped += 1;
      if (junkFront) frontMatter += 1;
      index += 1;
      continue;
    }
    // 半句碎片当标题(旧缓存/面板里可能还留着):标题文字接回上一章末尾,正文另起一段。
    if (title && !looksLikeHeadingTitle(title) && out.length) {
      const previous = out[out.length - 1];
      previous.text = `${joinInlineFragment(previous.text, title)}\n\n${text}`.trim();
      dropped += 1;
      index += 1;
      continue;
    }
    out.push({ ...chapter, title });
    index += 1;
  }
  // 全掉光就还原(宁可留着难看,也不能出空书)。
  if (!out.length) return { chapters: list, dropped: 0, frontMatter: 0 };
  return { chapters: out, dropped, frontMatter };
}

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
// 没有可用目录(无大纲,或大纲只是页码标尺)时用正文标题当导航:mardown 的标题层级
// (h1/h2)就是导航层级。大纲里的顶层条目(作品名)当锚点:正文有同名标题就把它提为 1 级;
// 没有(如第二部作品名只在书签里)就按页码的**相对位置**插到对应章节 —— 页码顺序是对的,
// 相对位置可以信(用户口径)。《安妮·卡森诗选》正是这种:书签是页码标尺,正文标题才是目录。
export function chaptersToNavItems(chapters, { anchors = [], pages = [] } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  const items = [];
  list.forEach((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    if (!title) return;
    items.push({ title, chapterIndex: index, level: Math.min(3, Math.max(1, Number(chapter?.level) || 1)) });
  });
  const known = (Array.isArray(pages) ? pages : []).filter((value) => value > 0);
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const label = String(anchor?.label || "").trim();
    if (!label) continue;
    const key = tocKey(label);
    const hit = items.find((item) => chapterKey(item.title) === key);
    if (hit) {
      hit.level = 1;
      continue;
    }
    const page = Number(anchor?.page) || 0;
    if (!(page > 0) || known.length < 4 || !list.length) continue;
    const ratio = known[known.length - 1] > known[0] ? (page - known[0]) / (known[known.length - 1] - known[0]) : 1;
    const index = Math.min(list.length - 1, Math.max(0, Math.round(ratio * (list.length - 1))));
    items.push({ title: label, chapterIndex: index, level: 1 });
  }
  return items
    .sort((a, b) => a.chapterIndex - b.chapterIndex || a.level - b.level)
    .map((item) => ({
      title: item.title,
      file: `chapter-${String(item.chapterIndex + 1).padStart(3, "0")}.xhtml`,
      level: item.level,
    }));
}

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

export function registerEpubRunners(workshop, { vaultRoot = "", cacheRoot = "", subsetter = createFontSubsetter(), coverRenderer = null, readImage = null, docvortex = null, mathRenderer = createMathRenderer(), textLayer = createTextLayerReader(), outlineReader = null, spawnImpl = spawn, log = (...args) => console.log(...args) } = {}) {
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
    const isText = /\.(txt|md|markdown)$/i.test(source);
    // 面板里编辑过的目录优先(改名/合并/拆分/排序);文本源按标题自动分章;
    // PDF / Office / OFD / 图片先内部提取(中间产物放缓存目录,用户无感)。
    const provided = Array.isArray(payload?.chapters) ? payload.chapters : [];
    // 工作目录按源文件稳定(路径 + 大小 + 修改时间):MinerU 的解析结果可以复用,
    // 重跑 / 换样式不会重新等云端解析。
    const sourceStat = fs.statSync(source);
    const workKey = crypto.createHash("sha1").update(`${source}\n${sourceStat.size}\n${sourceStat.mtimeMs}`).digest("hex").slice(0, 8);
    const workRoot = path.join(cacheRoot, "work", `${path.basename(source).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${workKey}`);
    let text = "";
    let baseDir = path.dirname(source);
    // 上游(pdf_tool)给的目录条目:有就优先用(比从 md 文本兜底解析准)。
    let upstreamToc = [];
    let rawChapters;
    if (provided.length) {
      rawChapters = provided
        .map((chapter, index) => ({
          title: String(chapter?.title || `第 ${index + 1} 章`).slice(0, 120),
          text: String(chapter?.text || ""),
          markdown: Boolean(markdown),
        }))
        .filter((chapter) => chapter.text.trim());
    } else if (isText) {
      text = fs.readFileSync(source, "utf8");
      // 提取工具写出的 .md 里可能有「假代码块」(正文被包进围栏),先还原成段落。
      if (markdown) text = unwrapProseFences(text);
      // Markdown 有标题层级时按标题分章(与 PDF/Office 提取路径一致),否则按章节行 / 长度分。
      const found = markdown ? splitMarkdownChapters(text, { bookTitle: title }) : [];
      rawChapters = (found.length >= 2
        ? found.map((chapter, index) => ({ title: chapter.title || `第 ${index + 1} 章`, text: chapter.text }))
        : textToChapters(text, { markdown, title }).map((chapter) => ({ title: chapter.title, text: chapter.text })))
        .map((chapter) => ({ ...chapter, markdown: Boolean(markdown) }));
    } else {
      report({ label: "提取内容" });
      const extracted = await extractMarkdown(source, {
        kind: extractionKind(source),
        settings,
        docvortex,
        workDir: path.join(workRoot, "extract"),
        signal,
        log,
        spawnImpl,
        textLayer,
        // 勾了「忽略缓存重新提取」就重跑上游(MinerU),否则复用缓存。
        refresh: payload?.refresh === true,
      });
      if (signal.aborted) throw new Error("任务已取消");
      if (!extracted.ok) throw new Error(String(extracted.error || "内容提取失败"));
      text = extracted.markdown;
      upstreamToc = Array.isArray(extracted.tocEntries) ? extracted.tocEntries : [];
      baseDir = path.dirname(extracted.path || source);
      const found = splitMarkdownChapters(text, { bookTitle: title });
      rawChapters = (found.length
        ? found.map((chapter, index) => ({ title: chapter.title || `第 ${index + 1} 章`, text: chapter.text }))
        : textToChapters(text, { markdown: true, title }).map((chapter) => ({ title: chapter.title, text: chapter.text })))
        .map((chapter) => ({ ...chapter, markdown: true }));
    }
    if (!rawChapters.length) throw new Error("没有可写的内容");

    // 目录优先级第一步:**PDF 自带大纲**(作者给的三级结构)。先读它,好让后面的章节过滤
    // 不至于误删「目录认领过的章节」(用户实测的缺章就是这么来的)。
    // 有的书(如《安妮·卡森诗选》)的 PDF 书签只是「每 20 页一个」的**页码标尺**,
    // 标题就是 001/020/…:那不是目录,过滤掉并改用正文标题(否则导航是一串数字)。
    let outlineEntries = [];
    let outlineIsPageRuler = false;
    if (outlineReader && /\.pdf$/i.test(String(source))) {
      const outline = await outlineReader.read(source, {
        python: String(settings.ocrPython || "").trim() || "python",
        workDir: path.join(workRoot, "outline"),
        signal,
      });
      if (outline.ok) {
        const stripped = stripPageMarkers(outlineToTocEntries(outline.outline));
        outlineEntries = stripped.entries;
        outlineIsPageRuler = stripped.ruler;
        if (stripped.dropped) log("book build outline page markers dropped", stripped.dropped, "条", stripped.ruler ? "(整份大纲是页码标尺)" : "");
      } else {
        log("book build pdf outline skipped", outline.error);
      }
      if (signal.aborted) throw new Error("任务已取消");
    }
    // 大纲只剩两三条(或本来就是页码标尺)时,它撑不起导航 —— 留着当「顶层锚点」,
    // 让正文标题来当目录(作品名 → 各节)。
    const outlineAnchors = outlineEntries.length >= 2 && outlineEntries.length <= 8 ? outlineEntries : [];
    if (outlineIsPageRuler || outlineEntries.length < 4) outlineEntries = [];

    // 标题去噪 + 去掉页眉/扉页重复短章(提供的章节也照办:面板传过来的标题可能带
    // 脚注标记 $^{①}$,导航里就会看到这些符号)。
    const normalized = normalizeBookChapters(rawChapters, title, { keepKeys: new Set(outlineEntries.map((entry) => entry.key)) });
    const tocStrip = stripPrintedToc(normalized.chapters, { enabled: payload?.dropPrintedToc !== false });
    const bookChapters = tocStrip.chapters;
    if (tocStrip.dropped || tocStrip.removedLines) {
      log("book build printed toc dropped", tocStrip.dropped, "章", tocStrip.removedLines, "行");
    }
    if (normalized.dropped) log("book build repeated headers dropped", normalized.dropped, "章");
    if (normalized.frontMatter) log("book build cover fragments dropped", normalized.frontMatter, "章");

    // 公式(LaTeX → MathML)与图片(收进 EPUB):预览与成品都靠这两步。
    // 公式清单必须与下面 markdownToHtml 的请求完全一致:用同一个渲染器、按同样的
    // 「逐章」粒度收集(合并成一段收集会多出跨章边界的串,反而对不上)。
    const markdownChapters = bookChapters.filter((chapter) => chapter.markdown);
    const latexes = [...new Set(markdownChapters.flatMap((chapter) => collectMathFromMarkdown(chapter.text)))];
    let mathMap = null;
    if (latexes.length && mathRenderer) {
      report({ label: `渲染公式（${latexes.length}）` });
      const rendered = await mathRenderer.renderMap(latexes, {
        python: String(settings.ocrPython || "").trim() || "python",
        workDir: path.join(workRoot, "math"),
      });
      if (rendered.ok) mathMap = normalizeMathMap(rendered.map);
      else log("math render skipped", rendered.error);
      if (signal.aborted) throw new Error("任务已取消");
    }
    const renderMath = mathMap ? (latex, display) => shareFormulaHtml(mathMap.get(mathKey(latex)), display) : null;
    // 导航来源优先级已在上文定好:**PDF 自带大纲** > 上游 OCR 目录条目 > md 里的印刷目录 > 标题分章。
    const tocText = normalized.chapters.filter((chapter) => isPrintedTocChapter(chapter)).map((chapter) => chapter.text).join("\n");
    const tocSource = outlineEntries.length ? "outline" : upstreamToc.length ? "upstream" : tocText ? "printed" : "";
    let navItems = null;
    let navSource = "";
    let navDropped = 0;
    if (tocSource) {
      const entries = tocSource === "outline" ? outlineEntries : tocSource === "upstream" ? upstreamToc : parsePrintedTocEntries(tocText);
      const usingPdfPages = tocSource === "outline";
      // 章首页码 = 上一章最后一个页锚点(标题常在本页中间,取本章第一个锚点会差 1~3 页;
      // 上一步删掉的印刷目录章也要参与计算,否则跨过它的几页会算错),再按删除情况对齐回章节表。
      const startPages = chapterStartPages(normalized.chapters, usingPdfPages ? {} : { of: printedPageOf, lastOf: lastPrintedPageOf })
        .filter((_page, index) => tocStrip.keptIndexes.has(index));
      // 页锚点有缺口时按相邻锚点插值(大纲页码精确,缺一格就少一条导航)。
      const pages = usingPdfPages ? fillPageGaps(startPages) : startPages;
      const plan = buildNavPlan({ chapters: bookChapters, tocEntries: entries, pages, pageTolerance: 2, pageFirst: usingPdfPages, orderFallback: usingPdfPages });
      if (plan) {
        navItems = normalizeNavLevels(plan.items).map((item) => ({
          title: item.title,
          file: `chapter-${String(item.chapterIndex + 1).padStart(3, "0")}.xhtml`,
          level: item.level,
        }));
        // 目录条目的标题比正文里的残缺占位好(上游把「第4章 …」拆成了「第」):
        // 用目录标题把章节名补齐,正文标题也就跟着对了。
        for (const item of plan.items) {
          const chapter = bookChapters[item.chapterIndex];
          if (!chapter) continue;
          const current = String(chapter.title || "").replace(/[^\p{L}\p{N}]/gu, "");
          if (current.length <= 2 && item.title) chapter.title = item.title;
        }
        navDropped = plan.dropped.length;
        navSource = tocSource;
        log("book build nav from toc", tocSource, plan.matched, "entries", navDropped, "dropped");
        if (plan.dropped.length) log("book build nav dropped", plan.dropped.slice(0, 10).map((label) => String(label).slice(0, 30)).join(" / "));
      } else {
        log("book build nav from toc skipped", "matched too few entries");
      }
    }
    // 没有可用目录(没有大纲 / 大纲只是页码标尺 / 大纲对不上正文):用正文标题当导航,
    // 大纲剩下的顶层条目(作品名)当锚点。这样《安妮·卡森诗选》这类书得到的是
    // 「作品 → 各节」的目录,而不是一串页码。
    if (!navItems) {
      const pdfPages = fillPageGaps(chapterStartPages(normalized.chapters).filter((_page, index) => tocStrip.keptIndexes.has(index)));
      navItems = normalizeNavLevels(chaptersToNavItems(bookChapters, { anchors: outlineAnchors, pages: pdfPages }));
      navSource = "headings";
      log("book build nav from headings", navItems.length, "条", outlineAnchors.length ? `(另用大纲顶层 ${outlineAnchors.length} 条当锚点)` : "");
    }

    const chaptersWithHtml = bookChapters.map((chapter) => ({
      title: chapter.title,
      text: chapter.text,
      html: chapter.markdown ? markdownToHtml(chapter.text, { renderMath }) : textToHtml(chapter.text),
    }));
    const { chapters, images } = collectBookImages(chaptersWithHtml, { baseDir, log });
    if (signal.aborted) throw new Error("任务已取消");
    // 自报「有没有公式漏渲染」:成书后还剩多少原始 LaTeX,不用等用户翻书才发现。
    const unrendered = chapters.reduce((sum, chapter) => sum + countRawFormulas(chapter.html), 0);
    if (unrendered) log("book build raw formulas", unrendered, "个公式没能渲染成 MathML(成品里会显示 LaTeX 原文)");
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
      markdownText: text || rawChapters.map((chapter) => chapter.text).join("\n"),
      sourceDir: baseDir,
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
      images,
      cover,
      // 印刷目录匹配出来的导航(为空时 buildEpub 按章节标题生成,与旧行为一致)。
      nav: navItems,
      colophon: String(payload?.colophon || "由 UV Reader 书坊生成"),
    }, out);
    if (signal.aborted) throw new Error("任务已取消");
    const formulaCount = mathMap ? [...mathMap.values()].filter(Boolean).length : 0;
    return {
      output: out,
      detail: `EPUB · ${result.chapters} 章 · ${Math.round(result.bytes / 1024)} KB${fonts.length ? ` · ${fonts.length} 款字体` : ""}${images.length ? ` · ${images.length} 图` : ""}${formulaCount ? ` · ${formulaCount} 公式` : ""}${tocStrip.dropped ? ` · 去印刷目录 ${tocStrip.dropped} 章` : ""}${navItems ? ` · 目录${navSource === "outline" ? "来自 PDF 大纲" : navSource === "upstream" ? "来自上游" : navSource === "printed" ? "来自印刷目录" : "来自正文标题"} ${navItems.length} 条${navDropped ? `(丢弃 ${navDropped})` : ""}` : ""}${normalized.dropped ? ` · 去重复页眉 ${normalized.dropped} 章` : ""}${unrendered ? ` · 未渲染 ${unrendered}` : ""}`,
    };
  });
}
