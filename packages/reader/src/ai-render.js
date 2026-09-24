// AI chat rendering shared by the desktop sidebar and the mobile modal:
// markdown rendering, the chat log, context cards, composer prompts, the
// slash menu, the mobile header, user turns and reader-context sync.
//
// Host classes (Modal, Menu, MarkdownRenderer, Component) and late-bound
// factories (AiChatView, ConfirmModal, ReadSettingsModal) are injected.

import { isNonChineseSource } from "./ai-source-language.js";
import { svgIcon } from "./reader-icons.js";
import { bytesLabel, normalizeAiAttachments } from "./ai-attachments.js";
import { bindAiComposer } from "./ai-composer.js";
import { DRAFT_LIMIT } from "./ai-drafts.js";
import { createAiStreamingMarkdownRendererFactory } from "./ai-streaming-markdown.js";

export function createAiRender({
  translate,
  Modal,
  Menu,
  MarkdownRenderer,
  Component,
  normalizeAiTurnContext,
  aiQuickPrompts,
  paintAiSource,
  readerHud,
  readerIsPdf,
  AI_CHAT_VIEW_TYPE,
  getAiChatView,
  getConfirmModal,
  openReadSettings,
  openPluginAiSettings,
}) {
  function readerPageContext(view) {
    if (view?.engine && view.file) {
      let text = String(view.engine.visibleText() || "").trim();
      if (!text) return null;
      if (text.length > 6_000) text = `${text.slice(0, 6_000).trimEnd()}…`;
      return {
        kind: "page", label: translate("current-page"),
        page: view.engine.currentLocation()?.tocItem?.label || "",
        text, bookFile: view.file, readerView: view,
      };
    }
    const pager = view?.pager;
    const clip = pager?.clip;
    if (!pager?.flow || !clip || !view?.file) return null;
    // Never borrow text from a neighbouring page when the visible PDF page is a
    // scan. A mixed PDF can have selectable text later in the document, but that
    // does not make the current image-only page a trustworthy AI source.
    const pdfPage = pager.currentPdfPageElement?.();
    if (pdfPage && pdfPage.getAttribute("data-pdf-page-kind") !== "text") return null;
    let blocks = [];
    try {
      const viewport = clip.getBoundingClientRect();
      const overlaps = (rect) => rect.width > 0 && rect.height > 0
        && rect.right > viewport.left + 1 && rect.left < viewport.right - 1
        && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
      blocks = [...pager._blocks()].filter((el) => {
        const rects = typeof el.getClientRects === "function" ? [...el.getClientRects()] : [el.getBoundingClientRect()];
        return rects.some(overlaps);
      });
    } catch { blocks = []; }
    if (!blocks.length) {
      const index = pager.currentBlockIndex();
      blocks = [pager.blockEl(index), pager.blockEl(index + 1)].filter(Boolean);
    }
    const seen = new Set();
    const parts = [];
    for (const block of blocks) {
      const value = String(block?.textContent || "").replace(/[ \t]+/g, " ").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      parts.push(value);
    }
    let text = parts.join("\n\n").trim();
    if (text.length > 6_000) text = `${text.slice(0, 6_000).trimEnd()}…`;
    if (!text) return null;
    const sourcePage = view.file.extension === "pdf" ? pager.currentPdfPageNumber?.() : null;
    return {
      kind: "page",
      label: translate("current-page"),
      page: Number.isFinite(sourcePage)
        ? translate("page-0", sourcePage)
        : translate("page-0-of-1", (pager.spread || 0) + 1, Math.max(1, pager.total || 1)),
      text,
      bookFile: view.file,
      readerView: view,
    };
  }

  function readerDefaultAiContext(view) {
    if (readerIsPdf(view)) {
      const documentContext = view?.pdfDocumentContext;
      const text = String(documentContext?.text || "").trim();
      if (!text) return null;
      const pageCount = Math.max(0, Number(documentContext.pageCount) || 0);
      return {
        kind: "document",
        label: documentContext.truncated ? translate("full-pdf-condensed") : translate("full-pdf"),
        page: pageCount ? translate("0-pages", pageCount) : "",
        text,
        bookFile: view.file,
        readerView: view,
      };
    }
    return readerPageContext(view);
  }

  function readerAiPanelContext(view) {
    const context = readerDefaultAiContext(view);
    if (context) return context;
    if (!view?.file || !view?.bookHtml) return null;
    // A text-capable EPUB can legitimately open on an image-only cover.
    // That is not the same state as a scanned PDF: keep the book thread and
    // composer available, then attach page text when the reader reaches it.
    if (!readerIsPdf(view)) {
      return {
        bookFile: view.file,
        readerView: view,
      };
    }
    return {
      unavailable: true,
      bookFile: view.file,
      readerView: view,
    };
  }

  function readerSupportsAiContext(view) {
    if (!view?.file || !view?.bookHtml) return false;
    if (view.file.extension !== "pdf") return true;
    return !!String(view.pdfDocumentContext?.text || "").trim();
  }

  function syncReaderAiCapability(view) {
    if (!view?.aiBtn) return;
    const supported = readerSupportsAiContext(view);
    view.aiBtn.hidden = !supported;
    view.aiBtn.disabled = !supported;
    view.aiBtn.setAttribute("aria-label", translate("ai-reading"));
  }

  function renderAiHeadMeta(host, chat) {
    if (!chat.book) return;
    const meta = host.createDiv("qiaomu-reader-ai-head-meta");
    meta.createDiv({ cls: "qiaomu-reader-ai-book", text: chat.bookFile?.basename || chat.book });
  }

  const AI_MARKDOWN_RENDER_INTERVAL_MS = 50;

  function enhanceAiMarkdown(root) {
    for (const table of root.querySelectorAll("table")) {
      const parent = table.parentElement;
      if (parent?.classList.contains("table-wrapper")) {
        parent.addClass("qiaomu-reader-ai-table-scroll");
        continue;
      }
      if (parent?.classList.contains("qiaomu-reader-ai-table-scroll")) continue;
      const wrapper = root.ownerDocument.createElement("div");
      wrapper.className = "qiaomu-reader-ai-table-scroll";
      table.before(wrapper);
      wrapper.appendChild(table);
    }
    for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = true;
      checkbox.setAttribute("aria-disabled", "true");
    }
    for (const image of root.querySelectorAll("img")) {
      image.loading = "lazy";
      image.decoding = "async";
    }
  }

  async function renderAiMarkdown(owner, element, markdown, sourcePath = "") {
    element.addClass("qiaomu-reader-ai-markdown");
    element.removeClass("qiaomu-reader-ai-markdown-fallback");
    element.empty();
    try {
      await MarkdownRenderer.render(owner.app, String(markdown || ""), element, sourcePath, owner);
      enhanceAiMarkdown(element);
    } catch (error) {
      console.error("UV Reader: Markdown rendering failed", error);
      element.addClass("qiaomu-reader-ai-markdown-fallback");
      element.setText(String(markdown || ""));
    }
  }

  function aiLogFollowsTail(log) {
    if (!log) return false;
    return log.scrollHeight - log.scrollTop - log.clientHeight < 96;
  }

  function createAiChatLog(host, chat) {
    const wrap = host.createDiv("qiaomu-reader-ai-log-wrap");
    const log = wrap.createDiv("qiaomu-reader-ai-log");
    const jump = wrap.createEl("button", { cls: "qiaomu-reader-ai-jump-latest", text: translate("back-to-latest-reply") });
    jump.hidden = true;
    chat._readingEarlier = false;
    log.tabIndex = 0;
    log.setAttribute("aria-label", translate("chat-history"));
    const pause = () => { chat._readingEarlier = true; };
    log.addEventListener("wheel", (event) => { if (event.deltaY < 0) pause(); }, { passive: true });
    log.addEventListener("touchstart", pause, { passive: true });
    log.addEventListener("keydown", (event) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
    });
    log.addEventListener("scroll", () => {
      const atEnd = aiLogFollowsTail(log);
      if (atEnd) chat._readingEarlier = false;
      jump.hidden = atEnd;
    }, { passive: true });
    jump.addEventListener("click", () => { chat._scroll(); jump.hidden = true; log.focus(); });
    return log;
  }

  const createAiStreamingMarkdownRenderer = createAiStreamingMarkdownRendererFactory({
    Component,
    MarkdownRenderer,
    AI_MARKDOWN_RENDER_INTERVAL_MS,
    enhanceAiMarkdown,
  });

  function renderAiContextQuote(host, value, options = {}) {
    const context = normalizeAiTurnContext(value);
    if (!context) return null;
    const isDocument = context.kind === "document";
    const expandable = !isDocument && (context.text.length > 120 || context.text.includes("\n"));
    const previewText = isDocument && context.text.length > 180
      ? `${context.text.slice(0, 180).trimEnd()}…`
      : context.text;
    const cls = ["qiaomu-reader-ai-context", options.className || "", expandable ? "is-expandable" : "is-short"]
      .filter(Boolean).join(" ");
    const card = host.createEl(expandable ? "details" : "div", { cls });
    const summary = expandable ? card.createEl("summary") : card.createDiv("qiaomu-reader-ai-context-summary");
    const preview = summary.createDiv("qiaomu-reader-ai-context-preview-row");
    svgIcon(preview.createSpan("qiaomu-reader-ai-context-icon"), "text-quote");
    preview.createDiv({ cls: "qiaomu-reader-ai-context-preview", text: previewText });
    const meta = summary.createDiv("qiaomu-reader-ai-context-meta");
    const label = context.label || (isDocument ? translate("full-pdf") : context.kind === "page" ? translate("current-page") : translate("selection"));
    meta.createSpan({ text: [label, context.page, translate("0-characters", context.text.length)].filter(Boolean).join(" · ") });
    if (expandable) {
      const toggle = meta.createSpan("qiaomu-reader-ai-context-toggle");
      svgIcon(toggle, "chevron-down");
      card.createDiv({ cls: "qiaomu-reader-ai-context-text", text: context.text });
    }
    if (options.clearable) {
      const clear = card.createEl("button", { cls: "qiaomu-reader-ai-context-clear" });
      svgIcon(clear, "x");
      clear.setAttribute("aria-label", translate("remove-context-for-this-message"));
      clear.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onClear?.();
        card.remove();
      });
      return { card, clear };
    }
    return { card, clear: null };
  }

  function bindReaderAiComposer(chat, input, send, footer, blurOnSend = false) {
    const path = chat.bookFile?.path;
    const store = chat.plugin.aiDraftStore;
    input.maxLength = DRAFT_LIMIT;
    input.value = store?.texts.get(path) || "";
    const clear = footer.createEl("button", { cls: "qiaomu-reader-ai-act qiaomu-reader-ai-draft-clear", text: translate("clear-draft") });
    footer.prepend(clear);
    clear.hidden = !input.value;
    let lastSaved = input.value;
    const onDraftChange = (value, { settled = false } = {}) => {
      // An old, closed composer must not overwrite a draft from a reopened one.
      if (settled && store && (store.texts.get(path) || "") !== lastSaved) return;
      store?.set(path, value); lastSaved = value; clear.hidden = !value;
    };
    const controller = bindAiComposer(input, send, chat, { blurOnSend, onDraftChange });
    chat.draftChanged = onDraftChange;
    clear.addEventListener("click", () => {
      const ConfirmModal = getConfirmModal();
      new ConfirmModal(chat.app, {
        title: translate("clear-draft"), body: translate("only-clear-this-book-s-unsent-text-keep-conversations-and-select"),
        okText: translate("clear"), cancelText: translate("cancel"),
        onYes: () => { input.value = ""; input.dispatchEvent(new Event("input")); controller.refresh(); input.focus(); },
      }).open();
    });
    return controller;
  }

  const ReaderNameModal = class extends Modal {
    constructor(app, title, value, submit) { super(app); this.title = title; this.value = value; this.submit = submit; }
    onOpen() {
      const c = this.contentEl;
      c.createEl("h3", { text: this.title });
      const input = c.createEl("input", { cls: "qiaomu-reader-panel-input", attr: { type: "text", "aria-label": this.title, maxlength: "80" } });
      input.value = this.value || "";
      const error = c.createDiv({ cls: "qiaomu-reader-title-error", attr: { role: "alert" } });
      const save = c.createEl("button", { text: translate("save") });
      const submit = async () => {
        const title = input.value.trim();
        if (!title || save.disabled) return;
        save.disabled = true;
        try { await this.submit(title.slice(0, 80)); this.close(); }
        catch { error.setText(translate("saving-failed-check-vault-permissions-and-retry")); save.disabled = false; }
      };
      save.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void submit(); } });
      readerHud.autoFocus(input);
    }
    onClose() { this.contentEl.empty(); }
  };

  function contextualAiQuickPrompts(chat) {
    const items = aiQuickPrompts();
    const text = chat.contextMode === "none" ? "" : chat.pendingContext?.text || chat.text || "";
    if (!isNonChineseSource(text)) return items;
    const translation = {
      id: "translate-zh",
      name: translate("translate-source-to-chinese"),
      prompt: translate("translate-source-to-chinese-prompt"),
    };
    return [...items.slice(0, 3), translation, ...items.slice(3)];
  }

  function renderAiComposerPrompts(host, chat) {
    const items = contextualAiQuickPrompts(chat);
    chat.quickPromptButtons = [];
    const previous = chat.quickPromptRow;
    if (!items.length) { previous?.remove(); chat.quickPromptRow = null; return null; }
    const row = host.createDiv("qiaomu-reader-ai-composer-prompts");
    if (previous?.parentElement === host) previous.replaceWith(row);
    chat.quickPromptRow = row;
    const visibleCount = items.some((item) => item.id === "translate-zh") ? 4 : 3;
    row.setAttribute("aria-label", translate("quick-prompts-2"));
    const addPrompt = (item) => {
      const button = row.createEl("button", { cls: "qiaomu-reader-ai-composer-prompt", text: item.name });
      button.type = "button";
      button.addEventListener("click", () => {
        if (!chat.busy) void chat._send(item.prompt);
      });
      chat.quickPromptButtons.push(button);
    };
    items.slice(0, visibleCount).forEach(addPrompt);
    if (items.length > visibleCount) {
      const more = row.createEl("button", {
        cls: "qiaomu-reader-ai-composer-prompt qiaomu-reader-ai-composer-prompt-more",
        text: `${translate("more-prompts")} · ${items.length - visibleCount}`,
      });
      more.type = "button";
      more.addEventListener("click", (event) => {
        if (chat.busy) return;
        const menu = new Menu();
        for (const item of items.slice(visibleCount)) {
          menu.addItem((entry) => entry.setTitle(item.name).onClick(() => { if (!chat.busy) void chat._send(item.prompt); }));
        }
        menu.showAtMouseEvent(event);
      });
      chat.quickPromptButtons.push(more);
    }
    for (const button of chat.quickPromptButtons) button.disabled = !!chat.busy;
    return row;
  }

  function bindAiSlashPrompts(menu, input, chat) {
    let matches = [];
    let activeIndex = 0;
    const close = () => {
      menu.hidden = true;
      menu.empty();
      matches = [];
      activeIndex = 0;
    };
    const choose = (item) => {
      if (!item || chat.busy) return;
      close();
      void chat.inputController.submit(item.prompt);
    };
    const draw = () => {
      const raw = input.value.trimStart();
      if (!raw.startsWith("/") || chat.busy) {
        close();
        return;
      }
      const query = raw.slice(1).trim().toLocaleLowerCase();
      matches = contextualAiQuickPrompts(chat).filter((item) => item.name.toLocaleLowerCase().includes(query)).slice(0, 8);
      if (!matches.length) {
        close();
        return;
      }
      activeIndex = Math.min(activeIndex, matches.length - 1);
      menu.empty();
      menu.hidden = false;
      matches.forEach((item, index) => {
        const button = menu.createEl("button", { cls: "qiaomu-reader-ai-slash-item" });
        button.type = "button";
        button.toggleClass("is-active", index === activeIndex);
        button.createDiv({ cls: "qiaomu-reader-ai-slash-name", text: `/${item.name}` });
        button.createDiv({ cls: "qiaomu-reader-ai-slash-prompt", text: item.prompt });
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => choose(item));
      });
    };
    const move = (step) => {
      if (menu.hidden || !matches.length) return false;
      activeIndex = (activeIndex + step + matches.length) % matches.length;
      draw();
      menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
      return true;
    };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (event) => {
      if (menu.hidden || chat.inputController?.isComposing(event)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" && matches.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(matches[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    });
    chat.slashPromptController = { close };
    return chat.slashPromptController;
  }

  function renderMobileAiHeader(contentEl, chat) {
    const head = contentEl.createDiv("qiaomu-reader-ai-head");
    const headText = head.createDiv("qiaomu-reader-ai-headtext");
    headText.createDiv({ cls: "qiaomu-reader-ai-title", text: translate("talking-about-the-passage") });
    renderAiHeadMeta(headText, chat);
    const actions = head.createDiv("qiaomu-reader-ai-head-actions");
    const settings = actions.createEl("button", { cls: "qiaomu-reader-ai-prompt-settings" });
    svgIcon(settings, "sliders");
    settings.setAttribute("aria-label", translate("ai-reading-settings"));
    settings.addEventListener("click", () => {
      if (chat.readerView) openReadSettings(chat.app, chat.readerView);
      else openPluginAiSettings(chat.app, chat.plugin);
    });
    const close = actions.createEl("button", { cls: "qiaomu-reader-ai-close" });
    svgIcon(close, "x");
    close.setAttribute("aria-label", translate("close"));
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chat.close();
    });
    return { head, settings, close };
  }

  // Attachment chips: thumbnails for images, a name/size row for text files.
  // Editable in the composer (remove button), read-only inside a sent turn.
  function renderAiAttachmentList(host, attachments, options = {}) {
    const items = normalizeAiAttachments(attachments);
    const row = host.createDiv("qiaomu-reader-ai-attach-row");
    if (!items.length) {
      row.hidden = true;
      return { row, empty: true };
    }
    for (const attachment of items) {
      const chip = row.createDiv(`qiaomu-reader-ai-attach-chip qiaomu-reader-ai-attach-${attachment.kind}`);
      if (attachment.kind === "image") {
        const thumb = attachment.thumb || (attachment.data ? `data:${attachment.mimeType};base64,${attachment.data}` : "");
        if (thumb) chip.createEl("img", { cls: "qiaomu-reader-ai-attach-thumb", attr: { src: thumb, alt: "", loading: "lazy", decoding: "async" } });
        else svgIcon(chip.createSpan("qiaomu-reader-ai-attach-icon"), "image");
      } else {
        svgIcon(chip.createSpan("qiaomu-reader-ai-attach-icon"), "note");
      }
      const meta = chip.createDiv("qiaomu-reader-ai-attach-meta");
      meta.createDiv({ cls: "qiaomu-reader-ai-attach-name", text: attachment.name });
      meta.createDiv({ cls: "qiaomu-reader-ai-attach-size", text: bytesLabel(attachment.bytes) });
      chip.setAttribute("title", `${attachment.name} · ${bytesLabel(attachment.bytes)}`);
      if (options.onRemove) {
        const remove = chip.createEl("button", { cls: "qiaomu-reader-ai-attach-remove" });
        svgIcon(remove, "x");
        remove.setAttribute("aria-label", `${translate("remove-attachment")}: ${attachment.name}`);
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onRemove(attachment.id);
        });
      }
    }
    return { row, empty: false };
  }

  function renderAiUserTurn(log, turn) {
    const bubble = log.createDiv("qiaomu-reader-ai-msg qiaomu-reader-ai-msg-me");
    const context = normalizeAiTurnContext(turn?.context);
    if (context) renderAiContextQuote(bubble, context, { className: "qiaomu-reader-ai-msg-context" });
    if (normalizeAiAttachments(turn?.attachments).length) renderAiAttachmentList(bubble, turn.attachments);
    if (turn?.content) bubble.createDiv({ cls: "qiaomu-reader-ai-msg-text", text: turn.content });
    return bubble;
  }

  // Small popover for the composer: attach an image or a small text file.
  function closeAiAttachMenu(chat) {
    chat.attachMenu?.remove();
    chat.attachMenu = null;
    chat.attachButton?.setAttribute("aria-expanded", "false");
    const cleanup = chat.attachMenuCleanup;
    chat.attachMenuCleanup = null;
    cleanup?.();
  }

  function openAiAttachMenu(anchor, chat, actions = {}) {
    if (chat.attachMenu) { closeAiAttachMenu(chat); return; }
    const menu = anchor.parentElement.createDiv("qiaomu-reader-ai-attach-menu");
    menu.setAttribute("role", "menu");
    const item = (icon, label, run) => {
      const button = menu.createEl("button", { cls: "qiaomu-reader-ai-attach-item", attr: { type: "button", role: "menuitem" } });
      svgIcon(button.createSpan("qiaomu-reader-ai-attach-icon"), icon);
      button.createSpan({ text: label });
      button.addEventListener("click", () => { closeAiAttachMenu(chat); run(); });
    };
    item("image", translate("attach-image"), () => actions.pick?.("image"));
    item("note", translate("attach-file"), () => actions.pick?.("file"));
    if (actions.shot) item("crop", translate("screenshot"), () => actions.shot?.());
    chat.attachMenu = menu;
    chat.attachButton?.setAttribute("aria-expanded", "true");
    const doc = menu.ownerDocument;
    const onDown = (event) => {
      if (!menu.contains(event.target) && !anchor.contains(event.target)) closeAiAttachMenu(chat);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeAiAttachMenu(chat);
      anchor.focus?.();
    };
    chat.attachMenuCleanup = () => {
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("keydown", onKey, true);
    };
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("keydown", onKey, true);
    return menu;
  }

  function syncOpenAiSelectionContext(view, range) {
    const text = view?._pendingSel?.text?.trim();
    if (!text || !view.file) return;
    const leaf = view.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0];
    const AiChatView = getAiChatView();
    if (!(leaf?.view instanceof AiChatView)) return;
    if (!view.engine && range) paintAiSource(view, range);
    leaf.view.setContext({
      kind: "selection", label: translate("selection"),
      page: view._pendingSel.page ? translate("page-0", view._pendingSel.page) : "",
      text, bookFile: view.file, readerView: view,
    }, { selection: true, silent: true, focusInput: false });
  }

  function syncOpenAiReaderContext(view) {
    if (!view?.file || !view?.bookHtml) return;
    const leaf = view.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0];
    const AiChatView = getAiChatView();
    if (!(leaf?.view instanceof AiChatView)) return;
    const context = readerAiPanelContext(view);
    if (context) leaf.view.setContext(context, { follow: true, focusInput: false, silent: true });
  }

  return {
    readerPageContext,
    readerDefaultAiContext,
    readerAiPanelContext,
    readerSupportsAiContext,
    syncReaderAiCapability,
    renderAiHeadMeta,
    enhanceAiMarkdown,
    renderAiMarkdown,
    aiLogFollowsTail,
    createAiChatLog,
    createAiStreamingMarkdownRenderer,
    renderAiContextQuote,
    renderAiAttachmentList,
    openAiAttachMenu,
    closeAiAttachMenu,
    bindReaderAiComposer,
    ReaderNameModal,
    contextualAiQuickPrompts,
    renderAiComposerPrompts,
    bindAiSlashPrompts,
    renderMobileAiHeader,
    renderAiUserTurn,
    syncOpenAiSelectionContext,
    syncOpenAiReaderContext,
  };
}
