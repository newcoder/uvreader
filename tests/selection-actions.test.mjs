import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createSelectionActions } from "../packages/reader/src/selection-actions.js";
import { selectionActionPreferences } from "../packages/reader/src/selection-preferences.js";

const tick = () => new Promise(r => setTimeout(r, 5));
function setup(overrides = {}) {
  const { window } = new JSDOM('<main><article></article><div class="popup"></div></main>', { pretendToBeVisual: true });
  const proto = window.HTMLElement.prototype;
  proto.createEl = function(tag, opts = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (typeof opts === "string") el.className = opts;
    else {
      el.className = opts.cls || ""; el.textContent = opts.text || "";
      for (const [key, value] of Object.entries(opts.attr || {})) el.setAttribute(key, value);
    }
    this.append(el); return el;
  };
  proto.createDiv = function(opts) { return this.createEl("div", opts); };
  proto.createSpan = function(opts) { return this.createEl("span", opts); };
  proto.addClass = function(c) { this.classList.add(c); };
  proto.removeClass = function(c) { this.classList.remove(c); };
  const menus = [], copied = [], records = [], savedComments = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(make) {
      const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setChecked(v) { this.checked = v; return this; }, onClick(fn) { this.run = fn; return this; } };
      make(item); this.items.push(item); return this;
    }
    addSeparator() {}
    onHide(fn) { this.onhide = fn; }
    hide() { this.onhide?.(); }
    showAtPosition(pos) { this.pos = pos; }
  }
  const root = window.document.querySelector("main");
  const view = {
    file: { path: "Book.mobi", extension: "mobi" }, app: { vault: { getName: () => "Vault" } },
    contentEl: root, areaEl: root.querySelector("article"), hlPopup: root.querySelector(".popup"),
    plugin: { settings: { defaultHlColor: "yellow", navMode: "click" }, getHighlights: () => records,
      setHighlightColor: (_, id, color) => { records.find(h => h.id === id).color = color; },
      addHighlight: (_, h) => records.push(h), removeHighlight: (_, id) => records.splice(records.findIndex(h => h.id === id), 1),
      saveAll: async () => true,
      setHighlightComment: async (_, id, hl, text) => { records.find(h => h.id === id).comment = text; savedComments.push(text); return true; },
    },
    _pendingSel: { cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)", text: "选中文本" },
    _currentHl() { return records.find(h => h.id === this._editHlId) || this._pendingSel; },
    _showHlPopup(rect) { this._hlPopupRect = rect; this.hlPopup.classList.add("qiaomu-reader-hl-popup-on"); },
    _hideHlPopup() { api.closeInlineHighlightComment(this); this.hlPopup.classList.remove("qiaomu-reader-hl-popup-on"); this._pendingSel = null; this._editHlId = null; },
    _renderFlowHighlights() {}, _unwrapHighlight() {},
    _createHighlight(sel, color) { const existing = api.matchingSelectionHighlight(this, sel); if (existing) { existing.color = color; return existing.id; } const id = "h" + records.length; records.push({ ...sel, color, id }); return id; },
    _applyPopupColor(color) { api.applySelectionColor(this, color); },
  };
  class Scope { constructor() { this.bindings = []; } register(mods, key, run) { this.bindings.push({ mods, key, run }); } }
  const translations = [];
  const api = createSelectionActions({
    translate: k => k,
    Notice: class {},
    Menu, Scope,
    TranslateModal: class { constructor(app, plugin, text, file) { translations.push({ text, file }); } open() {} },
    setIcon() {}, window,
    isPdf: () => false,
    hlColorCss: color => color,
    hlColors: ["yellow", "green", "pink", "blue"].map(id => ({ id, label: () => id, css: id })),
    positionPopup() {}, refreshHlPanel() {}, autoFocus() {},
    paintAiSource() {},
    copyToClipboard: async text => { copied.push(text); return true; },
    quoteMarkdown: () => "",
    createNoteFromSelection() {},
    hlCommentMd: () => "",
    flowSelectionParts: () => null,
    raiseSelectionPopup() {},
    lookupPinyin: overrides.lookupPinyin,
    lookupWord: overrides.lookupWord,
    translateSelection: overrides.translateSelection,
    translationTarget: overrides.translationTarget,
  });
  view._showHlPopup({ left: 10, right: 210, top: 100, bottom: 120, width: 200, height: 20 });
  return { window, view, api, menus, records, copied, savedComments, translations, close: () => window.close() };
}

test("the highlight button applies the current colour and ArrowDown opens the swatch palette", () => {
  const f = setup(); const { api, view, menus, records, window } = f;
  api.addBarButtons(view, view.hlPopup);
  const labels = [...view.hlPopup.querySelectorAll("button")].map(b => b.getAttribute("aria-label"));
  assert.deepEqual(labels, ["highlight-action", "annotate-action", "ask-ai-action", "copy"]);
  const trigger = view.hlPopup.querySelector(".qiaomu-reader-hl-highlight");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  trigger.click();
  assert.equal(records.length, 1, "one click highlights with the current colour");
  assert.equal(records[0].color, "yellow");
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-color-dropdown"), null, "no palette on a plain click");
  trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(menus.length, 0, "colors use an attached dropdown, not an OS context menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const options = view.hlPopup.querySelectorAll('[role="radio"]');
  assert.equal(options.length, 3);
  assert.equal(options[0].getAttribute("aria-checked"), "true");
  assert.equal(options[0].querySelector(".qiaomu-reader-color-swatch"), options[0].firstElementChild);
  assert.equal(options[0].textContent.trim(), "", "the swatch carries the choice without a repeated colour name");
  assert.ok(options[0].getAttribute("aria-label"), "the swatch keeps an accessible name");
  view.hlPopup.querySelector(".qiaomu-reader-color-dropdown")
    .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-color-dropdown"), null);
  f.close();
});

test("holding the highlight button opens the palette without highlighting", () => {
  const f = setup(); const { api, view, records, window } = f;
  const timers = [];
  const realSetTimeout = window.setTimeout;
  window.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    api.addBarButtons(view, view.hlPopup);
    const trigger = view.hlPopup.querySelector(".qiaomu-reader-hl-highlight");
    trigger.dispatchEvent(new window.MouseEvent("pointerdown", { button: 0, bubbles: true }));
    assert.equal(timers.length, 1, "the hold timer is armed");
    timers[0]();
    assert.ok(view.hlPopup.querySelector(".qiaomu-reader-color-dropdown"), "the palette opens on hold");
    trigger.click();
    assert.equal(records.length, 0, "the click ending the hold must not highlight");
  } finally {
    window.setTimeout = realSetTimeout;
  }
  f.close();
});

test("selection popup shows the pinyin and glossary chip at the front", () => {
  const lookup = (text) => (text === "犇"
    ? { text, pinyin: "bēn", gloss: "群牛受惊奔跑。", single: true, words: [] }
    : null);
  const f = setup({ lookupPinyin: lookup });
  const { api, view } = f;
  view._pendingSel = { text: "犇" };
  api.syncSelectionToolbar(view);
  const row = view.hlPopup.querySelector(".qiaomu-reader-hl-actions");
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.className, "qiaomu-reader-py-chip");
  assert.equal(chip.nextElementSibling, row, "the reading row sits above the action row");
  assert.equal(chip.querySelector(".qiaomu-reader-py-pinyin").textContent, "bēn");
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "群牛受惊奔跑。");
  assert.ok(row.querySelector(".qiaomu-reader-hl-highlight"), "the actions stay in the row");
  view._pendingSel = { text: "阅读" };
  api.syncSelectionToolbar(view);
  assert.equal(view.hlPopup.querySelectorAll(".qiaomu-reader-py-chip").length, 0, "the chip follows the selection");
  f.close();
});

test("a fixed-layout selection pins through the block anchor without the engine", () => {
  const lookup = (text) => (text === "犇" ? { text, pinyin: "bēn", gloss: "群牛受惊奔跑。", single: true, words: [] } : null);
  const f = setup({ lookupPinyin: lookup });
  const { api, view } = f;
  const calls = [];
  view._togglePinyinPin = (sel, info) => { calls.push({ sel, info }); return { id: "p1" }; };
  view._pinyinPinFor = () => null;
  view._pendingSel = { text: "犇", block: 2, occ: 0, pre: "", post: "" };
  api.syncSelectionToolbar(view);
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.tagName, "BUTTON");
  chip.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sel.block, 2);
  assert.equal(calls[0].info.pinyin, "bēn");
  f.close();
});

test("the reading chip pins the selection and reflects the pinned state", () => {
  const lookup = (text) => (text === "犇"
    ? { text, pinyin: "bēn", gloss: "群牛受惊奔跑。", single: true, words: [] }
    : null);
  const f = setup({ lookupPinyin: lookup });
  const { api, view } = f;
  const calls = [];
  let pinned = null;
  view.engine = { addPin() {}, removePin() {} };
  view._pinyinPinFor = () => pinned;
  view._togglePinyinPin = (sel, info) => {
    calls.push({ sel, info });
    pinned = pinned ? null : { id: "p1", cfi: sel.cfi };
    return pinned;
  };
  view._pendingSel = { cfi: "epubcfi(/6/2!/4/2,/1:0,/1:1)", text: "犇" };
  api.syncSelectionToolbar(view);
  let chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.tagName, "BUTTON");
  assert.equal(chip.getAttribute("type"), "button");
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  assert.equal(chip.getAttribute("aria-label"), "pin-pinyin");
  chip.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].info.pinyin, "bēn");
  chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.getAttribute("aria-pressed"), "true", "the chip reflects the pinned state");
  assert.equal(chip.getAttribute("aria-label"), "unpin-pinyin");
  chip.click();
  assert.equal(calls.length, 2);
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-py-chip").getAttribute("aria-pressed"), "false");
  f.close();
});

test("the selection popup carries every action, so no second menu exists", () => {
  const f = setup();
  const { api, view, menus } = f;
  assert.equal(typeof api.openReaderSelectionContext, "undefined");
  assert.equal(typeof api.openSelectionMoreMenu, "undefined");
  api.syncSelectionToolbar(view);
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-hl-menu"), null);
  assert.equal(menus.length, 0);
  f.close();
});

test("the highlight toast sits under the passage instead of the page bottom", () => {
  const f = setup(); const { api, view } = f;
  view._hlPopupRect = { left: 120, top: 300, bottom: 320, width: 180, height: 20 };
  view.contentEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 700, width: 500, height: 700 });
  api.applySelectionColor(view, "green");
  const toast = view.contentEl.querySelector(".qiaomu-reader-selection-feedback");
  assert.ok(toast, "the toast exists");
  assert.ok(Number.parseInt(toast.style.top, 10) > 320, "it sits below the passage");
  assert.equal(toast.style.bottom, "auto");
  assert.equal(toast.style.transform, "none");
  f.close();
});

test("undoing an existing highlight leaves a tracked, self-hiding restore toast", () => {
  const f = setup(); const { api, view, records, window } = f;
  const timers = [];
  const realSetTimeout = window.setTimeout;
  window.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  window.clearTimeout = () => {};
  try {
    records.push({ id: "existing", color: "yellow", text: "选中文本", cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)" });
    view._editHlId = "existing";
    api.showHighlightUndo(view, { left: 10, top: 20, bottom: 40, width: 80, height: 20 });
    view.contentEl.querySelector(".qiaomu-reader-selection-feedback button").click();
    assert.equal(records.length, 0, "the highlight is removed");
    const restore = view.contentEl.querySelector(".qiaomu-reader-selection-feedback");
    assert.equal(view._selectionFeedback, restore, "the restore toast stays tracked instead of lingering forever");
    assert.equal(timers.length, 2, "the restore toast scheduled its own auto-hide");
    timers[1]();
    assert.equal(view.contentEl.querySelector(".qiaomu-reader-selection-feedback"), null, "the restore toast hides itself");
  } finally {
    window.setTimeout = realSetTimeout;
  }
  f.close();
});

test("an English selection is translated into the chip by the AI", async () => {
  const calls = [];
  const f = setup({
    translateSelection: async (view, text) => { calls.push(text); return "这是一个测试。"; },
    translationTarget: () => "简体中文",
  });
  const { api, view } = f;
  view._pendingSel = { text: "This is a test." };
  api.syncSelectionToolbar(view);
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.ok(chip, "the chip appears while the translation runs");
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "translating");
  await tick();
  assert.deepEqual(calls, ["This is a test."]);
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "这是一个测试。");
  f.close();
});

test("the translation chip offers AI setup when the service is missing", async () => {
  const contexts = [];
  const f = setup({
    translateSelection: async () => {
      const error = new Error("AI is not configured");
      error.qiaomuReaderReason = "notconfigured";
      error.qiaomuReaderSetup = true;
      throw error;
    },
    translationTarget: () => "简体中文",
  });
  const { api, view } = f;
  view.plugin.openAiChat = async (context) => contexts.push(context);
  view._pendingSel = { text: "Hello world" };
  api.syncSelectionToolbar(view);
  await tick();
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "ai-not-configured-tap-to-set-up");
  chip.click();
  assert.equal(contexts.length, 1, "tapping the chip opens the AI conversation to set it up");
  f.close();
});

test("a failed translation retries when the chip is tapped", async () => {
  let attempts = 0;
  const f = setup({
    translateSelection: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return "第二次成功";
    },
    translationTarget: () => "简体中文",
  });
  const { api, view } = f;
  view._pendingSel = { text: "Retry me" };
  api.syncSelectionToolbar(view);
  await tick();
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "translation-failed-tap-to-retry");
  chip.click();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-py-gloss").textContent, "第二次成功");
  f.close();
});

test("the chip obeys the automatic pinyin and translation switches", () => {
  const lookup = (text) => (text === "犇" ? { text, pinyin: "bēn", gloss: "群牛受惊奔跑。", single: true, words: [] } : null);
  const f = setup({ lookupPinyin: lookup, translateSelection: async () => "translated", translationTarget: () => "简体中文" });
  const { api, view } = f;
  view.plugin.settings.autoPinyinInfo = false;
  view._pendingSel = { text: "犇" };
  api.syncSelectionToolbar(view);
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-py-chip"), null, "Chinese annotations can be switched off");
  view.plugin.settings.autoPinyinInfo = true;
  view.plugin.settings.autoTranslateEnglish = false;
  view._pendingSel = { text: "Hello" };
  api.syncSelectionToolbar(view);
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-py-chip"), null, "English translation can be switched off");
  f.close();
});

test("a word selection fills in its definition when the lookup resolves", async () => {
  const lookup = (text) => (text === "阅读"
    ? { text, pinyin: "yuè dú", gloss: "", single: false, words: [], wordKey: "阅读" }
    : null);
  const f = setup({
    lookupPinyin: lookup,
    lookupWord: async (key) => (key === "阅读" ? "看书﹑报﹑文件等，并领会其内容" : ""),
  });
  const { api, view } = f;
  view._pendingSel = { text: "阅读" };
  api.syncSelectionToolbar(view);
  const chip = view.hlPopup.querySelector(".qiaomu-reader-py-chip");
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss"), null, "the definition arrives asynchronously");
  await tick();
  assert.equal(chip.querySelector(".qiaomu-reader-py-gloss").textContent, "看书﹑报﹑文件等，并领会其内容");
  f.close();
});

test("a stale word lookup never leaks into the next selection", async () => {
  const resolvers = [];
  const f = setup({
    lookupPinyin: (text) => (text === "阅读"
      ? { text, pinyin: "yuè dú", gloss: "", single: false, words: [], wordKey: "阅读" }
      : null),
    lookupWord: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  const { api, view } = f;
  view._pendingSel = { text: "阅读" };
  api.syncSelectionToolbar(view);
  view._pendingSel = { text: "阅读" };
  api.syncSelectionToolbar(view);
  resolvers[0]("上一轮的结果");
  await tick();
  assert.equal(view.hlPopup.querySelector(".qiaomu-reader-py-gloss"), null, "the earlier lookup is dropped");
  f.close();
});

test("a click anywhere else dismisses the toast", () => {
  const f = setup(); const { api, view, window } = f;
  view._hlPopupRect = { left: 120, top: 300, bottom: 320, width: 180, height: 20 };
  api.applySelectionColor(view, "green");
  assert.ok(view.contentEl.querySelector(".qiaomu-reader-selection-feedback"));
  view.contentEl.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-selection-feedback"), null, "outside click hides the toast");
  assert.equal(view._selectionFeedback, null);
  f.close();
});

test("an existing highlight offers the undo toast that removes and restores it", () => {
  const f = setup(); const { api, view, records } = f;
  records.push({ id: "existing", color: "yellow", text: "选中文本", cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)" });
  view._editHlId = "existing";
  const rect = { left: 100, top: 200, bottom: 220, width: 120, height: 20 };
  api.showHighlightUndo(view, rect);
  const toast = view.contentEl.querySelector(".qiaomu-reader-selection-feedback");
  assert.equal(toast.querySelector("span").textContent, "highlight-saved");
  toast.querySelector("button").click();
  assert.equal(records.length, 0, "undo removes the highlight");
  const restore = view.contentEl.querySelector(".qiaomu-reader-selection-feedback");
  assert.equal(restore.querySelector("span").textContent, "highlight-deleted");
  restore.querySelector("button").click();
  assert.equal(records.length, 1, "the second undo restores it");
  assert.equal(records[0].id, "existing");
  f.close();
});

test("recoloring an existing CFI keeps its ID and comment; undo restores the previous color", () => {
  const f = setup(); const { records, view, api } = f;
  records.push({ ...view._pendingSel, id: "existing", color: "yellow", comment: "保留批注" });
  view._editHlId = "existing";
  api.applySelectionColor(view, "green");
  assert.equal(records.length, 1); assert.equal(records[0].id, "existing"); assert.equal(records[0].comment, "保留批注");
  assert.equal(records[0].color, "green"); assert.equal(view.plugin.settings.defaultHlColor, "green");
  view.contentEl.querySelector(".qiaomu-reader-selection-feedback button").click();
  assert.equal(records[0].color, "yellow"); f.close();
});

test("comment drafts survive dismissal; ordinary Enter and IME confirmation do not submit", async () => {
  const f = setup(); const { api, view, window, savedComments, records } = f;
  const pending = { ...view._pendingSel };
  api.openInlineHighlightComment(view);
  let ta = view.hlPopup.querySelector("textarea"); ta.value = "第一行\n第二行"; ta.dispatchEvent(new window.Event("input"));
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }));
  assert.equal(records.length, 0);
  view._hideHlPopup(); view._pendingSel = pending; api.openInlineHighlightComment(view);
  ta = view.hlPopup.querySelector("textarea"); assert.equal(ta.value, "第一行\n第二行");
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
  await tick();
  assert.equal(records.length, 1); assert.deepEqual(savedComments, ["第一行\n第二行"]);
  assert.equal(view.plugin._highlightCommentDrafts.size, 0); f.close();
});

test("the click dismissing a popup is consumed once before edge navigation", () => {
  const f = setup(); let pages = 0;
  f.view.areaEl.getBoundingClientRect = () => ({ left: 0, width: 500 }); f.view.nav = () => pages++;
  f.api.beginReaderSelection(f.view, { button: 0, pointerType: "mouse" });
  const event = { target: f.view.areaEl, clientX: 490 };
  assert.equal(f.api.handleAreaNavClick(f.view, event), true); assert.equal(pages, 0);
  f.api.handleAreaNavClick(f.view, event); assert.equal(pages, 1); f.close();
});


test("temporary Obsidian key scope saves the comment and is released on dismissal", async () => {
  const f = setup(); const scopes = [];
  f.view.app.keymap = { pushScope: s => scopes.push(s), popScope: s => scopes.splice(scopes.indexOf(s), 1) };
  f.api.openInlineHighlightComment(f.view);
  const ta = f.view.hlPopup.querySelector("textarea"); ta.value = "组合键批注";
  assert.equal(scopes.length, 1);
  scopes[0].bindings.find(b => b.key === "Enter").run({ isComposing: false });
  await tick();
  assert.equal(f.records[0].comment, "组合键批注"); assert.equal(scopes.length, 0);
  f.view._editHlId = f.records[0].id; f.api.openInlineHighlightComment(f.view);
  assert.equal(scopes.length, 1); f.view._hideHlPopup(); assert.equal(scopes.length, 0);
  f.close();
});

test("Ask AI attaches selected text and book context without submitting a prompt", async () => {
  const f = setup(); const contexts = [];
  f.view.plugin.openAiChat = async context => contexts.push(context);
  f.api.openAiSelectionChat(f.view); await tick();
  assert.equal(contexts.length, 1); assert.equal(contexts[0].text, "选中文本");
  assert.equal(contexts[0].bookFile.path, "Book.mobi"); assert.equal(contexts[0].kind, "selection");
  assert.equal(f.view._pendingSel, null); f.close();
});


test("icon-only defaults keep accessible names, translated text is opt-in", () => {
  const f = setup(); f.api.addBarButtons(f.view, f.view.hlPopup);
  assert.equal(f.view.hlPopup.querySelectorAll(".qiaomu-reader-selection-label").length, 0);
  assert.ok([...f.view.hlPopup.querySelectorAll("button")].every(b => b.getAttribute("aria-label")));
  f.view.plugin.settings.selectionShowLabels = true;
  f.api.syncSelectionToolbar(f.view);
  assert.equal(f.view.hlPopup.querySelectorAll(".qiaomu-reader-hl-actions").length, 1);
  assert.equal(f.view.hlPopup.querySelectorAll(".qiaomu-reader-selection-label").length, 4);
  f.close();
});

test("translation becomes a primary action only when enabled and retains selected text", () => {
  const f = setup(); f.api.syncSelectionToolbar(f.view);
  assert.equal(f.view.hlPopup.querySelector(".qiaomu-reader-hl-translate"), null);
  f.view.plugin.settings.translateEnabled = true; f.api.syncSelectionToolbar(f.view);
  f.view.hlPopup.querySelector(".qiaomu-reader-hl-translate").click();
  assert.deepEqual(f.translations.map(t => t.text), ["选中文本"]);
  assert.equal(f.translations[0].file.path, "Book.mobi");
  f.close();
});

test("configured order drives the four visible buttons", () => {
  const f = setup();
  f.view.plugin.settings.selectionActions = [{ id: "copy" }, { id: "highlight", visible: false }];
  f.api.syncSelectionToolbar(f.view);
  const labels = [...f.view.hlPopup.querySelectorAll(".qiaomu-reader-hl-actions button")].map(b => b.getAttribute("aria-label"));
  assert.deepEqual(labels, ["copy", "annotate-action", "ask-ai-action"]);
  assert.equal(f.view.hlPopup.querySelector(".qiaomu-reader-hl-highlight"), null);
  f.close();
});

test("preferences recover malformed values and preserve deliberate all-hidden state", () => {
  const defaults = selectionActionPreferences(null);
  assert.equal(defaults.length, 5);
  const normalized = selectionActionPreferences([null, {id:"bogus"}, {id:"copy",visible:false}, {id:"copy"}]);
  assert.equal(normalized.length, 5); assert.equal(normalized[0].visible, false);
  const f = setup(); f.view.plugin.settings.selectionActions = defaults.map(x => ({...x, visible:false}));
  f.api.addBarButtons(f.view, f.view.hlPopup);
  assert.equal(f.view.hlPopup.querySelectorAll("button").length, 0);
  f.close();
});
