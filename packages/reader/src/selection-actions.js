// Selection toolbar, highlight popup and colour actions for the reader UI.
// The host injects menus, modals, notices and clipboard access so the module
// stays independent of the Obsidian API.
import { selOf } from "./reader-dom.js";
import { PDF_ZOOM_DEFAULT, clampPdfZoom } from "./pdf-zoom.js";
import { selectionActionPreferences } from "./selection-preferences.js";

const QUICK_HL_COLOR_IDS = ["yellow", "green", "pink"];

export function createSelectionActions({
  translate, Notice, Scope, TranslateModal, setIcon, window,
  isPdf, hlColorCss, hlColors, positionPopup, refreshHlPanel, autoFocus,
  paintAiSource, copyToClipboard,
  flowSelectionParts, raiseSelectionPopup, lookupPinyin,
}) {
  function selectionActions(view) {
    const actions = {
      highlight: ["qiaomu-reader-hl-highlight", "highlighter", "highlight-action", () => view._applyPopupColor(selectionColor(view))],
      comment: ["qiaomu-reader-hl-comment-btn", "message-square", "annotate-action", () => openInlineHighlightComment(view)],
      ai: ["qiaomu-reader-hl-ai", "sparkles", "ask-ai-action", () => openAiSelectionChat(view)],
      translate: ["qiaomu-reader-hl-translate", "languages", "translate", () => {
        const cur = view._currentHl(), file = view.file;
        if (!cur || !file || !view.plugin.settings.translateEnabled) return;
        clearReaderSelection(view); view._hideHlPopup();
        new TranslateModal(view.app, view.plugin, cur.text, file, { ...cur }).open();
      }],
      copy: ["qiaomu-reader-hl-copy", "copy", "copy", () => void copySelectionText(view)],
    };
    return selectionActionPreferences(view.plugin.settings.selectionActions)
      .filter(item => item.id !== "translate" || view.plugin.settings.translateEnabled)
      .map(item => ({ ...item, cls: actions[item.id][0], icon: actions[item.id][1], label: translate(actions[item.id][2]), run: actions[item.id][3] }));
  }

  function matchingSelectionHighlight(view, selection) {
    if (!selection || !view.file) return null;
    return view.plugin.getHighlights(view.file.path).find((hl) => selection.cfi
      ? hl.cfi === selection.cfi
      : !hl.cfi && Number.isInteger(selection.block) && hl.block === selection.block
        && (hl.occ || 0) === (selection.occ || 0) && hl.text === selection.text) || null;
  }

  function selectionColor(view) {
    return view._currentHl()?.color || view.plugin.settings.defaultHlColor || "yellow";
  }

  function clearReaderSelection(view) {
    view._selectionDoc?.getSelection()?.removeAllRanges();
    selOf(view.areaEl)?.removeAllRanges();
    view._selectionDoc = null;
  }

  function beginReaderSelection(view, event) {
    if (event.button !== 0 || view._selectionMenuOpen) return;
    view._dismissSelectionClick = !!view.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on");
    view._hideHlPopup?.();
    if (event.pointerType === "mouse") view._selectionDragging = true;
  }

  function engineSelectionRect(doc, range) {
    const r = range.getBoundingClientRect();
    const frame = doc?.defaultView?.frameElement?.getBoundingClientRect();
    const x = frame?.left || 0, y = frame?.top || 0;
    return { left: r.left + x, right: r.right + x, top: r.top + y, bottom: r.bottom + y, width: r.width, height: r.height };
  }

  // The toast follows the passage it talks about: under the selection on
  // desktop, and only without a rect does it fall back to the bottom centre.
  function positionFeedback(view, el, rect) {
    const root = view.contentEl;
    const rootBox = root.getBoundingClientRect();
    const width = el.offsetWidth || 160;
    const height = el.offsetHeight || 34;
    const left = Math.max(6, Math.min(rect.left - rootBox.left + rect.width / 2 - width / 2, root.clientWidth - width - 6));
    const top = Math.max(6, Math.min(rect.bottom - rootBox.top + 10, rootBox.height - height - 6));
    Object.assign(el.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, bottom: "auto", transform: "none" });
  }

  function hideSelectionFeedback(view) {
    if (!view?._selectionFeedback && !view?._selectionFeedbackTimer) return;
    window.clearTimeout(view._selectionFeedbackTimer);
    view._selectionFeedbackTimer = null;
    view._selectionFeedback?.remove();
    view._selectionFeedback = null;
  }

  // A click anywhere else dismisses the toast; it also hides itself after a
  // moment, so it never lingers over the page.
  function bindFeedbackDismiss(view) {
    if (view._selectionFeedbackDismiss) return;
    view._selectionFeedbackDismiss = true;
    const doc = view.contentEl?.ownerDocument;
    if (!doc) return;
    const onDown = (event) => {
      const el = view._selectionFeedback;
      if (!el || el.contains(event.target)) return;
      hideSelectionFeedback(view);
    };
    if (typeof view.registerDomEvent === "function") view.registerDomEvent(doc, "pointerdown", onDown);
    else doc.addEventListener("pointerdown", onDown);
  }

  function selectionFeedback(view, message, undo, rect = null) {
    hideSelectionFeedback(view);
    bindFeedbackDismiss(view);
    const el = view._selectionFeedback = view.contentEl.createDiv("qiaomu-reader-selection-feedback");
    el.setAttribute("role", "status");
    el.createSpan({ text: message });
    if (undo) el.createEl("button", { text: translate("undo"), attr: { type: "button" } }).addEventListener("click", () => {
      // Dismiss this toast before running the action: the action may raise a
      // follow-up toast (delete → restore) that must keep its own timer.
      hideSelectionFeedback(view);
      undo();
    });
    if (rect) positionFeedback(view, el, rect);
    view._selectionFeedbackTimer = window.setTimeout(() => { el.remove(); view._selectionFeedback = null; view._selectionFeedbackTimer = null; }, undo ? 6000 : 1800);
  }

  function removeHighlightWithUndo(view, id, rect) {
    const file = view.file;
    if (!file || !id) return;
    const hl = view.plugin.getHighlights(file.path).find((item) => item.id === id);
    if (!hl) return;
    view.plugin.removeHighlight(file.path, id);
    view._unwrapHighlight(id);
    refreshHlPanel(view);
    view._hideHlPopup();
    selectionFeedback(view, translate("highlight-deleted"), () => {
      if (view.plugin.getHighlights(file.path).some((item) => item.id === id)) return;
      view.plugin.addHighlight(file.path, hl);
      if (view.file?.path === file.path) repaintSelectionHighlights(view);
    }, rect);
  }

  // Clicking an existing highlight reopens its toolbar and offers the same undo
  // affordance a fresh highlight gets, so it can be removed without the panel.
  function showHighlightUndo(view, rect) {
    const id = view._editHlId;
    if (!id || !view.file) return;
    selectionFeedback(view, translate("highlight-saved"), () => removeHighlightWithUndo(view, id, rect), rect);
  }

  function repaintSelectionHighlights(view) {
    view._renderFlowHighlights();
    refreshHlPanel(view);
  }

  function applySelectionColor(view, colorId) {
    if (!view.file || !view._currentHl()) return;
    const path = view.file.path;
    const before = new Map(view.plugin.getHighlights(path).map((hl) => [hl.id, { ...hl }]));
    const ids = [];
    if (view._editHlId) {
      const id = view._editHlId;
      view.plugin.setHighlightColor(path, id, colorId);
      ids.push(id);
    } else for (const part of view._pendingSel.parts || [view._pendingSel]) {
      const id = view._createHighlight(part, colorId);
      if (id) ids.push(id);
    }
    view.plugin.settings.defaultHlColor = colorId;
    void view.plugin.saveAll();
    repaintSelectionHighlights(view);
    const rect = view._hlPopupRect;
    clearReaderSelection(view); view._hideHlPopup();
    selectionFeedback(view, translate("highlight-saved"), () => {
      for (const id of ids) {
        const old = before.get(id);
        if (old) view.plugin.setHighlightColor(path, id, old.color);
        else {
          view.plugin.removeHighlight(path, id);
          if (view.file?.path === path) view._unwrapHighlight(id);
        }
      }
      if (view.file?.path === path) repaintSelectionHighlights(view);
    }, rect);
  }

  function closeSelectionColorDropdown(view, focus = false) {
    view.hlPopup?.querySelector(".qiaomu-reader-color-dropdown")?.remove();
    const trigger = view.hlPopup?.querySelector(".qiaomu-reader-hl-highlight");
    trigger?.setAttribute("aria-expanded", "false");
    if (focus) trigger?.focus();
  }

  // The highlight button opens this palette; the swatches carry the colour and
  // their accessible name, without repeating the label as text.
  function toggleSelectionColorDropdown(view) {
    const pop = view.hlPopup;
    if (pop.querySelector(".qiaomu-reader-color-dropdown")) { closeSelectionColorDropdown(view, true); return; }
    const trigger = pop.querySelector(".qiaomu-reader-hl-highlight");
    trigger.setAttribute("aria-expanded", "true");
    const menu = pop.createDiv("qiaomu-reader-color-dropdown");
    menu.setAttribute("role", "radiogroup");
    menu.setAttribute("aria-label", translate("highlight-colors"));
    const buttons = [];
    for (const color of hlColors.filter(entry => QUICK_HL_COLOR_IDS.includes(entry.id))) {
      const selected = color.id === selectionColor(view);
      const button = menu.createEl("button", { cls: "qiaomu-reader-color-option", attr: {
        type: "button", role: "radio", "aria-checked": String(selected), "aria-label": color.label(), tabindex: selected ? "0" : "-1",
      } });
      const swatch = button.createSpan({ cls: "qiaomu-reader-color-swatch" });
      swatch.style.background = color.css;
      if (selected) setIcon(swatch, "check");
      button.addEventListener("click", () => view._applyPopupColor(color.id));
      buttons.push(button);
    }
    const box = pop.getBoundingClientRect(), root = view.contentEl.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(0, Math.min(trigger.offsetLeft, root.right - box.left - width - 8))}px`;
    menu.classList.toggle("is-above", box.bottom + menu.offsetHeight + 8 > root.bottom);
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSelectionColorDropdown(view, true); }
      const i = buttons.indexOf(event.target);
      if (i >= 0 && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons.forEach((b, at) => b.tabIndex = at === next ? 0 : -1);
        buttons[next].focus();
      }
    });
    (buttons.find(b => b.getAttribute("aria-checked") === "true") || buttons[0]).focus({ preventScroll: true });
  }

  // Reading + short definition for the current selection, on its own row above
  // the action buttons. Long selections and latin text produce no chip. Where
  // the format supports it the chip is a button that pins the reading.
  function syncSelectionInfo(view) {
    const pop = view.hlPopup;
    if (!pop) return;
    pop.querySelector(".qiaomu-reader-py-chip")?.remove();
    const row = pop.querySelector(".qiaomu-reader-hl-actions");
    if (!row || typeof lookupPinyin !== "function") return;
    const sel = view._pendingSel || view._currentHl() || null;
    const info = lookupPinyin(sel?.text || "");
    if (!info) return;
    const canPin = !!view.engine && view.file?.extension !== "pdf" && !!sel?.cfi
      && typeof view._togglePinyinPin === "function";
    const pinned = canPin && Boolean(view._pinyinPinFor?.(sel));
    const chip = canPin
      ? pop.createEl("button", { cls: "qiaomu-reader-py-chip" })
      : pop.createDiv("qiaomu-reader-py-chip");
    if (canPin) {
      chip.setAttribute("type", "button");
      chip.setAttribute("aria-pressed", String(pinned));
      chip.setAttribute("aria-label", translate(pinned ? "unpin-pinyin" : "pin-pinyin"));
      chip.addEventListener("click", () => {
        view._togglePinyinPin(sel, info);
        syncSelectionInfo(view);
      });
    } else {
      chip.setAttribute("role", "note");
    }
    chip.createDiv({ cls: "qiaomu-reader-py-pinyin", text: info.pinyin });
    if (info.gloss) chip.createDiv({ cls: "qiaomu-reader-py-gloss", text: info.gloss });
    row.before(chip);
  }

  function syncSelectionToolbar(view) {
    const config = JSON.stringify([view.plugin.settings.selectionShowLabels, view.plugin.settings.selectionActions, view.plugin.settings.translateEnabled]);
    if (view.hlPopup && view._selectionToolbarConfig !== config) {
      view.hlPopup.querySelector(".qiaomu-reader-hl-actions")?.remove();
      closeSelectionColorDropdown(view);
      addBarButtons(view, view.hlPopup);
      view._selectionToolbarConfig = config;
    }
    syncSelectionInfo(view);
    const btn = view.hlPopup?.querySelector(".qiaomu-reader-hl-highlight");
    if (!btn) return;
    btn.style.setProperty("--selection-color", hlColorCss(selectionColor(view)));
  }

  function addBarButtons(view, pop) {
    const row = pop.createDiv("qiaomu-reader-hl-actions");
    row.setAttribute("role", "toolbar");
    row.setAttribute("aria-label", translate("selection-actions"));
    const button = (parent, cls, icon, label, run, compact = false) => {
      const btn = parent.createEl("button", { cls: "qiaomu-reader-selection-action " + cls, attr: { type: "button", "aria-label": label } });
      setIcon(btn, icon);
      if (!compact && view.plugin.settings.selectionShowLabels === true) btn.createSpan({ cls: "qiaomu-reader-selection-label", text: label });
      btn.addEventListener("click", run);
      return btn;
    };
    for (const action of selectionActions(view).filter(item => item.visible)) {
      const isHighlight = action.id === "highlight";
      const btn = button(row, action.cls, action.icon, action.label,
        isHighlight ? () => toggleSelectionColorDropdown(view) : action.run);
      if (isHighlight) {
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
      }
    }
    row.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = [...row.querySelectorAll("button")];
      const i = buttons.indexOf(event.target);
      if (i < 0) return;
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (i + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length].focus();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); view._hideHlPopup(); }
    });
  }

  async function copySelectionText(view) {
    const cur = view._currentHl();
    if (!cur) return;
    const rect = view._hlPopupRect;
    clearReaderSelection(view); view._hideHlPopup();
    const ok = await copyToClipboard(cur.text);
    selectionFeedback(view, translate(ok ? "copied" : "could-not-copy"), null, rect);
  }

  function openAiSelectionChat(view) {
    const cur = view._currentHl();
    const live = view._selectionDoc?.getSelection() || selOf(view.areaEl);
    if (live?.rangeCount && !view.engine) paintAiSource(view, live.getRangeAt(0));
    if (!cur) return;
    const context = { kind: "selection", label: translate("selection"),
      page: cur.page ? translate("page-0", cur.page) : "",
      text: cur.text, bookFile: view.file, readerView: view };
    clearReaderSelection(view); view._hideHlPopup();
    void view.plugin.openAiChat(context);
  }

  function closeInlineHighlightComment(view) {
    const pop = view && view.hlPopup;
    if (!pop) return;
    view._commentEditing = false;
    pop.removeClass("qiaomu-reader-hl-popup-commenting");
    const editor = pop.querySelector(".qiaomu-reader-hl-comment-editor");
    if (editor) { editor.saveDraft?.(); editor.releaseScope?.(); editor.remove(); }
    if (view._hlPopupRect) positionPopup(view, view._hlPopupRect, 260, 44);
  }

  function openInlineHighlightComment(view) {
    const popup = view.hlPopup;
    const current = view._currentHl();
    const pendingSel = view._pendingSel;
    const priorId = view._editHlId;
    const file = view.file;
    if (!popup || !current || !view.file) return;
    closeSelectionColorDropdown(view);
    closeInlineHighlightComment(view);
    const drafts = view.plugin._highlightCommentDrafts ||= new Map();
    const draftKey = JSON.stringify([file.path, current.cfi || priorId || [pendingSel?.block, pendingSel?.occ, current.text]]);
    view._commentEditing = true;
    const stored = priorId
      ? view.plugin.getHighlights(view.file.path).find((h) => h.id === priorId)
      : null;
    popup.addClass("qiaomu-reader-hl-popup-commenting");
    const editor = popup.createDiv("qiaomu-reader-hl-comment-editor");
    hlCommentQuoteBlock(editor, current.text);
    const ta = editor.createEl("textarea", { cls: "qiaomu-reader-hl-comment-textarea" });
    ta.value = drafts.has(draftKey) ? drafts.get(draftKey) : stored?.comment || "";
    editor.saveDraft = () => {
      drafts.delete(draftKey);
      drafts.set(draftKey, ta.value);
      if (drafts.size > 100) drafts.delete(drafts.keys().next().value);
    };
    ta.placeholder = translate("write-a-short-thought-about-this-passage");
    ta.setAttribute("aria-label", translate("comment-on-a-highlight"));
    const actions = editor.createDiv("qiaomu-reader-hl-comment-actions");
    const cancelBtn = actions.createEl("button", { text: translate("cancel") });
    cancelBtn.addClass("qiaomu-reader-hl-comment-cancel");
    const saveBtn = actions.createEl("button", { text: translate("save") });
    saveBtn.addClass("qiaomu-reader-hl-comment-save");
    let sending = false;
    let targetId = priorId;
    const refreshSendState = () => { saveBtn.disabled = sending || (!priorId && !ta.value.trim()); };
    refreshSendState();
    ta.addEventListener("input", () => { editor.saveDraft(); refreshSendState(); });
    const place = () => { if (view._hlPopupRect) positionPopup(view, view._hlPopupRect, 340, 220); };
    window.requestAnimationFrame(place);
    cancelBtn.addEventListener("click", () => view._hideHlPopup());
    const send = async () => {
      if (sending || view.file?.path !== file.path || (!priorId && !ta.value.trim())) return;
      sending = true;
      refreshSendState();
      if (!targetId && pendingSel) {
        for (const part of pendingSel.parts || [pendingSel]) {
          const made = view._createHighlight(part, view.plugin.settings.defaultHlColor || "yellow");
          if (!targetId && made) targetId = made;
        }
      }
      if (!targetId) {
        new Notice(translate("could-not-save-the-comment"));
        sending = false;
        refreshSendState();
        return;
      }
      try {
        const saved = await view.plugin.setHighlightComment(file.path, targetId, current, ta.value.trim());
        if (!saved) throw new Error("Comment was not saved");
        drafts.delete(draftKey); editor.saveDraft = null;
        if (view.file?.path === file.path && popup.querySelector(".qiaomu-reader-hl-comment-editor") === editor) {
          repaintSelectionHighlights(view);
          clearReaderSelection(view); view._hideHlPopup();
        }
      } catch {
        sending = false;
        refreshSendState();
        new Notice(translate("could-not-save-the-comment"));
      }
    };
    saveBtn.addEventListener("click", send);
    // Obsidian handles application shortcuts before textarea keydown listeners.
    // A temporary scope owns only the editor's save/dismiss keys and is always
    // popped on dismissal, book changes, and reader teardown.
    if (view.app.keymap) {
      const scope = new Scope();
      const saveFromKey = (event) => {
        if (!event.isComposing) void send();
        return false;
      };
      scope.register(["Mod"], "Enter", saveFromKey);
      scope.register(["Ctrl"], "Enter", saveFromKey);
      scope.register([], "Escape", () => { view._hideHlPopup(); return false; });
      view.app.keymap.pushScope(scope);
      editor.releaseScope = () => { view.app.keymap.popScope(scope); };
    }
    ta.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault(); send();
      }
      if (event.key === "Escape") {
        event.preventDefault(); view._hideHlPopup();
      }
    });
    autoFocus(ta, 30);
  }

  function handleAreaNavClick(view, e) {
    if (view._dismissSelectionClick) {
      view._dismissSelectionClick = false;
      if (!view._currentHl?.()) view._hideHlPopup?.();
      return true;
    }
    if (e.defaultPrevented) return false;
    if ((view.plugin.settings.navMode || "buttons") !== "click") return false;
    if (view.plugin.settings.readMode === "scroll" || view.pager?.scrollMode) return false;
    // A zoomed PDF page is a pan surface. Side taps and horizontal drags belong
    // to that surface until the reader resets it to fit-page size.
    if (isPdf(view) && clampPdfZoom(view.pdfZoom) > PDF_ZOOM_DEFAULT + 0.001) return false;
    if (e.target?.closest?.("a,button,input,textarea,select,[contenteditable],img,.qiaomu-reader-hl,.qiaomu-reader-hl-popup")) return false;
    const sel = e.target?.ownerDocument?.getSelection() || selOf(view.areaEl);
    if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
    const r = view.areaEl.getBoundingClientRect();
    if (!r.width) return false;
    const x = e.clientX - r.left;
    const goNext = () => view.nav ? view.nav("next") : view._nav("next");
    const goPrev = () => view.nav ? view.nav("prev") : view._nav("prev");
    if (x < r.width * 0.32) { goPrev(); return true; }
    if (x > r.width * 0.68) { goNext(); return true; }
    return false;
  }

  function hlCommentQuoteBlock(editor, text) {
    const quote = editor.createDiv({ cls: "qiaomu-reader-hl-comment-quote", text });
    quote.setAttribute("role", "button");
    quote.setAttribute("tabindex", "0");
    quote.setAttribute("aria-label", translate("expand-or-collapse-the-selected-passage"));
    const flip = () => quote.toggleClass("qiaomu-reader-hl-comment-quote-open", !quote.hasClass("qiaomu-reader-hl-comment-quote-open"));
    quote.addEventListener("click", flip);
    quote.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); flip();
      }
    });
  }

  return {
    matchingSelectionHighlight, selectionColor, clearReaderSelection, beginReaderSelection,
    engineSelectionRect, selectionFeedback, hideSelectionFeedback, showHighlightUndo, removeHighlightWithUndo, repaintSelectionHighlights,
    applySelectionColor, closeSelectionColorDropdown, toggleSelectionColorDropdown, syncSelectionToolbar,
    actions: selectionActions, addBarButtons, copySelectionText, openAiSelectionChat,
    closeInlineHighlightComment, openInlineHighlightComment, handleAreaNavClick,
  };
}
