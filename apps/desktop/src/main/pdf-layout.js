// 扫描版式转换：MinerU 版面 + RapidOCR 行框 → 引擎原位重排。
//
// 这条链路不经过 DocVortex：DocVortex 会把页面重新排版，扫描书的彩色版面和
// 插图位置都会丢失。这里只把「文字」换掉，页面图像、插图、色块和装饰线保持
// 原位；引擎负责 OCR、擦字和重新排版（engine/engine/layout_pdf.py）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { convertPath } from "../shared/workshop-names.js";
import { pdfFigureManifestData, pdfFiguresFromLayout } from "../../../../packages/reader/src/pdf-figures.js";
import { extractTocFromLayout } from "../shared/layout-toc.js";
import { removeFile, uniqueFile } from "./paths.js";
import { formulaCacheDir } from "./workshop-formula.js";

function normaliseBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return [0, 0, 1, 1];
  const values = bbox.slice(0, 4).map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return [0, 0, 1, 1];
  // MinerU middle_json uses 0..1; content_list uses 0..1000.
  if (values.some((value) => value > 1.5)) {
    return values.map((value) => Math.max(0, Math.min(1, value / 1000)));
  }
  return values.map((value) => Math.max(0, Math.min(1, value)));
}

function collectLines(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      const parts = collectLines(item);
      if (parts.length) lines.push(parts.join(""));
    }
    return lines;
  }
  if (value && typeof value === "object") {
    if (typeof value.content === "string") return [value.content];
    if (value.content != null) return collectLines(value.content);
    if (typeof value.text === "string") return [value.text];
  }
  return [];
}

function blockText(block) {
  return collectLines(block?.content).filter(Boolean).join("\n").trim();
}

function chunkStart(folder) {
  const match = /^(\d+)-(\d+)$/.exec(String(folder || ""));
  return match ? Number(match[1]) : 0;
}

function blocksFromChunk(file, start) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = [];
  for (const page of data.pages || []) {
    const number = start + Number(page.page_idx || 0);
    if (!number) continue;
    const blocks = [];
    for (const block of page.blocks || []) {
      const type = String(block.type || "text");
      if (type === "image" || type === "table") {
        blocks.push({ type, bbox: normaliseBbox(block.bbox), text: "" });
        continue;
      }
      const text = blockText(block);
      if (text) blocks.push({ type, bbox: normaliseBbox(block.bbox), text });
    }
    if (blocks.length) rows.push({ page: number, blocks });
  }
  return rows;
}

function blocksFromContentList(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const byPage = new Map();
  for (const item of Array.isArray(data) ? data : []) {
    const number = Number(item?.page_idx ?? -1) + 1;
    if (number <= 0) continue;
    const type = String(item?.type || "text");
    const text = String(item?.text || "").trim();
    if (!text && type !== "image" && type !== "table") continue;
    if (!byPage.has(number)) byPage.set(number, []);
    byPage.get(number).push({ type, bbox: normaliseBbox(item?.bbox), text: type === "image" || type === "table" ? "" : text });
  }
  return [...byPage.entries()].map(([page, blocks]) => ({ page, blocks }));
}

// Read the MinerU layout from the same cache used by the formula chain. The
// chunks keep page_idx local, so the folder's start page is added back.
export function readMineruLayout(workDir) {
  const roots = [
    path.join(workDir, "mineru"),
    path.join(workDir, "extract", "mineru"),
  ];
  for (const root of roots) {
    const chunksDir = path.join(root, "chunks");
    if (fs.existsSync(chunksDir)) {
      const rows = [];
      for (const entry of fs.readdirSync(chunksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const middle = path.join(chunksDir, entry.name, "middle_json.json");
        if (!fs.existsSync(middle)) continue;
        rows.push(...blocksFromChunk(middle, chunkStart(entry.name)));
      }
      if (rows.length) {
        rows.sort((a, b) => a.page - b.page);
        return { pages: rows, source: chunksDir };
      }
    }
    const contentList = path.join(root, "content_list.json");
    if (fs.existsSync(contentList)) {
      const rows = blocksFromContentList(contentList);
      if (rows.length) return { pages: rows, source: contentList };
    }
  }
  return { pages: [], source: "" };
}

export function writeLayoutJson(workDir, layout) {
  const target = path.join(workDir, "layout.json");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(layout, null, 2), "utf8");
  return target;
}

export function requestedPageNumbers(value) {
  const wanted = new Set();
  for (const part of String(value || "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(text);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (start > end) [start, end] = [end, start];
      for (let page = start; page <= end; page += 1) wanted.add(page);
    } else if (/^\d+$/.test(text)) {
      wanted.add(Number(text));
    }
  }
  return [...wanted].sort((left, right) => left - right);
}

// The user often has a formula-cache directory from an earlier extraction of
// the same book (possibly under a different filename such as "... (1).pdf").
// Reuse its MinerU layout instead of paying for another full parse. When the
// source page count is known, only accept a cache that covers the whole book:
// a layout from a different edition (or a 3-page trial) must not be silently
// applied to a 461-page scan. For a page-range run, every requested page must
// be present.
export function findLayoutCache(cacheRoot, source, pageCount = 0, requestedPages = []) {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;
  const stem = path.basename(String(source || ""), path.extname(String(source || "")))
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .slice(0, 24);
  if (!stem) return null;
  let best = null;
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(stem)) continue;
    const dir = path.join(cacheRoot, entry.name);
    const layout = readMineruLayout(dir);
    if (!layout.pages.length) continue;
    const pageSet = new Set(layout.pages.map((page) => Number(page.page) || 0));
    if (requestedPages.length && !requestedPages.every((page) => pageSet.has(page))) continue;
    const lastPage = Math.max(...pageSet);
    if (pageCount > 0 && lastPage !== pageCount) continue;
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch { /* best effort */ }
    if (!best || layout.pages.length > best.layout.pages.length
      || (layout.pages.length === best.layout.pages.length && mtime > best.mtime)) {
      best = { workDir: dir, layout, mtime };
    }
  }
  return best ? { workDir: best.workDir, layout: best.layout } : null;
}

// The text-layer job exists on every engine version; its output length is the
// PDF page count. It is a cheap preflight for choosing a layout cache.
async function sourceTextPages(engine, settings, source, signal) {
  const target = path.join(os.tmpdir(), `qbr-layout-pages-${process.pid}-${Date.now().toString(36)}.json`);
  try {
    const ran = await engine.runJob(settings, "text-layer", { source, out: target }, {
      signal,
      timeoutMs: 120_000,
      intervalMs: 500,
    });
    if (!ran.ok) return { count: 0, native: 0 };
    const pages = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!Array.isArray(pages)) return { count: 0, native: 0 };
    // A page with real text and no page-covering image is born-digital; the
    // engine keeps those vector pages, and a fully digital book needs no
    // MinerU run at all.
    const native = pages.filter((text) => String(text || "").trim().length >= 40).length;
    return { count: pages.length, native };
  } catch {
    return { count: 0, native: 0 };
  } finally {
    try { removeFile(target); } catch { /* temp file */ }
  }
}
function engineError(error) {
  const text = String(error || "");
  if (/未知.*作业|unknown.*job|layout-pdf/i.test(text) && /未知|unknown|400/i.test(text)) {
    return "当前书坊引擎不支持保留版式转换：请在「设置 → 书坊」更新书坊引擎。";
  }
  if (/fetch failed|ECONNREFUSED|连接超时|connect/i.test(text)) {
    return "书坊引擎没有响应：请在「设置 → 书坊」启动引擎后重试。";
  }
  return text || "保留版式转换失败";
}

export function registerLayoutRunner(workshop, {
  chain,
  engine,
  vaultRoot = "",
  cacheRoot = "",
  log = (...args) => console.log(...args),
} = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  workshop.register("layout-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const format = String(payload?.format || "pdf").toLowerCase();
    if (format !== "pdf") throw new Error("保留版式只输出 PDF：请把目标格式选为 PDF。");
    const pages = String(payload?.pages || "").trim();
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, "pdf")));
    let workDir = formulaCacheDir(cacheRoot, source, pages);

    if (!engine?.runJob) throw new Error("这个宿主没有书坊引擎，无法做保留版式转换。");
    // An older engine bundle does not know this job kind; fail with a recovery
    // action instead of a raw HTTP 400.
    try {
      const health = await engine.health(settings);
      const kinds = health?.ok ? health.data?.capabilities?.jobKinds : null;
      if (Array.isArray(kinds) && !kinds.includes("layout-pdf")) {
        throw new Error("当前书坊引擎不支持保留版式转换：请在「设置 → 书坊」更新书坊引擎。");
      }
    } catch (error) {
      if (String(error?.message || error).includes("不支持保留版式")) throw error;
      log("layout chain: engine health unavailable, trying the job anyway", String(error?.message || error));
    }

    // For a full-book run, learn the source page count before reusing a cache:
    // a layout from a different edition (or a short trial) must not be silently
    // applied to this PDF. Subset runs only accept a cache that has every
    // requested page.
    let pageCount = 0;
    let nativePages = 0;
    if (!pages) {
      const preflight = await sourceTextPages(engine, settings, source, signal);
      pageCount = preflight.count;
      nativePages = preflight.native;
      // A born-digital book is already perfect: the repaint path would only
      // rasterise its vector text (and MinerU would waste half an hour on it).
      if (pageCount > 0 && nativePages >= Math.ceil(pageCount * 0.8)) {
        if (path.resolve(out) !== path.resolve(source)) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.copyFileSync(source, out);
        }
        let tocCount = 0;
        try {
          const outline = await engine.runJob(settings, "outline", { source }, { signal, timeoutMs: 60_000 });
          tocCount = Number(outline?.result?.count || 0);
        } catch { /* the copy keeps the original outline anyway */ }
        report({ label: "已是文字版 PDF，原样保留" });
        log("layout chain: born-digital pdf, copied as-is", pageCount, "pages");
        return {
          output: out,
          detail: `PDF · 已是文字版 · 原样保留${tocCount ? ` · 目录 ${tocCount} 条` : ""} · ${path.basename(out)}`,
          via: "native",
          result: {
            pages: pageCount,
            native: pageCount,
            replaced: 0,
            kept: 0,
            toc: tocCount,
            copied: true,
          },
        };
      }
    }
    if (signal?.aborted) throw new Error("任务已取消");
    const requestedPages = requestedPageNumbers(pages);

    // Reuse an existing layout cache for the same book (the filename may have
    // changed from "... (1).pdf" to "... .pdf"). Refresh always re-parses.
    let layout = payload?.refresh === true ? { pages: [] } : readMineruLayout(workDir);
    if (!layout.pages.length && payload?.refresh !== true) {
      const reused = findLayoutCache(cacheRoot, source, pageCount, requestedPages);
      if (reused) {
        workDir = reused.workDir;
        layout = reused.layout;
        report({ label: "复用 MinerU 版面缓存" });
        log("layout chain: reuse cached layout", workDir, layout.pages.length, "pages");
      }
    }
    if (!layout.pages.length) {
      report({ label: "MinerU 版面解析" });
      const prepared = await chain.prepare({
        settings,
        source,
        workDir,
        pages,
        signal,
        report,
        format: "pdf",
        refresh: payload?.refresh === true,
      });
      if (signal?.aborted) throw new Error("任务已取消");
      if (!prepared.ok) throw new Error(String(prepared.error || "MinerU 解析失败"));
      layout = readMineruLayout(workDir);
    }
    if (!layout.pages.length) {
      throw new Error("MinerU 没有返回版面数据：请确认「设置 → 书坊」里的 MinerU 可用，或换一个带文字层的 PDF。");
    }
    const layoutPath = writeLayoutJson(workDir, layout);
    log("layout chain:", source, "pages", layout.pages.length, "->", out);

    // Full-book conversions can carry the printed contents into the PDF
    // outline. Subset runs would need their page numbers remapped, so leave
    // those alone. The layout already has MinerU's title/page rows; sorting
    // blocks by column handles the double-column TOC.
    let toc = { pages: [], entries: [], offset: 0 };
    let tocReliable = false;
    if (!pages) {
      toc = extractTocFromLayout(layout, {
        pageCount: pageCount || Math.max(...layout.pages.map((page) => Number(page.page) || 0), 0),
      });
      // A wrong outline is worse than no outline. Require a body-page offset
      // with a clear majority before writing bookmarks; otherwise keep the
      // extracted rows in the task result but leave the PDF outline empty.
      tocReliable = Boolean(toc.entries.length && toc.offsetInfo?.total >= 3 && toc.offsetInfo?.confidence >= 0.5);
      if (toc.entries.length) {
        report({
          label: tocReliable
            ? `目录 ${toc.entries.length} 条（偏移 ${toc.offset >= 0 ? "+" : ""}${toc.offset}）`
            : `目录 ${toc.entries.length} 条（页码偏移不确定）`,
        });
        log("layout chain: toc", JSON.stringify({
          pages: toc.pages,
          entries: toc.entries.length,
          offset: toc.offset,
          agree: toc.offsetInfo?.agree,
          total: toc.offsetInfo?.total,
          reliable: tocReliable,
        }));
      } else {
        log("layout chain: no printed contents found");
      }
    }

    report({ label: "保留版式重排" });
    const ran = await engine.runJob(settings, "layout-pdf", {
      source,
      out,
      layout: layoutPath,
      pages,
      dpi: Number(settings.layoutDpi) || 216,
      cacheDir: path.join(workDir, "layout-ocr"),
      toc: tocReliable ? toc.entries.map((entry) => ({
        level: entry.level || 1,
        title: entry.title,
        page: entry.pdfPage,
      })) : [],
    }, {
      signal,
      timeoutMs: 120 * 60_000,
      onProgress: (progress) => report({
        label: progress.label || "保留版式重排",
        done: progress.done,
        total: progress.total,
      }),
    });
    if (ran.cancelled) throw new Error("任务已取消");
    if (!ran.ok) throw new Error(engineError(ran.error));
    if (!fs.existsSync(out)) throw new Error("引擎没有生成 PDF");
    const stats = ran.result || {};
    log("layout chain: done", stats.replaced, "replaced,", stats.kept, "kept");

    // Figure boxes are page-indexed: a subset run's page numbers are local to
    // the output, so only full-book conversions write the sidecar. The reader
    // crops these boxes from the page raster on click.
    let figureInfo = { count: 0, sidecar: "" };
    if (!pages) {
      const figures = pdfFiguresFromLayout(layout);
      const sidecar = `${out.replace(/\.pdf$/i, "")}.figures.json`;
      try {
        if (figures.length) {
          fs.writeFileSync(sidecar, JSON.stringify(pdfFigureManifestData(figures, { source: path.basename(out) }), null, 2), "utf8");
          figureInfo = { count: figures.length, sidecar };
          report({ label: `插图预览 ${figures.length} 处` });
          log("layout chain: figures", figures.length, "->", sidecar);
        } else if (fs.existsSync(sidecar)) {
          removeFile(sidecar);
        }
      } catch (error) {
        log("layout chain: could not write the figure sidecar", error?.message || error);
      }
    }

    const nativePart = Number(stats.native || 0) > 0 ? ` · 文字版原样保留 ${stats.native} 页` : "";
    return {
      output: out,
      detail: toc.entries.length
        ? `PDF · 保留版式 · 目录 ${toc.entries.length} 条${tocReliable ? "" : "（偏移不确定）"}${figureInfo.count ? ` · 插图 ${figureInfo.count} 处` : ""}${nativePart} · ${path.basename(out)}`
        : `PDF · 保留版式 · ${figureInfo.count ? `插图 ${figureInfo.count} 处 · ` : ""}${nativePart ? `${nativePart.replace(/^ · /, "")} · ` : ""}${path.basename(out)}`,
      via: "engine",
      result: {
        ...stats,
        toc: {
          pages: toc.pages,
          entries: toc.entries.length,
          offset: toc.offset,
          agree: toc.offsetInfo?.agree || 0,
          total: toc.offsetInfo?.total || 0,
          reliable: tocReliable,
        },
        figures: figureInfo,
      },
    };
  });

  return { readMineruLayout };
}
