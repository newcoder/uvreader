// PdfPaginator assembly. The host supplies the  base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { PDF_ZOOM_DEFAULT, clampPdfZoom } from "./pdf-zoom.js";
import { READER_BLOCK_SELECTOR } from "./pdf-page-mode.js";
import { comfortableLineWidth } from "./reader-experience.js";
import { docOf } from "./reader-dom.js";
import { ensureBundledReaderFont } from "./bundled-fonts.js";
import { resolveReaderFont } from "./reader-appearance.js";
import { uiLanguageMetadata } from "./i18n-languages.js";
import { waitForReaderFrame } from "./reader-load.js";

export function createPdfPaginatorClass({
  FONTS, READER_FONTS, SHORT_PAGE_GAP, currentLanguage,
}) {
  return class PdfPaginator {
  constructor() {
    this.spread = 0;
    this.total = 0;
    this.sw = 0;  // stride per spread in px (float)
    this.pdfZoom = PDF_ZOOM_DEFAULT;
  }
  async build(area, bookHtml, cfg, anchorSpread) {
    // This paginator accepts PDF page surfaces only. Reflowable ebooks are
    // rendered and navigated exclusively by EpubEngine.
    if (!bookHtml.includes('class="qiaomu-reader-pdf-page-break')) throw new Error("PDF page surfaces required");
    await this._ensureFonts(docOf(area), cfg);
    const reuse = !!(this.flow && this.clip && this.flow.parentElement === this.clip
      && this.clip.parentElement === area && this._html === bookHtml);
    if (!reuse) area.empty();
    this._vAlign = cfg.vAlign || "top";
    this._vCache = this._blockGeom = null;
    this.scrollMode = (cfg.readMode || "pages") === "scroll";
    // Boolean by construction; also the animation-class flag below.
    this.animate = cfg.pageTurnAnimation !== false;
    this.clip = reuse ? this.clip : area.createDiv("qiaomu-reader-clip");
    this._bindClip(this.scrollMode);
    await this._nextFrame();
    await this._nextFrame();
    if (!area.offsetWidth) await this._delay(80);
    const box = this._measureArea(area);
    const geo = this._columnMetrics(box, cfg);
    this.flow = reuse ? this.flow : this.clip.createDiv("qiaomu-reader-flow");
    const cjk = this._isCjkLayout(cfg);
    this._styleFlow(cfg, geo, cjk);
    this._mountBookHtml(bookHtml, cfg, geo, cjk, reuse);
    await this._nextFrame();
    await this._nextFrame();
    this._fitPdfFigures(geo);
    const zoom = clampPdfZoom(this.pdfZoom);
    this.pdfZoom = zoom;
    this.flow.style.setProperty("--qiaomu-reader-pdf-zoom", String(zoom));
    await this._nextFrame();
    const endMarker = this.flow.querySelector(".qiaomu-reader-end");
    if (this.scrollMode) return this._finishScrollLayout(anchorSpread, box);
    return this._finishPagedLayout(anchorSpread, geo, endMarker);
  }
  async _ensureFonts(doc, cfg) {
    if (this.loadFont) await this.loadFont(doc, cfg);
    else await ensureBundledReaderFont(doc, cfg.fontFamily);
  }
  _nextFrame() {
    return waitForReaderFrame(window);
  }
  _delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  _bindClip(scroll) {
    const stale = this._scrollHandler;
    if (stale) this.clip.removeEventListener("scroll", stale);
    if (this._scrollT) window.clearTimeout(this._scrollT);
    for (const [prop, value] of [
      ["flex", "1"],
      ["align-self", "stretch"],
      ["position", "relative"],
      ["min-width", "0"],
      ["min-height", "0"],
    ]) this.clip.style.setProperty(prop, value);
    // Overflow stays with the stylesheet: hidden on .qiaomu-reader-clip, auto
    // on .qiaomu-reader-clip-scroll — the plain class switch is enough.
    this.clip.toggleClass("qiaomu-reader-clip-scroll", scroll);
  }
  _measureArea(area) {
    const width = this.clip.offsetWidth || area.offsetWidth || 390;
    const height = this.clip.offsetHeight || area.offsetHeight || 700;
    this.builtWidth = width;
    this.builtHeight = height;
    return { width, height };
  }
  _columnMetrics(box, cfg) {
    const fit = cfg.fitPage === true;
    const colCount = cfg.columns === "2" && box.width > 700 ? 2 : 1;
    const colGap = colCount === 2 ? 48 : 0;
    const edgePad = fit ? 16 : (colCount === 2 ? 48 : (box.width <= 600 ? 26 : box.width <= 820 ? 42 : 60));
    const padTop = Math.min(edgePad, 40);
    const slotWidth = box.width / colCount;
    const colWidth = this.scrollMode ? box.width : slotWidth - colGap;
    return {
      width: box.width,
      height: box.height,
      cols: colCount,
      gap: colGap,
      slot: slotWidth,
      colWidth,
      flowWidth: this.scrollMode ? box.width : 4000 * slotWidth - colGap,
      padTop,
      padBottom: padTop,
      innerHeight: box.height - padTop - padTop,
      sidePad: this._sidePad(cfg, colWidth, edgePad),
    };
  }
  _sidePad(cfg, colWidth, edgePad) {
    if (cfg.fitPage === true) return edgePad;
    let pad = edgePad;
    const target = comfortableLineWidth(Number(cfg.fontSize) || 18, Number(cfg.maxLineCh) || 0, this._isCjkLayout(cfg));
    if (target > 0 && target < colWidth - edgePad * 2) pad = Math.round((colWidth - target) / 2);
    return pad;
  }
  _isCjkLayout(cfg) {
    return uiLanguageMetadata(currentLanguage()).cjk || READER_FONTS[cfg.fontFamily]?.cjk === true;
  }
  _styleFlow(cfg, geo, cjk) {
    // Switching back from pagination must discard its measured translation.
    for (const property of ["transform", "column-width", "column-gap", "column-fill", "min-height"])
      this.flow.style.removeProperty(property);
    // Every dimension here is a build-time measurement, hence inline style.
    // No transition on purpose: .qiaomu-reader-flow-anim (added when layout
    // finishes) must own it or the sliding page turn breaks, and during
    // initial positioning there is no animation to want anyway.
    // Declared as property/value pairs because every dimension here is a
    // build-time measurement that themes must not be able to override.
    const flowStyle = [
      ["width", `${geo.flowWidth}px`],
      ["height", this.scrollMode ? "auto" : `${geo.innerHeight}px`],
      ...(this.scrollMode ? [["min-height", "100%"]] : []),
      ...(this.scrollMode ? [] : [
        ["column-width", `${geo.colWidth}px`],
        ["column-gap", `${geo.gap}px`],
        ["column-fill", "auto"],
      ]),
      ["left", this.scrollMode ? "0" : `${geo.gap / 2}px`],
      ["orphans", "1"],
      ["widows", "1"],
      ["padding", `${geo.padTop}px 0 ${geo.padBottom}px`],
      ["box-sizing", "content-box"],
      ["margin-top", "0"],
      ["font-family", resolveReaderFont(cfg, FONTS)],
      ...(cjk ? [["font-synthesis-style", "none"]] : []),
      ["font-size", `${cfg.fontSize}px`],
      ["line-height", String(cfg.lineHeight)],
      ["color", "var(--qiaomu-reader-text)"],
      ["background", "var(--qiaomu-reader-bg)"],
      ["overflow", "hidden"],
      ["user-select", "text"],
      ["-webkit-user-select", "text"],
      ["will-change", this.scrollMode ? "auto" : "transform"],
    ];
    for (const [prop, value] of flowStyle) this.flow.style.setProperty(prop, value);
  }
  _mountBookHtml(bookHtml, cfg, geo, cjk, reuse) {
    // extractPdf emits sanitized page surfaces; no ebook HTML enters here.
    const markup = `<style>\n${this._bookStyleCss(cfg, geo, cjk)}\n</style>${bookHtml}<div class="qiaomu-reader-end" aria-hidden="true"></div>`;
    if (reuse) return;
    const parser = new DOMParser();
    const parsed = parser.parseFromString(markup, "text/html");
    this.flow.replaceChildren();
    for (const host of [parsed.head, parsed.body]) {
      for (const child of [...host.childNodes]) this.flow.appendChild(document.importNode(child, true));
    }
    this._html = bookHtml;
  }
  _bookStyleCss(cfg, geo) {
    const innerH = geo.innerHeight;
    return [
      // The page is its own zoom/pan scroller. Its scrollbars are hidden (they
      // would otherwise take width and force a second, horizontal bar); wheel
      // and drag panning still work.
      ".qiaomu-reader-flow .qiaomu-reader-pdf-page-break{width:100%;height:100%;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:flex-start;overflow:auto;overscroll-behavior:contain;break-inside:avoid;-webkit-column-break-inside:avoid;scrollbar-width:none}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-page-break::-webkit-scrollbar{display:none}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-page-break:not(.qiaomu-reader-pdf-last-page){break-after:column;-webkit-column-break-after:always}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-native-page{flex:none;margin:auto;padding:0;max-width:none;max-height:none;text-align:center;position:relative;"
        + "width:calc(var(--qiaomu-reader-pdf-fit-width,0px) * var(--qiaomu-reader-pdf-zoom,1));"
        + "height:calc(var(--qiaomu-reader-pdf-fit-height,0px) * var(--qiaomu-reader-pdf-zoom,1))}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-page-surface{position:relative;display:block;max-width:none;max-height:none;line-height:0;transform-origin:0 0;"
        + "transform:scale(var(--qiaomu-reader-pdf-zoom,1));"
        + "background:#fff;border:1px solid var(--qiaomu-reader-border);border-radius:4px;overflow:hidden;"
        + "box-shadow:0 8px 28px color-mix(in srgb,#000 12%,transparent)}",
      `.qiaomu-reader-flow .qiaomu-reader-pdf-page-img{max-width:100%;max-height:${innerH - 4}px;width:auto;height:auto;object-fit:contain;display:block;`
        + "margin:0;border:0;border-radius:0;break-inside:avoid;-webkit-column-break-inside:avoid;pointer-events:none}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer{color-scheme:only light;position:absolute;inset:0;width:100%!important;height:100%!important;overflow:clip;"
        + "text-align:initial;line-height:1;letter-spacing:normal;word-spacing:normal;text-size-adjust:none;"
        + "-webkit-text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:1;"
        + "--total-scale-factor:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));"
        + "--min-font-size-inv:calc(1 / var(--min-font-size))}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;"
        + "user-select:text;-webkit-user-select:text}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer>.markedContent{display:contents}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer>:not(.markedContent),.qiaomu-reader-flow .qiaomu-reader-pdf-text-layer .markedContent span:not(.markedContent){"
        + "z-index:1;--font-height:0;--scale-x:1;--rotate:0deg;"
        + "font-size:calc(var(--text-scale-factor) * var(--font-height));"
        + "transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer .qiaomu-reader-hl{position:static;color:transparent;white-space:inherit;transform:none}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-text-layer::selection,.qiaomu-reader-flow .qiaomu-reader-pdf-text-layer *::selection{color:transparent;"
        + "background:color-mix(in srgb,var(--interactive-accent) 32%,transparent)}",
      ".qiaomu-reader-flow .qiaomu-reader-pdf-render-error::after{content:attr(data-pdf-error);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"
        + "padding:24px;box-sizing:border-box;color:#8b1e1e;background:#fff4f3;font:14px/1.5 var(--font-interface)}",
      ".qiaomu-reader-clip-scroll .qiaomu-reader-flow .qiaomu-reader-pdf-page-break{height:auto;min-height:0;padding:12px 0 24px;overflow:visible;break-after:auto}",
      ".qiaomu-reader-flow .qiaomu-reader-end{display:block;height:0;margin:0;padding:0;border:0;visibility:hidden}",
    ].join("\n");
  }
  _fitPdfFigures(geo) {
    // A lazy PDF surface is inline-block around an img without src; measuring
    // the surface itself yields a circular 34px shrink-to-fit box, so size
    // everything from the declared column instead.
    const figMaxH = Math.max(40, geo.innerHeight - 4);
    const lazyImgs = this.flow.querySelectorAll("img.qiaomu-reader-pdf-lazy");
    for (const img of lazyImgs) {
      const natW = parseFloat(img.getAttribute("width")) || 0;
      const natH = parseFloat(img.getAttribute("height")) || 0;
      if (!natW || !natH) continue;
      const frame = img.parentElement;
      const maxW = Math.max(40, geo.colWidth - geo.sidePad * 2);
      const fit = Math.min(1, maxW / natW, figMaxH / natH);
      const w = Math.round(natW * fit);
      const h = Math.round(natH * fit);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      if (frame && frame.classList.contains("qiaomu-reader-pdf-page-surface")) {
        frame.style.width = `${w}px`;
        frame.style.height = `${h}px`;
        const pageFig = frame.closest(".qiaomu-reader-pdf-native-page");
        if (pageFig) {
          // The surface border sits outside its content box; count it in the
          // scroll extent so fit-page never shows a pointless two-pixel bar.
          pageFig.style.setProperty("--qiaomu-reader-pdf-fit-width", `${w + 2}px`);
          pageFig.style.setProperty("--qiaomu-reader-pdf-fit-height", `${h + 2}px`);
        }
      }
      const textLayer = frame?.querySelector(".qiaomu-reader-pdf-text-layer");
      if (textLayer) textLayer.style.setProperty("--total-scale-factor", String(fit));
    }
  }
  _finishScrollLayout(anchorSpread, box) {
    this.sw = box.height;
    this._pitch = this.sw; this.cols = 1; this._colX = null;
    const viewportH = this.clip.clientHeight || box.height;
    this.total = Math.max(1, Math.ceil((this.clip.scrollHeight || viewportH) / viewportH));
    this.spread = Math.max(0, Math.min(anchorSpread, this.total - 1));
    this.flow.toggleClass("qiaomu-reader-flow-anim", this.animate);
    this.applyTransform(false); this._watchScroll(); return [this.spread, this.total];
  }
  _watchScroll() {
    this._scrollHandler = () => {
      if (this._scrollT) window.clearTimeout(this._scrollT);
      this._scrollT = window.setTimeout(() => this._syncScrollSpread(), 140);
    };
    const passiveOpts = { passive: true };
    this.clip.addEventListener("scroll", this._scrollHandler, passiveOpts);
  }
  _syncScrollSpread() {
    const stepH = this.clip.clientHeight || 1;
    const at = Math.max(0, Math.min(Math.round(this.clip.scrollTop / stepH), this.total - 1));
    this.spread = at; if (this.onSpreadChange) this.onSpreadChange(at, this.total);
  }
  async _finishPagedLayout(anchorSpread, geo, endMarker) {
    let nPhys = this._countColumns(endMarker, geo.slot);
    this.flow.style.width = `${Math.ceil(nPhys * geo.slot) - geo.gap}px`;
    await this._nextFrame();
    await this._nextFrame();
    nPhys = Math.max(nPhys, this._countColumns(endMarker, geo.slot));
    this.sw = geo.slot * geo.cols;
    this.cols = geo.cols;
    this._pitch = geo.slot; this._colX = null;
    this._captureColumnStarts(endMarker, nPhys, geo.slot);
    this.total = Math.max(1, Math.ceil(nPhys / geo.cols));
    this.spread = Math.max(0, Math.min(anchorSpread, this.total - 1));
    this.flow.toggleClass("qiaomu-reader-flow-anim", this.animate);
    this.applyTransform(false); return [this.spread, this.total];
  }
  _countColumns(endMarker, slotWidth) {
    const flowRect = this.flow.getBoundingClientRect();
    let lastX = endMarker ? endMarker.getBoundingClientRect().right - flowRect.left : 0;
    if (lastX <= 0) for (const el of this.flow.querySelectorAll(
      "p,h1,h2,h3,h4,h5,h6," + "img,li,pre,table,blockquote,figure,dd,dt")) {
      const right = el.getBoundingClientRect().right - flowRect.left;
      if (right > lastX) lastX = right;
    }
    return Math.max(1, Math.ceil(lastX / slotWidth));
  }
  _captureColumnStarts(endMarker, nPhys, slotWidth) {
    // Clamped widths or late font swaps can leave real block starts off the
    // ideal slot grid; remember each column's actual first-block x so
    // _spreadOffset can snap to it instead of assuming uniform slots.
    try {
      const flowRect = this.flow.getBoundingClientRect();
      const endX = endMarker ? endMarker.getBoundingClientRect().left - flowRect.left : 0;
      if (!endMarker || Math.abs(endX - (nPhys - 1) * slotWidth) <= 1) return;
      this._colX = new Map();
      const blocks = this.flow.querySelectorAll(READER_BLOCK_SELECTOR);
      for (const el of blocks) {
        const x = el.getBoundingClientRect().left - flowRect.left;
        const k = Math.round(x / slotWidth);
        const prev = this._colX.get(k);
        if (prev === undefined || x < prev) this._colX.set(k, x);
      }
    } catch { this._colX = null; }
  }
  _vOffset() {
    const mode = this._vAlign || "top";
    if (mode === "top" || !this.flow) return 0;
    if (!this._vCache) this._vCache = /* @__PURE__ */ new Map();
    if (this._vCache.has(this.spread)) return this._vCache.get(this.spread);
    this._vCache.set(this.spread, Math.round(this._verticalSlack(mode)));
    return this._vCache.get(this.spread);
  }
  // Free space under the deepest block of the visible spread; geometry is
  // measured once per layout and reused across spreads.
  _verticalSlack(mode) {
    try {
      this._ensureBlockGeometry();
      const from = this._spreadOffset(), to = from + this.sw;
      let maxBottom = 0;
      for (const g of this._blockGeom) if (g.x >= from - 2 && g.x < to - 2 && g.bottom > maxBottom) maxBottom = g.bottom;
      const height = this.flow.clientHeight || 0;
      if (maxBottom > 0 && height > 0) {
        const leftover = height - maxBottom;
        if (leftover > height * SHORT_PAGE_GAP) return mode === "center" ? leftover / 2 : leftover;
      }
      return 0;
    } catch { return 0; }
  }
  _ensureBlockGeometry() {
    if (this._blockGeom) return;
    const fRect = this.flow.getBoundingClientRect();
    this._blockGeom = [...this._blocks()].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - fRect.left, bottom: r.bottom - fRect.top };
    });
  }
  _spreadOffset() {
    if (this.scrollMode) return this.clip ? this.clip.scrollTop : 0;
    const k = this.spread * (this.cols || 1);
    const exact = this._colX && this._colX.get(k);
    if (typeof exact === "number") return exact;
    if (this._colX && this._colX.size) {
      let bestK = null;
      for (const kk of this._colX.keys()) {
        if (bestK === null || Math.abs(kk - k) < Math.abs(bestK - k)) bestK = kk;
      }
      if (bestK !== null) return this._colX.get(bestK) + (k - bestK) * (this._pitch || this.sw / (this.cols || 1));
    }
    return this.spread * this.sw;
  }
  applyTransform(animate = true) {
    if (this.scrollMode) {
      const viewH = this.clip.clientHeight || 1;
      this.clip.scrollTo({ top: this.spread * viewH, behavior: animate ? "smooth" : "auto" });
      return;
    }
    this.flow.style.top = this._vOffset() + "px";
    const t = `translate3d(${-Math.round(this._spreadOffset())}px, 0, 0)`;
    if (!animate) {
      this.flow.removeClass("qiaomu-reader-flow-anim");
      this.flow.getBoundingClientRect();
      this.flow.style.transform = t;
      window.requestAnimationFrame(() => this.flow.toggleClass("qiaomu-reader-flow-anim", this.animate !== false));
    } else {
      this.flow.style.transform = t;
    }
  }
  next() {
    if (this.spread < this.total - 1)
      this.spread++;
    this.applyTransform();
    return [this.spread, this.total];
  }
  prev() {
    if (this.spread > 0)
      this.spread--;
    this.applyTransform();
    return [this.spread, this.total];
  }
  goTo(s, animate = true) {
    this.spread = Math.max(0, Math.min(s, this.total - 1));
    this.applyTransform(animate);
    return [this.spread, this.total];
  }
  jumpTo(s) { return this.goTo(s, false); }
  _blocks() { return this.flow ? this.flow.querySelectorAll(READER_BLOCK_SELECTOR) : []; }
  _blockIndexAtScroll() {
    const blocks = this._blocks();
    if (!blocks.length || !this.clip) return 0;
    const fTop = this.flow.getBoundingClientRect().top;
    const want = this.clip.scrollTop - 2;
    const topAt = (i) => blocks[i].getBoundingClientRect().top - fTop;
    let lo = 0, hi = blocks.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (topAt(mid) >= want) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans > 0 && blocks[ans - 1].getBoundingClientRect().bottom > this.clip.getBoundingClientRect().top ? ans - 1 : ans;
  }
  currentBlockIndex() {
    // A scan page deliberately has no text anchor. Returning paragraph zero
    // here would make saveProgress prefer a fake block over the real percentage
    // and reopen an image-only PDF at the beginning every time.
    const pdfPage = this.currentPdfPageElement();
    if (pdfPage) {
      if (pdfPage.getAttribute("data-pdf-page-kind") !== "text") return -1;
      const pdfBlock = pdfPage.querySelector(READER_BLOCK_SELECTOR);
      return pdfBlock ? [...this._blocks()].indexOf(pdfBlock) : -1;
    }
    if (this.scrollMode) return this._blockIndexAtScroll();
    const blocks = this._blocks();
    if (!blocks.length || !this.sw) return -1;
    const fLeft = this.flow.getBoundingClientRect().left;
    const winLeft = this._spreadOffset() - 2;
    const xat = (i) => blocks[i].getBoundingClientRect().left - fLeft;
    let lo = 0, hi = blocks.length - 1, ans = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xat(mid) >= winLeft) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  }
  // First source PDF page in the current viewport. Unlike text blocks, every
  // PDF page has this anchor, including scans, so status and progress do not
  // depend on OCR being available.
  currentPdfPageElement() {
    if (!this.flow) return null;
    const pages = [...this.flow.querySelectorAll(".qiaomu-reader-pdf-page-break[data-pdf-page-no]")];
    if (!pages.length) return null;
    if (this.scrollMode && this.clip) {
      const viewport = this.clip.getBoundingClientRect();
      const at = viewport.top + 4;
      return pages.find((page) => {
        const rect = page.getBoundingClientRect();
        return rect.bottom > at && rect.top < viewport.bottom - 1;
      }) || pages[pages.length - 1];
    }
    const flowLeft = this.flow.getBoundingClientRect().left;
    const from = this._spreadOffset() - 2;
    const to = from + (this.sw || Number.MAX_SAFE_INTEGER);
    let first = null;
    let firstX = Number.POSITIVE_INFINITY;
    for (const page of pages) {
      const x = page.getBoundingClientRect().left - flowLeft;
      if (x >= from && x < to && x < firstX) {
        first = page;
        firstX = x;
      }
    }
    return first || pages[0];
  }
  currentPdfPageNumber() {
    const page = this.currentPdfPageElement();
    const value = page ? parseInt(page.getAttribute("data-pdf-page-no"), 10) : NaN;
    return Number.isFinite(value) ? value : null;
  }
  spreadForBlock(idx) { // block index -> spread index, in either layout mode
    const block = this.blockEl(idx);
    const pdfPage = block?.closest?.(".qiaomu-reader-pdf-page-break[data-pdf-page-no]");
    if (pdfPage && this.flow) {
      const flowRect = this.flow.getBoundingClientRect();
      const pageRect = pdfPage.getBoundingClientRect();
      if (this.scrollMode) {
        const rowHeight = this.clip?.clientHeight || 1;
        return Math.max(0, Math.min(Math.floor((pageRect.top - flowRect.top) / rowHeight), this.total - 1));
      }
      return Math.max(0, Math.min(Math.round((pageRect.left - flowRect.left) / (this.sw || 1)), this.total - 1));
    }
    return this.scrollMode ? this._scrollSpreadForBlock(idx) : this._pagedSpreadForBlock(idx);
  }
  _scrollSpreadForBlock(idx) {
    const blocks = this._blocks(); if (!blocks.length || idx < 0) return 0;
    const anchor = blocks[Math.min(idx, blocks.length - 1)];
    const top = anchor.getBoundingClientRect().top - this.flow.getBoundingClientRect().top;
    const rowHeight = this.clip.clientHeight || 1;
    return Math.max(0, Math.min(Math.floor(top / rowHeight), this.total - 1));
  }
  _pagedSpreadForBlock(idx) {
    const blocks = this._blocks(); if (!blocks.length || !this.sw || idx < 0) return 0;
    const anchor = blocks[Math.min(idx, blocks.length - 1)];
    const offsetX = anchor.getBoundingClientRect().left - this.flow.getBoundingClientRect().left;
    const column = Math.round(offsetX / (this.sw / (this.cols || 1)));
    return Math.max(0, Math.min(Math.floor(column / (this.cols || 1)), this.total - 1));
  }
  blockEl(idx) {
    const blocks = this._blocks();
    if (!blocks.length) return null;
    return blocks[Math.min(Math.max(0, idx), blocks.length - 1)] || null;
  }
  get currentSpread() {
    return this.spread;
  }
  get currentPct() {
    return this.total > 1 ? this.spread / (this.total - 1) : 0;
  }
  get totalSpreads() {
    return this.total;
  }
};
}
