// AiChatView assembly. The host supplies the ItemView base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { shouldFollowContext } from "./reader-experience.js";
import { svgIcon } from "./reader-icons.js";

export function createAiChatView({
  ItemView, Notice, TFile, setIcon, AI_CHAT_VIEW_TYPE, AiChatHistoryModal, ReadSettingsModal, ReaderView, aiChatTitle, aiConfig, aiConnectionErrorMessage, aiSetupState, aiTurnsHaveDocumentContext, bindAiAttachmentIntake, bindAiSlashPrompts, bindReaderAiComposer, bookNoteLinkFor, clearAiSource, createAiChatLog, newAiSessionKey, normalizeAiChatHistory, normalizeAiTurnContext, openAiAttachMenu, openPluginAiSettings, pickAiAttachments, qiaomuReaderTranslate, readerAiPanelContext, readerDefaultAiContext, readerHud, renderAiComposerPrompts, renderAiContextQuote, renderAiHeadMeta, renderAiMarkdown, renderAiUserTurn, stripAiAttachmentData, testAndEnableAi,
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
    this.aiSessionKey = window.crypto?.randomUUID?.() || `reader-${Date.now()}-${Math.random()}`;
    this.contextUnavailable = false;
    this.drafts = this.plugin.aiDraftStore?.texts || new Map();
  }
  getViewType() { return AI_CHAT_VIEW_TYPE; }
  getDisplayText() { return qiaomuReaderTranslate("ai-reading"); }
  getIcon() { return "wand-sparkles"; }
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
    headText.createDiv({ cls: "qiaomu-reader-ai-title", text: qiaomuReaderTranslate("ai-reading") });
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
    this._settingsButton(actions);
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
  setContext(value, options = {}) {
    if (this.busy) {
      if (options.selection || options.follow && !this._deferredContext?.options.selection)
        this._deferredContext = { value, options };
      if (!options.silent) new Notice(qiaomuReaderTranslate("stop-the-current-answer-before-changing-the-passage"));
      return;
    }
    const context = normalizeAiTurnContext(value);
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
    clearAiSource(this.readerView);
    this.turns = [];
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
    this.contextMode = options.pendingContext?.kind === "selection" ? "selection" : readerView ? "follow" : "none";
    this.pendingContext = normalizeAiTurnContext(options.pendingContext);
    if (this.pendingContext) this.text = this.pendingContext.text;
    this.turns = session.turns.map((turn) => ({ ...turn }));
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
        content: turn.content,
        ...(turn.interrupted ? { interrupted: true } : {}),
        ...(turn.savedNotePath ? { savedNotePath: turn.savedNotePath } : {}),
        ...(turn.context ? { context: normalizeAiTurnContext(turn.context) } : {}),
        ...(turn.attachments?.length ? { attachments: stripAiAttachmentData(turn.attachments) } : {}),
      })),
      updatedAt: Date.now(),
    };
    this.chatRecordId = record.id;
    const old = normalizeAiChatHistory(this.plugin.settings.aiChatHistory).filter((item) => item.id !== record.id);
    this.plugin.settings.aiChatHistory = [record, ...old].slice(0, 30);
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
    this.plugin.settings.aiChatHistory = old.filter((item) => !matches(item));
    try {
      await this.plugin.saveAll();
      if (removeCurrent) this._newChat({ persist: false });
    } catch {
      this.plugin.settings.aiChatHistory = old;
      new Notice(qiaomuReaderTranslate("conversation-could-not-be-saved-it-remains-in-this-panel-check-v"));
    } finally { this._historySaving = false; }
  }
  _renderStoredTurns() {
    this.turns.forEach((turn, index) => {
      if (turn.role === "user") {
        renderAiUserTurn(this.log, turn);
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
    });
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
    if (this.turns.length) this._renderStoredTurns();
    else this._buildEmpty();
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
    attach.addEventListener("click", () => openAiAttachMenu(attach, this, { pick: (kind) => { void pickAiAttachments(this, kind); } }));
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
    if (!this.plugin._unloading) await this.plugin._rememberCompanion(false);
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
