// PDF document reading: page text extraction, the lazy page renderer and the
// document outline. Host bits (worker bootstrap and the window clock) are
// injected so the module stays testable outside Obsidian.

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_CMAP_OPTIONS } from "./pdf-cmaps.js";
import { getPdfTextContent } from "./pdf-text-content.js";
import { PDF_AI_CONTEXT_MAX_CHARS, packPdfDocumentContext, pdfPageKind, pdfPageShell, pdfPageTextFallback, pdfPageTextForAi } from "./pdf-page-mode.js";
import { pdfScanVerdict } from "./pdf-scan.js";
import { throwIfReaderLoadAborted } from "./reader-load.js";
import { pdfTextLooksUnreadable } from "./toc-build.js";

export function createPdfDocument({ setupWorker, win = globalThis }) {
  async function pdfTextLayerElement(page, textContent, ownerDocument = document) {
    if (!pdfjsLib.TextLayer || !textContent || !textContent.items?.length) return null;
    const container = ownerDocument.createElement("div");
    container.className = "qiaomu-reader-pdf-text-layer";
    container.setAttribute("data-pdf-selectable", "true");
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
  async function readPdfPage(doc, pageNumber, signal, onProgress, total) {
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

  function createPdfLazyView(doc, loadingTask, pageText) {
    return {
      _doc: doc,
      _loadingTask: loadingTask,
      _destroyed: false,
      _pageText: pageText,
      // Text layers generated later (OCR for scanned pages) land here first so
      // the page renders from them instead of the empty PDF text content.
      _ocrContents: new Map(),
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
      async render(pageNumber, ownerDocument = document) {
        const page = await doc.getPage(pageNumber);
        try {
          if (this._destroyed) throw Object.assign(new Error("Reader closed"), { name: "AbortError" });
          const unit = page.getViewport({ scale: 1 });
          const fit = Math.max(1, Math.min(2, 1600 / Math.max(unit.width, unit.height, 1)));
          const generated = this._ocrContents.get(pageNumber) || null;
          const textContent = generated
            || (this._pageText[pageNumber - 1] ? await getPdfTextContent(page) : null);
          const textLayer = textContent ? await pdfTextLayerElement(page, textContent, ownerDocument) : null;
          for (const [scale, budget] of [[fit, 15000], [fit / 2, 8000]]) {
            const viewport = page.getViewport({ scale });
            const canvas = ownerDocument.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            try {
              await this._paint(page.render({ canvasContext: context, viewport }), budget);
              if (this._destroyed) throw Object.assign(new Error("Reader closed"), { name: "AbortError" });
              return { src: canvas.toDataURL("image/jpeg", 0.82), textLayer };
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
      destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._pageText.length = 0;
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
      const pageCount = doc.numPages;
      const parts = [], textPages = [], pageText = [], pageKinds = [], outline = [];
      for (let i = 1; i <= pageCount; i++) {
        const part = await readPdfPage(doc, i, signal, onProgress, pageCount);
        pageKinds.push(part.kind);
        if (part.kind === "text" && part.aiText) textPages.push({ page: i, text: part.aiText });
        pageText.push(part.kind === "text" ? part.textFallback : "");
        parts.push(pdfPageShell({
          pageNumber: i,
          width: part.width,
          height: part.height,
          kind: part.kind,
          isLast: i === pageCount,
          textFallback: part.textFallback,
        }));
      }
      try {
        await collectPdfOutlineInto(doc, outline);
      } catch (e) {
        console.warn("UV Reader: PDF outline unavailable", e);
      }
      return {
        html: parts.join("\n"),
        lazy: createPdfLazyView(doc, loadingTask, pageText),
        outline,
        scan: pdfScanVerdict(pageKinds, { total: pageCount }),
        pdfDocumentContext: packPdfDocumentContext(textPages, PDF_AI_CONTEXT_MAX_CHARS),
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
