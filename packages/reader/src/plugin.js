// QiaomuBookReader assembly. The host supplies the Plugin base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { ENGINE_EXTENSIONS } from "./reader-engine.js";
import { STARTER_BOOKS } from "./starter-book-data.js";
import { addMissingQuoteLinks, highlightBacklink, jumpToEngineHighlight } from "./highlight-navigation.js";
import { sortHighlightsByPosition } from "./highlight-order.js";
import { aiProviderFor, normalizeAiBase } from "./ai-providers.js";
import { normalizeAiCapabilities } from "./ai-capability.js";
import { createReadingStore } from "./reading-store.js";
import { cloneJson, createSerialTaskQueue, isPlainRecord, mergeReadingProgress, readJsonRecordStore, writeVerifiedJsonRecord } from "./storage.js";
import { createStarterLibraryInstaller } from "./starter-library.js";
import { disposeReaderFonts } from "./reader-fonts.js";
import { loadAiDrafts } from "./ai-drafts.js";
import { migrateCoverCache } from "./book-cover.js";
import { migrateReaderTheme } from "./reader-themes.js";
import { normalizeLocationMarks } from "./reading-workflow.js";
import { normalizeUiLanguage } from "./i18n-languages.js";
import { watchQuietUi } from "./quiet-ui.js";

export function createPlugin({
  MarkdownView, Notice, Plugin, TFile, AI_CHAT_VIEW_TYPE, AiChatView, AiExplainModal, BOOK_EXTENSIONS, BookQuickOpen, DEFAULT, LIB_VIEW_TYPE, LibraryView, MAX_BOOK_COMMANDS, OnboardingModal, ReaderModal, ReaderView, SettingsTab, VIEW_TYPE, WhatsNewModal, aiSetupState, applyDeviceProfile, bookNoteFiles, bookNoteLinkFor, bookNoteTemplatePath, bookNotesFolderPath, captureDeviceProfile, flattenSelectionText, hlMark, isMarkedReadingNote, isUnsafeReadingNote, normalizeAiChatHistory, notesFolderPath, openPluginAiSettings, processTemplateManually, qiaomuReaderPath, qiaomuReaderSetLanguage, qiaomuReaderTranslate, readerAiPanelContext, readerDefaultAiContext, readerHud, readerSupportsAiContext, readerTodayKey, rememberReaderJump, resolveBookNote, sanitizeNoteTitle, selectedReaderTheme, stripGeneratedReadingNoteTitle, syncHighlightsToReadingNote, whatsNewSince, writeBookProperty, writeWhatsNewNote,
}) {
  return class QiaomuBookReader extends Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT };
    this.progress = {};
    this.thumbCache = {};
    this.highlights = {};
    this.pins = {};
    this._readingStoreCache = null;
    this.progressBackups = {};
    this._progressQueue = createSerialTaskQueue();
    this._localDataQueue = createSerialTaskQueue();
    this._corruptStoreNotices = new Set();
    this._blockedStores = new Set();
    this._unreadableStores = new Map();
  }
  async onload() { // state first (loadAll), then every Obsidian integration, registered in the original order
    await this.loadAll(); await this._attachAiDraftStore();
    this._unloading = false;
    this._watchCompanionAndNotes();
    this._registerReaderViews();
    this._registerBookProtocol();
    this._registerReaderExtensions();
    this._addRibbonEntry();
    this._registerCommandsAndSettings();
    this._quietUiDocuments = new Map();
    this._watchQuietUiDocument(document);
    this.app.workspace.iterateAllLeaves(leaf => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (doc) this._watchQuietUiDocument(doc);
    });
    this.registerEvent(this.app.workspace.on("window-open", (_workspace, win) => this._watchQuietUiDocument(win.document)));
    this.registerEvent(this.app.workspace.on("window-close", (_workspace, win) => {
      this._quietUiDocuments.get(win.document)?.();
      this._quietUiDocuments.delete(win.document);
    }));
    this.register(() => {
      for (const stop of this._quietUiDocuments.values()) stop();
      this._quietUiDocuments.clear();
    });
    this._registerPdfFileMenu();
    this.registerEvent(this.app.workspace.on("css-change", () => {
      if (selectedReaderTheme(this.settings) !== "auto" || this.settings.einkMode) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.applyVars();
      this._openReaderModal?._applyTheme();
    }));
    this.app.workspace.onLayoutReady(() => {
      this._watchBookFiles();
      // Note metadata and the plugin instance must exist before rendering links.
      void this._repairCfiBacklinks().catch((error) => console.warn("UV Reader: backlink upgrade failed", error));
    });
    this._scheduleFirstRunFlow();
  }
  _watchCompanionAndNotes() {
    const remember = (leaf) => {
      if (leaf?.view instanceof MarkdownView && leaf.view.file?.extension === "md") this._lastNoteLeaf = leaf;
    };
    remember(this.app.workspace.activeLeaf);
    this.registerEvent(this.app.workspace.on("active-leaf-change", remember));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      if (this._unloading || this._openingCompanion || !this._companionWasVisible) return;
      const leaf = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0];
      if (leaf && this.app.workspace.rightSplit?.collapsed) {
        this._companionWasVisible = false;
        void this._rememberCompanion(false);
      }
    }));
  }
  async _rememberCompanion(visible) {
    this.settings.aiCompanionVisible = visible;
    await this._saveLocalData();
  }
  async _showCompanionForBook(view) {
    if (this._unloading || this._openingCompanion || view._closed || !view.bookHtml || view._openingBook
      || this.app.isMobile || view.containerEl.ownerDocument.defaultView.innerWidth < 1000
      || this.settings.aiCompanionVisible === false || this.app.workspace.activeLeaf !== view.leaf) return;
    if (this._companionWasVisible && !this.app.workspace.rightSplit?.collapsed) return;
    this._openingCompanion = true;
    try { await this.openAiChat(readerAiPanelContext(view), { automatic: true }); }
    catch (error) { console.warn("UV Reader: companion could not open", error); }
    finally { this._openingCompanion = false; }
  }
  _watchQuietUiDocument(doc) {
    if (doc?.body && this._quietUiDocuments && !this._quietUiDocuments.has(doc)) {
      const stop = watchQuietUi(doc);
      const cleanup = () => {
        if (this._quietUiDocuments.get(doc) !== cleanup) return;
        this._quietUiDocuments.delete(doc);
        doc.defaultView?.removeEventListener("unload", cleanup);
        stop();
      };
      this._quietUiDocuments.set(doc, cleanup);
      doc.defaultView?.addEventListener("unload", cleanup, { once: true });
    }
  }
  async _repairCfiBacklinks() {
    if (!this.settings.cfiBacklinksMigrated && this.settings.quoteBacklinks !== false) {
      for (const [bookPath, items] of Object.entries(this.highlights || {})) {
        const note = resolveBookNote(this.app, this.settings.bookNoteLinks?.[bookPath]);
        if (!(note instanceof TFile) || isUnsafeReadingNote(this.app, note)) continue;
        const entries = (items || []).filter((hl) => hl.cfi).map((hl) => ({
          quote: `> ${hlMark(this.app, flattenSelectionText(hl.text), hl.color)}`,
          uri: highlightBacklink(this.app.vault.getName(), bookPath, hl),
        }));
        if (entries.length) await this.app.vault.process(note, (data) => addMissingQuoteLinks(data, entries));
      }
      this.settings.cfiBacklinksMigrated = true; await this._saveLocalData();
    }
  }
  async _attachAiDraftStore() {
    const onDraftStoreFailure = () => new Notice(qiaomuReaderTranslate("drafts-could-not-be-saved-they-remain-in-memory-check-plugin-fol"));
    this.aiDraftStore = await loadAiDrafts(this.app.vault.adapter, `${this.manifest.dir}/ai-drafts.json`, onDraftStoreFailure);
    this.register(() => { void this.aiDraftStore.flush(); });
  }
  _registerReaderViews() {
    const viewTypes = [
      [VIEW_TYPE, ReaderView],
      [LIB_VIEW_TYPE, LibraryView],
      [AI_CHAT_VIEW_TYPE, AiChatView],
    ];
    for (const [viewType, ViewClass] of viewTypes) {
      this.registerView(viewType, (leaf) => new ViewClass(leaf, this));
    }
  }
  _registerBookProtocol() {
    const openBacklink = (params) => {
      const book = params.book || "";
      void this.openBookAt(book, params.block, params.page, params.highlight, params.cfi);
    };
    this.registerObsidianProtocolHandler("qiaomu-reader", openBacklink);
    // Existing reading notes keep working after users switch to the new plugin ID.
    this.registerObsidianProtocolHandler("qiaomu-book-reader", openBacklink);
  }
  _registerReaderExtensions() {
    this.registerExtensions(["epub"], VIEW_TYPE);
    // The rendering engine formats: each gets its own guarded registration so
    // a conflict with another plugin over one extension never takes the rest
    // of the reader down.
    for (const ext of ENGINE_EXTENSIONS) {
      if (ext === "epub") continue;
      try { this.registerExtensions([ext], VIEW_TYPE); }
      catch (e) { console.warn(`UV Reader: could not register .${ext}`, e); }
    }
    // PDFs open in the reader too, falling back to the right-click menu when
    // another plugin has claimed the extension.
    try { this.registerExtensions(["pdf"], VIEW_TYPE); }
    catch (e) { console.warn("UV Reader: could not register .pdf; use the file menu to open it in UV Reader", e); }
  }
  _addRibbonEntry() {
    const libraryLabel = `UV Reader — ${qiaomuReaderTranslate("library")}`;
    this.addRibbonIcon("book-open", libraryLabel, () => this.openLibrary()).addClass("qiaomu-reader-ribbon");
  }
  _registerCommandsAndSettings() {
    const primaryCommands = [
      {
        id: "open-library", name: qiaomuReaderTranslate("open-library"),
        callback: () => this.openLibrary(),
      },
      {
        id: "open-library-window", name: qiaomuReaderTranslate("open-the-library-in-a-separate-window"),
        callback: () => this.openLibrary(true),
      },
      {
        id: "open-pdf-reader", name: qiaomuReaderTranslate("open-a-pdf-in-the-reader"),
        checkCallback: (probe) => {
          const active = this.app.workspace.getActiveFile();
          if (!active || active.extension !== "pdf") return false;
          if (!probe) this.openFile(active);
          return true;
        },
      },
      {
        id: "search-in-book", name: qiaomuReaderTranslate("search-the-book"),
        checkCallback: (probe) => {
          const reader = this.app.workspace.getActiveViewOfType(ReaderView);
          const target = (reader && reader.bookHtml) ? reader : (this._openReaderModal || null);
          if (!target || !target.bookHtml) return false;
          if (!probe) {
            const toggle = target.togglePanel || target._togglePanel;
            toggle.call(target, "find");
            if (target._findInput) readerHud.autoFocus(target._findInput, 80);
          }
          return true;
        },
      },
      {
        id: "open-ai-chat", name: qiaomuReaderTranslate("open-ai-reading-sidebar"),
        checkCallback: (probe) => {
          const reader = this.app.workspace.getActiveViewOfType(ReaderView);
          const target = reader?.bookHtml ? reader : (this._openReaderModal?.bookHtml ? this._openReaderModal : null);
          if (target && !readerSupportsAiContext(target)) return false;
          if (!probe) void this.openAiChat(target ? readerDefaultAiContext(target) : null);
          return true;
        },
      },
      {
        id: "export-highlights", name: qiaomuReaderTranslate("export-highlights-to-notes"),
        checkCallback: (probe) => {
          const reader = this.app.workspace.getActiveViewOfType(ReaderView);
          if (!reader || !reader.file) return false;
          if (!probe) reader.exportHighlights();
          return true;
        },
      },
    ];
    for (const command of primaryCommands) this.addCommand(command);
    this.settingsTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    const laterCommands = [
      {
        id: "show-onboarding", name: qiaomuReaderTranslate("show-welcome-onboarding"),
        callback: () => { new OnboardingModal(this.app, this).open(); },
      },
      {
        id: "continue-reading", name: qiaomuReaderTranslate("continue-reading-last-book"),
        checkCallback: (probe) => {
          const recent = this.lastReadBookFile();
          if (!recent) return false;
          if (!probe) this.openFile(recent);
          return true;
        },
      },
      {
        id: "open-book-picker", name: qiaomuReaderTranslate("open-a-book"),
        callback: () => { new BookQuickOpen(this.app, this).open(); },
      },
    ];
    for (const command of laterCommands) this.addCommand(command);
  }
  _registerPdfFileMenu() {
    const onFileMenu = (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "pdf") return;
      menu.addItem((item) => item.setTitle(qiaomuReaderTranslate("open-in-book-reader")).setIcon("book-open").onClick(() => this.openFile(file)));
    };
    this.registerEvent(this.app.workspace.on("file-menu", onFileMenu));
  }
  _watchBookFiles() {
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      let changed = false;
      for (const [book, target] of Object.entries(this.settings.bookNoteLinks || {})) {
        if (typeof target === "string" && (target === oldPath || target.startsWith(`${oldPath}/`))) {
          this.settings.bookNoteLinks[book] = file.path + target.slice(oldPath.length);
          changed = true;
        }
      }
      if (changed) void this._saveLocalData();
    }));
    this.registerBookCommands(); const scheduleRefresh = () => {
      window.clearTimeout(this._bookCmdTimer); this._bookCmdTimer = window.setTimeout(() => this.registerBookCommands(), 1500);
    };
    for (const eventName of ["create", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(eventName, (file) => {
        if (file && BOOK_EXTENSIONS.has(file.extension || "")) scheduleRefresh();
      }));
    }
  }
  _scheduleFirstRunFlow() {
    if (this.settings.onboarded) {
      this._scheduleWhatsNewCheck();
      return;
    }
    const onReady = async () => {
      if (this._onbShown || this.settings.onboarded) return;
      // fresh install: nothing to catch up on
      this._onbShown = true; this.settings.onboarded = true; this.settings.lastSeenVersion = this.manifest.version;
      await this.saveAll(); const welcome = new OnboardingModal(this.app, this);
      welcome.open();
    };
    this.app.workspace.onLayoutReady(onReady);
  }
  _scheduleWhatsNewCheck() {
    const onReady = async () => {
      if (this._wnShown) { return; }
      const previous = this.settings.lastSeenVersion || "";
      const current = this.manifest.version;
      const news = whatsNewSince(previous, current);
      if (news.length === 0) {
        if (previous !== current) { this.settings.lastSeenVersion = current; await this._saveLocalData(); }
        return;
      }
      this._wnShown = true; this.settings.lastSeenVersion = current;
      await this.saveAll(); const noteFile = this.settings.whatsNewNote === false ? null : await writeWhatsNewNote(this.app, this, news);
      const update = new WhatsNewModal(this.app, this, news, noteFile);
      update.open();
    };
    this.app.workspace.onLayoutReady(onReady);
  }
  onunload() {
    this._unloading = true;
    this._aiQuoteJumpController?.abort();
    disposeReaderFonts(this);
    window.clearTimeout(this._bookCmdTimer);
    for (const timer of Object.values(this._fmTimers || {})) window.clearTimeout(timer);
    this._fmTimers = {};
    this.flushReadingTime();
    const pending = [
      this._progressQueue?.drain?.(),
      this._localDataQueue?.drain?.(),
      this._hlChain,
      this._thumbSaveChain,
    ].filter(Boolean);
    void Promise.allSettled(pending);
  }
  async openFile(file) {
    if (this.app.isMobile) {
      const modal = new ReaderModal(this.app, this, file);
      modal.open();
      return modal;
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves.find((item) => item.view.file?.path === file.path) || leaves[0] || this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, state: { path: file.path }, active: true });
    await this.app.workspace.revealLeaf(leaf);
    void this._showCompanionForBook(leaf.view);
    return leaf.view;
  }
  // Leaving the reader (home page, library, settings) closes the companion
  // sidebar: it belongs to the book, not to the app chrome. The saved "show the
  // companion while reading" preference stays untouched.
  closeReadingCompanion() {
    const leaves = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    if (!leaves.length) return;
    this._companionWasVisible = false;
    this._closingCompanionForRoute = true;
    for (const leaf of leaves) leaf.detach();
    this._closingCompanionForRoute = false;
  }
  async openAiChat(context = null, options = {}) {
    let target = null;
    if (!context) {
      const view = this.app.workspace.getActiveViewOfType(ReaderView);
      target = view?.bookHtml ? view : (this._openReaderModal?.bookHtml ? this._openReaderModal : null);
      if (target) context = readerAiPanelContext(target);
    }
    if (this.app.isMobile) {
      const state = aiSetupState(this);
      if (!(state.ready && state.enabled)) {
        openPluginAiSettings(this.app, this, () => void this.openAiChat(context));
        return;
      }
      if (context && context.text) {
        new AiExplainModal(this.app, this, context).open();
      } else if (context?.unavailable) {
        new Notice(qiaomuReaderTranslate("this-pdf-has-no-usable-text-layer-you-can-still-read-the-origina"));
      } else {
        new Notice(qiaomuReaderTranslate("open-a-book-first-or-select-a-passage-in-the-book"));
      }
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice(qiaomuReaderTranslate("could-not-open-the-ai-reading-sidebar"));
      return;
    }
    if (!leaf.view || leaf.view.getViewType() !== AI_CHAT_VIEW_TYPE) {
      await leaf.setViewState({ type: AI_CHAT_VIEW_TYPE, active: !options.automatic });
    }
    if (context && leaf.view instanceof AiChatView) {
      leaf.view.setContext(context, { focusInput: !options.automatic, silent: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this._companionWasVisible = true;
    await this._rememberCompanion(true);
    if (options.automatic && context?.readerView?.leaf) this.app.workspace.setActiveLeaf(context.readerView.leaf, { focus: false });
  }
  async openLibrary(inNewWindow = false) {
    // The library is where the reading session ends for the desktop reader's
    // back button; the companion sidebar closes with it.
    this.closeReadingCompanion();
    const existing = this.app.workspace.getLeavesOfType(LIB_VIEW_TYPE);
    if (existing.length && !inNewWindow) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = inNewWindow && !this.app.isMobile && this.app.workspace.openPopoutLeaf
      ? this.app.workspace.openPopoutLeaf()
      : this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: LIB_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  async openBookAt(rawPath, block, page, highlightId, cfi) {
    const request = this._backlinkRequest = {};
    const found = this.app.vault.getAbstractFileByPath(qiaomuReaderPath(rawPath));
    if (!(found instanceof TFile)) {
      new Notice(qiaomuReaderTranslate("book-not-found-0", rawPath));
      return;
    }
    try {
      const view = await this.openFile(found);
      const deadline = Date.now() + 15000;
      while (this._backlinkRequest === request && !view?._closed && Date.now() < deadline
        && (view?.file?.path !== found.path || view._openingBook || !(view.engine?.currentLocation() || view.pager?.total))) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (this._backlinkRequest !== request || view?._closed || view?.file?.path !== found.path) return;
      if (view._openingBook || !(view.engine?.currentLocation() || view.pager?.total)) throw new Error("Book not ready");
      const highlight = highlightId && this.getHighlights(found.path).find((item) => item.id === highlightId);
      if (highlight) { await view.goToHighlight(highlight.id); return; }
      if (cfi && view.engine) { rememberReaderJump(view); await jumpToEngineHighlight(view, { cfi }); return; }
      if (view.engine) throw new Error("An ebook link requires a CFI location");
      const idx = Number(block);
      if (block !== undefined && block !== "" && Number.isInteger(idx) && idx >= 0) {
        view.jumpToBlockWhenReady(idx);
        return;
      }
      const pageNum = Number(page);
      if (Number.isInteger(pageNum) && pageNum >= 1) view.jumpToPdfPageWhenReady(pageNum);
    } catch (error) {
      console.warn("UV Reader: backlink navigation failed", error);
      new Notice(qiaomuReaderTranslate("highlight-not-found"));
    }
  }
  _dataFolder() {
    const dedicated = qiaomuReaderPath(this.settings.dataFolder);
    if (dedicated) return dedicated;
    return qiaomuReaderPath(this.settings.booksFolder);
  }
  // Reading traces live in per-book folders under this root. The default keeps
  // everything inside the plugin data folder so the vault (and its backups)
  // still carry the whole reading history.
  _readingRoot() {
    const custom = qiaomuReaderPath(this.settings.readingRoot);
    if (custom) return custom;
    const data = this._dataFolder();
    return data ? `${data}/reading` : "reading";
  }
  _readingStore() {
    const root = this._readingRoot();
    if (!this._readingStoreCache || this._readingStoreCache.root !== root) {
      this._readingStoreCache = createReadingStore({ adapter: this.app.vault.adapter, root });
    }
    return this._readingStoreCache;
  }
  // Identity of a book for the per-book folder: vault files know their title
  // and stats, files opened by path fall back to the file name.
  _bookMeta(bookPath) {
    const file = this.app.vault.getAbstractFileByPath(bookPath);
    return {
      title: file?.basename || String(bookPath).split("/").pop() || "",
      format: file?.extension || "",
      sourcePath: bookPath,
      size: file?.stat?.size || 0,
      mtime: file?.stat?.mtime || 0,
    };
  }
  _progressFilePath() {
    const folder = this._dataFolder();
    return qiaomuReaderPath(folder ? `${folder}/reading-progress.json` : "reading-progress.json");
  }
  _progressRecoveryFilePath() {
    return qiaomuReaderPath(`${this.manifest.dir}/reading-progress-recovery.json`);
  }
  _storeRecoveryHint() {
    const folder = this._dataFolder();
    if (folder) return qiaomuReaderPath(`${folder}/_reader-rescue`);
    if (this._lastBookPath && this._lastBookPath.includes("/")) {
      return qiaomuReaderPath(`${this._lastBookPath.slice(0, this._lastBookPath.lastIndexOf("/"))}/_reader-rescue`);
    }
    return "";
  }
  async loadAll() { // persisted data in, normalized settings + migrated state + restored reading state out
    const saved = await this.loadData();
    this._mergeDefaultSettings(saved);
    await this._applyLegacySettingMigrations();
    applyDeviceProfile(this.settings); if (this.settings.pageTurnAnimation == null) this.settings.pageTurnAnimation = true;
    this._applyLanguageDefaults();
    await this._migrateChineseDefaults();
    await this._restoreReadingState(saved);
    await this._repairBookNoteState();
    await this._adoptLegacyProgress(saved);
  }
  _mergeDefaultSettings(saved) {
    this.settings = { ...DEFAULT, ...(saved?.settings ?? {}) };
    this.settings.aiModels = { ...(this.settings.aiModels || {}) };
    this.settings.aiSecrets = { ...(this.settings.aiSecrets || {}) };
    this.settings.aiBases = { ...(this.settings.aiBases || {}) };
    this.settings.aiThinking = { ...(this.settings.aiThinking || {}) };
    this.settings.aiCapabilities = normalizeAiCapabilities(this.settings.aiCapabilities);
    this.settings.aiChatHistory = normalizeAiChatHistory(this.settings.aiChatHistory);
    this.settings.locationMarks = normalizeLocationMarks(this.settings.locationMarks);
    if (this.settings.aiProvider && this.settings.aiModel && !this.settings.aiModels[this.settings.aiProvider]) {
      this.settings.aiModels[this.settings.aiProvider] = this.settings.aiModel;
    }
    this.settings.aiModel = this.settings.aiProvider
      ? this.settings.aiModels[this.settings.aiProvider] || ""
      : "";
  }
  async _applyLegacySettingMigrations() {
    // The old built-in quote template accidentally exposed the Russian word
    // "из" ("from") in every locale. Only rewrite that exact template fragment;
    // a genuinely custom template otherwise remains untouched.
    if (this.settings.quoteTemplate) {
      this.settings.quoteTemplate = this.settings.quoteTemplate.replace(/—\s+из\s+(?=\[\[\{book\}\]\])/giu, "— ");
    }
    let settingsMigrated = false;
    // The CLI/ACP providers were replaced by the pi-ai runtime, which only
    // speaks HTTP providers. Drop their stored paths/effort settings and reset
    // a removed provider so the reader can pick a service again.
    const REMOVED_CLI_PROVIDERS = new Set(["codex-cli", "claude-cli", "grok-cli", "kimi-cli", "zcode-cli"]);
    if (this.settings.aiCliPaths || this.settings.aiAcpPaths || this.settings.aiCliEfforts) {
      delete this.settings.aiCliPaths;
      delete this.settings.aiAcpPaths;
      delete this.settings.aiCliEfforts;
      settingsMigrated = true;
    }
    if (REMOVED_CLI_PROVIDERS.has(this.settings.aiProvider)) {
      this.settings.aiProvider = "";
      this.settings.aiEnabled = false;
      this.settings.aiNeedsVerification = false;
      settingsMigrated = true;
    }
    // v3.3 replaces the old colour names with purpose-built reading themes.
    // Migrate both the shared appearance and any per-device profiles once.
    const migratedTheme = migrateReaderTheme(this.settings.theme);
    if (migratedTheme !== this.settings.theme) settingsMigrated = true;
    this.settings.theme = migratedTheme;
    if (!["auto", "reader"].includes(this.settings.libTheme)) {
      const migratedLibraryTheme = migrateReaderTheme(this.settings.libTheme);
      if (migratedLibraryTheme !== this.settings.libTheme) settingsMigrated = true;
      this.settings.libTheme = migratedLibraryTheme;
    }
    for (const profile of Object.values(this.settings.deviceProfiles || {})) {
      if (profile && profile.theme) {
        const migratedProfileTheme = migrateReaderTheme(profile.theme);
        if (migratedProfileTheme !== profile.theme) settingsMigrated = true;
        profile.theme = migratedProfileTheme;
      }
    }
    if (this.settings.aiProvider === "local") {
      this.settings.aiProvider = "ollama";
      settingsMigrated = true;
    }
    // Unknown providers must not send a saved key to a different service.
    if (this.settings.aiProvider && !aiProviderFor(this.settings.aiProvider)) {
      this.settings.aiProvider = "";
      this.settings.aiEnabled = false;
      settingsMigrated = true;
    }
    // Move legacy plaintext keys out of data.json on modern Obsidian.
    // The retired service key is preserved as a secret but not selected.
    if (this.settings.aiKey && this.app.secretStorage) {
      const secretId = this.settings.aiProvider
        ? `qiaomu-book-reader-${this.settings.aiProvider}`
        : "qiaomu-book-reader-legacy-key";
      this.app.secretStorage.setSecret(secretId, this.settings.aiKey);
      if (this.settings.aiProvider) this.settings.aiSecret = secretId;
      this.settings.aiKey = "";
      settingsMigrated = true;
    }
    // Versions before 4.2.13 kept one selected secret and endpoint override
    // globally. Associate those values only with the provider that owned them,
    // then remove the global references so they cannot leak across providers.
    const legacyAiProvider = this.settings.aiProvider;
    if (this.settings.aiSecret) {
      if (legacyAiProvider && !this.settings.aiSecrets[legacyAiProvider]) {
        this.settings.aiSecrets[legacyAiProvider] = this.settings.aiSecret;
      }
      this.settings.aiSecret = "";
      settingsMigrated = true;
    }
    if (this.settings.aiBase) {
      if (legacyAiProvider && !this.settings.aiBases[legacyAiProvider]) {
        this.settings.aiBases[legacyAiProvider] = normalizeAiBase(this.settings.aiBase);
      }
      this.settings.aiBase = "";
      settingsMigrated = true;
    }
    if (settingsMigrated) await this._saveLocalData();
  }
  _applyLanguageDefaults() {
    // UV Reader is Chinese-first. Existing explicit language choices
    // stay untouched; every fresh install and every legacy install that never
    // chose a language starts in Simplified Chinese, regardless of OS locale.
    if (!this.settings.languagePicked) this.settings.language = "zh";
    // Publish the chosen UI language so qiaomuReaderTranslate() (module-level i18n helper) can read it.
    this.settings.language = normalizeUiLanguage(this.settings.language);
    qiaomuReaderSetLanguage(this.settings.language);
  }
  async _migrateChineseDefaults() {
    // Older builds persisted Russian translation/AI targets even when the user
    // never touched those controls. Move only those untouched legacy defaults
    // to Chinese; any deliberate non-Russian choice remains intact.
    if (this.settings.chineseDefaultsMigrated) return;
    if (this.settings.translateTo === "ru") this.settings.translateTo = "zh-CN";
    if (this.settings.aiInto === "english-2") this.settings.aiInto = "中文";
    this.settings.chineseDefaultsMigrated = true; await this._saveLocalData();
  }
  async _restoreReadingState(saved) {
    await this._loadThumbCache(saved);
    this.progressBackups = saved?.progressBackups ?? {};
    this.highlightsBackups = saved?.highlightsBackups ?? {};
    this._lastBookPath = saved?.lastBookPath || "";
    if (this.settings.storageLayout === "books") {
      await this._loadBooksLayout();
      return;
    }
    this.progress = (await this._loadProgressFromVault()) || {};
    this.highlights = (await this._loadHighlightsFromVault()) || {};
    this.pins = (await this._loadPinsFromVault()) || {};
    await this._migrateToBooksLayout();
  }
  // Per-book layout: every book's traces load from its own folder. The index
  // is the authority for which books exist; a missing file simply means the
  // book has no data of that kind yet.
  async _loadBooksLayout() {
    const store = this._readingStore();
    let index = await store.readIndex();
    if (!Object.keys(index.books).length) {
      // The index is a cache; if it is gone the book.json files rebuild it.
      index = await store.rebuildIndex(this.app.vault.getFiles().map((file) => ({
        bookPath: file.path,
        title: file.basename,
        format: file.extension,
      })));
    }
    const progress = {}, highlights = {}, pins = {};
    await Promise.all(Object.keys(index.books).map(async (bookPath) => {
      const values = await store.loadBook(bookPath);
      if (values.progress && Object.keys(values.progress).length) progress[bookPath] = values.progress;
      if (values.highlights?.length) highlights[bookPath] = values.highlights;
      if (values.pins?.length) pins[bookPath] = values.pins;
    }));
    this.progress = progress;
    this.highlights = highlights;
    this.pins = pins;
  }
  // One-time move from the three global files into per-book folders. Verified
  // writes run book by book; the layout flag flips only on full success, so a
  // failure (or a downgrade) keeps the legacy files authoritative.
  async _migrateToBooksLayout() {
    const store = this._readingStore();
    const bookPaths = new Set([
      ...Object.keys(this.progress || {}),
      ...Object.keys(this.highlights || {}),
      ...Object.keys(this.pins || {}),
    ]);
    const finish = async (payload = {}) => {
      Object.assign(this.settings, {
        storageLayout: "books",
        storageMigratedAt: Date.now(),
        storageMigrationError: "",
      }, payload);
      await this._archiveLegacyStores();
      await this._saveLocalData();
    };
    if (!bookPaths.size) {
      await finish();
      return { books: 0, files: 0 };
    }
    const titles = {};
    for (const bookPath of bookPaths) titles[bookPath] = this._bookMeta(bookPath);
    try {
      const report = await store.migrate({
        progress: this.progress,
        highlights: this.highlights,
        pins: this.pins,
        notes: this.settings.bookNoteLinks || {},
        titles,
      });
      if (report.errors.length) throw new Error(report.errors[0].message);
      await finish();
      console.info(`UV Reader: reading data moved to per-book folders (${report.books} books, ${report.files} files)`);
      return report;
    } catch (error) {
      this.settings.storageMigrationError = String(error?.message || error).slice(0, 300);
      await this._saveLocalData().catch(() => {});
      console.error("UV Reader: reading data migration failed; keeping the legacy files", error);
      return { books: 0, files: 0, errors: [String(error?.message || error)] };
    }
  }
  // Keep the old global files as read-only backups once the per-book layout is
  // authoritative, so a downgrade or a manual recovery still has the originals.
  async _archiveLegacyStores() {
    const adapter = this.app.vault.adapter;
    for (const path of [this._progressFilePath(), this._highlightsFilePath(), this._pinsFilePath()]) {
      try {
        if (!await adapter.exists(path)) continue;
        const target = path.replace(/\.json$/, ".legacy.json");
        if (!await adapter.exists(target)) await adapter.rename(path, target);
      } catch { /* the legacy file stays where it is */ }
    }
  }
  async _repairBookNoteState() {
    const { promptedRepaired } = this.settings;
    if (!promptedRepaired) {
      const prompted = this.settings.bookNotePrompted || {};
      const noteLinks = this.settings.bookNoteLinks || {};
      for (const key of Object.keys(prompted)) if (!noteLinks[key]) delete prompted[key];
      this.settings.promptedRepaired = true; await this._saveLocalData();
    }
    // Older builds treated every note with a matching `book` property as the
    // canonical reading note. That accidentally captured templates and notes
    // such as `type: person`. Remove only those clearly unsafe links; deliberate
    // links to ordinary notes remain untouched.
    if (!this.settings.readingNoteLinksRepaired) {
      const noteLinks = this.settings.bookNoteLinks || {};
      const prompted = this.settings.bookNotePrompted || {};
      for (const [bookPath, noteName] of Object.entries(noteLinks)) {
        const candidate = resolveBookNote(this.app, noteName);
        if (!candidate || isUnsafeReadingNote(this.app, candidate)) {
          delete noteLinks[bookPath];
          delete prompted[bookPath];
        }
      }
      this.settings.readingNoteLinksRepaired = true; await this._saveLocalData();
    }
    // One-time presentation migration: rewrite managed reading-note sections
    // with the icon-only backlink. This updates existing notes immediately on
    // upgrade instead of waiting for the reader to edit every old highlight.
    if (!this.settings.iconBacklinksMigrated && this.settings.quotesToBookNote === true) {
      for (const [bookPath, items] of Object.entries(this.highlights || {})) {
        if (Array.isArray(items) && items.length) {
          await syncHighlightsToReadingNote(this.app, this, bookPath, items);
        }
      }
      this.settings.iconBacklinksMigrated = true; await this._saveLocalData();
    }
    if (!this.settings.manualExcerptSectionsMigrated && this.settings.quotesToBookNote === true) {
      const bookPaths = new Set([
        ...Object.keys(this.settings.bookNoteLinks || {}),
        ...Object.keys(this.highlights || {}),
      ]);
      for (const bookPath of bookPaths) {
        await syncHighlightsToReadingNote(this.app, this, bookPath, this.highlights[bookPath] || [], { migrateManualExcerpts: true });
      }
      this.settings.manualExcerptSectionsMigrated = true; await this._saveLocalData();
    }
    // Remove the duplicate H1 only from old auto-generated reading notes. A
    // custom template is untouched unless its first H1 exactly matches the
    // filename and is followed immediately by a reader-managed section.
    if (!this.settings.readingNoteTitlesMigratedV4) {
      const names = new Set(Object.values(this.settings.bookNoteLinks || {}).filter(Boolean));
      const candidates = new Map(bookNoteFiles(this.app).map((note) => [note.path, note]));
      for (const name of names) {
        const found = resolveBookNote(this.app, name);
        if (found instanceof TFile) candidates.set(found.path, found);
      }
      for (const note of candidates.values()) {
        const before = await this.app.vault.read(note);
        // Metadata cache may still be empty while the plugin is loading. The
        // linked file is eligible when either the cache or its own frontmatter
        // carries the explicit reading-note marker.
        const markedInText = /^---\s*\n[\s\S]*?\n(?:type:\s*(?:reading-note|book-note)|book-reader-note:\s*true)\s*\n[\s\S]*?\n---(?:\n|$)/im.test(before);
        if (!isMarkedReadingNote(this.app, note) && !markedInText) continue;
        const after = stripGeneratedReadingNoteTitle(before, note.basename);
        if (after !== before) await this.app.vault.modify(note, after);
      }
      this.settings.readingNoteTitlesMigratedV4 = true; await this._saveLocalData();
    }
  }
  async _adoptLegacyProgress(saved) {
    const legacyProgress = saved?.progress ?? {};
    if (Object.keys(legacyProgress).length > 0 && Object.keys(this.progress).length === 0) {
      this.progress = legacyProgress;
      await this._saveProgressToVault(); await this._saveLocalData();
    }
  }
  async saveAll() {
    await this._saveLocalData();
    if (this.settings.storageLayout === "books") {
      const store = this._readingStore();
      await Promise.all(Object.keys(this.progress || {}).map((bookPath) =>
        store.saveBook(bookPath, "progress", this.progress[bookPath] || {}, this._bookMeta(bookPath))));
      return;
    }
    await this._saveProgressToVault();
  }
  _saveLocalData() {
    captureDeviceProfile(this.settings);
    const snapshot = cloneJson({
      settings: this.settings,
      progressBackups: this.progressBackups,
      highlightsBackups: this.highlightsBackups,
      lastBookPath: this._lastBookPath || "",
    });
    return this._localDataQueue.run(() => this.saveData(snapshot)).then(() => true).catch((error) => {
      console.error("UV Reader: could not save plugin data", error);
      const now = Date.now();
      if (!this._lastLocalDataErrorNotice || now - this._lastLocalDataErrorNotice > 15000) {
        this._lastLocalDataErrorNotice = now;
        new Notice(qiaomuReaderTranslate("could-not-save-the-plugin-settings-check-vault-access"), 8000);
      }
      return false;
    });
  }
  _thumbCachePath() { return qiaomuReaderPath(`${this.manifest.dir}/thumb-cache.json`); }
  async _loadThumbCache(d) {
    try {
      const p = this._thumbCachePath();
      if (await this.app.vault.adapter.exists(p)) {
        const j = JSON.parse(await this.app.vault.adapter.read(p));
        this.thumbCache = (j && j.ver === 2 && j.cache) ? migrateCoverCache(j.cache, j.artworkVersion) : {};
        if (j?.artworkVersion !== 1) await this._saveThumbCache();
        return;
      }
    } catch (e) { console.warn("UV Reader: thumb cache load failed", e); }
    this.thumbCache = ((d == null ? void 0 : d.thumbCacheVer) === 2 && (d == null ? void 0 : d.thumbCache)) ? migrateCoverCache(d.thumbCache) : {};
    if (Object.keys(this.thumbCache).length) this._saveThumbCache();
  }
  _saveThumbCache() {
    this._thumbSaveChain = (this._thumbSaveChain || Promise.resolve()).then(
      () => this.app.vault.adapter.write(this._thumbCachePath(), JSON.stringify({ ver: 2, artworkVersion: 1, cache: this.thumbCache }))
    ).catch((e) => console.warn("UV Reader: thumb cache save failed", e));
    return this._thumbSaveChain;
  }
  _todayKey() { return readerTodayKey(); }
  bumpReadingTime(sec) {
    const s = this.settings;
    if (!s.readingLog) s.readingLog = {};
    const k = this._todayKey();
    s.readingLog[k] = (s.readingLog[k] || 0) + sec;
    s.lifetimeSeconds = (s.lifetimeSeconds || 0) + sec;
    const keys = Object.keys(s.readingLog);
    if (keys.length > 100) { keys.sort(); while (keys.length > 90) delete s.readingLog[keys.shift()]; }
    this._readingDirty = true;
  }
  getTodaySeconds() {
    const s = this.settings;
    return (s.readingLog && s.readingLog[this._todayKey()]) || 0;
  }
  getTotalSeconds() {
    const s = this.settings;
    const logSum = s.readingLog ? Object.keys(s.readingLog).reduce((a, k) => a + (s.readingLog[k] || 0), 0) : 0;
    return Math.max(s.lifetimeSeconds || 0, logSum);
  }
  ensureStarterBooks(explicit = false) {
    if (!this._installStarterLibrary) this._installStarterLibrary = createStarterLibraryInstaller({
      vault: this.app.vault, books: STARTER_BOOKS,
      getState: () => this.settings.starterLibrary,
      getFolder: () => qiaomuReaderPath(`${this.settings.booksFolder || "Books"}/${qiaomuReaderTranslate("starter-books-folder")}`),
      saveState: async (state) => {
        const previous = this.settings.starterLibrary;
        this.settings.starterLibrary = state;
        if (await this._saveLocalData() === false) {
          this.settings.starterLibrary = previous;
          throw new Error("Could not save starter library state");
        }
      },
    });
    return this._installStarterLibrary(explicit);
  }
  bookFiles() {
    const folder = qiaomuReaderPath(this.settings.booksFolder || "");
    const prefix = folder ? folder + "/" : "";
    return this.app.vault.getFiles().filter(
      (f) => BOOK_EXTENSIONS.has(f.extension)
        && (prefix === "" || f.path.startsWith(prefix))
    );
  }
  lastReadBookFile() {
    const prog = this.progress || {};
    let bestPath = "", bestAt = -1;
    for (const p of Object.keys(prog)) {
      const at = (prog[p] && (prog[p].lastRead || prog[p].updated)) || 0;
      const ts = typeof at === "number" ? at : Date.parse(at) || 0;
      if (ts > bestAt) { bestAt = ts; bestPath = p; }
    }
    if (!bestPath) bestPath = this.settings.lastBookPath || "";
    if (!bestPath) return null;
    const f = this.app.vault.getAbstractFileByPath(bestPath);
    return f && f.extension ? f : null;
  }
  registerBookCommands() { // one command per book, refreshed whenever the library changes
    for (const stale of this._bookCmdIds || []) {
      try {
        this.app.commands.removeCommand(stale);
      } catch { /* removal is best-effort */ }
    }
    const collected = [];
    // Cap the list: a huge library would otherwise bury every other command.
    const books = this.bookFiles()
      .sort((x, y) => x.basename.localeCompare(y.basename))
      .slice(0, MAX_BOOK_COMMANDS);
    for (const book of books) {
      const bookPath = book.path;
      const command = this.addCommand({
        id: `open-book:${bookPath}`,
        name: qiaomuReaderTranslate("open-book-0", book.basename),
        callback: () => this._openBookCommand(bookPath)
      });
      if (command?.id) collected.push(command.id);
    }
    this._bookCmdIds = collected;
  }
  _openBookCommand(bookPath) {
    const current = this.app.vault.getAbstractFileByPath(bookPath);
    if (current) this.openFile(current);
    else new Notice(qiaomuReaderTranslate("book-not-found-0", bookPath));
  }
  async ensureBookNote(file) {
    if (!file) return null;
    const s = this.settings;
    if (!s.bookNoteLinks) s.bookNoteLinks = {};
    if (s.bookNoteLinks[file.path]) return null;
    const base = bookNotesFolderPath(this.app) || notesFolderPath(this.app) || "";
    return this.createBookNote(file, file.basename, base);
  }
  async setBookTags(bookPath, tags) {
    const s = this.settings;
    if (!s.bookTags) s.bookTags = {};
    const list = (tags || []).filter(Boolean);
    if (list.length) s.bookTags[bookPath] = list;
    else delete s.bookTags[bookPath];
    await this.saveAll();
  }
  async createBookNote(file, title, folder) { // create (or reuse) the note linked to a book
    try {
      if (!file) { return null; }
      const settings = this.settings;
      if (!settings.bookNoteLinks) settings.bookNoteLinks = {};
      const dir = qiaomuReaderPath(folder);
      const noteName = sanitizeNoteTitle(title || file.basename);
      const basePath = qiaomuReaderPath(dir ? `${dir}/${noteName}` : noteName);
      let notePath = `${basePath}.md`;
      let note = this.app.vault.getAbstractFileByPath(notePath);
      const usedByAnotherBook = note && Object.entries(settings.bookNoteLinks).some(([book, target]) =>
        book !== file.path && (target === note.path || target === note.basename));
      if (usedByAnotherBook) {
        let suffix = 2;
        do { notePath = `${basePath} (${suffix++}).md`; }
        while (this.app.vault.getAbstractFileByPath(notePath));
        note = null;
      }
      if (note == null || !(note instanceof TFile)) {
        note = await this._materializeBookNote(notePath, dir, noteName);
      }
      if (note == null || !(note instanceof TFile)) {
        new Notice(qiaomuReaderTranslate("could-not-create-the-note"));
        return null;
      }
      settings.bookNoteLinks[file.path] = note.path;
      await this.saveAll(); await writeBookProperty(this.app, note.path, file);
      return note;
    } catch (error) {
      console.error("UV Reader: create book note failed", error);
      new Notice(qiaomuReaderTranslate("could-not-create-the-note"));
      return null;
    }
  }
  async _materializeBookNote(notePath, dir, noteName) {
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    // Obsidian already shows the filename as the note title. Repeating it
    // as an H1 makes every reading note look as if it has two titles.
    const tplPath = bookNoteTemplatePath(this.app);
    let body = ""; const tplFile = tplPath && this.app.vault.getAbstractFileByPath(tplPath);
    if (tplFile instanceof TFile) body = await this._applyBookNoteTemplate(tplFile, noteName);
    return this.app.vault.create(notePath, body).catch((failure) => {
      console.error("UV Reader: create book note failed", failure);
      return null;
    });
  }
  async _applyBookNoteTemplate(tplFile, noteName) {
    try {
      return `${processTemplateManually(await this.app.vault.read(tplFile), noteName)}\n\n`;
    } catch { return ""; }
  }
  resetTodaySeconds() {
    const s = this.settings;
    if (!s.readingLog) s.readingLog = {};
    s.readingLog[this._todayKey()] = 0;
    this._readingDirty = true;
  }
  getGoalSeconds() { return Math.max(60, (this.settings.dailyGoalMin || 15) * 60); }
  flushReadingTime() {
    if (!this._readingDirty) return;
    this._readingDirty = false;
    this._saveLocalData();
  }
  _recordBackup(path5, prev, now) {
    if (!prev || typeof prev.percent !== "number") return;
    const list = this.progressBackups[path5] || (this.progressBackups[path5] = []);
    const last = list[list.length - 1];
    if (last && last.percent === prev.percent) { last.ts = now; return; }
    list.push({ pct: prev.pct, percent: prev.percent, lastRead: prev.lastRead || now, ts: now,
      ...(typeof prev.block === "number" ? { block: prev.block } : {}),
      ...(prev.cfi ? { cfi: prev.cfi } : {}) });
    if (list.length > 30) list.shift();
  }
  async _loadProgressFromVault() {
    const path5 = this._progressFilePath();
    const value = await this._loadJsonStore(path5, qiaomuReaderTranslate("progress"));
    if (value !== null) return value;
    // Keep the damaged source blocked and untouched. The local snapshot lets
    // reading resume across a restart while the user resolves sync/history.
    const recovery = await readJsonRecordStore(this.app.vault.adapter, this._progressRecoveryFilePath());
    if (recovery.status === "ok" && recovery.value.sourcePath === path5 && isPlainRecord(recovery.value.progress)) {
      return mergeReadingProgress(recovery.value.progress, this.progress);
    }
    return null;
  }
  _saveProgressToVault() {
    const path5 = this._progressFilePath();
    const snapshot = cloneJson(this.progress || {});
    return this._progressQueue.run(async () => {
      // Write and verify an independent snapshot BEFORE touching the synced
      // primary. Even a blocked primary must not leave new positions in RAM only.
      await writeVerifiedJsonRecord(this.app.vault.adapter, this._progressRecoveryFilePath(), {
        sourcePath: path5, progress: snapshot,
      }, { validateExisting: false });
      if (this._blockedStores.has(path5)) return false;
      const folder = path5.substring(0, path5.lastIndexOf("/"));
      if (folder) {
        const folderExists = await this.app.vault.adapter.exists(folder);
        if (!folderExists) await this.app.vault.createFolder(folder).catch(() => {});
      }
      try {
        await writeVerifiedJsonRecord(this.app.vault.adapter, path5, snapshot);
      } catch (error) {
        if (error.code === "QIAOMU_READER_STORE_UNREADABLE") await this._loadJsonStore(path5, qiaomuReaderTranslate("progress"));
        throw error;
      }
      await this._writeRescue(false);
      return true;
    });
  }
  async _loadJsonStore(path5, label) {
    const adapter = this.app.vault.adapter;
    const result = await readJsonRecordStore(adapter, path5, label);
    if (result.status !== "unreadable") {
      this._blockedStores.delete(path5);
      this._unreadableStores.delete(path5);
      this._corruptStoreNotices.delete(path5);
      return result.value;
    }
    console.error(`UV Reader: could not load ${label}`, result.error);
    this._blockedStores.add(path5);
    this._unreadableStores.set(path5, {
      path: path5,
      label,
      backupPath: result.backupPath || "",
      recoveryHint: this._storeRecoveryHint(),
    });
    if (!this._corruptStoreNotices.has(path5)) {
      this._corruptStoreNotices.add(path5);
      const message = result.backupPath
        ? qiaomuReaderTranslate("the-0-file-is-unreadable-the-plugin-stopped-overwriting-it-and-p", label, result.backupPath)
        : qiaomuReaderTranslate("the-0-file-could-not-be-read-the-plugin-stopped-overwriting-it-m", label);
      new Notice(message, 10000);
    }
    return null;
  }
  async retryUnreadableStore(path5) {
    const isProgress = path5 === this._progressFilePath();
    const isHighlights = path5 === this._highlightsFilePath();
    if (!isProgress && !isHighlights) return false;
    const value = await this._loadJsonStore(path5, qiaomuReaderTranslate(isProgress ? "progress" : "highlights"));
    if (value === null) return false;
    if (isProgress) {
      this.progress = mergeReadingProgress(value, this.progress);
      try { return await this._saveProgressToVault(); }
      catch (error) {
        console.error("UV Reader: recovered progress could not be saved", error);
        return false;
      }
    }
    this.highlights = value;
    return true;
  }
  async _writeRescue(force) {
    try {
      const now = Date.now();
      if (!force && this._lastRescueTs && (now - this._lastRescueTs) < 5 * 60 * 1e3) return;
      this._lastRescueTs = now;
      let date;
      try { date = window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10); }
      catch { date = new Date().toISOString().slice(0, 10); }
      const bf = this._dataFolder();
      let base;
      if (bf) {
        base = qiaomuReaderPath(`${bf}/_reader-rescue`);
      } else if (this._lastBookPath && this._lastBookPath.includes("/")) {
        const bookDir = this._lastBookPath.slice(0, this._lastBookPath.lastIndexOf("/"));
        base = qiaomuReaderPath(`${bookDir}/_reader-rescue`);
      } else {
        return;
      }
      const dir = qiaomuReaderPath(`${base}/_reader-rescue-${date}`);
      const ad = this.app.vault.adapter;
      if (!await ad.exists(base)) await this.app.vault.createFolder(base).catch(() => {});
      if (!await ad.exists(dir)) await this.app.vault.createFolder(dir).catch(() => {});
      await ad.write(qiaomuReaderPath(`${dir}/reading-progress.json`), JSON.stringify(this.progress, null, 2));
      await ad.write(qiaomuReaderPath(`${dir}/reading-highlights.json`), JSON.stringify(this.highlights, null, 2));
      const dataPath = qiaomuReaderPath(`${this.manifest.dir}/data.json`);
      if (await ad.exists(dataPath)) await ad.write(qiaomuReaderPath(`${dir}/plugin-data.json`), await ad.read(dataPath));
    } catch (e) {
      console.error("UV Reader: rescue backup failed", e);
    }
  }
  saveProgress(bookPath, spread, total, block, cfi) {
    const ratio = total > 1 ? spread / (total - 1) : 0;
    const percent = Math.round(ratio * 100);
    const stamp = Date.now();
    const prev = this.progress[bookPath];
    const backups = this.progressBackups[bookPath];
    const lastBackup = backups && backups[backups.length - 1];
    const dueBackup = !lastBackup || stamp - (lastBackup.ts || 0) >= 180000;
    const jumpedFar = prev && typeof prev.pct === "number" && Math.abs(ratio - prev.pct) >= 0.15;
    if (jumpedFar || dueBackup) this._recordBackup(bookPath, prev, stamp);
    this._lastBookPath = bookPath;
    const record = { pct: ratio, percent, lastRead: stamp };
    if (typeof block === "number" && block >= 0) record.block = block;
    if (cfi) record.cfi = cfi;
    this.progress[bookPath] = record;
    const persisted = this._commitProgressStore();
    this._syncProgressFrontmatter(bookPath);
    return persisted;
  }
  _commitProgressStore(bookPath = this._lastBookPath) {
    // Per-book layout: only this book's file is rewritten, so a write touches
    // one folder instead of the whole library.
    const save = this.settings.storageLayout === "books" && bookPath
      ? this._readingStore().saveBook(bookPath, "progress", this.progress[bookPath] || {}, this._bookMeta(bookPath)).then(() => true)
      : this._saveProgressToVault();
    return Promise.all([save, this._saveLocalData()]).then((stores) => {
      if (stores.some((store) => store === false)) throw new Error("reading progress store is locked");
      return true;
    }).catch((error) => {
      console.error("UV Reader: could not save reading progress", error);
      const marked = Date.now();
      if (!this._lastProgressErrorNotice || marked - this._lastProgressErrorNotice > 15000) {
        this._lastProgressErrorNotice = marked;
        new Notice(this._blockedStores.has(this._progressFilePath())
          ? qiaomuReaderTranslate("the-reading-progress-file-is-unreadable-and-writes-are-paused-re")
          : qiaomuReaderTranslate("could-not-save-the-reading-position-check-free-space-sync-status"), 8000);
      }
      return false;
    });
  }
  // Engine formats report a plain 0..1 fraction and a CFI anchor instead of
  // the paginated spread/total pair, but share the same persistence machinery.
  saveEngineProgress(path5, fraction, cfi) {
    const steps = 1000;
    const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
    return this.saveProgress(path5, Math.round(clamped * (steps - 1)), steps, -1, cfi);
  }
  _syncProgressFrontmatter(bookPath) { // debounce the frontmatter write; it is advisory, not authoritative
    if (!this.settings.progressToFrontmatter) return;
    const linkedNote = bookNoteLinkFor(this, { basename: "", path: bookPath });
    if (!linkedNote) return;
    const bookNote = resolveBookNote(this.app, linkedNote);
    if (!bookNote) return;
    const timers = this._fmTimers || (this._fmTimers = {});
    window.clearTimeout(timers[bookPath]);
    timers[bookPath] = window.setTimeout(async () => {
      const snap = this.progress[bookPath];
      if (!snap) return;
      try {
        await this.app.fileManager.processFrontMatter(bookNote, (fm) => {
          fm["reading-progress"] = Math.round((snap.pct || 0) * 100);
          fm["reading-updated"] = new Date(snap.lastRead || Date.now()).toISOString().slice(0, 10);
        });
      } catch (e) {
        console.warn("UV Reader: could not write progress into the book note", e);
      }
    }, 4000);
  }
  getBackups(path5) {
    const list = this.progressBackups[path5];
    return Array.isArray(list) ? list : [];
  }
  getProgress(path5) {
    let _a;
    return (_a = this.progress[path5]) != null ? _a : null;
  }
  getSpreadForTotal(path5, total) {
    const prog = this.getProgress(path5);
    if (!prog) return 0;
    if (typeof prog.pct === "number") {
      return Math.round(prog.pct * Math.max(0, total - 1));
    }
    return typeof prog.spread === "number" ? prog.spread : 0;
  }
  async refreshProgress() {
    const fresh = await this._loadProgressFromVault();
    if (fresh) this.progress = fresh;
  }
  _highlightsFilePath() {
    const folder = this._dataFolder();
    return qiaomuReaderPath(folder ? `${folder}/reading-highlights.json` : "reading-highlights.json");
  }
  async _loadHighlightsFromVault() {
    return this._loadJsonStore(this._highlightsFilePath(), qiaomuReaderTranslate("highlights"));
  }
  async _saveHighlightsToVault() {
    const path5 = this._highlightsFilePath();
    if (this._blockedStores.has(path5)) throw new Error("highlight store is locked after a read failure");
    const folder = path5.substring(0, path5.lastIndexOf("/"));
    if (folder) {
      const folderExists = await this.app.vault.adapter.exists(folder);
      if (!folderExists) await this.app.vault.createFolder(folder).catch(() => {});
    }
    await this.app.vault.adapter.write(path5, JSON.stringify(this.highlights, null, 2));
    await this._writeRescue(true);
    return true;
  }
  async refreshHighlights() {
    const fresh = await this._loadHighlightsFromVault();
    if (fresh) this.highlights = fresh;
  }
  getHighlights(path5) {
    let _a;
    const list = (_a = this.highlights[path5]) != null ? _a : [];
    return sortHighlightsByPosition(list);
  }
  addHighlight(path5, hl) {
    if (!this.highlights[path5]) this.highlights[path5] = [];
    this.highlights[path5].push(hl);
    void this._persistHighlights(path5, (disk) => {
      if (!disk[path5]) disk[path5] = [];
      if (!disk[path5].some((x) => x.id === hl.id)) disk[path5].push(hl);
    }).then((saved) => { if (!saved) this._reportHighlightSaveError(); });
  }
  removeHighlight(path5, id) {
    const list = this.highlights[path5];
    if (list) this.highlights[path5] = list.filter((h) => h.id !== id);
    void this._persistHighlights(path5, (disk) => {
      if (disk[path5]) disk[path5] = disk[path5].filter((h) => h.id !== id);
    }).then((saved) => { if (!saved) this._reportHighlightSaveError(); });
  }
  async setHighlightComment(path5, id, hl, text) {
    const list = this.highlights[path5] || [];
    let target = id ? list.find((x) => x.id === id) : null;
    if (!target && hl && hl.text) target = list.find((x) => x.text === hl.text);
    if (!target) { new Notice(qiaomuReaderTranslate("highlight-a-passage-with-a-colour-first")); return false; }
    const value = String(text || "").trim();
    if (value) target.comment = value; else delete target.comment;
    const saved = await this._persistHighlights(path5, (disk) => {
      const d = (disk[path5] || []).find((x) => x.id === target.id);
      if (d) { if (value) d.comment = value; else delete d.comment; }
    });
    if (!saved) {
      this._reportHighlightSaveError();
      return false;
    }
    new Notice(value ? qiaomuReaderTranslate("comment-saved") : qiaomuReaderTranslate("comment-removed"));
    return true;
  }
  setHighlightColor(path5, id, color) {
    const list = this.highlights[path5];
    if (list) {
      const h = list.find((x) => x.id === id);
      if (h) h.color = color;
    }
    void this._persistHighlights(path5, (disk) => {
      if (disk[path5]) {
        const h = disk[path5].find((x) => x.id === id);
        if (h) h.color = color;
      }
    }).then((saved) => { if (!saved) this._reportHighlightSaveError(); });
  }
  _reportHighlightSaveError() {
    const now = Date.now();
    if (this._lastHighlightErrorNotice && now - this._lastHighlightErrorNotice < 15000) return;
    this._lastHighlightErrorNotice = now;
    new Notice(qiaomuReaderTranslate("could-not-save-the-highlight-it-remains-on-screen-but-may-disapp"), 8000);
  }
  _persistHighlights(bookPath, applyFn) { // serialized: every write waits for the previous one
    this._lastBookPath = bookPath;
    const operation = (this._hlChain || Promise.resolve()).then(() => this._writeHighlightStore(bookPath, applyFn));
    this._hlChain = operation.catch(() => {});
    return operation.catch((e) => {
      console.error("UV Reader: highlight persist failed", e);
      return false;
    });
  }
  async _writeHighlightStore(bookPath, applyFn) {
    if (this.settings.storageLayout === "books") {
      const disk = { [bookPath]: (Array.isArray(this.highlights[bookPath]) ? this.highlights[bookPath] : []).map((item) => ({ ...item })) };
      applyFn(disk);
      this.highlights[bookPath] = disk[bookPath];
      this._backupHighlights(bookPath, disk[bookPath] || []);
      await this._readingStore().saveBook(bookPath, "highlights", disk[bookPath] || [], this._bookMeta(bookPath));
      await this._saveLocalData();
      if (this.settings.quotesToBookNote === true) {
        await syncHighlightsToReadingNote(this.app, this, bookPath, disk[bookPath] || []);
      }
      return true;
    }
    const disk = await this._readHighlightStore(this._highlightsFilePath());
    applyFn(disk); this._mergeLocalHighlights(bookPath, disk);
    this.highlights = disk; this._backupHighlights(bookPath, disk[bookPath] || []);
    await this._saveHighlightsToVault(); await this._saveLocalData();
    if (this.settings.quotesToBookNote === true) {
      await syncHighlightsToReadingNote(this.app, this, bookPath, disk[bookPath] || []);
    }
    return true;
  }
  async _readHighlightStore(file) {
    if (!(await this.app.vault.adapter.exists(file))) return {};
    const fresh = await this._loadJsonStore(file, qiaomuReaderTranslate("highlights"));
    if (!fresh) throw new Error("highlight store is unreadable");
    return fresh && typeof fresh === "object" ? fresh : {};
  }
  _mergeLocalHighlights(bookPath, disk) {
    if (!Array.isArray(this.highlights[bookPath])) return;
    const rows = disk[bookPath] || (disk[bookPath] = []);
    const known = new Set(rows.map((h) => h.id));
    for (const h of this.highlights[bookPath]) if (!known.has(h.id)) rows.push(h);
  }
  _backupHighlights(path5, list) {
    if (!this.highlightsBackups) this.highlightsBackups = {};
    const arr = this.highlightsBackups[path5] || (this.highlightsBackups[path5] = []);
    const now = Date.now();
    const sig = list.map((h) => h.id).sort().join(",");
    const last = arr[arr.length - 1];
    if (last && last.sig === sig) { last.ts = now; return; }
    arr.push({ ts: now, count: list.length, sig, items: JSON.parse(JSON.stringify(list)) });
    while (arr.length > 12) arr.shift();
  }
  // Pinyin annotations pinned to a book, keyed by the same book paths as the
  // highlights. Small records ({id, cfi, text, pinyin, gloss}) in their own
  // store so highlight panels, exports and note sync never see them.
  _pinsFilePath() {
    const folder = this._dataFolder();
    return qiaomuReaderPath(folder ? `${folder}/reading-pins.json` : "reading-pins.json");
  }
  async _loadPinsFromVault() {
    return this._loadJsonStore(this._pinsFilePath(), qiaomuReaderTranslate("pins"));
  }
  getPins(path5) {
    const list = this.pins[path5];
    return Array.isArray(list) ? [...list] : [];
  }
  addPin(path5, pin) {
    if (!this.pins[path5]) this.pins[path5] = [];
    this.pins[path5].push(pin);
    void this._persistPins(path5, (disk) => {
      if (!disk[path5]) disk[path5] = [];
      if (!disk[path5].some((x) => x.id === pin.id)) disk[path5].push(pin);
    });
  }
  removePin(path5, id) {
    const list = this.pins[path5];
    if (list) this.pins[path5] = list.filter((pin) => pin.id !== id);
    void this._persistPins(path5, (disk) => {
      if (disk[path5]) disk[path5] = disk[path5].filter((pin) => pin.id !== id);
    });
  }
  _persistPins(bookPath, applyFn) {
    const operation = (this._pinChain || Promise.resolve()).then(() => this._writePinStore(bookPath, applyFn));
    this._pinChain = operation.catch(() => {});
    return operation.catch((error) => {
      console.error("UV Reader: pinyin pin persist failed", error);
      return false;
    });
  }
  async _writePinStore(bookPath, applyFn) {
    if (this.settings.storageLayout === "books") {
      const disk = { [bookPath]: (Array.isArray(this.pins[bookPath]) ? this.pins[bookPath] : []).map((pin) => ({ ...pin })) };
      applyFn(disk);
      this.pins[bookPath] = disk[bookPath];
      await this._readingStore().saveBook(bookPath, "pins", disk[bookPath] || [], this._bookMeta(bookPath));
      return true;
    }
    const file = this._pinsFilePath();
    if (this._blockedStores.has(file)) throw new Error("pin store is locked after a read failure");
    const disk = (await this.app.vault.adapter.exists(file))
      ? await this._loadJsonStore(file, qiaomuReaderTranslate("pins"))
      : {};
    if (disk === null) throw new Error("pin store is unreadable");
    applyFn(disk);
    this.pins = disk && typeof disk === "object" ? disk : {};
    const folder = file.substring(0, file.lastIndexOf("/"));
    if (folder && !(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }
    await this.app.vault.adapter.write(file, JSON.stringify(this.pins, null, 2));
    return true;
  }
};
}
