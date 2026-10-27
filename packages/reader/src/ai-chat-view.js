// AiChatView assembly. The host supplies the ItemView base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { shouldFollowContext } from "./reader-experience.js";
import { svgIcon } from "./reader-icons.js";

export function createAiChatView({
  ItemView, Notice, TFile, setIcon, AI_CHAT_VIEW_TYPE, AiChatHistoryModal, ReadSettingsModal, ReaderView, aiChatTitle, aiConfig, aiConnectionErrorMessage, aiSetupState, aiTurnsHaveDocumentContext, bindAiAttachmentIntake, bindAiSlashPrompts, bindReaderAiComposer, bookNoteLinkFor, captureAiScreenshot, clearAiSource, createAiChatLog, newAiSessionKey, normalizeAiChatHistory, normalizeAiTurnContext, normalizeAiTurnLocation, normalizeToolTurnContent, openAiAttachMenu, openPluginAiSettings, pickAiAttachments, prepareAiTools, qiaomuReaderTranslate, readerAiPanelContext, readerDefaultAiContext, readerHud, renderAiComposerPrompts, renderAiContextQuote, renderAiHeadMeta, renderAiMarkdown, renderAiUserTurn, renderAiWorkshopPreview, stripAiAttachmentData, testAndEnableAi,
}) {
  return class AiChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.text = "";
    this.bookFile = null;
    this.readerView = null;
    this.book = "";
    this.turns = [];
    this.attachments = [];
    this.pendingContext = null;
    this.structuredContext = true;
    this.scannedPdf = false;
    this.aiSessionKey = window.crypto?.randomUUID?.() || `reader-${Date.now()}-${Math.random()}`;
    this.contextUnavailable = false;
    this._finishedWorkshopPreviewIds = new Set();
    this._finishedTaskCards = new Set();
    this.drafts = this.plugin.aiDraftStore?.texts || new Map();
  }
  getViewType() { return AI_CHAT_VIEW_TYPE; }
  getDisplayText() { return this._title(); }
  getIcon() { return "wand-sparkles"; }
  _titleKey() {
    return this.readerView?.getViewType?.() === "qbr-quiz" ? "ai-quiz" : "ai-reading";
  }
  _isQuizContext() {
    return this.readerView?.getViewType?.() === "qbr-quiz";
  }
  _title() {
    return qiaomuReaderTranslate(this._titleKey());
  }
  _syncViewTitle() {
    try {
      const title = this._title();
      const tabTitle = this.leaf?.tabHeaderInnerTitleEl;
      if (tabTitle?.setText) tabTitle.setText(title);
      else if (tabTitle) tabTitle.textContent = title;
      const inner = this.leaf?.tabHeaderEl?.querySelector?.(".workspace-tab-header-inner-title");
      if (inner) inner.textContent = title;
    } catch {
      // Tab chrome belongs to the host; the sidebar header updates regardless.
    }
  }
  async onOpen() {
    this.contentEl.addClass("qiaomu-reader-ai-modal", "qiaomu-reader-ai-sidebar");
    this._renderWaiting();
    const view = this.app.workspace.getActiveViewOfType(ReaderView);
    const target = view?.bookHtml ? view : (this.plugin._openReaderModal?.bookHtml ? this.plugin._openReaderModal : null);
    const context = target ? readerAiPanelContext(target) : null;
    if (context) this.setContext(context, { focusInput: false, silent: true });
  }
  _settingsButton(head) {
    const settings = head.createEl("button", { cls: "qiaomu-reader-ai-prompt-settings" });
    svgIcon(settings, "sliders");
    settings.setAttribute("aria-label", qiaomuReaderTranslate("ai-reading-settings"));
    settings.addEventListener("click", () => {
      if (this.readerView) new ReadSettingsModal(this.app, this.readerView, "ai").open();
      else openPluginAiSettings(this.app, this.plugin);
    });
  }
  _renderHead(c) {
    const head = c.createDiv("qiaomu-reader-ai-head");
    const headText = head.createDiv("qiaomu-reader-ai-headtext");
    headText.createDiv({ cls: "qiaomu-reader-ai-title", text: this._title() });
    renderAiHeadMeta(headText, this);
    const actions = head.createDiv("qiaomu-reader-ai-head-actions");
    const iconButton = (icon, label, fn) => {
      const button = actions.createEl("button", { cls: "qiaomu-reader-ai-prompt-settings" });
      setIcon(button, icon);
      button.setAttribute("aria-label", label);
      button.addEventListener("click", fn);
      return button;
    };
    this.sessionButtons = [
      iconButton("plus", qiaomuReaderTranslate("new-chat"), () => this._newChat()),
      iconButton("history", qiaomuReaderTranslate("chat-history"), () => new AiChatHistoryModal(this.app, this).open()),
    ];
    if (!this._isQuizContext() && typeof this.plugin?.openWorkshopCapabilities === "function") {
      this.sessionButtons.unshift(iconButton("layout-grid", "我能对文档做什么", () => {
        this.plugin.openWorkshopCapabilities({
          extension: this.bookFile?.extension || "",
          readerView: this.readerView,
          inAi: true,
        });
      }));
    }
    // The study companion has no separate settings of its own; its empty
    // settings entry only led to a blank page.
    if (!this._isQuizContext()) this._settingsButton(actions);
    iconButton("x", qiaomuReaderTranslate("close"), () => {
      void this.plugin._rememberCompanion(false);
      this.leaf.detach();
    });
  }
  _renderSetup() {
    this._rememberDraft();
    const c = this.contentEl;
    c.empty();
    this._renderHead(c);
    const host = c.createDiv("qiaomu-reader-companion-setup");
    host.createEl("p", { text: qiaomuReaderTranslate("companion-setup-intro") });
    const form = host.createDiv();
    const draw = () => {
      form.empty();
      this.plugin.settingsTab._groupAi(form, draw, { enableOnSuccess: true, onReady: () => this._renderConversation() });
      if (!aiConfig(this.plugin).provider) return;
      const start = form.createEl("button", { cls: "mod-cta qiaomu-reader-companion-start", text: qiaomuReaderTranslate("ai-start-using") });
      start.addEventListener("click", async () => {
        start.disabled = true;
        try {
          await testAndEnableAi(this.plugin, text => start.setText(text));
          if (this.contentEl.isConnected) this._renderConversation();
        } catch (error) {
          const feedback = form.querySelector(".qiaomu-reader-ai-setup-feedback");
          if (feedback) { feedback.setAttribute("role", "alert"); feedback.setText(aiConnectionErrorMessage(error)); }
          for (const details of form.querySelectorAll("details[data-ai-advanced], details[data-ai-connection]")) details.open = true;
        } finally { start.disabled = false; start.setText(qiaomuReaderTranslate("ai-start-using")); }
      });
    };
    draw();
  }
  _renderWaiting() {
    const c = this.contentEl;
    c.empty();
    this._renderHead(c);
    const empty = c.createDiv("qiaomu-reader-ai-sidebar-waiting");
    svgIcon(empty.createDiv("qiaomu-reader-ai-empty-icon"), "text-select");
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-title", text: qiaomuReaderTranslate("open-a-book-to-start-chatting") });
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-sub", text: qiaomuReaderTranslate("ask-about-the-full-text-of-a-text-based-pdf-or-select-a-passage") });
  }
  _renderUnavailable() {
    const c = this.contentEl;
    c.empty();
    this._renderHead(c);
    const empty = c.createDiv("qiaomu-reader-ai-sidebar-waiting");
    svgIcon(empty.createDiv("qiaomu-reader-ai-empty-icon"), "text-select");
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-title", text: qiaomuReaderTranslate("this-pdf-has-no-usable-text-layer") });
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-sub", text: qiaomuReaderTranslate("only-original-page-reading-and-the-book-note-are-available-text") });
  }
  _showDocumentTools() {
    if (this._isQuizContext() || this.busy || !this.log) return false;
    if (this.empty) {
      this.empty.remove();
      this.empty = null;
    }
    renderAiUserTurn(this.log, { role: "user", content: "文档工具" }, this);
    const group = this.log.createDiv("qiaomu-reader-ai-group");
    const bubble = group.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-ai");
    const rawCapabilities = typeof this.plugin?.workshopCapabilities === "function"
      ? this.plugin.workshopCapabilities({ extension: this.bookFile?.extension || "", readerView: this.readerView })
      : [];
    const capabilities = Array.isArray(rawCapabilities)
      ? rawCapabilities.filter((capability) => !capability?.hidden)
      : [];
    if (!capabilities.length) {
      this._documentTools = null;
      bubble.createDiv({
        cls: "qiaomu-reader-ai-workshop-hint",
        text: "当前文档暂时没有可用的操作。",
      });
    } else {
      bubble.createDiv({ cls: "qiaomu-reader-ai-workshop-intro", text: "选择一个操作，或输入编号后发送：" });
      this._renderWorkshopDiscovery(bubble, capabilities);
    }
    if (this.inputEl) {
      this.inputEl.value = "";
      this.inputController?.refresh?.();
    }
    this._scroll();
    return true;
  }
  _renderWorkshopDiscovery(host, suppliedCapabilities = null) {
    if (!host || this._isQuizContext() || typeof this.plugin?.workshopCapabilities !== "function") return;
    const rawCapabilities = Array.isArray(suppliedCapabilities) ? suppliedCapabilities : this.plugin.workshopCapabilities({
      extension: this.bookFile?.extension || "",
      readerView: this.readerView,
    });
    const capabilities = Array.isArray(rawCapabilities)
      ? rawCapabilities.filter((capability) => !capability?.hidden)
      : [];
    if (!capabilities.length) return;
    const section = host.createDiv("qiaomu-reader-ai-workshop");
    const head = section.createDiv("qiaomu-reader-ai-workshop-head");
    head.createDiv({ cls: "qiaomu-reader-ai-workshop-title", text: "我能对文档做什么" });
    const recommended = capabilities.filter((capability) => capability.recommended && capability.primary);
    const baseCapabilities = recommended.length ? recommended : capabilities;
    const extraCapabilities = capabilities.filter((capability) => !baseCapabilities.includes(capability));
    let more = null;
    if (extraCapabilities.length) {
      more = head.createEl("button", {
        cls: "qiaomu-reader-ai-workshop-all",
        text: "更多...",
        attr: { type: "button", "aria-expanded": "false" },
      });
    }
    const baseItems = baseCapabilities.map((capability, index) => ({
      number: index + 1,
      capability,
    }));
    this._documentTools = {
      bookPath: this.bookFile?.path || "",
      at: Date.now(),
      items: [...baseItems],
    };
    const actions = section.createDiv("qiaomu-reader-ai-doc-list");
    const addRow = (item) => {
      const action = actions.createEl("button", {
        cls: "qiaomu-reader-ai-doc-row",
        attr: { type: "button" },
      });
      action.disabled = Boolean(this.busy);
      action.createSpan({ cls: "qiaomu-reader-ai-doc-number", text: `${item.number}.` });
      action.createSpan({ cls: "qiaomu-reader-ai-doc-title", text: item.capability.title });
      action.addEventListener("click", () => { void this._runDocumentTool(item); });
      return action;
    };
    baseItems.forEach(addRow);
    let expanded = false;
    let extraItems = [];
    let extraRows = [];
    if (more) {
      more.disabled = Boolean(this.busy);
      more.addEventListener("click", () => {
        if (this.busy) return;
        if (expanded) {
          for (const row of extraRows) row.remove();
          extraRows = [];
          extraItems = [];
          this._documentTools.items = [...baseItems];
          more.setText("更多...");
          more.setAttribute("aria-expanded", "false");
          expanded = false;
          return;
        }
        extraItems = extraCapabilities.map((capability, index) => ({
          number: baseItems.length + index + 1,
          capability,
        }));
        extraRows = extraItems.map(addRow);
        this._documentTools.items = [...baseItems, ...extraItems];
        more.setText("收起");
        more.setAttribute("aria-expanded", "true");
        expanded = true;
        this._scroll?.();
      });
    }
    section.createDiv({
      cls: "qiaomu-reader-ai-workshop-hint",
      text: "点击操作，或输入编号后发送。",
    });
  }

  _runDocumentTool(item) {
    if (this.busy || !item?.capability) return false;
    if (item.capability.action === "export-toc") {
      const exportAction = this.readerView?.exportNavigationCopy || this.readerView?.exportEpubWithToc;
      if (typeof exportAction !== "function") {
        new Notice("当前阅读视图不支持导出带导航的副本");
        return false;
      }
      void exportAction.call(this.readerView);
      return true;
    }
    const prompt = item.capability.prompt || `我想${item.capability.title}。`;
    return this._send(prompt);
  }

  _useDocumentToolNumber(command) {
    const match = String(command || "").trim().match(/^(\d{1,2})[.、)）]?$/u);
    if (!match) return false;
    const menu = this._documentTools;
    if (!menu || menu.bookPath !== (this.bookFile?.path || "")) return false;
    if (Date.now() - Number(menu.at || 0) > 10 * 60_000) {
      this._documentTools = null;
      return false;
    }
    const item = menu.items.find((entry) => entry.number === Number(match[1]));
    return item ? this._runDocumentTool(item) : false;
  }
  setContext(value, options = {}) {
    if (this.busy) {
      if (options.selection || options.follow && !this._deferredContext?.options.selection)
        this._deferredContext = { value, options };
      if (!options.silent) new Notice(qiaomuReaderTranslate("stop-the-current-answer-before-changing-the-passage"));
      return;
    }
    const context = normalizeAiTurnContext(value);
    this.scannedPdf = value?.scanned === true;
    const bookFile = value?.bookFile || null;
    const readerView = value?.readerView || null;
    const bookPath = bookFile?.path || "";
    const sameBook = !!bookPath && bookPath === this.bookFile?.path;
    this._rememberDraft();
    const draft = this.drafts.get(bookPath) || "";
    if (options.follow && !shouldFollowContext(this.contextMode, sameBook)) return;
    this.contextMode = context?.kind === "selection" ? "selection" : "follow";
    const unavailable = value?.unavailable === true;
    // A persistent ACP conversation already knows the document after its first
    // document-backed turn. HTTP providers receive that turn again in history,
    // so neither path needs another copy of the whole PDF on every toolbar tap.
    const nextContext = sameBook && context?.kind === "document" && aiTurnsHaveDocumentContext(this.turns)
      ? null
      : context;
    const sameContext = sameBook && unavailable === this.contextUnavailable
      && nextContext?.kind === this.pendingContext?.kind
      && nextContext?.text === this.pendingContext?.text
      && nextContext?.page === this.pendingContext?.page;
    if (sameContext) {
      if (!this.inputEl?.isConnected && aiSetupState(this.plugin).enabled) this._renderConversation(options);
      if (options.focusInput !== false) readerHud.autoFocus(this.inputEl);
      return;
    }
    if (!sameBook || context?.kind !== "selection") clearAiSource(this.readerView);
    if (!sameBook && this.turns.length) void this._persistSession();
    this.text = nextContext?.text || (sameBook ? this.text : "");
    this.pendingContext = nextContext;
    this.bookFile = bookFile;
    this.readerView = readerView;
    this._syncViewTitle();
    this.contextUnavailable = unavailable;
    this.book = this.bookFile ? bookNoteLinkFor(this.plugin, this.bookFile) || this.bookFile.basename : "";
    if (unavailable) {
      this.turns = [];
      this.chatRecordId = "";
      this.pendingContext = null;
      this.text = "";
      this.aiSessionKey = newAiSessionKey();
      this._renderUnavailable();
      return;
    }
    if (!sameBook) {
      this._documentTools = null;
      const recent = normalizeAiChatHistory(this.plugin.settings.aiChatHistory)
        .find((item) => item.bookPath && item.bookPath === bookPath);
      if (recent) {
        const pendingContext = context?.kind === "document" && aiTurnsHaveDocumentContext(recent.turns)
          ? null
          : context;
        this.loadSession(recent, {
          readerView,
          bookFile,
          pendingContext,
          draft,
          skipPersist: true,
          focusInput: options.focusInput,
        });
        return;
      }
      this.turns = [];
      this.chatRecordId = "";
      this.aiSessionKey = newAiSessionKey();
    }
    if (sameBook && this.pendingContextHost?.isConnected && !unavailable) {
      this._refreshPendingContext();
      if (options.focusInput) readerHud.autoFocus(this.inputEl);
      return;
    }
    this._renderConversation({ focusInput: options.focusInput });
    if (draft && this.inputEl) {
      this.inputEl.value = draft;
      this.inputController?.refresh();
    }
  }
  _rememberDraft() {
    this.drafts ||= new Map();
    const path = this.bookFile?.path;
    if (!path || !this.inputEl?.isConnected) return;
    if ((this.busy || this.inputController?.pending) && !this.inputEl.value) return;
    this.plugin.aiDraftStore?.set(path, this.inputEl.value);
  }
  _newChat({ persist = true } = {}) {
    if (this.busy) return;
    if (this.contextUnavailable) {
      this._renderUnavailable();
      return;
    }
    this._rememberDraft();
    const draft = this.drafts.get(this.bookFile?.path) || "";
    if (persist && this.turns.length) void this._persistSession();
    this.contextMode = "follow";
    this.pendingContext = null;
    this._documentTools = null;
    clearAiSource(this.readerView);
    this.turns = [];
    this._finishedTaskCards = new Set();
    this.chatRecordId = "";
    this.aiSessionKey = newAiSessionKey();
    this.sessionTitle = "";
    if (!this.pendingContext && this.readerView) {
      const current = readerDefaultAiContext(this.readerView);
      this.pendingContext = normalizeAiTurnContext(current);
      this.text = this.pendingContext?.text || "";
    }
    if (this.bookFile || this.pendingContext) this._renderConversation();
    else this._renderWaiting();
    if (this.inputEl?.isConnected) {
      this.inputEl.value = draft;
      this.inputController?.refresh();
    }
  }
  loadSession(item, options = {}) {
    if (this.busy) return;
    const session = normalizeAiChatHistory([item])[0];
    if (!session) return;
    if (!options.skipPersist && this.turns.length && this.chatRecordId !== session.id) void this._persistSession();
    if (!options.skipPersist) this._rememberDraft();
    const readerView = options.readerView || (this.readerView?.file?.path === session.bookPath ? this.readerView : null);
    clearAiSource(this.readerView);
    this.text = session.text;
    this.book = session.book;
    this.bookFile = options.bookFile || (session.bookPath ? this.app.vault.getAbstractFileByPath(session.bookPath) : null);
    if (!(this.bookFile instanceof TFile)) this.bookFile = null;
    this.readerView = readerView;
    this.contextUnavailable = false;
    this._syncViewTitle();
    this.contextMode = options.pendingContext?.kind === "selection" ? "selection" : readerView ? "follow" : "none";
    this.pendingContext = normalizeAiTurnContext(options.pendingContext);
    if (this.pendingContext) this.text = this.pendingContext.text;
    this.turns = session.turns.map((turn) => ({ ...turn }));
    this._finishedTaskCards = new Set();
    this.chatRecordId = session.id;
    this.sessionTitle = session.titleEdited ? session.title : "";
    this.aiSessionKey = newAiSessionKey();
    this._renderConversation({ focusInput: options.focusInput });
    const draft = options.draft ?? this.drafts.get(session.bookPath) ?? "";
    if (this.inputEl) {
      this.inputEl.value = draft;
      this.inputController?.refresh();
    }
  }
  async _persistSession() {
    const lastAssistant = this.turns.findLastIndex((turn) => turn.role === "assistant");
    if (lastAssistant < 0) return;
    const completeTurns = this.turns.slice(0, lastAssistant + 1);
    const record = {
      id: this.chatRecordId || newAiSessionKey(),
      title: this.sessionTitle || aiChatTitle(completeTurns, this.text),
      ...(this.sessionTitle ? { titleEdited: true } : {}),
      book: this.book,
      bookPath: this.bookFile?.path || "",
      text: this.text,
      contextVersion: 1,
      turns: completeTurns.map((turn) => ({
        role: turn.role,
        content: turn.role === "tool" ? normalizeToolTurnContent(turn.content) : turn.content,
        ...(turn.interrupted ? { interrupted: true } : {}),
        ...(turn.savedNotePath ? { savedNotePath: turn.savedNotePath } : {}),
        ...(turn.context ? { context: normalizeAiTurnContext(turn.context) } : {}),
        ...(turn.location ? { location: normalizeAiTurnLocation(turn.location) } : {}),
        ...(turn.attachments?.length ? { attachments: stripAiAttachmentData(turn.attachments) } : {}),
        ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
        ...(turn.role === "tool" ? { toolCallId: turn.toolCallId, toolName: turn.toolName, isError: turn.isError === true } : {}),
        ...(turn.workshopPreview ? {
          workshopPreview: turn.workshopPreview,
          ...(turn.workshopConfirmation ? { workshopConfirmation: turn.workshopConfirmation } : {}),
          ...(turn.workshopPreviewId ? { workshopPreviewId: turn.workshopPreviewId } : {}),
          ...(turn.workshopPreviewDone ? { workshopPreviewDone: true } : {}),
          ...(turn.workshopTaskId ? { workshopTaskId: turn.workshopTaskId } : {}),
        } : {}),
        ...(turn.workshopPreviewDoneId ? { workshopPreviewDoneId: turn.workshopPreviewDoneId } : {}),
        ...(turn.taskCompletion ? {
          taskCompletion: {
            id: String(turn.taskCompletion.id || "").slice(0, 120),
            status: turn.taskCompletion.status === "done" ? "done" : "failed",
            kind: String(turn.taskCompletion.kind || "").slice(0, 80),
            title: String(turn.taskCompletion.title || "").slice(0, 120),
            detail: String(turn.taskCompletion.detail || "").slice(0, 300),
            output: String(turn.taskCompletion.output || "").slice(0, 500),
            error: String(turn.taskCompletion.error || "").slice(0, 300),
            bookPath: String(turn.taskCompletion.bookPath || "").slice(0, 500),
            finishedAt: Number(turn.taskCompletion.finishedAt) || 0,
          },
        } : {}),
      })),
      updatedAt: Date.now(),
    };
    this.chatRecordId = record.id;
    const old = normalizeAiChatHistory(this.plugin.settings.aiChatHistory).filter((item) => item.id !== record.id);
    this.plugin.settings.aiChatHistory = [record, ...old].slice(0, 30);
    await this.plugin.saveAiChatRecord?.(record);
    try {
      await this.plugin.saveAll();
      this._historySaveFailed = false;
    } catch {
      if (!this._historySaveFailed) new Notice(qiaomuReaderTranslate("conversation-could-not-be-saved-it-remains-in-this-panel-check-v"));
      this._historySaveFailed = true;
    }
  }
  async _removeHistory(matches) {
    if (this.busy || this._historySaving) return;
    this._historySaving = true;
    const old = normalizeAiChatHistory(this.plugin.settings.aiChatHistory);
    const removeCurrent = old.some((item) => item.id === this.chatRecordId && matches(item));
    const removed = old.filter((item) => matches(item));
    this.plugin.settings.aiChatHistory = old.filter((item) => !matches(item));
    try {
      await this.plugin.removeAiChatRecords?.(removed);
      await this.plugin.saveAll();
      if (removeCurrent) this._newChat({ persist: false });
    } catch {
      this.plugin.settings.aiChatHistory = old;
      new Notice(qiaomuReaderTranslate("conversation-could-not-be-saved-it-remains-in-this-panel-check-v"));
    } finally { this._historySaving = false; }
  }
  // Older conversations predate the structured preview turn field. Their
  // prepare result is still in the transcript, so reconstruct the card from
  // the tool text instead of leaving a dead "click below" sentence.
  _storedWorkshopPreview() {
    let stored = null;
    for (const turn of this.turns) {
      if (turn.role === "assistant" && turn.workshopPreview) stored = turn;
    }
    if (stored) {
      // A done marker without a task id came from an interrupted old submit;
      // show the card again so the reader can actually finish the task.
      return {
        id: stored.workshopPreviewId || "",
        preview: stored.workshopPreview,
        confirmation: stored.workshopConfirmation || null,
        done: stored.workshopPreviewDone === true && Boolean(stored.workshopTaskId),
      };
    }
    let lastUserIndex = -1;
    for (let index = 0; index < this.turns.length; index += 1) {
      if (this.turns[index].role === "user") lastUserIndex = index;
    }
    for (let index = 0; index < this.turns.length; index += 1) {
      const turn = this.turns[index];
      const call = (turn.toolCalls || []).find((item) => item.name === "prepare_workshop_task");
      if (!call) continue;
      const resultIndex = this.turns.findIndex((item) => item.role === "tool" && item.toolCallId === call.id);
      const result = resultIndex >= 0 ? this.turns[resultIndex] : null;
      // A later user question means this prepare belongs to an older turn; do
      // not resurface a stale confirm card at the bottom of the conversation.
      if (!result || result.isError || resultIndex <= lastUserIndex) continue;
      const content = Array.isArray(result.content)
        ? result.content.map((block) => block?.type === "text" ? String(block.text || "") : "").join("\n")
        : String(result.content || "");
      const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length || !/^准备开始：/.test(lines[0])) continue;
      const read = (prefix) => {
        const line = lines.find((item) => item.startsWith(prefix));
        return line ? line.slice(prefix.length).trim() : "";
      };
      stored = {
        id: call.id || "",
        preview: {
          operation: lines[0].slice("准备开始：".length).trim(),
          summary: lines[1] || "",
          source: read("来源："),
          output: read("结果："),
        },
        confirmation: {
          operation: String(call.arguments?.operation || lines[0].slice("准备开始：".length).trim()),
          label: "确认开始",
        },
      };
    }
    if (stored && this._finishedWorkshopPreviewIds?.has(stored.id)) return null;
    if (stored && this.turns.some((turn) => turn.role === "assistant"
      && turn.workshopPreviewDoneId === stored.id)) return null;
    return stored;
  }
  _flushTaskCompletions() {
    const pending = this.plugin?._aiTaskCompletions;
    if (!Array.isArray(pending) || !pending.length) return;
    // Keep the list for the session. A later re-render of this sidebar must be
    // able to restore the same completion cards.
    for (const task of pending) this.showWorkshopTaskFinished(task);
  }

  _taskCompletionText(task = {}) {
    const done = task.status === "done";
    const title = String(task.title || "文档任务").trim();
    const output = String(task.output || "").replace(/\\/g, "/").trim();
    const error = String(task.error || "").trim();
    return done
      ? `任务完成：${title}\n\n文件：${output || "没有生成文件"}\n\n可在「书坊 → 任务」查看详情。`
      : `任务未完成：${title}\n\n${error ? `原因：${error}\n\n` : ""}可在「书坊 → 任务」查看详情。`;
  }

  _appendTaskCompletionBubble(content) {
    const group = this.log.createDiv("qiaomu-reader-ai-group");
    const bubble = group.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-ai");
    bubble.createDiv({ cls: "qiaomu-reader-ai-msg-text", text: content });
    if (typeof this._scroll === "function") this._scroll();
  }

  _taskBookKey(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  _taskCompletionMatchesBook(completion = {}) {
    const taskBook = this._taskBookKey(completion.bookPath);
    const openBook = this._taskBookKey(this.bookFile?.path);
    return Boolean(taskBook && openBook && taskBook === openBook);
  }

  // Completion is a normal assistant message in the conversation. It needs no
  // model call, survives a sidebar rebuild with the conversation, and states
  // where the output file is.
  showWorkshopTaskFinished(task = {}) {
    if (!this._taskCompletionMatchesBook(task)) return false;
    this._finishedTaskCards ||= new Set();
    const id = String(task.id || "");
    const existing = id
      ? this.turns.find((turn) => turn.role === "assistant" && turn.taskCompletion?.id === id)
      : null;
    if (existing) {
      if (!this._taskCompletionMatchesBook(existing.taskCompletion)) return false;
      if (!this.log?.isConnected) return false;
      // The turn can be restored while the sidebar is detached; render it when
      // the same view becomes visible, but never add a second copy.
      if (id && this._finishedTaskCards.has(id)) return true;
      if (id) this._finishedTaskCards.add(id);
      this._appendTaskCompletionBubble(existing.content);
      return true;
    }
    const content = this._taskCompletionText(task);
    const completion = {
      id,
      status: task.status === "done" ? "done" : "failed",
      kind: String(task.kind || ""),
      title: String(task.title || ""),
      detail: String(task.detail || ""),
      output: String(task.output || "").replace(/\\/g, "/"),
      error: String(task.error || ""),
      bookPath: this._taskBookKey(task.bookPath),
      finishedAt: Number(task.finishedAt) || 0,
    };
    this.turns.push({ role: "assistant", content, taskCompletion: completion });
    if (typeof this._persistSession === "function") void this._persistSession();
    if (!this.log?.isConnected) return false;
    if (id) this._finishedTaskCards.add(id);
    this._appendTaskCompletionBubble(content);
    return true;
  }

  _renderStoredTurns() {
    let hasPreviewCard = false;
    let lastPreviewIndex = -1;
    this.turns.forEach((turn, index) => {
      if (turn.role === "assistant" && turn.workshopPreview) lastPreviewIndex = index;
    });
    this.turns.forEach((turn, index) => {
      if (turn.role === "user") {
        renderAiUserTurn(this.log, turn, this);
        return;
      }
      // Tool results stay in the transcript for the model; the step cards
      // around them are a live-session affordance.
      if (turn.role !== "assistant") return;
      // A completion belongs to the document it was started from. Older
      // unassociated completions are hidden here and dropped by history
      // normalization rather than leaking into whichever book opens next.
      if (turn.taskCompletion) {
        if (!this._taskCompletionMatchesBook(turn.taskCompletion)) return;
        const group = this.log.createDiv("qiaomu-reader-ai-group");
        const bubble = group.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-ai");
        void renderAiMarkdown(this, bubble, turn.content, this.bookFile?.path || "");
        const taskId = String(turn.taskCompletion.id || "");
        if (taskId) this._finishedTaskCards.add(taskId);
        return;
      }
      const group = this.log.createDiv("qiaomu-reader-ai-group");
      const bubble = group.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-ai");
      void renderAiMarkdown(this, bubble, turn.content, this.bookFile?.path || "");
      if (turn.interrupted) group.createDiv({ cls: "qiaomu-reader-ai-interrupted", text: qiaomuReaderTranslate("reply-interrupted-generated-content-has-been-kept") });
      const question = this.turns[index - 1];
      this._actions(group, turn.content, {
        question: question?.role === "user" ? question.content : "",
        context: question?.role === "user" ? question.context : null,
        turn: question,
        answerTurn: turn,
        regenerate: index === this.turns.length - 1,
      });
      if (index === lastPreviewIndex && turn.workshopPreview && typeof renderAiWorkshopPreview === "function") {
        this._pendingPreviewCard = renderAiWorkshopPreview(group, {
          id: turn.workshopPreviewId || "",
          preview: turn.workshopPreview,
          confirmation: turn.workshopConfirmation || null,
          done: turn.workshopPreviewDone === true && Boolean(turn.workshopTaskId),
        }, this) || null;
        hasPreviewCard = true;
      }
    });
    if (hasPreviewCard || typeof renderAiWorkshopPreview !== "function") return;
    const restored = this._storedWorkshopPreview();
    if (restored) this._pendingPreviewCard = renderAiWorkshopPreview(this.log, restored, this) || null;
  }
  // The task plan itself is memory-only (it contains provider settings), so a
  // preview restored from history prepares once more before submitting. The
  // visible card keeps its original wording; the actual output path can pick a
  // new suffix if the file now exists.
  async _confirmStoredWorkshopTask(operation) {
    if (typeof this._confirmWorkshopTask === "function") {
      return this._confirmWorkshopTask(operation);
    }
    if (typeof prepareAiTools !== "function") return { ok: false, error: "当前环境不能开始文档处理。" };
    try {
      const tools = await prepareAiTools(this);
      if (!tools) return { ok: false, error: "当前这个文档暂时没有可用的文档操作。" };
      const prepared = await tools.run("prepare_workshop_task", { operation });
      if (!prepared?.confirmation?.operation) {
        return { ok: false, error: prepared?.text || "没有准备好这个任务。" };
      }
      if (typeof this._confirmWorkshopTask !== "function") {
        return { ok: false, error: "没有准备好这个任务，请重新发起。" };
      }
      return await this._confirmWorkshopTask(prepared.confirmation.operation);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
  _markWorkshopPreviewDone(id = "", taskId = "") {
    if (!taskId) return;
    const restored = this._storedWorkshopPreview();
    let changed = false;
    for (const turn of this.turns) {
      if (turn.role !== "assistant" || !turn.workshopPreview) continue;
      if (id && turn.workshopPreviewId !== id) continue;
      turn.workshopPreviewDone = true;
      turn.workshopTaskId = String(taskId);
      changed = true;
    }
    // A card reconstructed from an older transcript has no preview fields on
    // its answer turn. Attach the parsed preview there so it survives the next
    // reopen as a submitted card instead of disappearing.
    if (!changed && id) {
      for (let index = this.turns.length - 1; index >= 0; index -= 1) {
        const turn = this.turns[index];
        if (turn.role !== "assistant") continue;
        if (restored && restored.id === id && restored.preview) {
          turn.workshopPreview = restored.preview;
          if (restored.confirmation) turn.workshopConfirmation = restored.confirmation;
          turn.workshopPreviewId = id;
          turn.workshopPreviewDone = true;
          turn.workshopTaskId = String(taskId);
        } else {
          turn.workshopPreviewDoneId = id;
        }
        changed = true;
        break;
      }
    }
    if (id) this._finishedWorkshopPreviewIds.add(id);
    if (changed && typeof this._persistSession === "function") void this._persistSession();
  }
  _renderConversation(options = {}) {
    const state = aiSetupState(this.plugin);
    if (!(state.ready && state.enabled)) { this._renderSetup(); return; }
    const c = this.contentEl;
    c.empty();
    if (!this.pendingContext && !this.turns.length && this.readerView && this.contextMode !== "none") {
      this.pendingContext = normalizeAiTurnContext(readerDefaultAiContext(this.readerView));
      this.text = this.pendingContext?.text || this.text;
    }
    this._renderHead(c);
    this.log = createAiChatLog(c, this);
    this._finishedTaskCards = new Set();
    if (this.turns.length) this._renderStoredTurns();
    else this._buildEmpty();
    this._flushTaskCompletions();
    renderAiComposerPrompts(c, this);
    const bar = c.createDiv("qiaomu-reader-ai-composer");
    this.pendingContextHost = bar.createDiv("qiaomu-reader-ai-context-slot");
    this._renderPendingContext(this.pendingContextHost);
    this.attachHost = bar.createDiv("qiaomu-reader-ai-attach-slot");
    const slashMenu = bar.createDiv("qiaomu-reader-ai-slash-menu");
    slashMenu.hidden = true;
    const input = bar.createEl("textarea", { cls: "qiaomu-reader-ai-input" });
    input.rows = 1;
    input.placeholder = qiaomuReaderTranslate("message");
    input.setAttribute("aria-label", qiaomuReaderTranslate("message"));
    const footer = bar.createDiv("qiaomu-reader-ai-composer-foot");
    const attach = footer.createEl("button", { cls: "qiaomu-reader-ai-attach", attr: { type: "button", "aria-expanded": "false" } });
    svgIcon(attach, "paperclip");
    attach.setAttribute("aria-label", qiaomuReaderTranslate("attach-image-or-file"));
    attach.addEventListener("click", () => openAiAttachMenu(attach, this, {
      pick: (kind) => { void pickAiAttachments(this, kind); },
      page: () => { void captureAiScreenshot(this, { page: true }); },
      shot: () => { void captureAiScreenshot(this); },
    }));
    this.attachButton = attach;
    const send = footer.createEl("button", { cls: "qiaomu-reader-ai-send" });
    this.inputEl = input;
    this.sendEl = send;
    this.canCancel = true;
    bindAiSlashPrompts(slashMenu, input, this);
    bindAiAttachmentIntake(this, c, input);
    this.inputController = bindReaderAiComposer(this, input, send, footer);
    this._renderAttachments();
    input.value = this.drafts.get(this.bookFile?.path) || "";
    this.inputController.refresh();
    if (options.focusInput !== false) readerHud.autoFocus(input);
    readerHud.blurOnTapOutside(c, input);
  }
  _renderPendingContext(host) {
    const context = normalizeAiTurnContext(this.pendingContext);
    if (!context) {
      if (this.contextMode === "none" && this.readerView?.file?.path === this.bookFile?.path) {
        const row = host.createDiv("qiaomu-reader-ai-context-detached");
        row.createSpan({ text: qiaomuReaderTranslate("no-source-attached-this-turn"), attr: { title: qiaomuReaderTranslate("earlier-sources-remain-in-conversation-history-start-a-new-conve") } });
        row.createEl("button", { text: qiaomuReaderTranslate("attach-reading-context-again"), attr: { type: "button" } }).addEventListener("click", () => {
          this.contextMode = "follow";
          this._prepareContext();
        });
      }
      return;
    }
    const rendered = renderAiContextQuote(host, context, {
      className: "qiaomu-reader-ai-context-attached",
      clearable: true,
      onClear: () => {
        this.pendingContext = null;
        this.text = "";
        this.contextMode = "none";
        clearAiSource(this.readerView);
        this._refreshPendingContext();
      },
    });
    this.pendingContextEl = rendered?.card || null;
    this.contextClearEl = rendered?.clear || null;
  }
  _refreshPendingContext() {
    if (this.quickPromptRow?.parentElement) renderAiComposerPrompts(this.quickPromptRow.parentElement, this);
    const expanded = this.pendingContextHost?.querySelector("details")?.open;
    this.pendingContextHost?.empty();
    if (this.pendingContextHost) this._renderPendingContext(this.pendingContextHost);
    const details = this.pendingContextHost?.querySelector("details");
    if (details && expanded) details.open = true;
  }
  _prepareContext() {
    if (this.contextMode !== "follow" || !this.readerView || this.readerView.file?.path !== this.bookFile?.path) return;
    // A request snapshots its source before busy is set. End any page-turn
    // transition first, so the source matches the destination screen.
    if (!this.readerView.engine && this.readerView.pager?.flow && !this.readerView.pager.scrollMode) this.readerView.pager.applyTransform(false);
    void this.readerView.pager?.flow?.offsetHeight;
    this.setContext(readerAiPanelContext(this.readerView), { follow: true, silent: true, focusInput: false });
  }
  // Keeping the sidebar open after an answer is saved preserves the reading
  // thread; closing the leaf remains an explicit Obsidian action.
  close() {}
  async onClose() {
    this.plugin._companionWasVisible = false;
    // An explicit close means "don't auto-open the companion"; a route change
    // (home, library) must not change that preference.
    if (!this.plugin._unloading && !this.plugin._closingCompanionForRoute) await this.plugin._rememberCompanion(false);
    if (this.abortController) this.abortController.abort();
    this._rememberDraft();
    await this.plugin.aiDraftStore?.flush();
    this.activeMarkdownRenderer?.dispose();
    this.activeMarkdownRenderer = null;
    if (this.turns.length) await this._persistSession();
    this.contentEl.empty();
  }
};
}
