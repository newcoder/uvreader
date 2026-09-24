// AiExplainModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { svgIcon } from "./reader-icons.js";
import { verifiedQuotes } from "./reading-workflow.js";

export function createAiExplainModal({
  Component, Menu, Modal, Notice, aiExplain, aiLogFollowsTail, aiTurnsHaveAttachments, bindAiAttachmentIntake, bindAiSlashPrompts, bindReaderAiComposer, bookNoteLinkFor, copyToClipboard, createAiChatLog, createAiStreamingMarkdownRenderer, createNoteFromAiAnswer, jumpToAiQuote, newAiSessionKey, normalizeAiTurnContext, noteAiImageFailure, openAiAttachMenu, pickAiAttachments, prepareAiTurns, qiaomuReaderTranslate, readerHud, removeAiAttachment, renderAiAttachmentList, renderAiComposerPrompts, renderAiContextQuote, renderAiUserTurn, renderMobileAiHeader, stripAiAttachmentData,
}) {
  return class AiExplainModal extends Modal {
  constructor(app, plugin, context) {
    super(app);
    this.plugin = plugin;
    // Modal does not inherit Component; own Markdown children explicitly.
    this._markdownComponent = new Component();
    this.pendingContext = normalizeAiTurnContext(context);
    this.structuredContext = true;
    this.text = this.pendingContext?.text || "";
    this.bookFile = context?.bookFile || null;
    this.readerView = context?.readerView || null;
    this.book = this.bookFile ? bookNoteLinkFor(plugin, this.bookFile) || this.bookFile.basename : "";
    this.turns = [];
    this.attachments = [];
    this.aiSessionKey = newAiSessionKey();
  }
  async onOpen() {
    this._markdownComponent.load();
    const c = this.contentEl;
    c.empty();
    this.modalEl.addClass("qiaomu-reader-ai-modal");
    renderMobileAiHeader(c, this);
    this.log = createAiChatLog(c, this);
    this._buildEmpty();
    renderAiComposerPrompts(c, this);
    const bar = c.createDiv("qiaomu-reader-ai-composer qiaomu-reader-ai-composer-mobile");
    const rendered = renderAiContextQuote(bar, this.pendingContext, {
      className: "qiaomu-reader-ai-context-attached",
      clearable: true,
      onClear: () => {
        this.pendingContext = null;
        this.text = "";
        const row = bar.createDiv({ cls: "qiaomu-reader-ai-context-detached", text: qiaomuReaderTranslate("no-source-attached-this-turn"), attr: { title: qiaomuReaderTranslate("earlier-sources-remain-in-conversation-history-start-a-new-conve") } });
        bar.prepend(row);
      },
    });
    this.pendingContextEl = rendered?.card || null;
    this.contextClearEl = rendered?.clear || null;
    this.attachHost = bar.createDiv("qiaomu-reader-ai-attach-slot");
    const slashMenu = bar.createDiv("qiaomu-reader-ai-slash-menu");
    slashMenu.hidden = true;
    const footer = bar.createDiv("qiaomu-reader-ai-composer-foot");
    const input = footer.createEl("input", { cls: "qiaomu-reader-ai-input", type: "text" });
    input.placeholder = qiaomuReaderTranslate("message");
    input.setAttribute("aria-label", qiaomuReaderTranslate("message"));
    const attach = footer.createEl("button", { cls: "qiaomu-reader-ai-attach", attr: { type: "button", "aria-expanded": "false" } });
    svgIcon(attach, "paperclip");
    attach.setAttribute("aria-label", qiaomuReaderTranslate("attach-image-or-file"));
    attach.addEventListener("click", () => openAiAttachMenu(attach, this, { pick: (kind) => { void pickAiAttachments(this, kind); } }));
    this.attachButton = attach;
    const send = footer.createEl("button", { cls: "qiaomu-reader-ai-send" });
    this.inputEl = input;
    this.sendEl = send;
    bindAiAttachmentIntake(this, c, input);
    this._renderAttachments();
    this.canCancel = true;
    bindAiSlashPrompts(slashMenu, input, this);
    this.inputController = bindReaderAiComposer(this, input, send, footer, true);
    readerHud.autoFocus(input);
    readerHud.blurOnTapOutside(c, input);
    this._watchKeyboard();
  }
  _setSending(busy) {
    if (!busy && this._deferredContext) {
      const deferred = this._deferredContext;
      this._deferredContext = null;
      queueMicrotask(() => this.setContext?.(deferred.value, deferred.options));
    }
    if (!this.sendEl) return;
    const stopping = !!busy && this.canCancel;
    this.sendEl.empty();
    svgIcon(this.sendEl, stopping ? "square" : "send");
    this.sendEl.setAttribute("aria-label", stopping ? qiaomuReaderTranslate("stop-generating") : qiaomuReaderTranslate("send"));
    this.sendEl.toggleClass("is-stop", stopping);
    const empty = !this.inputEl?.value.trim() && !(this.attachments || []).length;
    this.sendEl.disabled = busy ? !this.canCancel : empty;
    this.sendEl.toggleClass("is-empty", !busy && empty);
    if (this.contextClearEl) this.contextClearEl.disabled = !!busy;
    for (const button of this.quickPromptButtons || []) button.disabled = !!busy;
    for (const button of this.sessionButtons || []) button.disabled = !!busy;
    if (busy) this.slashPromptController?.close();
  }
  _watchKeyboard() { // mobile keyboards: keep the composer above the inset
    const panel = this.modalEl;
    this._kbShow = (event) => {
      const inset = this._keyboardHeight(event);
      if (inset) this._showKeyboardInset(panel, inset);
    };
    this._kbHide = () => this._hideKeyboardInset(panel);
    for (const type of ["keyboardWillShow", "keyboardDidShow"]) window.addEventListener(type, this._kbShow);
    window.addEventListener("keyboardWillHide", this._kbHide);
  }
  _keyboardHeight(event) {
    const raw = event && (event.keyboardHeight != null ? event.keyboardHeight : event.detail && event.detail.keyboardHeight);
    return typeof raw === "number" && raw > 0 ? raw : 0;
  }
  _showKeyboardInset(modal, h) {
    modal.style.setProperty("--qiaomu-reader-kb", h + "px");
    modal.addClass("qiaomu-reader-kb-up"); window.setTimeout(() => this._scroll(), 60);
  }
  _hideKeyboardInset(modal) {
    modal.removeClass("qiaomu-reader-kb-up");
    modal.style.removeProperty("--qiaomu-reader-kb");
  }
  _renderAttachments() {
    if (this.attachHost) {
      this.attachHost.replaceChildren();
      renderAiAttachmentList(this.attachHost, this.attachments, { onRemove: (id) => { void removeAiAttachment(this, id); } });
    }
    if (this.sendEl) this._setSending(!!this.busy);
  }
  // The turn went out: keep attachment metadata in the conversation (the bytes
  // are already on disk) and clear the composer strip.
  _finishAttachments(userTurn) {
    if (userTurn?.attachments?.length) userTurn.attachments = stripAiAttachmentData(userTurn.attachments);
    if ((this.attachments || []).length) {
      this.attachments = [];
      this._renderAttachments();
    }
  }
  // Start with the recurring jobs readers actually have. These are prompts,
  // not modes: after any one of them the conversation remains fully open.
  _buildEmpty() {
    const empty = this.log.createDiv("qiaomu-reader-ai-empty");
    svgIcon(empty.createDiv("qiaomu-reader-ai-empty-icon"), "wand-sparkles");
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-title", text: qiaomuReaderTranslate("what-would-you-like-to-ask") });
    empty.createDiv({ cls: "qiaomu-reader-ai-empty-sub", text: qiaomuReaderTranslate("choose-a-quick-prompt-or-write-your-own") });
    this.empty = empty;
  }
  _scroll() { this._readingEarlier = false; this.log.scrollTop = this.log.scrollHeight; }
  _consumePendingContext(attachedContext) {
    if (this.contextMode === "selection" || this.contextMode === "follow") return;
    const current = normalizeAiTurnContext(this.pendingContext);
    if (attachedContext && current?.kind === attachedContext.kind && current?.text === attachedContext.text) {
      this.pendingContext = null;
      if (this.pendingContextEl?.isConnected) this.pendingContextEl.remove();
    }
  }
  _actions(group, answer, source = {}) {
    const targetUser = source.turn || this.turns[this.turns.length - 2];
    const answerTurn = source.answerTurn || this.turns[this.turns.indexOf(targetUser) + 1];
    const bookFile = this.bookFile;
    const row = group.createDiv("qiaomu-reader-ai-acts");
    const act = (icon2, label, fn) => {
      const b = row.createEl("button", { cls: "qiaomu-reader-ai-act" });
      svgIcon(b, icon2);
      b.createSpan({ text: label });
      b.addEventListener("click", fn);
      return b;
    };
    act("copy", qiaomuReaderTranslate("copy"), async () => {
      const ok = await copyToClipboard(answer);
      new Notice(ok ? qiaomuReaderTranslate("copied") : qiaomuReaderTranslate("could-not-copy"));
    });
    let savedNote = answerTurn?.savedNotePath ? this.app.vault.getAbstractFileByPath(answerTurn.savedNotePath) : null;
    const saveAnswer = async (toBookNote = false) => {
      if (savedNote && this.app.vault?.getAbstractFileByPath(savedNote.path)) {
        await this.app.workspace.openLinkText(savedNote.path, bookFile?.path || "", "tab");
        return;
      }
      if (save.disabled) return;
      save.disabled = true;
      try {
      const note = await createNoteFromAiAnswer(this.app, this.plugin, answer, source.question, source.context, bookFile, {
        open: false,
        toBookNote,
      });
      if (note) {
        savedNote = note;
        save.querySelector("span")?.setText(qiaomuReaderTranslate("saved-open-note"));
        if (answerTurn?.role === "assistant") {
          answerTurn.savedNotePath = note.path;
          if (this.turns.includes(answerTurn)) await this._persistSession?.();
        }
      }
      } finally { save.disabled = false; }
    };
    const save = act("note", qiaomuReaderTranslate("save-ai-response"), () => { void saveAnswer(); });
    if (bookFile && this.plugin.settings.askNoteTitle === false) {
      const options = act("more-horizontal", qiaomuReaderTranslate("save-options"), (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle(qiaomuReaderTranslate("append-to-book-note")).onClick(() => saveAnswer(true)));
        menu.showAtMouseEvent(event);
      });
      options.setAttribute("aria-label", qiaomuReaderTranslate("save-options"));
    }
    if (savedNote) save.querySelector("span")?.setText(qiaomuReaderTranslate("saved-open-note"));
    const targetIndex = this.turns.indexOf(targetUser);
    const sources = targetIndex >= 0 ? this.turns.slice(0, targetIndex + 1).map((turn) => turn.context?.text) : [source.context?.text];
    const quotes = verifiedQuotes(answer, sources);
    if (bookFile && quotes.length) {
      const links = group.createDiv("qiaomu-reader-ai-citations");
      for (const quote of quotes) {
        const link = links.createEl("button", { cls: "qiaomu-reader-ai-act", text: `${qiaomuReaderTranslate("view-source")} · ${quote.slice(0, 24)}${quote.length > 24 ? "…" : ""}` });
        link.setAttribute("title", quote);
        link.addEventListener("click", () => { void jumpToAiQuote(this.plugin, bookFile, quote); });
      }
    }
    if (source.regenerate === false) return;
    const regenerate = act("rotate-ccw", qiaomuReaderTranslate("regenerate"), () => {
      if (this.busy) return;
      const assistant = this.turns[this.turns.length - 1];
      const user = this.turns[this.turns.length - 2];
      if (assistant?.role !== "assistant" || user?.role !== "user" || user !== targetUser) return;
      this.turns.splice(-2, 2);
      const userBubble = group.previousElementSibling;
      group.remove();
      if (userBubble?.classList?.contains("qiaomu-reader-ai-msg-me")) userBubble.remove();
      this.aiSessionKey = newAiSessionKey();
      this.pendingContext = normalizeAiTurnContext(user.context);
      this._regeneratingContext = true;
      if (this.pendingContext) this.text = this.pendingContext.text;
      void this._send(user.content);
    });
    regenerate.addClass("qiaomu-reader-ai-regenerate");
  }
  async _send(text) {
    if (this.busy || this._historySaving || (!text && !(this.attachments || []).length)) return false;
    if (!this._regeneratingContext) this._prepareContext?.();
    this._regeneratingContext = false;
    this.busy = true;
    this.abortController = new AbortController();
    this._setSending(true);
    for (const button of this.log.querySelectorAll(".qiaomu-reader-ai-regenerate")) button.remove();
    if (this.empty) { this.empty.remove(); this.empty = null; }
    const attachedContext = normalizeAiTurnContext(this.pendingContext);
    const attachedAttachments = this.attachments || [];
    const userTurn = {
      role: "user",
      content: text,
      ...(attachedContext ? { context: attachedContext } : {}),
      ...(attachedAttachments.length ? { attachments: attachedAttachments } : {}),
    };
    const userBubble = renderAiUserTurn(this.log, userTurn);
    this.turns.push(userTurn);
    const group = this.log.createDiv("qiaomu-reader-ai-group");
    const reasoningBox = group.createEl("details", { cls: "qiaomu-reader-ai-reason" });
    reasoningBox.addClass("qiaomu-reader-ai-reason-hidden");
    const reasoningSummary = reasoningBox.createEl("summary", { text: qiaomuReaderTranslate("thinking") });
    const reasoningText = reasoningBox.createDiv("qiaomu-reader-ai-reason-text");
    const bubble = group.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-ai");
    bubble.setAttribute("aria-busy", "true");
    const markdownRenderer = createAiStreamingMarkdownRenderer(
      this,
      bubble,
      this.bookFile ? this.bookFile.path : "",
      {
        beforeRender: () => aiLogFollowsTail(this.log),
        afterRender: (followTail) => { if (followTail && !this._readingEarlier) this._scroll(); },
      },
    );
    this.activeMarkdownRenderer = markdownRenderer;
    // indicator used by chat interfaces. A still line of text reads as a frozen window.
    const ind = bubble.createDiv("qiaomu-reader-ai-typing");
    const dots = ind.createDiv("qiaomu-reader-ai-typing-dots");
    for (let i = 0; i < 3; i++) dots.createDiv("qiaomu-reader-ai-typing-dot");
    ind.createDiv({ cls: "qiaomu-reader-ai-typing-text", text: qiaomuReaderTranslate("thinking-2") });
    this._scroll();
    let answer = "";
    let reasoning = "";
    let hasContent = false;
    const onDelta = (delta) => {
      if (delta.reasoning) {
        reasoning = delta.reasoningText || reasoning + delta.reasoning;
        reasoningBox.removeClass("qiaomu-reader-ai-reason-hidden");
        reasoningBox.open = !hasContent;
        reasoningText.setText(reasoning);
      }
      if (delta.content) {
        answer = delta.answer || answer + delta.content;
        if (!hasContent) {
          hasContent = true;
          ind.remove();
          bubble.addClass("qiaomu-reader-ai-msg-streaming");
          if (reasoning) {
            reasoningBox.open = false;
            reasoningSummary.setText(qiaomuReaderTranslate("reasoning"));
          }
        }
        markdownRenderer.update(answer);
      }
    };
    try {
      // Hydration plus the image-support gate; a blocked turn throws with a
      // reason the failure branch below already understands. A text-only send
      // stays on the original turns so nothing about it becomes asynchronous.
      const outbound = aiTurnsHaveAttachments(this.turns)
        ? await prepareAiTurns(this, this.turns)
        : { turns: this.turns, vision: false };
      answer = await aiExplain(this.structuredContext ? "" : this.text, this.plugin, outbound.turns, this.book, {
        signal: this.abortController.signal,
        onDelta,
        sessionKey: this.aiSessionKey,
        vision: outbound.vision,
      });
    } catch (e) {
      const followTail = aiLogFollowsTail(this.log);
      const why = e && e.qiaomuReaderReason;
      if (why !== "cancelled") console.error("UV Reader: AI chat failed", e);
      // A partial answer is still useful reading material. Keep its Markdown,
      // source and actions, but rebuild ACP next time after an interrupted turn.
      this.aiSessionKey = newAiSessionKey();
      if (answer.trim()) {
        await markdownRenderer.finish(answer);
        this.turns.push({ role: "assistant", content: answer, interrupted: true });
        this._finishAttachments(userTurn);
        this._consumePendingContext(attachedContext);
        bubble.removeClass("qiaomu-reader-ai-msg-streaming");
        bubble.removeAttribute("aria-busy");
        ind.remove();
        if (reasoning) reasoningBox.open = false;
        else reasoningBox.remove();
        group.createDiv({ cls: "qiaomu-reader-ai-interrupted", text: qiaomuReaderTranslate("reply-interrupted-generated-content-has-been-kept") });
        this._actions(group, answer, { question: text, context: attachedContext, turn: userTurn });
        if (this.activeMarkdownRenderer === markdownRenderer) this.activeMarkdownRenderer = null;
        this.busy = false;
        this.abortController = null;
        this._setSending(false);
        if (followTail && !this._readingEarlier) this._scroll();
        if (typeof this._persistSession === "function") void this._persistSession();
        return true;
      }
      markdownRenderer.dispose();
      if (this.activeMarkdownRenderer === markdownRenderer) this.activeMarkdownRenderer = null;
      bubble.removeAttribute("aria-busy");
      if (reasoning) {
        reasoningBox.open = false;
        reasoningSummary.setText(qiaomuReaderTranslate("reasoning"));
      } else {
        reasoningBox.remove();
      }
      this.turns.pop();
      if (attachedAttachments.length) {
        // The composer still holds the attachments for a retry.
        this._renderAttachments();
        if (why === "novision") noteAiImageFailure?.(this);
      }
      if (why !== "cancelled") bubble.addClass("qiaomu-reader-ai-msg-err");
      bubble.setText(
        why === "cancelled" ? qiaomuReaderTranslate("generation-stopped")
          : why === "notconfigured" ? qiaomuReaderTranslate("choose-an-ai-service-and-model-in-plugin-settings-first")
          : why === "nokey" ? qiaomuReaderTranslate("select-or-create-an-api-key-in-plugin-settings-first")
          : why === "desktop" ? qiaomuReaderTranslate("use-local-cli-providers-from-obsidian-desktop")
          : why === "climissing" ? qiaomuReaderTranslate("cli-not-found-install-it-or-set-its-path-first")
          : why === "cliauth" ? qiaomuReaderTranslate("the-cli-is-not-signed-in-complete-its-login-flow-in-terminal-fir")
          : why === "model" ? qiaomuReaderTranslate("the-model-name-is-unavailable-leave-it-empty-to-use-the-cli-defa")
          : why === "timeout" ? qiaomuReaderTranslate("the-ai-request-timed-out-try-again-later")
          : why === "novision" ? qiaomuReaderTranslate("the-model-does-not-support-images-remove-them-or-switch-models")
          : why === "inputtoolong" ? qiaomuReaderTranslate("the-pdf-or-selection-is-too-long-use-a-smaller-selection-or-remo")
          : why === "outputtoolong" ? qiaomuReaderTranslate("the-ai-response-was-too-long-and-has-been-stopped")
          : why === "acpsession" ? qiaomuReaderTranslate("the-acp-session-expired-and-automatic-reconnection-failed-try-ag")
          : why === "acpstopped" ? qiaomuReaderTranslate("the-acp-process-exited-and-automatic-restart-failed-try-again-or")
          : why === "cli" ? qiaomuReaderTranslate("the-cli-call-failed-this-is-not-necessarily-a-login-problem-veri")
          : why === "auth" ? qiaomuReaderTranslate("the-api-key-was-rejected")
            : why === "forbidden" ? qiaomuReaderTranslate("the-service-refused-the-request-403-this-may-be-a-content-restri")
            : why === "limit" ? qiaomuReaderTranslate("the-service-is-rate-limiting-wait-a-minute-and-try-again")
              : why === "local" ? qiaomuReaderTranslate("the-local-model-is-not-answering-check-that-ollama-or-lm-studio")
                : why === "empty" ? qiaomuReaderTranslate("the-model-returned-nothing")
                  : why === "emptyanswer" ? qiaomuReaderTranslate("the-model-returned-reasoning-but-no-final-answer-try-again")
                  : why === "http" ? qiaomuReaderTranslate("the-service-answered-with-error-0", e.qiaomuReaderStatus)
                    : qiaomuReaderTranslate("could-not-reach-the-service-it-looks-like-there-is-no-internet-c"));
      if (why !== "cancelled") {
        const retryRow = group.createDiv("qiaomu-reader-ai-acts qiaomu-reader-ai-error-actions");
        const retry = retryRow.createEl("button", { cls: "qiaomu-reader-ai-act" });
        svgIcon(retry, "rotate-ccw");
        retry.createSpan({ text: qiaomuReaderTranslate("try-again") });
        retry.addEventListener("click", () => {
          if (this.busy) return;
          retry.disabled = true;
          userBubble.remove();
          group.remove();
          this.pendingContext = normalizeAiTurnContext(attachedContext);
          if (this.pendingContext) this.text = this.pendingContext.text;
          this._regeneratingContext = true;
          void this._send(text);
        });
      }
      if (followTail && !this._readingEarlier) this._scroll();
      this.busy = false;
      this.abortController = null;
      this._setSending(false);
      return false;
    }
    this.turns.push({ role: "assistant", content: answer });
    this._finishAttachments(userTurn);
    this._consumePendingContext(attachedContext);
    this.answer = answer;
    if (!reasoning) reasoningBox.remove();
    else {
      reasoningBox.open = false;
      reasoningSummary.setText(qiaomuReaderTranslate("reasoning"));
    }
    bubble.removeClass("qiaomu-reader-ai-msg-streaming");
    bubble.removeAttribute("aria-busy");
    // Keep the exact same Markdown renderer for the last stream frame. This
    // prevents a plain-text -> formatted-content jump when generation ends.
    const followTail = aiLogFollowsTail(this.log);
    await markdownRenderer.finish(answer);
    if (this.activeMarkdownRenderer === markdownRenderer) this.activeMarkdownRenderer = null;
    this._actions(group, answer, { question: text, context: attachedContext });
    if (followTail && !this._readingEarlier) this._scroll();
    this.busy = false;
    this.abortController = null;
    this._setSending(false);
    if (typeof this._persistSession === "function") void this._persistSession();
    return true;
  }
  onClose() {
    if (this.abortController) this.abortController.abort();
    void this.plugin.aiDraftStore?.flush();
    this.activeMarkdownRenderer?.dispose();
    this.activeMarkdownRenderer = null;
    this._markdownComponent.unload();
    if (this._kbShow) {
      window.removeEventListener("keyboardWillShow", this._kbShow);
      window.removeEventListener("keyboardDidShow", this._kbShow);
    }
    if (this._kbHide) window.removeEventListener("keyboardWillHide", this._kbHide);
    this.contentEl.empty();
  }
};
}
