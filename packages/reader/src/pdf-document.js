// PDF document reading: page text extraction, the lazy page renderer and the
// document outline. Host bits (worker bootstrap and the window clock) are
// injected so the module stays testable outside Obsidian.

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_CMAP_OPTIONS } from "./pdf-cmaps.js";
import { normalisePdfFigureBbox, pdfFigureManifestFromData } from "./pdf-figures.js";
import { pdfImageBoxesFromOps } from "./pdf-image-boxes.js";
import { PDF_RASTER_LEGACY_MAX_SCALE, PDF_RASTER_LEGACY_SIDE, PDF_RASTER_MAX_PIXELS, PDF_RASTER_MIN_SCALE, pdfRasterPlan } from "./pdf-raster.js";
import { getPdfTextContent } from "./pdf-text-content.js";
import { pdfTextLines } from "./pdf-toc.js";
import { PDF_AI_CONTEXT_MAX_CHARS, packPdfDocumentContext, pdfPageKind, pdfPageShell, pdfPageTextFallback, pdfPageTextForAi } from "./pdf-page-mode.js";
import { pdfScanPageKind, pdfScanVerdict } from "./pdf-scan.js";
import { throwIfReaderLoadAborted } from "./reader-load.js";
import { pdfTextLooksUnreadable } from "./toc-build.js";

// Text content is heavy (one item object per run), so only keep a small window
// of recently rendered pages. The first pages are primed because they are the
// ones the reader sees before the background text pass moves on.
const PDF_TEXT_CACHE_LIMIT = 24;
const PDF_TEXT_CACHE_PRIME = 8;

// PDF.js returns field objects either as a name→fields map or wrapped in an
// allFields object, depending on its build. Only the controls this reader can
// actually fill count as an available form: editable text fields and check
// boxes. Read-only fields, radio groups and signature fields do not warrant
// showing the fill/sign/save toolbar.
export function pdfFieldObjectsHaveFillableForm(fields) {
  if (!fields || typeof fields !== "object") return false;
  const groups = fields.allFields && typeof fields.allFields === "object"
    ? Object.values(fields.allFields)
    : Object.values(fields);
  return groups.some((group) => {
    const list = Array.isArray(group) ? group : [group];
    return list.some((field) => field
      && typeof field === "object"
      && field.hidden !== true
      && field.editable !== false
      && (field.type === "text" || field.type === "checkbox"));
  });
}

export function createPdfDocument({ setupWorker, win = globalThis }) {
  async function pdfTextLayerElement(page, textContent, ownerDocument = document) {
    if (!pdfjsLib.TextLayer || !textContent || !textContent.items?.length) return null;
    const container = ownerDocument.createElement("div");
    container.className = "qiaomu-reader-pdf-text-layer";
    container.setAttribute("data-pdf-selectable", "true");
    // Marks the real, positioned PDF.js layer. Backfill/OCR placeholders are
    // plain text nodes with the same class, and a bitmap re-render must not
    // mistake those for a layer it can keep.
    container.setAttribute("data-pdf-layer", "pdfjs");
    const viewport = page.getViewport({ scale: 1 });
    try {
      const layer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container,
        viewport,
      });
      await layer.render();
    } catch (error) {
      console.warn(`UV Reader: PDF text layer unavailable on page ${page.pageNumber}`, error);
      return null;
    }
    return container.textContent.trim() ? container : null;
  }

  function pdfPageCharCount(items) {
    let count = 0;
    for (const item of items || []) {
      if (typeof item.str === "string") count += item.str.replace(/\s+/g, "").length;
    }
    return count;
  }

  // Small JPEG preview kept when a page is dropped from the scroll window. It
  // makes returning to a page instant instead of showing an empty white box
  // while the full-resolution raster is rebuilt.
  function pdfPageThumbnail(canvas, ownerDocument, maxWidth = 180) {
    try {
      const width = Math.max(1, Math.min(maxWidth, canvas.width));
      const height = Math.max(1, Math.round(canvas.height * (width / canvas.width)));
      const thumb = ownerDocument.createElement("canvas");
      thumb.width = width;
      thumb.height = height;
      const context = thumb.getContext("2d");
      if (!context) return "";
      context.drawImage(canvas, 0, 0, width, height);
      return thumb.toDataURL("image/jpeg", 0.72);
    } catch {
      return "";
    }
  }

  function pdfPageSize(page) {
    const view = page.view || [0, 0, 612, 792];
    return {
      width: Math.max(1, Math.round(Math.abs(view[2] - view[0]))),
      height: Math.max(1, Math.round(Math.abs(view[3] - view[1]))),
    };
  }

  // Loads a single page: progress is reported at page 1, every 4th page and on
  // the final one, aborts are re-checked around each await, and unreadable text
  // runs suppress the HTML text layer.
  async function readPdfPage(doc, pageNumber, signal, onProgress, total, onText = null) {
    throwIfReaderLoadAborted(signal);
    if (onProgress && (pageNumber === 1 || pageNumber % 4 === 0 || pageNumber === total)) {
      onProgress(pageNumber, total);
    }
    const page = await doc.getPage(pageNumber);
    try {
      throwIfReaderLoadAborted(signal);
      const textContent = await getPdfTextContent(page);
      throwIfReaderLoadAborted(signal);
      const textLen = pdfPageCharCount(textContent.items);
      const size = pdfPageSize(page);
      const brokenText = textLen >= 40 && pdfTextLooksUnreadable(textContent.items);
      const textFallback = brokenText ? "" : pdfPageTextFallback(textContent.items);
      const kind = pdfPageKind(textLen, brokenText || !textFallback);
      // The background text pass already pays for this extraction; hand it to
      // the lazy view so the first render of the page can reuse it. Scanned or
      // unreadable pages would never ask for it.
      if (kind === "text") onText?.(pageNumber, textContent);
      return {
        width: size.width,
        height: size.height,
        kind,
        textFallback,
        aiText: kind === "text" ? pdfPageTextForAi(textContent.items) : "",
      };
    } finally {
      page.cleanup?.();
    }
  }

  // Resolves an outline entry to its 1-based page number, or null when the
  // destination cannot be resolved.
  async function pdfOutlinePageOf(doc, node) {
    try {
      const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
      if (Array.isArray(dest) && dest[0]) return (await doc.getPageIndex(dest[0])) + 1;
    } catch { /* optional step; a failure here must not interrupt reading */ }
    return null;
  }

  // Depth-first outline walk; entries land in the caller's array so a late
  // failure keeps whatever was already collected.
  async function collectPdfOutlineInto(doc, outline) {
    const walk = async (nodes, level) => {
      for (const node of nodes || []) {
        const page = await pdfOutlinePageOf(doc, node);
        const label = String(node.title || "").replace(/\s+/g, " ").trim();
        if (label && page) outline.push({ label, page, level });
        if (node.items && node.items.length) await walk(node.items, level + 1);
      }
    };
    await walk(await doc.getOutline(), 0);
  }

  // Races a render task against a hard wall-clock budget; when the budget
  // fires, the task is cancelled and the race rejects with a marker error.
  function startRenderBudget(task, ms) {
    let timer = null;
    const promise = new Promise((_, rej) => {
      timer = win.setTimeout(() => {
        try { task.cancel(); } catch { /* optional step; a failure here must not interrupt reading */ }
        rej(new Error("qiaomu-reader-render-budget"));
      }, ms);
    });
    return { promise, clear: () => win.clearTimeout(timer) };
  }

  // High-resolution pages are the common case; a complex page can still exceed
  // the budget. Retry that page at a smaller scale (marked `limited` so the
  // sweep does not try the same expensive size after every repaint).
  function pdfRenderAttempts(plan, unit) {
    const legacy = Math.max(1, Math.min(
      PDF_RASTER_LEGACY_MAX_SCALE,
      PDF_RASTER_LEGACY_SIDE / Math.max(unit.width, unit.height, 1),
    ));
    if (plan.legacy) return [
      { scale: plan.scale, budget: 15000, limited: false },
      { scale: plan.scale / 2, budget: 8000, limited: false },
    ];
    return [
      { scale: plan.scale, budget: 15000, limited: false },
      { scale: Math.max(PDF_RASTER_MIN_SCALE, Math.min(plan.scale * 0.55, legacy)), budget: 8000, limited: true },
    ];
  }

  function createPdfLazyView(doc, loadingTask, pageText) {
    return {
      _doc: doc,
      _loadingTask: loadingTask,
      _destroyed: false,
      _pageText: pageText,
      // Text layers generated later (OCR for scanned pages) land here first so
      // the page renders from them instead of the empty PDF text content.
      _ocrContents: new Map(),
      // PDF text content is shared by every bitmap re-render of a page (zoom,
      // HiDPI), so extract it once instead of on each paint. The map is a small
      // LRU: a 738-page book must not retain every page's run objects.
      _textContents: new Map(),
      _textWanted: new Set(),
      _imageBoxes: new Map(),
      cacheTextContent(pageNumber, content) {
        if (!content?.items?.length) return;
        this._textContents.delete(pageNumber);
        this._textContents.set(pageNumber, content);
        while (this._textContents.size > PDF_TEXT_CACHE_LIMIT) {
          const oldest = this._textContents.keys().next().value;
          this._textContents.delete(oldest);
        }
      },
      rememberTextContent(pageNumber, content) {
        if (pageNumber > PDF_TEXT_CACHE_PRIME && !this._textWanted.has(pageNumber)) return;
        this.cacheTextContent(pageNumber, content);
      },
      // Stores a generated page text layer and makes it visible on the next
      // repaint of that page.
      applyOcr(pageNumber, content, text) {
        if (!content?.items?.length) return false;
        this._ocrContents.set(pageNumber, content);
        this._pageText[pageNumber - 1] = String(text || "");
        return true;
      },
      async _paint(task, budgetMs) {
        void task.promise.catch(() => {});
        const deadline = startRenderBudget(task, budgetMs);
        try {
          await Promise.race([task.promise, deadline.promise]);
        } finally {
          deadline.clear();
        }
      },
      // The complete source page is always the visual truth. Text, when reliable,
      // is a transparent interaction layer and never replaces these pixels.
      //
      // `options.cssWidth` / `cssHeight` are the on-screen page box (the reader
      // zoom transform is already included). Passing them makes the bitmap
      // match the physical screen pixels instead of the old fixed 1600px edge.
      // Callers that omit them (AI attachments, screenshots) keep the historical
      // JPEG thumbnail behaviour.
      async render(pageNumber, ownerDocument = document, options = {}) {
        const page = await doc.getPage(pageNumber);
        try {
          if (this._destroyed) throw Object.assign(new Error("Reader closed"), { name: "AbortError" });
          const unit = page.getViewport({ scale: 1 });
          const plan = pdfRasterPlan({
            pageWidth: unit.width,
            pageHeight: unit.height,
            cssWidth: options.cssWidth,
            cssHeight: options.cssHeight,
            devicePixelRatio: options.devicePixelRatio,
          });
          const generated = this._ocrContents.get(pageNumber) || null;
          let textContent = null;
          if (options.withTextLayer !== false) {
            textContent = generated || this._textContents.get(pageNumber) || null;
            if (!textContent && this._pageText[pageNumber - 1]) {
              this._textWanted.add(pageNumber);
              textContent = await getPdfTextContent(page);
              this.cacheTextContent(pageNumber, textContent);
            }
          }
          const textLayer = textContent ? await pdfTextLayerElement(page, textContent, ownerDocument) : null;
          // Text pages are lossless: JPEG ringing is what made glyph edges look
          // soft even when the bitmap had enough pixels. Pages without a real
          // text layer are usually scans; keep those as high-quality JPEG so a
          // single photo page does not become a multi-megabyte PNG data URL.
          const textBearing = Boolean(generated) || Boolean(String(this._pageText[pageNumber - 1] || "").trim());
          const screen = !plan.legacy;
          const type = screen && textBearing ? "image/png" : "image/jpeg";
          const quality = type === "image/png" ? undefined : (screen ? 0.92 : 0.82);
          for (const attempt of pdfRenderAttempts(plan, unit)) {
            const viewport = page.getViewport({ scale: attempt.scale });
            const canvas = ownerDocument.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            try {
              await this._paint(page.render({ canvasContext: context, viewport }), attempt.budget);
              if (this._destroyed) throw Object.assign(new Error("Reader closed"), { name: "AbortError" });
              let src;
              let encoderFallback = false;
              try {
                src = canvas.toDataURL(type, quality);
                if (!String(src).startsWith("data:image/")) throw new Error("canvas encoder unavailable");
              } catch {
                // A huge lossless canvas can exceed a platform encoder limit.
                encoderFallback = true;
                src = canvas.toDataURL("image/jpeg", 0.92);
              }
              return {
                src,
                textLayer,
                thumb: options.withThumbnail === true ? pdfPageThumbnail(canvas, ownerDocument) : "",
                mimeType: String(src).startsWith("data:image/png") ? "image/png" : "image/jpeg",
                pixelWidth: canvas.width,
                pixelHeight: canvas.height,
                scale: attempt.scale,
                limited: plan.limited || attempt.limited || encoderFallback,
              };
            } catch (e) {
              if (String(e && e.message) !== "qiaomu-reader-render-budget") throw e;
            } finally {
              canvas.width = 0;
              canvas.height = 0;
            }
          }
          throw new Error("qiaomu-reader-render-too-heavy");
        } finally {
          page.cleanup?.();
        }
      },
      textFor(pageNumber) {
        return this._pageText[pageNumber - 1] || "";
      },
      // A figure preview is rendered straight from the PDF at the crop's own
      // resolution. Re-rendering the full page bitmap and then cropping would
      // either be blurry (the on-screen raster) or expensive (a 4x page); this
      // paints the whole page into a canvas the size of the figure, shifted so
      // only the requested box lands in it.
      async figureImage(pageNumber, bbox, { width = 1600, doc: ownerDocument = null } = {}) {
        if (this._destroyed) return "";
        const box = normalisePdfFigureBbox(bbox);
        if (!box || !ownerDocument) return "";
        const page = await doc.getPage(pageNumber);
        try {
          const base = page.getViewport({ scale: 1 });
          const cropWidth = Math.max(1, (box[2] - box[0]) * base.width);
          const cropHeight = Math.max(1, (box[3] - box[1]) * base.height);
          const targetWidth = Math.max(480, Math.min(2400, Number(width) || 1600));
          const areaCap = Math.sqrt(PDF_RASTER_MAX_PIXELS / (cropWidth * cropHeight));
          const scale = Math.max(1, Math.min(4, targetWidth / cropWidth, areaCap));
          const viewport = page.getViewport({ scale });
          const canvas = ownerDocument.createElement("canvas");
          canvas.width = Math.ceil(cropWidth * scale);
          canvas.height = Math.ceil(cropHeight * scale);
          const context = canvas.getContext("2d");
          if (!context) return "";
          await page.render({
            canvasContext: context,
            viewport,
            transform: [1, 0, 0, 1, -box[0] * viewport.width, -box[1] * viewport.height],
            background: "#ffffff",
          }).promise;
          if (this._destroyed) return "";
          return canvas.width * canvas.height > 4_000_000
            ? canvas.toDataURL("image/jpeg", 0.92)
            : canvas.toDataURL("image/png");
        } finally {
          page.cleanup?.();
        }
      },
      // Positioned text lines for the contents extractor. Called only for a
      // handful of TOC pages, so fetching the text content on demand is fine.
      async linesFor(pageNumber) {
        if (this._destroyed) return { lines: [], width: 0, height: 0 };
        const page = await doc.getPage(pageNumber);
        try {
          const viewport = page.getViewport({ scale: 1 });
          let content = this._ocrContents.get(pageNumber) || this._textContents.get(pageNumber) || null;
          if (!content) {
            content = await getPdfTextContent(page);
            this.cacheTextContent(pageNumber, content);
          }
          return {
            lines: pdfTextLines(content?.items, { pageWidth: viewport.width }),
            width: viewport.width,
            height: viewport.height,
          };
        } finally {
          page.cleanup?.();
        }
      },
      // Image boxes from the page's operator list, used to keep embedded photos
      // and figures in their original colours while text/paper follow the theme.
      // Cached because a page can repaint at several zoom levels.
      async imageBoxesFor(pageNumber) {
        if (this._destroyed) return [];
        if (this._imageBoxes.has(pageNumber)) return this._imageBoxes.get(pageNumber);
        const page = await doc.getPage(pageNumber);
        let boxes = [];
        try {
          const operatorList = await page.getOperatorList();
          boxes = pdfImageBoxesFromOps(operatorList.fnArray, operatorList.argsArray, {
            ops: pdfjsLib.OPS,
            viewport: page.getViewport({ scale: 1 }),
          });
        } catch (error) {
          console.warn(`UV Reader: could not read images on PDF page ${pageNumber}`, error);
        }
        if (!this._destroyed) this._imageBoxes.set(pageNumber, boxes);
        return boxes;
      },
      destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._pageText.length = 0;
        this._ocrContents.clear();
        this._textContents.clear();
        this._textWanted.clear();
        this._imageBoxes.clear();
        try { void loadingTask.destroy(); } catch { /* already stopped */ }
      }
    };
  }

  // Prepares the worker, reads the book file and hands back a cancellable
  // pdf.js loading task. Every await is bracketed by an abort check. A source
  // override lets the book identity (and its highlights) stay on the original
  // file while the pages come from the generated searchable copy.
  async function openPdfLoadingTask(app, file, signal, sourceFile = null) {
    throwIfReaderLoadAborted(signal);
    await setupWorker(app);
    throwIfReaderLoadAborted(signal);
    const bytes = await app.vault.readBinary(sourceFile || file);
    throwIfReaderLoadAborted(signal);
    return pdfjsLib.getDocument({ data: bytes, ...PDF_CMAP_OPTIONS, isEvalSupported: false });
  }

  // Runs `worker(pageNumber)` for every page inside a small concurrency window
  // so the cheap per-page metadata pass stays fast on long documents.
  async function mapPdfPages(total, limit, worker) {
    const results = new Array(total);
    let next = 1;
    const run = async () => {
      for (;;) {
        const pageNumber = next++;
        if (pageNumber > total) return;
        results[pageNumber - 1] = await worker(pageNumber);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, total)) }, run));
    return results;
  }

  // Opening a PDF happens in two phases. Sizes and page shells come first so
  // the view can paint immediately; text layers, the scan verdict and the AI
  // context follow in the background (`whenTextReady`, with the lazy view
  // handing out text as it arrives). Reading every page's text upfront used to
  // hold the first frame hostage, which made large PDFs open as a white screen
  // for seconds.
  async function extractPdf(file, app, _settings = {}, onProgress, options = {}) {
    const signal = options.signal;
    const loadingTask = await openPdfLoadingTask(app, file, signal, options.sourceFile || null);
    const abortLoading = () => {
      try { void loadingTask.destroy(); } catch { /* already stopped */ }
    };
    signal?.addEventListener("abort", abortLoading, { once: true });
    try {
      const doc = await loadingTask.promise;
      throwIfReaderLoadAborted(signal);
      // Field detection is a cheap catalog lookup and must not hold up the
      // first page. The toolbar stays hidden until this resolves true.
      const whenFormReady = (typeof doc.getFieldObjects === "function"
        ? doc.getFieldObjects().then((fields) => pdfFieldObjectsHaveFillableForm(fields))
        : Promise.resolve(false)).catch(() => false);
      const pageCount = doc.numPages;
      const pageText = new Array(pageCount).fill("");
      const sizes = await mapPdfPages(pageCount, 12, async (pageNumber) => {
        throwIfReaderLoadAborted(signal);
        const page = await doc.getPage(pageNumber);
        try { return pdfPageSize(page); } finally { page.cleanup?.(); }
      });
      const parts = [];
      for (let i = 1; i <= pageCount; i++) {
        const size = sizes[i - 1] || { width: 612, height: 792 };
        parts.push(pdfPageShell({
          pageNumber: i,
          width: size.width,
          height: size.height,
          kind: "text",
          isLast: i === pageCount,
          textFallback: "",
        }));
      }
      const lazy = createPdfLazyView(doc, loadingTask, pageText);
      const whenTextReady = (async () => {
        const pageKinds = [], textPages = [];
        for (let i = 1; i <= pageCount; i++) {
          if (signal?.aborted) break;
          const part = await readPdfPage(doc, i, signal, onProgress, pageCount, (page, content) => {
            lazy.rememberTextContent(page, content);
          });
          // The verdict looks for a real text layer: a few watermark characters
          // do not make a scanned page digital.
          pageKinds.push(pdfScanPageKind(part.textFallback));
          if (part.kind === "text" && part.aiText) textPages.push({ page: i, text: part.aiText });
          pageText[i - 1] = part.kind === "text" ? part.textFallback : "";
        }
        return {
          scan: pdfScanVerdict(pageKinds, { total: pageCount }),
          pdfDocumentContext: packPdfDocumentContext(textPages, PDF_AI_CONTEXT_MAX_CHARS),
        };
      })();
      whenTextReady.catch(() => { /* aborted or closed; the verdict is simply late */ });
      const outline = [];
      try {
        await collectPdfOutlineInto(doc, outline);
      } catch (e) {
        console.warn("UV Reader: PDF outline unavailable", e);
      }
      const figureManifest = await readPdfFigureManifest(app, options.sourceFile || file);
      return {
        html: parts.join("\n"),
        lazy,
        outline,
        figureManifest,
        pdfDocumentContext: null,
        whenTextReady,
        whenFormReady,
      };
    } catch (error) {
      try { await loadingTask.destroy(); } catch { /* best-effort cleanup */ }
      if (signal?.aborted) throwIfReaderLoadAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortLoading);
    }
  }

  return {
    pdfTextLayerElement,
    pdfPageCharCount,
    pdfFigureManifestFromData,
    readPdfFigureManifest,
    pdfPageSize,
    readPdfPage,
    pdfOutlinePageOf,
    collectPdfOutlineInto,
    startRenderBudget,
    createPdfLazyView,
    openPdfLoadingTask,
    extractPdf,
  };
}

// Scanned-layout conversions write a small sidecar next to the PDF listing the
// illustration/table boxes. The page raster already contains those pixels, so
// the reader can crop the current page image on click instead of shipping a
// second copy of every picture. The parsing lives in pdf-figures.js; the host
// lookup below only handles vault paths and legacy absolute paths.
export { pdfFigureManifestFromData };

export async function readPdfFigureManifest(app, file) {
  try {
    const source = String(file?.path || "");
    if (!/\.pdf$/i.test(source)) return null;
    const sidecar = `${source.replace(/\.pdf$/i, "")}.figures.json`;
    const entry = app?.vault?.getAbstractFileByPath?.(sidecar);
    if (entry) return pdfFigureManifestFromData(JSON.parse(await app.vault.read(entry)));
    // Books opened from outside the vault keep an absolute path that the
    // abstract-file index may not know about. Ask the adapter directly.
    const adapter = app?.vault?.adapter;
    if (adapter?.read && (await adapter.exists?.(sidecar))) {
      return pdfFigureManifestFromData(JSON.parse(await adapter.read(sidecar)));
    }
    return null;
  } catch {
    return null;
  }
}
