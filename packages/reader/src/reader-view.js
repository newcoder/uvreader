// Reader view assembly. The host supplies the ItemView base class, menus,
// notices and the reader's own helper functions so the module can run outside
// Obsidian; pure helpers are imported directly.
import { EpubEngine } from "./reader-engine.js";
import { PDF_ZOOM_DEFAULT, pdfZoomShortcut } from "./pdf-zoom.js";
import { createImageZoom } from "./image-zoom.js";
import { imageMimeType, isImageBookFile } from "./image-book.js";
import { READER_BLOCK_SELECTOR } from "./pdf-page-mode.js";
import { captureReadingAnchor, queueReadingLayout, restoreReadingAnchor } from "./reader-experience.js";
import { createReaderLoadCoordinator, isReaderLoadAbort, waitForReaderFrame } from "./reader-load.js";
import { docOf } from "./reader-dom.js";
import { jumpToEngineHighlight } from "./highlight-navigation.js";
import { readerTextCss, resolveReaderFont, syncPageButtons } from "./reader-appearance.js";
import { svgIcon } from "./reader-icons.js";
import { pinyinPinFor, renderEnginePins, togglePinyinPin } from "./pinyin-pins.js";
import { warmWordGlosses } from "./pinyin-annotate.js";
import { columnDragActive, installColumnDragWatch, onColumnDrag } from "./column-drag.js";
import { pageForBlock } from "./toc-build.js";
import { createPdfFormController } from "./pdf-form.js";

export function createReaderView({
  ItemView, Notice, TFile, setIcon, AI_CHAT_VIEW_TYPE, BookSetupModal, FONTS, InfoModal, ReadSettingsModal, SignaturePickerModal, VIEW_TYPE, addBookFileMenu, attachEngineChrome, attachReaderContentClick, attachReaderSwipeNav, bookNoteAction, buildFindPanelFor, buildReaderPageArea, buildReaderPanels, buildReaderSettPanelBody, buildReaderTopBar, buildTocItems, buildTocPanelFor, clearAiSource, clearFoundIn, createPdfPaginator, createPdfZoomControls, currentBookPage, enrichHighlights, ensureSelectedReaderFont, exportHighlightsMenu,   flowSelectionParts, handleReaderWheel, hidePinPopup, hlColorCss, loadReaderDocument, locateHl, markFoundIn, navigateEngineToc, openEngineHighlightPopup, openEnginePinPopup, pageJump, pdfVisiblePageLabel, pdfZoom, persistCurrentReaderPosition, qiaomuReaderClearPaintedSelection, qiaomuReaderLocale, qiaomuReaderRevealWhenSettled, qiaomuReaderTheme, qiaomuReaderTranslate, raiseSelectionPopup, readerAiPanelContext, readerHud, readerIsPdf, readerPaginationMappingCollapsed, readerPdfPages, readerTimer, rememberReaderJump, renderHighlightPanel, renderReaderLoadError, backfillPdfTextLayers, refreshReaderPdfTextLayer, renderVisibleFigures, resolveHighlightAnchor, restoreAiSource, restoreEngineHistory, selectionHud, setReaderTitle, setReadingFocus, settleReader, syncNavigationPanel, syncOpenAiReaderContext, syncOpenAiSelectionContext, syncReaderAiCapability,   unwrapAllHighlights, unwrapAllPins, updateEngineLocation, wireReaderChrome, wrapBlockRange, pdfFormBridge = null,
}) {
  return class ReaderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.file = null;
    this.ext = null;
    this.plugin = plugin;
    this.pdfFormBridge = pdfFormBridge;
    this.pdfZoom = PDF_ZOOM_DEFAULT;
    this.pager = createPdfPaginator(this);
    this._loadCoordinator = createReaderLoadCoordinator();
    this.bookHtml = "";
    this.pdfDocumentContext = null;
    this._pdfHasForm = false;
    this._pdfFormKnown = false;
    this._pdfFormReady = null;
    this.tocItems = [];
    this.panelOpen = null;
    this._resizeTimer = null;
    this._lastWidth = 0;
    this._pendingSel = null;
    this._editHlId = null;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    addBookFileMenu(this.app, menu, this.file, this.plugin);
  }
  getDisplayText() {
    let _a, _b;
    return (_b = (_a = this.file) == null ? void 0 : _a.basename) != null ? _b : "UV Reader";
  }
  getIcon() {
    return "book-open";
  }
  getState() {
    let _a, _b;
    const p = (_b = (_a = this.file) == null ? void 0 : _a.path) != null ? _b : "";
    return { file: p, path: p };
  }
  async setState(state, _result) {
    const path5 = (state == null ? void 0 : state.file) != null ? state.file : state == null ? void 0 : state.path;
    if (!path5)
      return;
    if (this.file && this.file.path === path5 && this.bookHtml)
      return;
    const f = this.app.vault.getAbstractFileByPath(path5);
    if (f instanceof TFile)
      await this.openFile(f);
  }
  async onOpen() { // chrome, resize watching and workspace hooks
    this.buildDOM();
    this.registerDomEvent(docOf(this.contentEl), "visibilitychange", () => renderVisibleFigures(this));
    const obs = this._resizeObs = new ResizeObserver(() => this._onAreaResized());
    obs.observe(this.areaEl);
    this._columnDragWatchOff = installColumnDragWatch(this.app?.workspaceEl || this.contentEl);
    this._columnDragOff = onColumnDrag((active) => {
      if (active) {
        // A reflow queued just before the drag would land mid-drag; the drag
        // end re-checks the width and lands it then.
        if (this._resizeTimer) { this._columnDragResized = true; window.clearTimeout(this._resizeTimer); this._resizeTimer = null; }
        return;
      }
      this._afterColumnDrag();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this._repaginateWhenWidthStale()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this._onLeafSwitch(leaf)));
  }
  // The throttle keeps quiet while the view is hidden or the geometry merely
  // jitters within a few pixels; only a real change schedules a reflow.
  _resizeAlreadySettled(width) {
    return Math.abs(width - (this._laidOutWidth || 0)) < 8
      && Math.abs(this.areaEl.clientHeight - (this.pager.builtHeight || 0)) < 8;
  }
  _onAreaResized() {
    if (!this.bookHtml || this._openingBook || this._closed || this.containerEl.offsetParent === null) return;
    if (this.engine) { this._setRelayout(false); return; }
    if (this._imageZoom) { this._setRelayout(false); return; }
    const width = this.areaEl.clientWidth;
    if (!width || this._resizeAlreadySettled(width)) return;
    // A divider drag changes the width frame by frame. Hold the reflow (and
    // the blur veil) until the pointer is released so the divider keeps up.
    if (columnDragActive()) { this._columnDragResized = true; return; }
    window.clearTimeout(this._resizeTimer);
    const delay = this.app?.isMobile ? 500 : 260;
    this._resizeTimer = window.setTimeout(() => this._repaginateAfterResize(), delay);
  }
  _repaginateAfterResize() {
    const width = this.areaEl.clientWidth;
    if (!width || this.containerEl.offsetParent === null || this._resizeAlreadySettled(width)) {
      this._setRelayout(false); return;
    }
    void this.repaginate();
  }
  // Pointer released: land the reflow the divider drag held back.
  _afterColumnDrag() {
    if (!this._columnDragResized) return;
    this._columnDragResized = false;
    window.clearTimeout(this._resizeTimer);
    this._repaginateAfterResize();
  }
  _repaginateWhenWidthStale() {
    if (this._layoutWidthStale()) void this.repaginate();
  }
  _onLeafSwitch(leaf) {
    if (leaf === this.leaf) {
      this._repaginateWhenWidthStale();
      void renderVisibleFigures(this);
      syncOpenAiReaderContext(this);
      void this.plugin._showCompanionForBook(this);
      return;
    }
    this._hideHlPopup(); const isAiChat = leaf?.view?.getViewType?.() === AI_CHAT_VIEW_TYPE;
    if (!isAiChat || leaf.getRoot() !== this.app.workspace.rightSplit) setReadingFocus(this, false);
    if (!isAiChat) clearAiSource(this);
  }
  async openFile(file) { // swap in another book: reset view state, show the loading card, load and render
    const pendingPosition = persistCurrentReaderPosition(this);
    const loadToken = this._loadCoordinator.begin();
    this._openingBook = loadToken;
    this._layoutAgain = false;
    await pendingPosition;
    if (this._layoutPromise) await this._layoutPromise.catch(() => {});
    if (!this._loadCoordinator.isCurrent(loadToken)) return;
    clearAiSource(this);
    readerHud.hideReturn(this);
    this._readingAnchor = null;
    this._layoutAgain = false;
    this.pdfZoomMode = "page";
    pdfZoom.setPanMode(this, false);
    this._releaseEngine();
    this._resetBookState(file);
    const statusLabel = this._showLoadingCard();
    await this._waitFrame(); await this._waitFrame();
    try {
      await this._loadBookIntoView(file, loadToken, statusLabel);
    } catch (e) {
      if (isReaderLoadAbort(e, loadToken.signal) || !this._loadCoordinator.isCurrent(loadToken)) return;
      console.error("UV Reader: could not open file", e);
      readerHud.hideVeil(this);
      this.areaEl.removeClass("qiaomu-reader-booting");
      renderReaderLoadError(this, e, () => this.openFile(file));
    } finally {
      this._loadCoordinator.finish(loadToken);
      if (this._openingBook === loadToken) {
        this._openingBook = null;
        settleReader(this);
        void this.plugin._showCompanionForBook(this);
        if (this._layoutWidthStale()) void this.repaginate();
      }
    }
  }
  _resetBookState(file) {
    this.file = file; this.ext = file.extension;
    this._releaseImage();
    if (this.fitBtn) {
      this.fitBtn.setAttribute("aria-label", qiaomuReaderTranslate("fit-page"));
      this.fitBtn.setAttribute("aria-pressed", String(this.plugin.settings.fitPage === true));
    }
    this._pdfHasForm = false;
    this._pdfFormKnown = false;
    this._pdfFormReady = null;
    this._pdfForm?.setFile(file);
    this._syncPdfFormControls();
    this.locEl?.setText(""); this.pctEl?.setText("0%");
    if (this.pbarFill) this.pbarFill.style.removeProperty("width");
    this._findCorpus = null; this._clearFound();
    this.buildFindPanel(); this.bookHtml = "";
    this.pdfDocumentContext = null; this.tocItems = []; this._tocOriginalItems = null;
    this._epubTocScan = null; this._epubTocDraft = null;
    this._disposePdfLazy();
    this.pager = createPdfPaginator(this); this._pdfOutline = null;
    this.pdfZoom = PDF_ZOOM_DEFAULT;
    this.pager.pdfZoom = this.pdfZoom;
    if (this.aiBtn) this.aiBtn.hidden = true;
    pdfZoom.syncControls(this);
    setReaderTitle(this.titleEl, file.basename);
    this.applyVars(); readerHud.hideVeil(this);
    this.areaEl.removeClass("qiaomu-reader-booting");
  }
  _disposePdfLazy() {
    const lazy = this._pdfLazy;
    if (lazy?.destroy) lazy.destroy(); this._pdfLazy = null;
  }
  _releaseImage() {
    this._imageZoom?.destroy?.();
    this._imageZoom = null;
    if (this._imageUrl) {
      try { URL.revokeObjectURL(this._imageUrl); } catch { /* already gone */ }
      this._imageUrl = null;
    }
  }
  _releaseEngine() {
    this._selectionMenu?.hide();
    this._hideHlPopup();
    window.clearTimeout(this._engineSelTimer);
    this._releaseImage();
    this.engine?.destroy?.();
    this.engine = null;
    this._engineLocation = null;
  }
  _showLoadingCard() {
    this.areaEl.empty(); const loading = this.areaEl.createDiv("qiaomu-reader-loading");
    loading.createDiv("qiaomu-reader-spin");
    const label = loading.createDiv("qiaomu-reader-loading-text");
    label.setText(qiaomuReaderTranslate("loading-the-book"));
    return label;
  }
  _waitFrame() {
    return waitForReaderFrame(window);
  }
  async _loadBookIntoView(file, loadToken, statusLabel) {
    let result = null;
    this._cancelTextLayerJob();
    this._hideOcrBar();
    const reportProgress = (done, total) => {
      if (this._loadCoordinator.isCurrent(loadToken))
        statusLabel.setText(qiaomuReaderTranslate("preparing-the-book-0", Math.round(done / total * 100)));
    };
    // PDFs read from the generated searchable copy when one is recorded, while
    // the book identity stays on the original file.
    const sourceFile = file.extension === "pdf" ? await this.plugin.pdfSourceFile?.(file.path).catch(() => null) : null;
    if (!this._loadCoordinator.isCurrent(loadToken)) return;
    result = await loadReaderDocument(file, this.app, this.plugin.settings, reportProgress, { signal: loadToken.signal, sourceFile });
    if (!this._loadCoordinator.isCurrent(loadToken)) { result.lazy?.destroy?.(); return; }
    if (result.image) {
      // A standalone image gets the whole reading area. It is not a book
      // document, so the paginator and foliate are deliberately bypassed.
      this.bookHtml = "image";
      this.pdfDocumentContext = null;
      this._pdfLazy = null;
      this._pdfOutline = null;
      await this.plugin.ensureReadingFolder(file.path);
      await this.plugin.refreshProgress(file.path);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      this._mountImage(result, file);
      this.tocItems = [];
      this.buildTocPanel();
      this.pager.total = 1;
      this.pager.spread = 0;
      this.updateUI(0, 1);
    } else if (result.engine) {
      // Engine formats render through foliate-js; the custom pagination
      // pipeline is not involved at all.
      this.bookHtml = "engine";
      this.pdfDocumentContext = null;
      this._pdfLazy = null;
      this._pdfOutline = null;
      await this.plugin.ensureReadingFolder(file.path);
      await this.plugin.refreshProgress(file.path);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      const savedEngine = this.plugin.getProgress(file.path);
      await this._mountEngine(result, file, savedEngine, loadToken);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      this.tocItems = await this._engineTocItemsWithGenerated(file);
      this.buildTocPanel();
      await this.plugin.refreshHighlights(file.path);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      this._renderEngineHighlights();
      this._renderEnginePins();
    } else {
      this._adoptPdfResult(result);
      // A generated TOC (from the AI tools) wins over the embedded outline
      // while its stamp still matches the file it was built from.
      const stat = file?.stat || {};
      const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
      const generated = await Promise.resolve(this.plugin.loadGeneratedToc?.(file.path, stamp)).catch(() => null);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      const outline = generated?.entries?.length
        ? generated.entries.flatMap((item) => {
          const level = item.level || 1;
          if (item.page2 && item.page !== item.page2) {
            return [
              { label: `${item.title}（${qiaomuReaderTranslate("toc-exercises")}）`, page: item.page || undefined, level },
              { label: `${item.title}（${qiaomuReaderTranslate("toc-answers")}）`, page: item.page2, level },
            ];
          }
          return [{ label: item.title, page: item.page || undefined, level }];
        }).sort((a, b) => (Number.isFinite(a.page) ? a.page : 1e9) - (Number.isFinite(b.page) ? b.page : 1e9))
        : this._pdfOutline;
      this.tocItems = buildTocItems(this.bookHtml, outline); this.buildTocPanel();
      await this.plugin.ensureReadingFolder(file.path);
      await this.plugin.refreshProgress(file.path); if (!this._loadCoordinator.isCurrent(loadToken)) return;
      await this.plugin.refreshHighlights(file.path); if (!this._loadCoordinator.isCurrent(loadToken)) return;
      const savedPosition = this.plugin.getProgress(file.path);
      const startPct = savedPosition && savedPosition.pct != null ? savedPosition.pct : 0;
      await this.paginate(startPct, savedPosition?.block, loadToken);
      if (!this._loadCoordinator.isCurrent(loadToken)) return;
      void this._maybeGenerateTextLayer(result, file);
    }
    this._finishBookOpen(file);
  }
  _adoptPdfResult(result) {
    this.bookHtml = result.html;
    this.pdfDocumentContext = result.pdfDocumentContext || null;
    this._pdfLazy = result.lazy;
    this._pdfOutline = result.outline;
    // Text, scan verdict and the AI context keep filling in after the first
    // frame; `_maybeGenerateTextLayer` waits for this before starting OCR.
    this._pdfTextReady = result.whenTextReady || null;
    this._pdfHasForm = false;
    this._pdfFormKnown = false;
    this._pdfForm?.setFile(this.file);
    this._syncPdfFormControls();
    const file = this.file;
    const formReady = result.whenFormReady;
    this._pdfFormReady = formReady && typeof formReady.then === "function" ? formReady : null;
    if (!this._pdfFormReady) {
      this._pdfFormKnown = true;
      return;
    }
    void this._pdfFormReady.then((hasForm) => {
      if (!this.file || this.file.path !== file.path) return;
      this._pdfHasForm = Boolean(hasForm);
      this._pdfFormKnown = true;
      if (this._pdfHasForm) this._closeReadingChromeForForm();
      this._syncPdfFormControls();
    }).catch(() => {
      if (this.file?.path === file.path) this._pdfFormKnown = true;
    });
  }
  // A fillable form is a task view: no companion, outline or reading panel
  // should compete with the page. They remain available from their buttons.
  _closeReadingChromeForForm() {
    this.closePanel();
    try { this.hlDockPanel?.close?.(); } catch { /* optional dock */ }
    try { this.plugin?.closeReadingCompanion?.(); } catch { /* optional host */ }
    try { this.plugin?.app?.qbrDesktopCloseToc?.(this); } catch { /* optional host */ }
  }
  _syncPdfFormControls() {
    const pdf = this.file?.extension === "pdf";
    // Ordinary PDFs have no fillable AcroForm fields; keep the whole form
    // action group out of the toolbar instead of showing a dead fill button.
    // A signed save locks the current session until the file is reopened.
    const form = this._pdfForm;
    const available = Boolean(pdf && this.pdfFormBridge && this._pdfHasForm && !form?.isLocked);
    if (this.pdfFormFillBtn) {
      this.pdfFormFillBtn.hidden = !available;
      this.pdfFormFillBtn.setAttribute("aria-pressed", String(Boolean(form?.isActive)));
    }
    if (this.pdfFormSignBtn) this.pdfFormSignBtn.hidden = !(available && form?.isActive);
    if (this.pdfFormSaveBtn) this.pdfFormSaveBtn.hidden = !(available && form?.isActive);
  }
  // ── scanned-PDF text layer ────────────────────────────────────────────────
  // The scan opens for reading immediately; its text layer is generated page by
  // page in the background (current page first, then its neighbours, then the
  // rest) and becomes searchable/selectable as each page arrives. Nothing has
  // to be reopened and the original file stays the reading source.
  async _maybeGenerateTextLayer(result, file) {
    // The page pass runs in the background, so the verdict only exists once it
    // finishes; waiting here keeps OCR from racing the first paint.
    const ready = await (this._pdfTextReady || result?.whenTextReady || Promise.resolve(null)).catch(() => null);
    if (ready) {
      this._pdfTextReady = null;
      if (!this.pdfDocumentContext) this.pdfDocumentContext = ready.pdfDocumentContext || null;
      // 文字刚到位:立刻把每一页的空文字层补上(不依赖扫页经过那一页),否则远处的页面
      // 在 DOM 里永远"没有文字"(查找/跨页选择/断言都读不到)。
      try { backfillPdfTextLayers(this); } catch { /* 补文字失败不影响阅读 */ }
      // The text pass just filled page text for the whole document: drop the
      // search corpus so a later search covers every page, and refresh an open
      // find panel the way the OCR pass does.
      this._findCorpus = null;
      if (this._foundQuery && this._findInput?.value) {
        this._findInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    // Any page without a text layer is worth generating (a scanned book, or the
    // scanned few pages of an otherwise digital one); fully digital files skip
    // the pass entirely.
    const scan = ready?.scan || result?.scan;
    if (!scan || !(scan.total > 0) || scan.textPages >= scan.total) return;
    if (!file || file.extension !== "pdf") return;
    // The layer was already generated for this exact file: replay it from the
    // sidecar cache WITHOUT the progress bar. The text itself lives in the OCR
    // cache and has to be applied on every open; skipping the pass made
    // finished books open with no text layer at all.
    const stat = file.stat || {};
    const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
    let done = false;
    try { done = await this.plugin.ocrTextLayerComplete?.(file.path, stamp) === true; } catch { done = false; }
    const silent = done === true;
    if (!this.plugin.ocrEnabled?.()) return;
    if (!this.plugin.ocrConfigured?.()) {
      if (!silent && this.plugin.ocrNotConfiguredHint?.()) {
        new Notice(qiaomuReaderTranslate("ocr-sidecar-not-configured-hint"), 12000);
      }
      return;
    }
    await this._startTextLayerQueue(file, scan.total, { silent });
  }
  _textLayerPageOrder(total) {
    const current = Math.max(1, Math.min(total, (this.pager?.spread || 0) + 1));
    const order = [current];
    for (let step = 1; step < total; step += 1) {
      if (current + step <= total) order.push(current + step);
      if (current - step >= 1) order.push(current - step);
    }
    return order;
  }
  async _startTextLayerQueue(file, total, { silent = false } = {}) {
    if (this._ocrJob || !file) return;
    const token = { jobId: `ocr-${Date.now().toString(36)}`, sessionId: "", done: 0, total, cancelled: false, silent };
    this._ocrJob = token;
    if (!silent) this._showOcrBar({ kind: "working", done: 0, total });
    try {
      // Hybrid: a missing layout runs in the background while the plain pass
      // already hands the reader its text; when it lands the pages are fetched
      // again (cache-hot) and upgraded in place. An existing source skips the
      // plain round entirely. Silent replays never start MinerU again.
      const hybridWanted = this.plugin.settings.ocrHybrid === true && !silent;
      let existing = "";
      if (hybridWanted) {
        try { existing = await this.plugin.ocrTextSourceFor(file.path); }
        catch { existing = ""; }
      }
      const layoutJob = hybridWanted && !existing
        ? this._prepareLayoutSource(file, total, token)
        : Promise.resolve(existing ? "ready" : "");
      await this._runTextLayerPass(file, total, token);
      if (token.cancelled || this._ocrJob !== token) return;
      const layoutReady = await layoutJob;
      if (token.cancelled || this._ocrJob !== token) return;
      if (!existing && layoutReady === "ready") {
        if (!silent) new Notice(qiaomuReaderTranslate("ocr-hybrid-upgraded"), 6000);
        token.done = 0;
        await this._runTextLayerPass(file, total, token);
      }
      if (this._ocrJob === token && !token.cancelled) {
        // Fully generated: remember it so the progress bar never returns.
        const stat = file?.stat || {};
        const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
        void this.plugin.markOcrTextLayerComplete?.(file.path, stamp);
        if (!silent) this._showOcrBar({ kind: "ready", file });
      }
    } catch (error) {
      if (this._ocrJob === token && !silent) this._showOcrBar({ kind: "error", message: this.plugin.ocrErrorText?.(error) || "OCR" });
    } finally {
      this.plugin.closeOcrSession?.(token.sessionId);
      if (this._ocrJob === token) this._ocrJob = null;
    }
  }
  // MinerU runs beside the plain pass; resolves "ready" once a text source
  // exists for the upgrade, "" when it failed (a notice explains why).
  async _prepareLayoutSource(file, total, token) {
    try {
      token.layoutJobId = `${token.jobId}-layout`;
      const built = await this.plugin.buildOcrTextSource(file.path, {
        jobId: token.layoutJobId,
        // MinerU reports one progress event at the end; size the no-progress
        // watchdog for the whole book instead of the sidecar's default.
        timeout: Math.max(600, Math.round(total * 15)),
      });
      token.layoutJobId = "";
      if (built?.ok) return "ready";
      new Notice(`${qiaomuReaderTranslate("ocr-text-source-failed")}：${this.plugin.ocrErrorText?.(built?.error) || built?.error || ""}`, 12000);
    } catch (error) {
      token.layoutJobId = "";
      new Notice(`${qiaomuReaderTranslate("ocr-text-source-failed")}：${this.plugin.ocrErrorText?.(error) || ""}`, 12000);
    }
    return "";
  }
  // One pass over the pages: a session (hybrid when a source is recorded) and
  // every page fetched in priority order, applied as it arrives.
  async _runTextLayerPass(file, total, token) {
    const opened = await this.plugin.openOcrSession(file.path);
    if (this._ocrJob !== token) { this.plugin.closeOcrSession?.(opened?.sessionId); return; }
    token.sessionId = String(opened?.sessionId || "");
    if (!token.sessionId) throw new Error(qiaomuReaderTranslate("ocr-needs-desktop"));
    for (const pageNumber of this._textLayerPageOrder(total)) {
      if (token.cancelled || this._ocrJob !== token || this._closed) break;
      // Pages that already carry a text layer are left alone, so a mostly
      // digital book only pays for the few scanned pages in it.
      if (String(this._pdfLazy?._pageText?.[pageNumber - 1] || "").trim()) {
        token.done += 1;
        if (!token.silent) this._showOcrBar({ kind: "working", done: token.done, total });
        continue;
      }
      const fetched = await this.plugin.fetchOcrPage(token.sessionId, pageNumber);
      if (token.cancelled || this._ocrJob !== token) break;
      if (fetched?.content) {
        const text = (fetched.content.items || [])
          .map((item) => String(item.str || "")).join(" ").replace(/\s+/g, " ").trim();
        if (this._pdfLazy?.applyOcr?.(pageNumber, fetched.content, text)) {
          this._ocrPages = (this._ocrPages || new Set()).add(pageNumber);
          // Repaint that page so its new text layer is selectable now, not on
          // the next scroll.
          refreshReaderPdfTextLayer(this, pageNumber);
          // A search started before this page had text holds a stale corpus;
          // drop it and let the open find panel rebuild its match list so
          // "next" can reach the new hits.
          this._findCorpus = null;
          if (this._foundQuery && this._findInput?.value) {
            this._findInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      token.done += 1;
      if (!token.silent) this._showOcrBar({ kind: "working", done: token.done, total });
      renderVisibleFigures(this);
      if (this._foundQuery) markFoundIn(this, this._foundQuery);
    }
    this.plugin.closeOcrSession?.(token.sessionId);
    token.sessionId = "";
  }
  _cancelTextLayerJob() {
    const token = this._ocrJob;
    if (!token) return;
    token.cancelled = true;
    this._ocrJob = null;
    // Stop whichever phase is running: the MinerU layout job or the page pass.
    if (token.layoutJobId) this.plugin.cancelOcrJob?.(token.layoutJobId);
    this.plugin.closeOcrSession?.(token.sessionId);
    this._hideOcrBar();
  }
  _ocrBar() {
    if (this._ocrBarEl?.isConnected) return this._ocrBarEl;
    this._ocrBarEl = this.contentEl.createDiv("qiaomu-reader-ocr-bar");
    return this._ocrBarEl;
  }
  _hideOcrBar() {
    this._ocrBarEl?.remove?.();
    this._ocrBarEl = null;
  }
  _showOcrBar({ kind, done = 0, total = 0, message = "", file: _file = null, phase = "" }) {
    const bar = this._ocrBar();
    bar.empty();
    bar.dataset.kind = kind;
    const text = bar.createDiv("qiaomu-reader-ocr-text");
    const fill = bar.createDiv("qiaomu-reader-ocr-track").createDiv("qiaomu-reader-ocr-fill");
    const actions = bar.createDiv("qiaomu-reader-ocr-actions");
    const button = (label, onClick) => {
      const el = actions.createEl("button", { text: label, attr: { type: "button" } });
      el.addEventListener("click", onClick);
      return el;
    };
    if (kind === "working") {
      if (phase === "layout" && !done) {
        // MinerU reports a single progress event at the end; a percentage here
        // would sit at 0% for minutes, so show an indeterminate bar instead.
        text.setText(qiaomuReaderTranslate("ocr-analyzing"));
        fill.addClass("qiaomu-reader-ocr-fill-waiting");
      } else {
        text.setText(total
          ? qiaomuReaderTranslate(phase === "layout" ? "ocr-analyzing-0-1" : "ocr-generating-0-1", done, total)
          : qiaomuReaderTranslate("ocr-preparing"));
        fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "4%";
      }
      button(qiaomuReaderTranslate("cancel"), () => this._cancelTextLayerJob());
      return;
    }
    bar.addClass("qiaomu-reader-ocr-bar-done");
    if (kind === "ready") {
      fill.style.width = "100%";
      text.setText(qiaomuReaderTranslate("ocr-ready"));
    } else {
      fill.style.width = "0%";
      text.setText(`${qiaomuReaderTranslate("ocr-failed")}${message ? ` · ${message}` : ""}`);
      button(qiaomuReaderTranslate("ocr-retry"), () => {
        this._hideOcrBar();
        void this.generateTextLayerNow();
      });
    }
    button(qiaomuReaderTranslate("close"), () => this._hideOcrBar());
  }
  // Called from the book menu: build the text layer on demand (also the retry
  // path for a scan whose automatic attempt failed).
  async generateTextLayerNow() {
    const file = this.file;
    if (!file || this._ocrJob) return;
    if (!this.plugin.ocrEnabled?.()) {
      new Notice(qiaomuReaderTranslate("ocr-needs-desktop"), 8000);
      return;
    }
    if (!this.plugin.ocrConfigured?.()) {
      new Notice(qiaomuReaderTranslate("ocr-sidecar-not-configured-hint"), 12000);
      return;
    }
    const total = this.pager?.total || this._pdfLazy?._pageText?.length || 0;
    if (!total) return;
    await this._startTextLayerQueue(file, total);
  }
  _finishBookOpen(file) {
    // Inflate the word glossary while the reader settles so the first
    // multi-character selection is instant.
    try { warmWordGlosses(); } catch (e) { console.warn("UV Reader: could not preload the word glossary", e); }
    syncReaderAiCapability(this);
    if (isImageBookFile(file)) {
      this.fitBtn?.setAttribute("aria-label", qiaomuReaderTranslate("fit-width"));
      this._imageZoom?.fitWidth?.();
    }
    this.buildSettPanel(); this._maybePromptBookNote(file);
    // The docked list must follow the book that just opened.
    this.buildHlPanel();
    this._sessionSec = 0; this._running = false;
    const todaySeconds = this.plugin.getTodaySeconds();
    this._goalNotified = todaySeconds >= this.plugin.getGoalSeconds();
    readerTimer.updateGoalBar(this); readerTimer.updateButton(this); syncOpenAiReaderContext(this);
    // Remembered "fit page" also applies when a PDF is opened again.
    if (readerIsPdf(this) && this.plugin.settings.fitPage === true) this._applyFitPage();
  }
  _mountImage(result, file) {
    this.areaEl.empty();
    const page = this.areaEl.createDiv("qiaomu-reader-image-page");
    const image = page.createEl("img", {
      attr: {
        alt: file.basename || file.name || "",
        draggable: "false",
        decoding: "async",
      },
    });
    const url = URL.createObjectURL(new Blob([result.bytes], { type: imageMimeType(file.extension) }));
    this._imageUrl = url;
    image.src = url;
    this._imageZoom = createImageZoom({
      image,
      doc: this.areaEl.ownerDocument,
      host: page,
      eventTarget: page,
      rootStyle: false,
      onChange: ({ fit }) => this.fitBtn?.setAttribute("aria-pressed", String(fit)),
    });
    this.fitBtn?.setAttribute("aria-label", qiaomuReaderTranslate("fit-width"));
  }
  async _mountEngine(result, file, saved, loadToken) {
    // foliate-js renders into its own element; the surrounding chrome (panels,
    // notes, AI sidebar) keeps working off the stored reading data.
    this.areaEl.empty();
    const mount = this.areaEl.createDiv("qiaomu-reader-engine-host");
    const plugin = this.plugin;
    const engine = this.engine = new EpubEngine(mount, {
      initialCss: this._engineAppearanceCss(),
      layout: plugin.settings,
      onNavigate: (direction) => this.nav(direction),
      onHighlightClick: (hit) => openEngineHighlightPopup(this, hit),
      onPinClick: (hit) => openEnginePinPopup(this, hit),
      onDocLoaded: ({ doc, index }) => {
        attachEngineChrome(this, doc, index);
        // Each section lives in an iframe the page stylesheet cannot reach:
        // load the selected reading font into it directly.
        try { void ensureSelectedReaderFont(doc, plugin, plugin.settings); }
        catch (e) { console.warn("UV Reader: could not load the reading font into a book document", e); }
        // Selections live inside the iframe too; forward them so the highlight
        // popup works for engine formats.
        try {
          const notify = () => {
            window.clearTimeout(this._engineSelTimer);
            this._engineSelTimer = window.setTimeout(() => {
              if (typeof this._engineSelectionCheck === "function") this._engineSelectionCheck({ doc, index });
            }, 60);
          };
          doc.addEventListener("pointerup", notify);
          doc.addEventListener("selectionchange", notify);
        } catch (e) { console.warn("UV Reader: could not watch selections in a book document", e); }
        // The pinned-reading card and the highlight toast are dismissed by a
        // click anywhere; clicks in a section never reach the main document.
        try {
          doc.addEventListener("pointerdown", () => {
            hidePinPopup(this);
            selectionHud.hideSelectionFeedback(this);
          });
        } catch (e) { console.warn("UV Reader: could not watch taps in a book document", e); }
      },
      onRelocate: (detail) => {
        if (this.file?.path !== file.path || this.engine !== engine || loadToken.signal.aborted) return;
        updateEngineLocation(this, detail);
      },
    });
    try {
      await engine.open(result.bytes, result.name, { initialCfi: saved?.cfi || undefined, initialFraction: saved?.pct });
    } catch (e) {
      engine.destroy();
      if (this.engine === engine) this.engine = null;
      throw e;
    }
  }
  _engineTocItems() {
    // foliate gives a tree of {label, href, subitems}; flatten it for the
    // shared navigation panel, keeping href as the jump target.
    const out = [];
    const walk = (items, level) => {
      for (const item of items ?? []) {
        if (!item || !item.label) continue;
        out.push({ label: String(item.label).slice(0, 80), href: item.href, level });
        if (Array.isArray(item.subitems)) walk(item.subitems, level + 1);
      }
    };
    walk(this.engine ? this.engine.toc() : [], 0);
    return out;
  }
  async _engineTocItemsWithGenerated(file) {
    const embedded = this._engineTocItems();
    this._tocOriginalItems = embedded;
    const stat = file?.stat || {};
    const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
    const generated = await Promise.resolve(this.plugin.loadGeneratedToc?.(file.path, stamp)).catch(() => null);
    const entries = Array.isArray(generated?.entries) ? generated.entries : [];
    const rows = entries
      .filter((item) => item && (item.cfi || item.href) && (item.title || item.label))
      .map((item) => ({
        label: String(item.title || item.label).slice(0, 120),
        level: Math.max(1, Number(item.level) || 1),
        cfi: String(item.cfi || ""),
        href: item.cfi ? "" : String(item.href || ""),
        sectionId: item.sectionId == null ? "" : String(item.sectionId),
        anchorPath: Array.isArray(item.anchorPath) ? item.anchorPath.map(Number) : null,
        anchorText: String(item.anchorText || ""),
        anchorId: String(item.anchorId || ""),
      }));
    return rows.length ? rows : embedded;
  }
  // Selections inside engine sections arrive from the iframe documents the
  // mount hook is watching; anchor them by CFI and raise the same popup.
  _engineSelectionCheck({ doc, index }) {
    if (!this.engine || !this.file || this.file.extension === "pdf") return;
    if (this._selectionMenuOpen || this._editHlId || this._commentEditing || this._selectionDragging || this.pdfPanMode) return;
    let sel = null;
    try { sel = doc.getSelection(); } catch { return; }
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text.trim()) return;
    let cfi = null;
    try { cfi = this.engine.cfiFromRange(index, range); } catch { cfi = null; }
    if (!cfi) return;
    this._selectionDoc = doc;
    this._pendingSel = { cfi, index, text };
    this._editHlId = selectionHud.matchingSelectionHighlight(this, this._pendingSel)?.id || null;
    try {
      const r = range.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      const rect = frame
        ? { left: r.left + frame.left, right: r.right + frame.left, top: r.top + frame.top, bottom: r.bottom + frame.top, width: r.width, height: r.height, x: r.left + frame.left, y: r.top + frame.top }
        : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, x: r.left, y: r.top };
      this._showHlPopup(rect);
      syncOpenAiSelectionContext(this, range);
    } catch (e) { console.warn("UV Reader: could not place the highlight popup", e); }
  }
  // Re-paint stored CFI highlights after reopen; block-anchored highlights
  // from the previous pipeline are intentionally not drawn here.
  _renderEngineHighlights() {
    if (!this.engine || !this.file) return;
    const engine = this.engine, path = this.file.path;
    void (async () => {
      for (const hl of this.plugin.getHighlights(path)) {
        if (this._closed || this.engine !== engine || this.file?.path !== path) return;
        if (!hl.cfi) continue;
        try { await engine.addHighlight(hl.id, hl.cfi, hl.color); }
        catch { /* the section holding that CFI may not be rendered yet */ }
      }
    })();
  }
  _renderEnginePins() {
    renderEnginePins(this);
  }
  _pinyinPinFor(sel) {
    return pinyinPinFor(this, sel);
  }
  _togglePinyinPin(sel, info) {
    return togglePinyinPin(this, sel, info, {
      notice: (message) => new Notice(message),
      translate: qiaomuReaderTranslate,
    });
  }
  _engineAppearanceCss() {
    // The engine renders each section inside its own iframe document, so the
    // reader's typography and theme travel into that document explicitly.
    const s = this.plugin.settings;
    const t = qiaomuReaderTheme(s);
    return readerTextCss(s, t, resolveReaderFont(s, FONTS), this.contentEl);
  }
  _maybePromptBookNote(file) { // first open of a book: auto-link or ask once
    const settings = this.plugin.settings;
    if (!file) return;
    if (!settings.bookNoteLinks) settings.bookNoteLinks = {};
    if (!settings.bookNotePrompted) settings.bookNotePrompted = {};
    const action = bookNoteAction(settings, file.path);
    if (["linked", "prompted"].includes(action)) return;
    if (action !== "auto") {
      new BookSetupModal(this.app, this.plugin, file, () => this._refreshSettingsPanel()).open();
      return;
    }
    settings.bookNotePrompted[file.path] = true;
    void this.plugin.ensureBookNote(file).then((note) => {
      if (note) new Notice(qiaomuReaderTranslate("book-note-created-0", note.basename));
      this._refreshSettingsPanel();
    });
  }
  _refreshSettingsPanel() {
    if (this.panelOpen === "settings") { this.buildSettPanel(); }
  }
  async paginate(savedPct = 0, savedBlock = null, loadToken = null) {
    const pager = this.pager;
    const current = () => !loadToken || this._loadCoordinator.isCurrent(loadToken);
    if (!current()) return;
    this.areaEl.empty();
    let w = this.areaEl.clientWidth, a = 0;
    while (!w && a < 60) {
      await waitForReaderFrame(docOf(this.areaEl).defaultView);
      if (!current()) return;
      w = this.areaEl.clientWidth;
      a++;
    }
    if (!w) return;
    this.areaEl.addClass("qiaomu-reader-booting");
    readerHud.showVeil(this);
    readerHud.markSlowLayout(this);
    await readerHud.paintVeil(this);
    if (!current()) return;
    let [, total] = await pager.build(
      this.areaEl,
      this.bookHtml,
      this._readerLayoutSettings(),
      0
    );
    if (!current()) return;
    if (readerPaginationMappingCollapsed(pager)) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      if (!current()) return;
      [, total] = await pager.build(this.areaEl, this.bookHtml, this._readerLayoutSettings(), 0);
      if (!current()) return;
    }
    this._laidOutWidth = pager.builtWidth || w;
    const hasBlock = typeof savedBlock === "number" && savedBlock >= 0;
    const targetSpread = hasBlock ? pager.spreadForBlock(savedBlock) : Math.round(savedPct * Math.max(0, total - 1));
    this._renderFlowHighlights();
    const [cur, tot] = pager.jumpTo(targetSpread);
    if (hasBlock && pager.scrollMode) restoreReadingAnchor(pager, { block: savedBlock, offset: 0, pct: savedPct });
    this._readingAnchor = captureReadingAnchor(pager);
    this.updateUI(cur, tot);
    qiaomuReaderRevealWhenSettled(this);
    if (hasBlock) this._flashBlock(savedBlock);
  }
  jumpToPdfPageWhenReady(pageNo) { // deep links can land before pagination; poll for the anchor
    let attempts = 0;
    const poll = () => {
      if (this._jumpToPdfPage(pageNo)) return;
      if (++attempts > 40) return;
      window.setTimeout(poll, 100);
    };
    poll();
  }
  // True once the page anchor exists and the jump has been performed.
  _jumpToPdfPage(pageNo) {
    const pane = this.pager && this.pager.flow;
    if (!pane || !this.pager.total) return false;
    const anchor = pane.querySelector(`[data-pdf-page-no="${pageNo}"]`);
    if (!anchor) return false;
    const offsetX = anchor.getBoundingClientRect().left - pane.getBoundingClientRect().left;
    const colStride = this.pager.sw / (this.pager.cols || 1);
    const targetSpread = Math.floor(Math.round(offsetX / colStride) / (this.pager.cols || 1));
    const [cur, tot] = this.pager.jumpTo(Math.max(0, Math.min(targetSpread, this.pager.total - 1)));
    (this.updateUI || this._updateUI).call(this, cur, tot); return true;
  }
  jumpToBlockWhenReady(idx) {
    let tries = 0;
    const tick = () => {
      if (this.pager && this.pager.flow && this.pager.total) {
        const [cur, tot] = this.pager.jumpTo(this.pager.spreadForBlock(idx));
        (this.updateUI || this._updateUI).call(this, cur, tot);
        this._flashBlock(idx);
        return;
      }
      if (++tries > 40) return;
      window.setTimeout(tick, 100);
    };
    tick();
  }
  _flashBlock(idx) {
    const el = this.pager.blockEl(idx);
    if (!el) return;
    el.classList.remove("qiaomu-reader-resume-flash");
    void el.offsetWidth;
    el.classList.add("qiaomu-reader-resume-flash");
    window.setTimeout(() => el.classList.remove("qiaomu-reader-resume-flash"), 2400);
  }
  _markFound(query) {
    markFoundIn(this, query);
  }
  _clearFound() {
    clearFoundIn(this);
  }
  async _jumpToBlock(block, flash = true) {
    if (!readerIsPdf(this) || !this.bookHtml || typeof block !== "number") return;
    rememberReaderJump(this);
    await this._settleLayoutBeforeJump();
    const [cur, tot] = restoreReadingAnchor(this.pager, { block, offset: 0, pct: this.pager.currentPct });
    this.updateUI(cur, tot);
    if (this.file) this.plugin.saveProgress(this.file.path, cur, tot, this.pager.currentBlockIndex());
    if (flash) this._flashBlock(block);
  }
  _setRelayout(on) {
    if (!on) readerHud.hideVeil(this);
    const root = this.contentEl;
    if (!root) return;
    if (on && !this._spinEl) {
      this._spinEl = root.createDiv("qiaomu-reader-relayout-spin");
      this._spinEl.createDiv("qiaomu-reader-relayout-ring");
    }
    root.toggleClass("qiaomu-reader-relayouting", !!on);
  }
  async repaginate() {
    if (!this.bookHtml || this._openingBook || this._closed) return;
    if (this.engine) { this.applyVars(); this._setRelayout(false); return; }
    if (this._imageZoom) return;
    if (!readerIsPdf(this)) return;
    if (!this.areaEl.clientWidth || this.containerEl.offsetParent === null) return;
    return queueReadingLayout(this, (anchor) => this._repaginateAnchored(anchor));
  }
  async _repaginateAnchored(anchor) {
    this._setRelayout(true); readerHud.showVeil(this);
    try {
      await waitForReaderFrame(docOf(this.areaEl).defaultView);
      this.areaEl.empty(); const pager = this.pager;
      await pager.build(this.areaEl, this.bookHtml, this._readerLayoutSettings(), 0);
      if (pager !== this.pager || !this.bookHtml || this._closed) return;
      this._recordLaidOutWidth();
      this._renderFlowHighlights(); // re-wrap markers on the fresh blocks
      const [cur, tot] = restoreReadingAnchor(this.pager, anchor);
      restoreAiSource(this);
      if (this.pdfZoomMode === "width") pdfZoom.fitWidth(this);
      this._readingAnchor = anchor;
      this.updateUI(cur, tot); if (this._tocRender) this._tocRender();
      this._findCorpus = null; if (this._foundQuery) this._markFound(this._foundQuery);
    } finally {
      window.requestAnimationFrame(() => { this._setRelayout(false); settleReader(this); });
    }
  }
  // Remember the width actually laid out, and whether the viewport kept
  // drifting far enough from it that a later reflow should give up waiting.
  _recordLaidOutWidth() {
    const visible = this.areaEl.clientWidth;
    this._laidOutWidth = this.pager.builtWidth || visible;
    const drifted = visible && Math.abs(visible - (this.pager.builtWidth || 0)) >= 8;
    this._staleGaveUpAt = drifted ? this.pager.builtWidth : null;
  }
  buildDOM() {
    const { contentEl: root } = this;
    root.empty();
    root.addClass("qiaomu-reader-view"); this.applyVars();
    const pb = root.createDiv("qiaomu-reader-pbar");
    this.pbarFill = pb.createDiv("qiaomu-reader-pbar-fill");
    const tray = buildReaderTopBar(this, {
      backAttr: { "aria-label": qiaomuReaderTranslate("library") },
      title: "UV Reader",
      onBack: () => this.plugin.openLibrary(),
    });
    readerTimer.buildButton(tray, this);
    // Tray buttons share an icon, accessible label and click handler.
    // The companion entry stays available before service setup.
    const trayButton = (icon, label, onClick, spec = {}) => {
      const btn = tray.createEl("button", { cls: spec.cls || "qiaomu-reader-ibtn", attr: spec.attr || { type: "button" } });
      if (icon) svgIcon(btn, icon);
      if (spec.lucide) setIcon(btn, spec.lucide);
      if (label) btn.setAttribute("aria-label", qiaomuReaderTranslate(label));
      if (spec.text) {
        btn.createSpan({
          cls: "qiaomu-reader-ibtn-text",
          text: qiaomuReaderTranslate(spec.text),
          attr: { "aria-hidden": "true" },
        });
      }
      if (spec.hidden) btn.hidden = true;
      if (onClick) btn.addEventListener("click", onClick);
      return btn;
    };
    // The book note stays reachable from the more menu and the context menus;
    // the tray keeps reading actions only.
    this.aiBtn = trayButton(null, "ai-reading", () => {
      void this._toggleAiCompanion();
    }, { lucide: "sparkles" });
    this.fitBtn = trayButton(null, "fit-page", () => {
      if (this._imageZoom) {
        this._imageZoom.fitWidth();
        return;
      }
      this.plugin.settings.fitPage = this.plugin.settings.fitPage !== true;
      void this.plugin.saveAll();
      this._applyFitPage();
    }, {
      cls: "qiaomu-reader-ibtn qiaomu-reader-fit-toggle",
      attr: { type: "button", "aria-pressed": String(this.plugin.settings.fitPage === true) },
      lucide: "maximize",
    });
    this.tocBtn = trayButton("list", "table-of-contents", () => {
      if (typeof this.plugin.app.qbrDesktopOpenToc === "function") {
        void this.plugin.app.qbrDesktopOpenToc(this);
        return;
      }
      this.togglePanel("toc");
    });
    this.hlBtn = trayButton("comment", "highlights", () => {
      this.togglePanel("highlights");
      this._syncToolButtons();
    });
    trayButton("sliders", "reading-settings", () => new ReadSettingsModal(this.app, this).open());
    pageJump.build(this, tray);
    // Search sits right after the reading settings, in its original place: a
    // box that searches on Enter, then the button that opens the results panel
    // (prefilled with whatever the box holds). The PDF zoom control stays the
    // last group, pinned to the far right of the toolbar.
    const findBox = tray.createEl("input", {
      cls: "qiaomu-reader-top-find",
      attr: {
        type: "search",
        placeholder: qiaomuReaderTranslate("search-the-book"),
        "aria-label": qiaomuReaderTranslate("search-the-book"),
      },
    });
    this.findBoxEl = findBox;
    findBox.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      this._findFromToolbar(findBox.value);
    });
    const findBtn = tray.createEl("button", { cls: "qiaomu-reader-ibtn", attr: { type: "button" } });
    svgIcon(findBtn, "search");
    findBtn.setAttribute("aria-label", qiaomuReaderTranslate("search-the-book"));
    findBtn.addEventListener("click", () => {
      const query = findBox.value.trim();
      if (query) { this._findFromToolbar(query); return; }
      this.togglePanel("find");
      if (this.panelOpen === "find" && this._findInput) readerHud.autoFocus(this._findInput, 60);
    });
    this.findBtn = findBtn;
    this.pdfFormFillBtn = trayButton("pdf-form-fill", "fill-pdf-form", () => { void this._pdfForm?.toggle(); }, {
      hidden: true,
      cls: "qiaomu-reader-ibtn qiaomu-reader-pdf-form-toggle",
      text: "pdf-form-fill-short",
      attr: { type: "button", "aria-pressed": "false" },
    });
    this.pdfFormSignBtn = trayButton("pdf-form-sign", "add-pdf-signature", () => { void this._pdfForm?.pickSignature(); }, {
      hidden: true,
      cls: "qiaomu-reader-ibtn qiaomu-reader-pdf-add-signature",
      text: "pdf-form-sign-short",
    });
    this.pdfFormSaveBtn = trayButton("pdf-form-save", "save-signed-copy", () => { void this._pdfForm?.save(); }, {
      hidden: true,
      cls: "qiaomu-reader-ibtn qiaomu-reader-pdf-save-signed",
      text: "pdf-form-save-short",
    });
    createPdfZoomControls(tray, this);
    buildReaderPageArea(this, root, "qiaomu-reader-area");
    this._pdfForm = createPdfFormController({
      view: this,
      bridge: this.pdfFormBridge,
      translate: qiaomuReaderTranslate,
      notify: (message) => new Notice(String(message || "")),
      onChange: () => this._syncPdfFormControls(),
      openSignaturePicker: (options) => {
        if (!SignaturePickerModal) return false;
        new SignaturePickerModal(this.app, options).open();
        return true;
      },
    });
    buildReaderPanels(this, root, {
      dismiss: () => this.closePanel(),
      buildPanelContents: () => {
        this.buildSettPanel(); this.buildTocPanel();
        this.buildHlPanel(); this.buildFindPanel();
      },
      buildPopup: () => this.buildHlPopup(),
    });
    this.registerDomEvent(docOf(this.containerEl), "selectionchange", () => this._scheduleSelCheck());
    const flagSelection = () => this._scheduleSelCheck();
    this.areaEl.addEventListener("mouseup", flagSelection);
    this.areaEl.addEventListener("wheel", (event) => handleReaderWheel(this, event), { passive: false });
    attachReaderContentClick(this);
    const hidePopup = () => this._hideHlPopup();
    this.registerDomEvent(docOf(this.containerEl), "mousedown", (ev) => {
      if (this._editHlId && !this._selectionMenuOpen) {
        const hit = ev.target;
        if (this.hlPopup.contains(hit)) return;
        if (hit instanceof HTMLElement && hit.closest(".qiaomu-reader-hl")) return;
        hidePopup();
      }
    });
    this.registerDomEvent(docOf(this.containerEl), "keydown", (ev) => {
      if (!this.bookHtml) {
        return;
      }
      const focused = docOf(this.areaEl).activeElement;
      if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)) return;
      if (!this.containerEl.contains(focused) && this.app.workspace.getActiveViewOfType(this.constructor) !== this) return;
      const zoom = readerIsPdf(this) && pdfZoomShortcut(ev);
      if (zoom) {
        ev.preventDefault();
        if (zoom === "reset") pdfZoom.apply(this, PDF_ZOOM_DEFAULT);
        else pdfZoom.change(this, zoom === "in" ? 1 : -1);
        return;
      }
      const toNext = ["ArrowRight", "ArrowDown", " "];
      const toPrev = ["ArrowLeft", "ArrowUp"];
      const step = toNext.includes(ev.key) ? "next" : toPrev.includes(ev.key) ? "prev" : null;
      if (step) {
        ev.preventDefault();
        this.nav(step);
      }
    });
    attachReaderSwipeNav(this);
    wireReaderChrome(this, root);
  }
  applyVars() {
    syncPageButtons(this);
    const t = qiaomuReaderTheme(this.plugin.settings);
    const s = this.plugin.settings;
    const r = this.contentEl;
    r.style.setProperty("--qiaomu-reader-bg", t.bg);
    r.style.setProperty("--qiaomu-reader-text", t.text);
    r.style.setProperty("--qiaomu-reader-ui", t.ui);
    r.style.setProperty("--qiaomu-reader-border", t.border);
    r.style.setProperty("--qiaomu-reader-accent", t.accent);
    r.style.setProperty("--qiaomu-reader-muted", t.muted);
    r.toggleClass("qiaomu-reader-eink", s.einkMode === true);
    // Live restyle of an open engine book: re-send the appearance CSS and make
    // sure any freshly selected reading font reaches the rendered documents.
    if (this.engine) {
      this.engine.setLayout(s);
      this.engine.setExtraCss(this._engineAppearanceCss());
      try {
        for (const { doc } of this.engine.contents()) void ensureSelectedReaderFont(doc, this.plugin, this.plugin.settings);
      } catch (e) { console.warn("UV Reader: could not refresh the engine font", e); }
    }
  }
  _readerLayoutSettings() {
    const settings = this.plugin.settings;
    // A PDF fitted to the page width reads as one page per screen: the spread
    // would otherwise squeeze each page back into half the reading area.
    if (readerIsPdf(this) && settings.fitPage === true && settings.columns !== "1") {
      return { ...settings, columns: "1" };
    }
    return settings;
  }
  _applyFitPage() {
    const fit = this.plugin.settings.fitPage === true;
    this.contentEl?.toggleClass("qiaomu-reader-fit-page", fit);
    this.fitBtn?.setAttribute("aria-pressed", String(fit));
    if (this._imageZoom) {
      this._imageZoom.fitWidth();
      return;
    }
    if (readerIsPdf(this)) {
      if (!this.bookHtml) return;
      const apply = () => {
        // Fill the reading slot: the zoom menu's old "fit width" and this
        // toggle are one control now, and the fill is what readers want.
        if (fit) pdfZoom.fitWidth(this);
        else pdfZoom.apply(this, PDF_ZOOM_DEFAULT, null, "page");
      };
      void this.repaginate().then(apply, apply);
      return;
    }
    if (this.engine) {
      this.engine.setLayout(this.plugin.settings);
      return;
    }
    if (this.bookHtml) void this.repaginate();
  }
  nav(dir) {
    if (!this.bookHtml)
      return;
    if (this._imageZoom) return;
    if (this.engine) {
      const engineNow = Date.now();
      if (this._lastNavTs && engineNow - this._lastNavTs < 90) return;
      this._lastNavTs = engineNow;
      this._lastActive = engineNow;
      void (dir === "next" ? this.engine.next() : this.engine.prev()).catch(error => {
        console.warn("UV Reader: page turn failed", error);
      });
      return;
    }
    const _now = Date.now();
    if (this._lastNavTs && _now - this._lastNavTs < 90) return;
    this._lastNavTs = _now;
    this._lastActive = _now;
    if (this._layoutWidthStale()) {
      this.repaginate().then(() => this._navNow(dir)).catch(() => this._navNow(dir));
      return;
    }
    this._navNow(dir);
  }
  _navNow(dir) {
    if (!this.bookHtml || this._imageZoom) return;
    this._hideHlPopup();
    const [cur, total] = dir === "next" ? this.pager.next() : this.pager.prev();
    this.updateUI(cur, total);
    this.plugin.saveProgress(this.file.path, cur, total, this.pager.currentBlockIndex());
  }
  _layoutWidthStale() {
    if (this._openingBook) return false;
    if (!this.bookHtml || !this.pager || !this.pager.builtWidth) return false;
    if (this.containerEl.offsetParent === null) return false;
    if (this._staleGaveUpAt === this.pager.builtWidth) return false;
    const now = this.areaEl.clientWidth;
    if (!now) return false;
    return Math.abs(now - this.pager.builtWidth) >= 8 || Math.abs(this.areaEl.clientHeight - (this.pager.builtHeight || 0)) >= 8;
  }
  exportHighlights(evt) {
    if (!this.file) {
      new Notice(qiaomuReaderTranslate("no-book-is-open"));
      return;
    }
    const list = enrichHighlights(this, this.plugin.getHighlights(this.file.path));
    exportHighlightsMenu(this.app, this.plugin, this.file, list, evt);
  }
  updateUI(cur, total) {
    settleReader(this);
    if (this.contentEl) this.contentEl.toggleClass("qiaomu-reader-scrolling", !!(this.pager && this.pager.scrollMode));
    const pct = total > 0 ? Math.round((cur + 1) / total * 100) : 0;
    this.pbarFill.style.width = `${pct}%`;
    const bookPage = currentBookPage(this);
    const where = this.ext === "pdf" ? qiaomuReaderTranslate("spread-0-of-1", cur + 1, total) : `${cur + 1} / ${total}`;
    if (this.locEl) this.locEl.setText(bookPage ? qiaomuReaderTranslate("p-0", bookPage) + " \xB7 " + where : where);
    if (this.locEl && readerIsPdf(this)) this.locEl.setText(qiaomuReaderTranslate("page-0-of-1", pdfVisiblePageLabel(this, bookPage || 1), readerPdfPages(this).length || total));
    if (this.pctEl) this.pctEl.setText(`${pct}%`);
    if (this.pageInputEl) pageJump.update(this);
    syncReaderAiCapability(this);
    pdfZoom.syncControls(this);
    renderVisibleFigures(this);
  }
  buildSettPanel() {
    const save = () => this.plugin.saveAll();
    const applyTheme = async () => { this.applyVars(); if (this.bookHtml) await this.repaginate(); };
    const applyStyle = async () => { if (this.bookHtml) await this.repaginate(); };
    buildReaderSettPanelBody(this, this.settPan, {
      title: qiaomuReaderTranslate("reading-settings"),
      onThemeApplied: applyTheme,
      onTextStyleApplied: applyStyle,
      buildFontSizeRow: (host) => {
        const row = host.createDiv("qiaomu-reader-sz-row");
        const dec = row.createDiv("qiaomu-reader-sz-btn");
        dec.setText("A−");
        const label = row.createDiv("qiaomu-reader-sz-label");
        label.setText(`${this.plugin.settings.fontSize}px`);
        const inc = row.createDiv("qiaomu-reader-sz-btn");
        inc.setText("A+");
        const step = async (delta) => {
          const next = this.plugin.settings.fontSize + delta;
          if (next < 12 || next > 36)
            return;
          this.plugin.settings.fontSize = next;
          label.setText(`${next}px`);
          await save();
          await applyStyle();
        };
        dec.addEventListener("click", () => step(-1));
        inc.addEventListener("click", () => step(1));
      },
      buildExtraAdvRows: (adv) => {
        adv.createDiv("qiaomu-reader-pan-sec").setText(qiaomuReaderTranslate("pages-side-by-side"));
        const row = adv.createDiv("qiaomu-reader-col-row");
        const clearActive = () => row.querySelectorAll(".qiaomu-reader-col-btn").forEach((b) => b.removeClass("active"));
        const choices = [["1", qiaomuReaderTranslate("1-page")], ["2", qiaomuReaderTranslate("2-pages")]];
        for (const [value, text] of choices) {
          const opt = row.createDiv("qiaomu-reader-col-btn");
          opt.setText(text);
          if (this.plugin.settings.columns === value) opt.addClass("active");
          opt.addEventListener("click", async () => {
            this.plugin.settings.columns = value;
            await save();
            await applyStyle();
            clearActive();
            opt.addClass("active");
          });
        }
      },
      openInfo: () => new InfoModal(this.app, this.plugin, this.file).open(),
    });
  }
  _renderHistory() { // restore points list for the settings panel
    const row = this._histRow;
    if (!row) return;
    row.empty();
    const backups = this.file ? this.plugin.getBackups(this.file.path) : [];
    this._syncHistoryBadge(row, backups.length);
    if (!backups.length) {
      row.createDiv("qiaomu-reader-hist-empty").setText(qiaomuReaderTranslate("no-points-yet"));
      return;
    }
    for (const snap of [...backups].reverse().slice(0, 14)) this._addHistoryChip(row, snap);
  }
  _syncHistoryBadge(row, count) {
    const badge = row.parentElement && row.parentElement._qiaomuReaderCount;
    if (badge) badge.setText(count ? String(count) : "");
  }
  _addHistoryChip(row, snap) {
    const chip = row.createDiv("qiaomu-reader-hist-chip");
    const at = new Date(snap.ts || snap.lastRead || Date.now());
    chip.setText(`${snap.percent}% \xB7 ${at.toLocaleString(qiaomuReaderLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
    chip.addEventListener("click", () => this._restoreHistorySnapshot(snap));
  }
  _restoreHistorySnapshot(snap) {
    if (!this.bookHtml || this._openingBook) return;
    if (this.engine) { void restoreEngineHistory(this, snap); return; }
    if (!readerIsPdf(this)) return;
    const total = this.pager.total;
    const spread = typeof snap.block === "number" && snap.block >= 0
      ? this.pager.spreadForBlock(snap.block)
      : Math.round((typeof snap.pct === "number" ? snap.pct : (snap.percent || 0) / 100) * Math.max(0, total - 1));
    const [page, pages] = this.pager.jumpTo(spread);
    this._commitSpreadJump(page, pages);
    new Notice(qiaomuReaderTranslate("jumped-back-to-0", snap.percent));
  }
  buildTocPanel() {
    this._tocRender = buildTocPanelFor(this, this.tocPan, {
      close: () => this.closePanel(),
      jump: (item) => {
        if (this.engine && item && typeof item === "object" && (item.href || item.cfi)) {
          void navigateEngineToc(this, item.cfi ? item : item.href);
          return;
        }
        this._jumpToBlock(item && typeof item === "object" ? item.block : item);
      },
    });
  }
  buildFindPanel() {
    buildFindPanelFor(this, this.findPan, {
      close: () => this.closePanel(),
      jump: (b) => this._jumpToBlock(b)
    });
  }
  togglePanel(name) {
    // The highlights list is docked beside the pages, so it keeps the reading
    // area visible and toggles without the slide-over machinery.
    if (name === "highlights") {
      if (this.hlDockPanel?.isOpen()) { this.hlDockPanel.close(); return; }
      this._hideHlPopup();
      this.buildHlPanel();
      this.hlDockPanel?.open();
      return;
    }
    if (this.panelOpen === name) {
      this.closePanel();
      return;
    }
    this._hideHlPopup();
    if (name === "settings") this._renderHistory();
    if (name === "toc" && this._tocRender) this._tocRender();
    this.panelOpen = name;
    syncNavigationPanel(this, name);
    this.settPan.classList.toggle("qiaomu-reader-panel-open", name === "settings");
    this.tocPan.classList.toggle("qiaomu-reader-panel-open", name === "toc");
    this.findPan.classList.toggle("qiaomu-reader-panel-open", name === "find");
    if (name === "find") this._positionFindPanel();
    if (name === "toc" && this._tocRender) this._tocRender();
    this.overlayEl.classList.add("qiaomu-reader-overlay-on");
  }
  closePanel() {
    this.panelOpen = null;
    syncNavigationPanel(this, null);
    this.settPan.classList.remove("qiaomu-reader-panel-open");
    this.tocPan.classList.remove("qiaomu-reader-panel-open");
    if (this.findPan) this.findPan.classList.remove("qiaomu-reader-panel-open");
    this.overlayEl.classList.remove("qiaomu-reader-overlay-on");
  }
  // The AI button toggles: a second click closes the companion sidebar,
  // exactly like the highlights dock and the navigation panels.
  async _toggleAiCompanion() {
    const plugin = this.plugin;
    const isOpen = typeof plugin?.aiCompanionOpen === "function" && plugin.aiCompanionOpen() === true;
    if (isOpen) {
      plugin.closeReadingCompanion?.();
      this._syncToolButtons();
      return;
    }
    await plugin?.openAiChat?.(readerAiPanelContext(this));
    this._syncToolButtons();
  }
  // Toolbar toggles show what is open (pressed style + aria-expanded). The
  // desktop shell syncs the TOC button itself (its TOC lives in a workspace
  // leaf) and calls this again whenever leaves change, so a sidebar closed
  // from its own ✕ clears the pressed look too.
  _syncToolButtons() {
    const plugin = this.plugin;
    const aiOpen = typeof plugin?.aiCompanionOpen === "function" && plugin.aiCompanionOpen() === true;
    if (this.aiBtn) {
      this.aiBtn.toggleClass("qiaomu-reader-ibtn-on", aiOpen);
      this.aiBtn.setAttribute("aria-expanded", String(aiOpen));
    }
    const hlOpen = this.hlDockPanel?.isOpen?.() === true;
    if (this.hlBtn) {
      this.hlBtn.toggleClass("qiaomu-reader-ibtn-on", hlOpen);
      this.hlBtn.setAttribute("aria-expanded", String(hlOpen));
    }
    // Non-desktop hosts keep the TOC as an in-reader panel; the desktop TOC
    // button is synced by the shell.
    if (typeof plugin?.app?.qbrDesktopOpenToc !== "function" && this.tocBtn) {
      const tocOpen = this.panelOpen === "toc";
      this.tocBtn.toggleClass("qiaomu-reader-ibtn-on", tocOpen);
      this.tocBtn.setAttribute("aria-expanded", String(tocOpen));
    }
  }
  async exportNavigationCopy() {
    if (this._exportingNavigationCopy) return;
    const extension = String(this.file?.extension || "").toLowerCase();
    if (!this.file || (extension !== "epub" && extension !== "azw3")) {
      new Notice("只有 EPUB 或 AZW3 可以导出带导航的副本");
      return;
    }
    const entries = (this.tocItems || []).filter((entry) => entry
      && (entry.sectionId || entry.href || entry.cfi));
    if (!entries.length) {
      new Notice("先生成并应用目录，再导出副本");
      return;
    }
    this._exportingNavigationCopy = true;
    try {
      if (extension === "azw3") {
        new Notice("正在通过 Calibre 生成带导航的 AZW3，可能需要几十秒…", 5000);
      }
      const output = await this.plugin.exportNavigationCopy(this.file.path, entries);
      new Notice(`已另存带导航副本：${output.name}`, 8000);
    } catch (error) {
      new Notice(`导出带导航副本失败：${String(error?.message || error)}`, 10000);
    } finally {
      this._exportingNavigationCopy = false;
    }
  }
  // Kept for older document-tool callers and tests.
  async exportEpubWithToc() {
    return this.exportNavigationCopy();
  }
  async reloadView() {
    if (!this.bookHtml || !this.file) {
      new Notice(qiaomuReaderTranslate("nothing-to-refresh"));
      return;
    }
    const cur = this.pager.spread, tot = this.pager.total;
    this.plugin.saveProgress(this.file.path, cur, tot, this.pager.currentBlockIndex());
    this._hideHlPopup();
    this.closePanel();
    await this.plugin.refreshHighlights(this.file.path);
    this._lastWidth = this.areaEl.clientWidth;
    await this.repaginate();
    new Notice(qiaomuReaderTranslate("refreshed"));
  }
  _renderFlowHighlights() {
    if (this.engine) { this._renderEngineHighlights(); this._renderEnginePins(); return; }
    if (!this.file || !this.pager.flow) return;
    const flow = this.pager.flow;
    unwrapAllHighlights(flow);
    const blocks = flow.querySelectorAll(READER_BLOCK_SELECTOR);
    const list = this.plugin.getHighlights(this.file.path);
    for (const hl of list) {
      const anchor = resolveHighlightAnchor(blocks, hl, this.file.extension === "pdf");
      if (!anchor) continue;
      wrapBlockRange(anchor.block, anchor.loc.start, anchor.loc.start + anchor.loc.len, { id: hl.id, color: hlColorCss(hl.color) });
    }
    this._renderFlowPins();
  }
  // Pinned readings in the block flow (fixed-layout pages) carry their pinyin
  // in a wrapped span; block anchors relocate them after repagination.
  _renderFlowPins() {
    if (this.engine || !this.file || !this.pager.flow) return;
    const flow = this.pager.flow;
    unwrapAllPins(flow);
    const blocks = flow.querySelectorAll(READER_BLOCK_SELECTOR);
    for (const pin of this.plugin.getPins(this.file.path)) {
      if (!Number.isInteger(pin.block) || !pin.pinyin) continue;
      const anchor = resolveHighlightAnchor(blocks, pin, this.file.extension === "pdf");
      if (!anchor) continue;
      wrapBlockRange(anchor.block, anchor.loc.start, anchor.loc.start + anchor.loc.len,
        { id: pin.id, pin: true, pinyin: pin.pinyin, text: pin.text });
    }
  }
  _scheduleSelCheck() {
    window.clearTimeout(this._selTimer);
    this._selTimer = window.setTimeout(() => this._onSelectionCheck(), 60);
  }
  _onSelectionCheck() {
    if (this.engine || this._selectionMenuOpen || this._selectionDragging || this._pdfPanning || this.pdfPanMode || this._editHlId || this._commentEditing) return;
    const found = flowSelectionParts(this);
    if (!found) {
      this._hideHlPopup();
      return;
    }
    raiseSelectionPopup(this, found.parts, found.range);
  }
  buildHlPopup() {
    const pop = this.hlPopup;
    pop.empty();
    pop.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof HTMLElement) || !e.target.closest(".qiaomu-reader-hl-comment-editor")) e.preventDefault();
    });
    selectionHud.addBarButtons(this, pop);
  }
  _applyPopupColor(colorId) { return selectionHud.applySelectionColor(this, colorId); }

  _createHighlight(sel, colorId) {
    if (!sel || !this.file) return null;
    const existing = selectionHud.matchingSelectionHighlight(this, sel);
    if (existing) {
      this.plugin.setHighlightColor(this.file.path, existing.id, colorId);
      if (this.engine) void this.engine.addHighlight(existing.id, existing.cfi, colorId);
      else this._renderFlowHighlights();
      return existing.id;
    }
    const id = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (sel.cfi && this.engine) {
      // Engine formats anchor by CFI; one highlight spans the whole selection
      // because the library's range can cross paragraphs on its own.
      const hl = { id, color: colorId, text: sel.text, cfi: sel.cfi, created: Date.now() };
      this.plugin.addHighlight(this.file.path, hl);
      void this.engine.addHighlight(id, sel.cfi, colorId);
      return id;
    }
    const hl = { id, color: colorId, text: sel.text, block: sel.block, occ: sel.occ, pre: sel.pre, post: sel.post, created: Date.now() };
    this.plugin.addHighlight(this.file.path, hl);
    const blocks = this.pager.flow.querySelectorAll(READER_BLOCK_SELECTOR);
    const block = blocks[hl.block];
    if (block) {
      const t = block.textContent;
      const loc = locateHl(t, hl);
      if (loc) wrapBlockRange(block, loc.start, loc.start + loc.len, { id: hl.id, color: hlColorCss(colorId) });
    }
    return id;
  }
  _currentHl() {
    if (this._editHlId && this.file) {
      const hl = this.plugin.getHighlights(this.file.path).find((h) => h.id === this._editHlId);
      if (hl) return { ...hl, text: hl.text || "" };
    }
    if (this._pendingSel) return { ...this._pendingSel, text: this._pendingSel.text || "", color: null };
    return null;
  }
  _openHlEdit(id) {
    let _a;
    const span = (_a = this.pager.flow) == null ? void 0 : _a.querySelector(`[data-hl-id="${id}"]`);
    if (!span) return;
    this._pendingSel = null;
    this._editHlId = id;
    this._showHlPopup(span.getBoundingClientRect());
  }
  _unwrapHighlight(id) {
    if (this.engine) { void this.engine.removeHighlight(id); return; }
    const flow = this.pager.flow;
    if (!flow) return;
    flow.querySelectorAll(`[data-hl-id="${id}"]`).forEach((span) => {
      const parent2 = span.parentNode;
      while (span.firstChild) parent2.insertBefore(span.firstChild, span);
      parent2.removeChild(span);
      parent2.normalize();
    });
  }
  _showHlPopup(rect) {
    const pop = this.hlPopup;
    this._hlPopupRect = rect;
    selectionHud.syncSelectionToolbar(this);
    pop.classList.add("qiaomu-reader-hl-popup-on");
    readerHud.positionPopup(this, rect, 320, 44);
    selectionHud.showHighlightUndo(this, rect);
  }
  _hideHlPopup() {
    qiaomuReaderClearPaintedSelection();
    selectionHud.closeSelectionColorDropdown(this);
    selectionHud.closeInlineHighlightComment(this);
    this._hlPopupRect = null;
    this._selectionDoc = null;
    this._pendingSel = null;
    this._editHlId = null;
    if (this.hlPopup) this.hlPopup.classList.remove("qiaomu-reader-hl-popup-on");
  }
  // The toolbar box drives the find panel: same search, first hit revealed.
  _findFromToolbar(query) {
    const value = String(query || "").trim();
    if (!value) return;
    // Ensure open: a toggle here would close the panel the button just opened.
    if (this.panelOpen !== "find") this.togglePanel("find");
    this._searchFromToolbar?.(value);
    if (this._findInput) readerHud.autoFocus(this._findInput, 60);
  }
  // The results card hangs right under the search box. The toolbar is fixed in
  // the desktop shell and any ancestor scroll would drag an absolutely
  // positioned card away from it, so pin the card in viewport coordinates.
  _positionFindPanel() {
    const panel = this.findPan;
    const anchor = this.findBoxEl;
    if (!panel || !anchor || this.panelOpen !== "find") return;
    const box = anchor.getBoundingClientRect();
    const bar = this.contentEl.querySelector(".qiaomu-reader-top")?.getBoundingClientRect();
    const width = panel.offsetWidth || 440;
    const maxLeft = Math.max(8, (window.innerWidth || box.right + width) - width - 8);
    panel.style.position = "fixed";
    panel.style.left = `${Math.round(Math.min(maxLeft, Math.max(8, box.left)))}px`;
    panel.style.right = "auto";
    panel.style.top = `${Math.round((bar ? bar.bottom : 40) + 2)}px`;
    panel.style.bottom = "auto";
  }
  // A pending reflow restores its own reading anchor, which would overwrite a
  // jump issued while the pages are being rebuilt (the dock opening or a window
  // resize schedules one). Let it finish first so the jump sticks.
  async _settleLayoutBeforeJump() {
    if (this._resizeTimer) {
      window.clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
      await this.repaginate().catch(() => {});
    }
    if (this._layoutPromise) await this._layoutPromise.catch(() => {});
  }
  async goToHighlight(id) { // panel click: reveal the highlight and flash it
    rememberReaderJump(this);
    if (this.engine) {
      const hl = this.file && this.plugin.getHighlights(this.file.path).find((item) => item.id === id);
      try { await jumpToEngineHighlight(this, hl); }
      catch { new Notice(qiaomuReaderTranslate("highlight-not-found")); }
      return;
    }
    await this._settleLayoutBeforeJump();
    this._jumpToHighlightRecord(id);
  }
  // Shared tail of every highlight jump: repaint, persist the position, close.
  _commitSpreadJump(page, pages) {
    this.updateUI(page, pages);
    if (this.file) this.plugin.saveProgress(this.file.path, page, pages, this.pager.currentBlockIndex());
    this.closePanel();
  }
  // Fixed-layout pages render lazily, so a wrapped span can exist with zero
  // size; the block anchor is what maps to a spread, exactly like a table of
  // contents jump. The flash waits for the page to become visible.
  _jumpToHighlightRecord(id) {
    const records = this.file ? this.plugin.getHighlights(this.file.path) : null;
    const hl = records ? records.find((h) => h.id === id) : null;
    if (!(hl && typeof hl.block === "number")) {
      new Notice(qiaomuReaderTranslate("highlight-not-found"));
      return;
    }
    const blocks = this.pager.flow?.querySelectorAll(READER_BLOCK_SELECTOR) || [];
    const anchor = resolveHighlightAnchor(blocks, hl, this.file?.extension === "pdf");
    if (!anchor) {
      // 固定版式按需渲染:目标页的文本层可能已经被回收,锚点自然找不回来。
      // PDF 的 block 与页一一对应(面板上的页码也是这么算的),照页跳过去,
      // 别只弹「找不到这条划线」。
      const page = this.file?.extension === "pdf"
        ? (this._pdfLazy ? hl.block + 1 : pageForBlock(this.pager.flow, hl.block))
        : 0;
      if (page) {
        const [current, pages] = this.pager.jumpTo(page - 1);
        this._commitSpreadJump(current, pages);
        window.requestAnimationFrame(() => this._flashHighlightLater(id));
        return;
      }
      new Notice(qiaomuReaderTranslate("highlight-not-found"));
      return;
    }
    const [page, pages] = this.pager.jumpTo(this.pager.spreadForBlock(anchor.index));
    this._commitSpreadJump(page, pages);
    window.requestAnimationFrame(() => this._flashHighlightLater(id));
  }
  _flashHighlightLater(id, attempt = 0) {
    const span = this.pager.flow?.querySelector(`[data-hl-id="${id}"]`);
    if (span && span.getBoundingClientRect().width > 0) { this._flashEl(span); return; }
    if (attempt < 8) window.setTimeout(() => this._flashHighlightLater(id, attempt + 1), 120);
  }
  _flashEl(el) {
    el.classList.add("qiaomu-reader-hl-flash");
    window.setTimeout(() => el.classList.remove("qiaomu-reader-hl-flash"), 1200);
  }
  buildHlPanel() {
    renderHighlightPanel(this.hlPan, this, {
      rebuild: () => this.buildHlPanel(),
      delAria: qiaomuReaderTranslate("delete"),
    });
  }
  async onClose() {
    this._loadCoordinator.cancel();
    this._cancelTextLayerJob();
    this._hideOcrBar();
    this._closed = true;
    this._resizeObs?.disconnect();
    this.pageJumpObs?.disconnect();
    this.pageJumpOff?.();
    this._columnDragWatchOff?.();
    this._columnDragOff?.();
    this._selectionCleanup?.();
    window.clearTimeout(this._contextSettleTimer);
    clearAiSource(this);
    setReadingFocus(this, false);
    await persistCurrentReaderPosition(this);
    this._releaseEngine();
    readerHud.hideVeil(this);
    let _a;
    readerTimer.stop(this);
    window.clearTimeout(this._immTimer);
    (_a = this._resizeObs) == null ? void 0 : _a.disconnect();
    window.clearTimeout(this._resizeTimer);
    window.clearTimeout(this._selTimer);
    window.clearTimeout(this._revealT);
    clearFoundIn(this);
    this._pdfLazy?.destroy?.();
    this._pdfLazy = null;
    this._pdfForm?.destroy?.();
    this._pdfForm = null;
  }
};
}
