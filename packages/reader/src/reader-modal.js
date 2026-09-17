// ReaderModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { EpubEngine } from "./reader-engine.js";
import { PDF_ZOOM_DEFAULT } from "./pdf-zoom.js";
import { READER_BLOCK_SELECTOR } from "./pdf-page-mode.js";
import { captureReadingAnchor, queueReadingLayout, restoreReadingAnchor } from "./reader-experience.js";
import { createReaderLoadCoordinator, isReaderLoadAbort, waitForReaderFrame } from "./reader-load.js";
import { docOf } from "./reader-dom.js";
import { jumpToEngineHighlight } from "./highlight-navigation.js";
import { readerTextCss, resolveReaderFont, syncPageButtons } from "./reader-appearance.js";

export function createReaderModal({
  Modal, Notice, BookSetupModal, FONTS, InfoModal, ReadSettingsModal, addPdfZoomMenuItems, attachEngineChrome, attachReaderContentClick, attachReaderSwipeNav, bookNoteAction, buildFindPanelFor, buildReaderBotNav, buildReaderMoreButton, buildReaderPageArea, buildReaderPanels, buildReaderSettPanelBody, buildReaderTopBar, buildTocItems, buildTocPanelFor, clearAiSource, clearFoundIn, createPdfPaginator, currentBookPage, enrichHighlights, ensureSelectedReaderFont, exportHighlightsMenu, flowSelectionParts, hlColorCss, loadReaderDocument, locateHl, markFoundIn, navigateEngineToc, openEngineHighlightPopup, openOrCreateBookNoteBeside, pdfVisiblePageLabel, pdfZoom, persistCurrentReaderPosition, qiaomuReaderClearPaintedSelection, qiaomuReaderLocale, qiaomuReaderRevealWhenSettled, qiaomuReaderTheme, qiaomuReaderTranslate, raiseSelectionPopup, readerHud, readerIsPdf, readerPaginationMappingCollapsed, readerPdfPages, readerTimer, rememberReaderJump, renderHighlightPanel, renderReaderLoadError, renderVisibleFigures, resolveHighlightAnchor, restoreAiSource, restoreEngineHistory, selectionHud, settleReader, syncNavigationPanel, syncOpenAiSelectionContext, syncReaderAiCapability, unwrapAllHighlights, updateEngineLocation, wireReaderChrome, wrapBlockRange,
}) {
  return class ReaderModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin  = plugin;
    this.file    = file;
    this.ext     = file.extension;
    this.pdfZoom = PDF_ZOOM_DEFAULT;
    this.pager = createPdfPaginator(this);
    this._loadCoordinator = createReaderLoadCoordinator();
    this._closed = false;
    this.bookHtml = "";
    this.pdfDocumentContext = null;
    this.tocItems = [];
    this.panelOpen = null;
    this._pendingSel = null;
    this._editHlId = null;
  }
  async onOpen() {
    const modalEl = this.modalEl;
    const contentEl = this.contentEl;
    this._closed = false; this.plugin._openReaderModal = this;
    this._stripEscapeFromScope();
    this._registerPdfZoomKeys();
    modalEl.addClass("qiaomu-reader-fullscreen-modal");
    this.containerEl.addClass("qiaomu-reader-fullscreen-container");
    contentEl.addClass("qiaomu-reader-fullscreen-content");
    this._applyTopInset(contentEl);
    this._installCloseGuard(modalEl);
    this._applyTheme(); this._buildDOM();
    const visibilityDoc = docOf(this.contentEl);
    const onVisible = () => { void renderVisibleFigures(this); };
    visibilityDoc.addEventListener("visibilitychange", onVisible);
    this._visibilityCleanup = () => visibilityDoc.removeEventListener("visibilitychange", onVisible);
    await this._loadBook();
    if (this._closed) return;
    this._startReadingSession();
    this._installResizeWatch();
  }
  _stripEscapeFromScope() {
    try {
      const scope = this.scope;
      if (scope && Array.isArray(scope.keys)) {
        scope.keys = scope.keys.filter((k) => String(k && k.key).toLowerCase() !== "escape");
      }
    } catch { /* the escape filter is best-effort only */ }
  }
  _registerPdfZoomKeys() {
    const zoomBy = (delta) => (event) => {
      if (!readerIsPdf(this)) { return; }
      event.preventDefault(); pdfZoom.change(this, delta);
    };
    this.scope.register(["Mod"], "=", zoomBy(1));
    this.scope.register(["Mod"], "-", zoomBy(-1));
    this.scope.register(["Mod"], "0", (event) => {
      if (!readerIsPdf(this)) { return; }
      event.preventDefault(); pdfZoom.apply(this, PDF_ZOOM_DEFAULT);
    });
  }
  _applyTopInset(contentEl) {
    const insetPx = Number(this.plugin.settings.mobileTopInset) || 0;
    if (insetPx <= 0) {
      return;
    }
    contentEl.style.setProperty("--qiaomu-reader-extra-top", insetPx + "px");
  }
  _installCloseGuard(modalEl) {
    const CLOSE_SELECTOR = ".modal-close-button, .modal-header-button";
    const sweep = (all) => {
      try {
        for (const b of docOf(modalEl).querySelectorAll(CLOSE_SELECTOR)) {
          const owner = b.closest(".modal-container");
          if (all || !owner || owner === this.containerEl) b.remove();
        }
      } catch { /* an unmatched selector simply removes nothing */ }
    };
    sweep(true);
    const pageDoc = docOf(modalEl);
    this._closeWatch = new MutationObserver(() => sweep(false));
    this._closeWatch.observe(pageDoc.body, { childList: true, subtree: true });
  }
  _startReadingSession() {
    this._sessionSec = 0; this._running = false;
    const readToday = this.plugin.getTodaySeconds();
    const goalToday = this.plugin.getGoalSeconds();
    this._goalNotified = readToday >= goalToday;
    readerTimer.updateGoalBar(this); readerTimer.updateButton(this);
  }
  _installResizeWatch() {
    const startWidth = this.areaEl.clientWidth;
    this._lastW = startWidth;
    const onResize = () => {
      window.clearTimeout(this._rsT); this._rsT = window.setTimeout(() => {
        const widthNow = this.areaEl ? this.areaEl.clientWidth : 0;
        if (!widthNow) {
          return;
        }
        const drifted = Math.abs(widthNow - (this._lastW || 0)) > 4
          || Math.abs(this.areaEl.clientHeight - (this.pager.builtHeight || 0)) > 4;
        if (drifted) { this._lastW = widthNow; this._repaginate(); }
      }, 180);
    };
    const obs = new ResizeObserver(onResize);
    this._resizeObs = obs;
    obs.observe(this.areaEl);
  }
  _applyTheme() {
    syncPageButtons(this);
    const t = qiaomuReaderTheme(this.plugin.settings);
    const m = this.modalEl;
    m.style.setProperty("--qiaomu-reader-bg", t.bg);
    m.style.setProperty("--qiaomu-reader-text", t.text);
    m.style.setProperty("--qiaomu-reader-ui", t.ui);
    m.style.setProperty("--qiaomu-reader-border", t.border);
    m.style.setProperty("--qiaomu-reader-accent", t.accent);
    m.style.setProperty("--qiaomu-reader-muted", t.muted);
    // Keep the full reading surface in the selected paper colour.
    // Navigation controls keep their own Obsidian surface styles.
    m.setCssProps({ background: "var(--qiaomu-reader-bg, var(--background-primary))" });
    this.engine?.setExtraCss(this._engineAppearanceCss());
  }
  _buildDOM() {
    const { contentEl: root } = this;
    root.empty();
    const pb = root.createDiv("qiaomu-reader-pbar");
    this.pbarFill = pb.createDiv("qiaomu-reader-pbar-fill");
    const tray = buildReaderTopBar(this, {
      backAttr: { type: "button", "aria-label": qiaomuReaderTranslate("close-the-book") },
      title: this.file.basename,
      onBack: () => this.close(),
    });
    readerTimer.buildButton(tray, this);
    // Mobile keeps one compact overflow: every item is reader-specific, and the
    // title retains enough room to identify the current book.
    buildReaderMoreButton(tray, this, (list, add) => {
      add("the-book-note", "file-text", () => openOrCreateBookNoteBeside(this.plugin, this.file));
      add("highlights", "highlighter", () => this._togglePanel("highlights"));
      add("reset-timer", "rotate-ccw", () => readerTimer.reset(this));
      add("reading-settings", "sliders", () => new ReadSettingsModal(this.app, this).open());
      addPdfZoomMenuItems(list, this);
      list.addSeparator();
      add("close-the-book", "x", () => this.close());
    });
    buildReaderPageArea(this, root, "qiaomu-reader-area qiaomu-reader-marea");
    const navBar = root.createDiv("qiaomu-reader-bot");
    buildReaderBotNav(this, root, navBar, { buttonType: true });
    buildReaderPanels(this, root, {
      dismiss: () => this._closePanel(),
      buildPanelContents: () => {
        this._buildSettPanel(); this._buildTocPanel();
        this._buildHlPanel(); this._buildFindPanel();
      },
      buildPopup: () => this._buildHlPopup(),
    });
    const pageDoc = docOf(this.areaEl);
    this._selDoc = pageDoc;
    const noteSelection = () => this._scheduleSelCheck();
    this._selHandler = noteSelection;
    this._selDoc.addEventListener("selectionchange", noteSelection);
    attachReaderContentClick(this);
    attachReaderSwipeNav(this);
    wireReaderChrome(this, root);
  }
  async _applyContentStyle() {
    await this._repaginate();
  }
  async _repaginate() {
    if (!this.bookHtml || this._openingBook || this._closed || !this.areaEl || !this.areaEl.clientWidth) return;
    if (this.engine) {
      this.engine.setLayout(this.plugin.settings);
      this.engine.setExtraCss(this._engineAppearanceCss());
      return;
    }
    return queueReadingLayout(this, (anchor) => this._repaginateAnchored(anchor));
  }
  async _repaginateAnchored(anchor) {
    this.areaEl.addClass("qiaomu-reader-booting");
    readerHud.showVeil(this);
    await this.pager.build(this.areaEl, this.bookHtml, this.plugin.settings, 0);
    this._renderFlowHighlights();
    const [cur, tot] = restoreReadingAnchor(this.pager, anchor);
    restoreAiSource(this);
    if (this.pdfZoomMode === "width") pdfZoom.fitWidth(this);
    this._readingAnchor = anchor;
    qiaomuReaderRevealWhenSettled(this);
    this._updateUI(cur, tot);
    if (this._tocRender) this._tocRender();
    this._findCorpus = null;
    if (this._foundQuery) this._markFound(this._foundQuery);
  }
  async _loadBook() {
    const loadToken = this._loadCoordinator.begin();
    this._openingBook = loadToken;
    this._layoutAgain = false;
    if (this._layoutPromise) await this._layoutPromise.catch(() => {});
    if (!this._loadCoordinator.isCurrent(loadToken)) return;
    readerHud.hideVeil(this);
    this.areaEl.removeClass("qiaomu-reader-booting");
    this.areaEl.empty(); const loading = this.areaEl.createDiv("qiaomu-reader-loading");
    loading.addClass("qiaomu-reader-centered");
    loading.createDiv("qiaomu-reader-spin");
    const loadText = loading.createDiv("qiaomu-reader-loading-text");
    loadText.setText(qiaomuReaderTranslate("loading-the-book"));
    await this._waitTwoFrames();
    let result = null;
    try {
      this._releasePdfLazy();
      result = await loadReaderDocument(this.file, this.app, this.plugin.settings, (i, n) => {
        if (this._loadCoordinator.isCurrent(loadToken)) {
          loadText.setText(qiaomuReaderTranslate("preparing-the-book-0", Math.round(i / n * 100)));
        }
      }, { signal: loadToken.signal });
      if (!this._loadCoordinator.isCurrent(loadToken)) {
        result.lazy?.destroy?.();
        return;
      }
      const settled = await this._openLoadedDocument(result, loadToken);
      if (!settled) return;
      this._buildSettPanel(); this._maybePromptBookNote(this.file);
    } catch (e) {
      if (isReaderLoadAbort(e, loadToken.signal) || !this._loadCoordinator.isCurrent(loadToken)) return;
      console.error("UV Reader: could not open file in the mobile reader", e);
      readerHud.hideVeil(this);
      this.areaEl.removeClass("qiaomu-reader-booting");
      renderReaderLoadError(this, e, () => this._loadBook());
    } finally {
      this._loadCoordinator.finish(loadToken);
      if (this._openingBook === loadToken) { this._openingBook = null; settleReader(this); }
    }
  }
  _releasePdfLazy() {
    this._pdfLazy?.destroy?.(); this._pdfLazy = null;
  }
  _waitTwoFrames() {
    const win = docOf(this.areaEl).defaultView;
    return waitForReaderFrame(win).then(() => waitForReaderFrame(win));
  }
  async _openLoadedDocument(result, loadToken) {
    if (result.engine) {
      // Engine formats render through foliate-js on mobile as well; the
      // paginated pipeline is bypassed entirely.
      this.bookHtml = "engine";
      this.pdfDocumentContext = null;
      this._pdfLazy = null;
      this._pdfOutline = null;
      await this.plugin.refreshProgress();
      if (!this._loadCoordinator.isCurrent(loadToken)) return false;
      const savedEngine = this.plugin.getProgress(this.file.path);
      await this._mountEngine(result, savedEngine, loadToken);
      if (!this._loadCoordinator.isCurrent(loadToken)) return false;
      this.tocItems = this._engineTocItems();
      this._buildTocPanel();
      await this.plugin.refreshHighlights();
      if (!this._loadCoordinator.isCurrent(loadToken)) return false;
      this._renderEngineHighlights();
      return true;
    }
    this.bookHtml = result.html;
    this.pdfDocumentContext = result.pdfDocumentContext || null;
    this._pdfLazy = result.lazy;
    this._pdfOutline = result.outline;
    this.tocItems = buildTocItems(this.bookHtml, this._pdfOutline);
    this._buildTocPanel();
    await this.plugin.refreshHighlights();
    if (!this._loadCoordinator.isCurrent(loadToken)) return false;
    await this.plugin.refreshProgress();
    if (!this._loadCoordinator.isCurrent(loadToken)) return false;
    const saved = this.plugin.getProgress(this.file.path);
    const pct = (saved == null ? void 0 : saved.pct) != null ? saved.pct : 0;
    this.areaEl.addClass("qiaomu-reader-booting");
    readerHud.showVeil(this);
    readerHud.markSlowLayout(this);
    await readerHud.paintVeil(this);
    if (!this._loadCoordinator.isCurrent(loadToken)) return false;
    await this.pager.build(this.areaEl, this.bookHtml, this.plugin.settings, 0);
    if (!this._loadCoordinator.isCurrent(loadToken)) return false;
    if (readerPaginationMappingCollapsed(this.pager)) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      if (!this._loadCoordinator.isCurrent(loadToken)) return false;
      await this.pager.build(this.areaEl, this.bookHtml, this.plugin.settings, 0);
      if (!this._loadCoordinator.isCurrent(loadToken)) return false;
    }
    const hasBlock = saved && typeof saved.block === "number" && saved.block >= 0;
    const target = hasBlock
      ? this.pager.spreadForBlock(saved.block)
      : Math.round(pct * Math.max(0, this.pager.total - 1));
    this._renderFlowHighlights();
    const [cur, tot] = this.pager.jumpTo(target);
    if (hasBlock && this.pager.scrollMode) restoreReadingAnchor(this.pager, { block: saved.block, offset: 0, pct });
    this._readingAnchor = captureReadingAnchor(this.pager);
    this._updateUI(cur, tot);
    qiaomuReaderRevealWhenSettled(this);
    if (hasBlock) this._flashBlock(saved.block);
    return true;
  }
  _maybePromptBookNote(file) {
    const s = this.plugin.settings;
    if (!file) return;
    if (!s.bookNoteLinks) s.bookNoteLinks = {};
    if (!s.bookNotePrompted) s.bookNotePrompted = {};
    const action = bookNoteAction(s, file.path);
    if (action === "linked" || action === "prompted") return;
    if (action === "auto") {
      s.bookNotePrompted[file.path] = true;
      this.plugin.ensureBookNote(file).then((note) => {
        if (note) new Notice(qiaomuReaderTranslate("book-note-created-0", note.basename));
      });
      return;
    }
    new BookSetupModal(this.app, this.plugin, file, () => {}).open();
  }
  _jumpToBlock(block, flash = true) {
    if (!readerIsPdf(this) || !this.bookHtml || typeof block !== "number") return;
    rememberReaderJump(this);
    const [cur, tot] = restoreReadingAnchor(this.pager, { block, offset: 0, pct: this.pager.currentPct });
    this._updateUI(cur, tot);
    if (this.file) this.plugin.saveProgress(this.file.path, cur, tot, this.pager.currentBlockIndex());
    if (flash) this._flashBlock(block);
  }
  jumpToPdfPageWhenReady(page) {
    let tries = 0; const tick = () => {
      const pagerFlow = this.pager && this.pager.flow;
      if (pagerFlow && this.pager.total) {
        const el = pagerFlow.querySelector(`[data-pdf-page-no="${page}"]`);
        if (el) {
          const offsetX = el.getBoundingClientRect().left - pagerFlow.getBoundingClientRect().left;
          const colCount = this.pager.cols || 1; const stride = this.pager.sw / colCount;
          const spread = Math.floor(Math.round(offsetX / stride) / colCount);
          const clamped = Math.max(0, Math.min(spread, this.pager.total - 1));
          const [cur, tot] = this.pager.jumpTo(clamped);
          const notify = this.updateUI || this._updateUI;
          notify.call(this, cur, tot);
          return;
        }
      }
      if (++tries > 40) { return; } window.setTimeout(tick, 100);
    };
    tick();
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
  _nav(dir) {
    if (!this.bookHtml) return;
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
    this._hideHlPopup();
    const [cur, total] = dir === "next" ? this.pager.next() : this.pager.prev();
    this._updateUI(cur, total);
    this.plugin.saveProgress(this.file.path, cur, total, this.pager.currentBlockIndex());
  }
  async _mountEngine(result, saved, loadToken) {
    // foliate-js renders into its own element; the mobile chrome keeps working
    // off the stored reading data exactly like the paginated pipeline does.
    const file = this.file;
    this.areaEl.empty();
    const mount = this.areaEl.createDiv("qiaomu-reader-engine-host");
    const plugin = this.plugin;
    const engine = this.engine = new EpubEngine(mount, {
      initialCss: this._engineAppearanceCss(),
      layout: plugin.settings,
      onNavigate: (direction) => this._nav(direction),
      onHighlightClick: (hit) => openEngineHighlightPopup(this, hit),
      onDocLoaded: ({ doc, index }) => {
        attachEngineChrome(this, doc, index);
        try { void ensureSelectedReaderFont(doc, plugin, plugin.settings); }
        catch (e) { console.warn("UV Reader: could not load the reading font into a book document", e); }
        try {
          const notify = () => {
            window.clearTimeout(this._engineSelTimer);
            this._engineSelTimer = window.setTimeout(() => this._engineSelectionCheck({ doc, index }), 60);
          };
          doc.addEventListener("pointerup", notify);
          doc.addEventListener("selectionchange", notify);
        } catch (e) { console.warn("UV Reader: could not watch selections in a book document", e); }
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
  _engineAppearanceCss() {
    const s = this.plugin.settings;
    const t = qiaomuReaderTheme(s);
    return readerTextCss(s, t, resolveReaderFont(s, FONTS), this.contentEl);
  }
  _engineSelectionCheck({ doc, index }) {
    if (!this.engine || !this.file) return;
    if (this._editHlId || this._commentEditing || this._selectionDragging) return;
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
  _renderEngineHighlights() {
    if (!this.engine || !this.file) return;
    const engine = this.engine, path = this.file.path;
    void (async () => {
      for (const hl of this.plugin.getHighlights(path)) {
        if (this._closed || this.engine !== engine || this.file?.path !== path) return;
        if (!hl.cfi) continue;
        try { await engine.addHighlight(hl.id, hl.cfi, hl.color); }
        catch { /* that section may not be rendered yet */ }
      }
    })();
  }
  exportHighlights(evt) {
    if (!this.file) { new Notice(qiaomuReaderTranslate("no-book-is-open")); return; }
    const list = enrichHighlights(this, this.plugin.getHighlights(this.file.path));
    exportHighlightsMenu(this.app, this.plugin, this.file, list, evt);
  }
  _updateUI(cur, total) {
    settleReader(this);
    if (this.contentEl) this.contentEl.toggleClass("qiaomu-reader-scrolling", !!(this.pager && this.pager.scrollMode));
    cur = cur != null ? cur : this.pager.spread;
    total = total != null ? total : this.pager.total;
    const pct = total > 0 ? Math.round((cur + 1) / total * 100) : 0;
    this.pbarFill.style.width = `${pct}%`;
    const bookPage = currentBookPage(this);
    this.locEl.setText(bookPage ? qiaomuReaderTranslate("p-0", bookPage) + " · " + `${cur + 1} / ${total}` : `${cur + 1} / ${total}`);
    if (readerIsPdf(this)) this.locEl.setText(qiaomuReaderTranslate("page-0-of-1", pdfVisiblePageLabel(this, bookPage || 1), readerPdfPages(this).length || total));
    this.pctEl.setText(`${pct}%`);
    syncReaderAiCapability(this);
    pdfZoom.syncControls(this);
    renderVisibleFigures(this);
  }
  _buildSettPanel() {
    const save = () => this.plugin.saveAll();
    const applyStyle = () => { this._applyContentStyle(); };
    buildReaderSettPanelBody(this, this.settPan, {
      title: qiaomuReaderTranslate("settings"),
      onThemeApplied: () => this._applyTheme(),
      onTextStyleApplied: applyStyle,
      buildFontSizeRow: (host) => {
        const row = host.createDiv("qiaomu-reader-sz-row");
        const dec = row.createDiv("qiaomu-reader-sz-btn");
        dec.setText("A−");
        const label = row.createDiv("qiaomu-reader-sz-label");
        this.szLabel = label;
        label.setText(`${this.plugin.settings.fontSize}px`);
        const inc = row.createDiv("qiaomu-reader-sz-btn");
        inc.setText("A+");
        const step = async (delta) => {
          this.plugin.settings.fontSize = Math.min(32, Math.max(12, this.plugin.settings.fontSize + delta));
          label.setText(`${this.plugin.settings.fontSize}px`);
          await save();
          applyStyle();
        };
        dec.addEventListener("click", () => step(-1));
        inc.addEventListener("click", () => step(1));
      },
      openInfo: () => { this._closePanel(); new InfoModal(this.app, this.plugin, this.file).open(); },
    });
  }
  _renderHistory() {
    const row = this._histRow;
    if (!row) {
      return;
    }
    row.empty();
    const backups = this.file ? this.plugin.getBackups(this.file.path) : [];
    this._syncHistoryBadge(backups.length);
    if (!backups.length) {
      row.createDiv("qiaomu-reader-hist-empty").setText(qiaomuReaderTranslate("no-points-yet"));
      return;
    }
    const recent = [...backups].reverse().slice(0, 14);
    for (const snap of recent) {
      const chip = row.createDiv("qiaomu-reader-hist-chip");
      chip.setText(this._historyChipLabel(snap));
      chip.addEventListener("click", () => this._restoreHistorySnapshot(snap));
    }
  }
  _syncHistoryBadge(count) {
    const badge = this._histRow?.parentElement?._qiaomuReaderCount;
    if (badge) {
      badge.setText(count ? String(count) : "");
    }
  }
  _historyChipLabel(snap) {
    const stamp = new Date(snap.ts || snap.lastRead || Date.now());
    return `${snap.percent}% · ${stamp.toLocaleString(qiaomuReaderLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  }
  _restoreHistorySnapshot(snap) {
    if (!this.bookHtml || this._openingBook) return;
    if (this.engine) { void restoreEngineHistory(this, snap); return; }
    if (!readerIsPdf(this)) return;
    this._closePanel();
    const hasBlockSnap = typeof snap.block === "number" && snap.block >= 0;
    if (hasBlockSnap) { this._jumpToBlock(snap.block); } else {
      const hasPctSnap = typeof snap.pct === "number";
      const frac = hasPctSnap ? snap.pct : (snap.percent || 0) / 100;
      const targetSpread = Math.round(frac * Math.max(0, this.pager.total - 1));
      const [now, total] = this.pager.jumpTo(targetSpread);
      this._updateUI(now, total);
      if (this.file) this.plugin.saveProgress(this.file.path, now, total, this.pager.currentBlockIndex());
    }
    new Notice(qiaomuReaderTranslate("jumped-back-to-0", (snap.percent)));
  }
  _buildTocPanel() {
    this._tocRender = buildTocPanelFor(this, this.tocPan, {
      close: () => this._closePanel(),
      jump: (item) => {
        if (this.engine && item && typeof item === "object" && item.href) {
          void navigateEngineToc(this, item.href);
          return;
        }
        this._jumpToBlock(item && typeof item === "object" ? item.block : item);
      },
    });
  }
  _buildFindPanel() {
    buildFindPanelFor(this, this.findPan, {
      close: () => this._closePanel(),
      jump: (b) => this._jumpToBlock(b),
    });
  }
  _markFound(query) { markFoundIn(this, query); }
  _clearFound() { clearFoundIn(this); }
  _togglePanel(name) {
    if (this.panelOpen === name) { this._closePanel(); return; }
    this._hideHlPopup();
    if (name === "highlights") this._buildHlPanel();
    if (name === "settings") this._renderHistory();
    this.panelOpen = name;
    syncNavigationPanel(this, name);
    this.settPan.classList.toggle("qiaomu-reader-panel-open", name === "settings");
    this.tocPan.classList.toggle("qiaomu-reader-panel-open", name === "toc");
    this.hlPan.classList.toggle("qiaomu-reader-panel-open", name === "highlights");
    this.overlayEl.classList.add("qiaomu-reader-overlay-on");
  }
  _closePanel() {
    this.panelOpen = null;
    syncNavigationPanel(this, null);
    this.settPan.classList.remove("qiaomu-reader-panel-open");
    this.tocPan.classList.remove("qiaomu-reader-panel-open");
    this.hlPan.classList.remove("qiaomu-reader-panel-open");
    if (this.findPan) this.findPan.classList.remove("qiaomu-reader-panel-open");
    this.overlayEl.classList.remove("qiaomu-reader-overlay-on");
  }
  _renderFlowHighlights() {
    if (this.engine) { this._renderEngineHighlights(); return; }
    if (!this.file || !this.pager.flow) return;
    unwrapAllHighlights(this.pager.flow);
    const blocks = this.pager.flow.querySelectorAll(READER_BLOCK_SELECTOR);
    const list = this.plugin.getHighlights(this.file.path);
    for (const hl of list) {
      const anchor = resolveHighlightAnchor(blocks, hl, this.file.extension === "pdf");
      if (!anchor) continue;
      wrapBlockRange(anchor.block, anchor.loc.start, anchor.loc.start + anchor.loc.len, { id: hl.id, color: hlColorCss(hl.color) });
    }
  }
  _scheduleSelCheck() {
    window.clearTimeout(this._selTimer);
    this._selTimer = window.setTimeout(() => this._onSelectionCheck(), 80);
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
  _buildHlPopup() {
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
      // Engine formats anchor by CFI; one highlight spans the whole selection.
      const hl = { id, color: colorId, text: sel.text, cfi: sel.cfi, created: Date.now() };
      this.plugin.addHighlight(this.file.path, hl);
      void this.engine.addHighlight(id, sel.cfi, colorId);
      return id;
    }
    const hl = { id, color: colorId, text: sel.text, block: sel.block, occ: sel.occ, pre: sel.pre, post: sel.post, created: Date.now() };
    this.plugin.addHighlight(this.file.path, hl);
    const blocks = this.pager.flow ? this.pager.flow.querySelectorAll(READER_BLOCK_SELECTOR) : [];
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
    const span = this.pager.flow?.querySelector(`[data-hl-id="${id}"]`);
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
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
  }
  _showHlPopup(rect) {
    const pop = this.hlPopup;
    this._hlPopupRect = rect;
    selectionHud.syncSelectionToolbar(this);
    pop.classList.add("qiaomu-reader-hl-popup-on");
    readerHud.positionPopup(this, rect, 320, 44);
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
  async goToHighlight(id) {
    const hl = this.file ? this.plugin.getHighlights(this.file.path).find((h) => h.id === id) : null;
    rememberReaderJump(this);
    if (!hl) return;
    if (this.engine) {
      try { await jumpToEngineHighlight(this, hl); }
      catch { new Notice(qiaomuReaderTranslate("highlight-not-found")); }
      return;
    }
    const blocks = this.pager.flow?.querySelectorAll(READER_BLOCK_SELECTOR) || [];
    const anchor = resolveHighlightAnchor(blocks, hl, this.file?.extension === "pdf");
    if (!anchor) {
      new Notice(qiaomuReaderTranslate("highlight-not-found"));
      return;
    }
    this._closePanel();
    const [cur, tot] = this.pager.jumpTo(this.pager.spreadForBlock(anchor.index));
    this._updateUI(cur, tot);
    if (this.file) this.plugin.saveProgress(this.file.path, cur, tot, this.pager.currentBlockIndex());
    window.requestAnimationFrame(() => {
      const span = this.pager.flow?.querySelector(`[data-hl-id="${id}"]`);
      if (span) {
        span.classList.add("qiaomu-reader-hl-flash");
        window.setTimeout(() => span.classList.remove("qiaomu-reader-hl-flash"), 1200);
      }
    });
  }
  _buildHlPanel() {
    renderHighlightPanel(this.hlPan, this, { rebuild: () => this._buildHlPanel() });
  }
  async onClose() {
    this._closed = true;
    this._selectionCleanup?.();
    window.clearTimeout(this._contextSettleTimer);
    clearAiSource(this);
    this._loadCoordinator.cancel();
    await persistCurrentReaderPosition(this); readerTimer.stop(this);
    window.clearTimeout(this._engineSelTimer);
    this.engine?.destroy(); this.engine = null; this._engineLocation = null;
    if (this.plugin._openReaderModal === this) { this.plugin._openReaderModal = null; }
    clearFoundIn(this); this._removeSelectionListener();
    this._detachReaderObservers(); this.contentEl.empty();
  }
  _removeSelectionListener() {
    const handler = this._selHandler;
    if (!handler) {
      return;
    }
    const listenDoc = this._selDoc || document;
    listenDoc.removeEventListener("selectionchange", handler);
  }
  _detachReaderObservers() {
    this._visibilityCleanup?.(); this._visibilityCleanup = null;
    this._resizeObs?.disconnect(); this._pdfLazy?.destroy?.(); this._pdfLazy = null;
    window.clearTimeout(this._rsT); window.clearTimeout(this._selTimer);
    window.clearTimeout(this._immTimer); window.clearTimeout(this._revealT); this._closeWatch?.disconnect();
  }
};
}
