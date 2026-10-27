import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { createAiRender } from "../packages/reader/src/ai-render.js";

function setup(overrides = {}) {
  const { window } = new JSDOM("<main></main>");
  installDomExtensions(window);
  const ctx = createAiRender({
    translate: (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key),
    Modal: class Modal { constructor(app) { this.app = app; this.contentEl = null; } close() { this.closed = true; } },
    Menu: class Menu { addItem() { return this; } showAtMouseEvent() {} },
    MarkdownRenderer: { async render() {} },
    Component: class {},
    normalizeAiTurnContext: (value) => (value?.text ? {
      kind: value.kind || "selection",
      label: value.label || (value.kind === "document" ? "full-pdf" : value.kind === "page" ? "current-page" : "selection"),
      page: value.page || "",
      text: value.text,
    } : null),
    normalizeAiTurnLocation: (value) => (value?.page || value?.label ? { label: value.label || "", page: value.page || 0, percent: value.percent || 0 } : null),
    locationLine: (location) => [location.label, `page-0:${location.page}`, `${Math.round(location.percent * 100)}%`].filter(Boolean).join(" · "),
    jumpToAiLocation: async () => {},
    aiQuickPrompts: () => [{ id: "explain", name: "explain-it", prompt: "p-explain" }],
    paintAiSource() {},
    readerHud: { autoFocus() {} },
    readerIsPdf: (view) => String(view?.file?.extension || "").toLowerCase() === "pdf",
    AI_CHAT_VIEW_TYPE: "ai-chat",
    getAiChatView: () => class Chat {},
    getConfirmModal: () => class Confirm {},
    openReadSettings() {},
    openPluginAiSettings() {},
    ...overrides,
  });
  return { window, doc: window.document, render: ctx };
}

test("enhanceAiMarkdown wraps tables once and calms embedded content", () => {
  const { doc, render } = setup();
  const root = doc.createElement("div");
  root.innerHTML = '<table><tr><td>1</td></tr></table><input type="checkbox"><img src="x.png">';
  render.enhanceAiMarkdown(root);
  const wrapper = root.querySelector(".qiaomu-reader-ai-table-scroll");
  assert.ok(wrapper);
  assert.equal(wrapper.querySelectorAll("table").length, 1);
  assert.equal(root.querySelector("input").disabled, true);
  assert.equal(root.querySelector("input").getAttribute("aria-disabled"), "true");
  assert.equal(root.querySelector("img").loading, "lazy");
  render.enhanceAiMarkdown(root);
  assert.equal(root.querySelectorAll(".qiaomu-reader-ai-table-scroll").length, 1, "already wrapped tables are not re-wrapped");
});

test("renderAiContextQuote expands long selections and clears on demand", () => {
  const { doc, render } = setup();
  let cleared = 0;
  const host = doc.createElement("div");
  const long = render.renderAiContextQuote(host, { kind: "selection", text: "x".repeat(200) }, {
    className: "ctx",
    clearable: true,
    onClear: () => { cleared += 1; },
  });
  assert.ok(long.card.tagName.toLowerCase() === "details");
  assert.ok(long.card.classList.contains("is-expandable"));
  assert.ok(long.card.querySelector(".qiaomu-reader-ai-context-text"));
  long.clear.click();
  assert.equal(cleared, 1);
  assert.equal(host.querySelector(".ctx"), null);

  const short = render.renderAiContextQuote(host, { kind: "page", text: "short", page: "p.2" });
  assert.equal(short.card.tagName.toLowerCase(), "div");
  assert.equal(short.clear, null);
  assert.match(short.card.textContent, /current-page/);
  assert.match(short.card.textContent, /p\.2/);
  assert.equal(render.renderAiContextQuote(host, null), null);
});

test("renderAiUserTurn prints the context card above the question", () => {
  const { doc, render } = setup();
  const log = doc.createElement("div");
  const turn = { role: "user", content: "what?", context: { kind: "page", text: "page text" } };
  const bubble = render.renderAiUserTurn(log, turn);
  assert.ok(bubble.classList.contains("qiaomu-reader-ai-msg-me"));
  assert.ok(bubble.querySelector(".qiaomu-reader-ai-msg-context"));
  assert.equal(bubble.querySelector(".qiaomu-reader-ai-msg-text").textContent, "what?");
});

test("contextualAiQuickPrompts keeps the configured common prompts", () => {
  const { render } = setup();
  assert.deepEqual(render.contextualAiQuickPrompts({ text: "阅读是与作者的对话。" }).map((item) => item.id), ["explain"]);
  assert.deepEqual(render.contextualAiQuickPrompts({ pendingContext: { text: "Reading is a conversation." } }).map((item) => item.id), ["explain"]);
  assert.equal(render.contextualAiQuickPrompts({ contextMode: "none", text: "Reading is a conversation." }).length, 1);
});

test("renderAiComposerPrompts sends immediately and disables while busy", () => {
  const { doc, render } = setup();
  const host = doc.createElement("div");
  const calls = [];
  const chat = { busy: false, _send: (prompt) => calls.push(prompt) };
  const row = render.renderAiComposerPrompts(host, chat);
  assert.equal(row.className, "qiaomu-reader-ai-composer-prompts");
  assert.equal(chat.quickPromptButtons.length, 1);
  chat.quickPromptButtons[0].click();
  assert.deepEqual(calls, ["p-explain"]);
  chat.busy = true;
  render.renderAiComposerPrompts(host, chat);
  assert.ok(chat.quickPromptButtons.every((button) => button.disabled));
  assert.equal(host.querySelectorAll(".qiaomu-reader-ai-composer-prompts").length, 1, "a refresh replaces the row in place");
});

test("createAiChatLog tracks reading-earlier state and the jump button", () => {
  const { doc, render } = setup();
  const host = doc.createElement("div");
  let scrolls = 0;
  const chat = { _scroll: () => { scrolls += 1; } };
  const log = render.createAiChatLog(host, chat);
  assert.equal(log.getAttribute("aria-label"), "chat-history");
  assert.equal(chat._readingEarlier, false);
  assert.equal(render.aiLogFollowsTail({ scrollHeight: 100, scrollTop: 0, clientHeight: 50 }), true);
  assert.equal(render.aiLogFollowsTail({ scrollHeight: 500, scrollTop: 0, clientHeight: 50 }), false);
  assert.equal(render.aiLogFollowsTail(null), false);
  Object.defineProperties(log, {
    scrollHeight: { value: 100, configurable: true },
    scrollTop: { value: 0, configurable: true },
    clientHeight: { value: 50, configurable: true },
  });
  log.dispatchEvent(new doc.defaultView.WheelEvent("wheel", { deltaY: -40 }));
  assert.equal(chat._readingEarlier, true);
  log.dispatchEvent(new doc.defaultView.Event("scroll"));
  assert.equal(chat._readingEarlier, false, "scrolling back to the tail resumes following");
  host.querySelector(".qiaomu-reader-ai-jump-latest").click();
  assert.equal(scrolls, 1);
});

test("reader context helpers expose page, document and capability state", () => {
  const { doc, render } = setup();
  const engineView = {
    file: { path: "a.epub", extension: "epub" },
    engine: { visibleText: () => "  body text  ", currentLocation: () => ({ tocItem: { label: "Ch 1" } }) },
  };
  const page = render.readerPageContext(engineView);
  assert.deepEqual(page, {
    kind: "page", label: "current-page", page: "Ch 1", text: "body text",
    bookFile: engineView.file, readerView: engineView,
  });
  assert.equal(render.readerPageContext({ file: engineView.file, pager: {} }), null);

  const pdfView = {
    file: { path: "a.pdf", extension: "pdf" },
    bookHtml: "<p>x</p>",
    pdfDocumentContext: { text: "full text", pageCount: 12, truncated: true },
  };
  const document = render.readerDefaultAiContext(pdfView);
  assert.equal(document.kind, "document");
  assert.equal(document.label, "full-pdf-condensed");
  assert.equal(document.page, "0-pages:12");
  assert.equal(render.readerSupportsAiContext(pdfView), true);
  // A scanned PDF has no text to send, but its page images are available, so
  // the chat stays open and the send path attaches the current page.
  const scanned = { file: { path: "b.pdf", extension: "pdf" }, bookHtml: "<p>x</p>", pdfDocumentContext: { text: "" } };
  assert.equal(render.readerSupportsAiContext(scanned), true);
  const scannedContext = render.readerAiPanelContext({ file: scanned.file, bookHtml: "<p>x</p>" });
  assert.equal(scannedContext.scanned, true);
  assert.equal(scannedContext.text, undefined);
  assert.equal(scannedContext.bookFile, scanned.file);
  assert.ok(scannedContext.readerView);
  const coverPage = render.readerAiPanelContext({ file: { path: "c.epub", extension: "epub" }, bookHtml: "<p>x</p>" });
  assert.equal(coverPage.kind, undefined);
  assert.equal(coverPage.bookFile.path, "c.epub");
  const aiBtn = doc.createElement("button");
  render.syncReaderAiCapability({ file: { path: "a.epub", extension: "epub" }, bookHtml: "<p>x</p>", aiBtn });
  assert.equal(aiBtn.hidden, false);
  assert.equal(aiBtn.getAttribute("aria-label"), "ai-reading");
});

test("an AI image preview saves the full image through the save bridge", async () => {
  let saved = null;
  const { doc, render } = setup({
    saveImage: async (src, options) => { saved = { src, options }; return true; },
  });
  const owner = { contentEl: doc.body };
  render.openAiImagePreview(owner, {
    id: "att-save",
    kind: "image",
    name: "figure.png",
    mimeType: "image/png",
    bytes: 3,
    data: "AAAA",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlay = doc.body.querySelector(".qiaomu-reader-image-preview");
  const save = overlay.querySelector(".qiaomu-reader-image-preview-save");
  assert.ok(save, "the preview offers a save action");
  assert.equal(save.disabled, false);
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.src, "data:image/png;base64,AAAA");
  assert.equal(saved.options.name, "figure.png");
  assert.ok(doc.body.querySelector(".qiaomu-reader-image-preview"), "saving does not close the preview");
});

test("double-clicking a thumbnail opens the real image and Esc closes it", async () => {
  const { doc, window, render } = setup({
    attachmentSrc: async (attachment) => `data:${attachment.mimeType};base64,${attachment.data || "STORED"}`,
  });
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const owner = { contentEl: host };
  const image = { id: "att-1", kind: "image", name: "figure.png", mimeType: "image/png", bytes: 2048, thumb: "data:image/jpeg;base64,QQ==" };
  render.renderAiAttachmentList(host, [image], { owner });
  const chip = host.querySelector(".qiaomu-reader-ai-attach-chip");
  assert.equal(chip.tabIndex, 0, "the thumbnail is reachable by keyboard");
  assert.equal(owner.imagePreview, undefined);
  chip.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlay = doc.body.querySelector(".qiaomu-reader-image-preview");
  assert.ok(overlay);
  assert.equal(overlay.querySelector("img").getAttribute("src"), "data:image/png;base64,STORED", "stored bytes win over the thumbnail");
  assert.match(overlay.querySelector(".qiaomu-reader-image-preview-meta").textContent, /figure\.png/);
  assert.match(overlay.textContent, /tap-the-image-to-zoom-background-or-to-close/);
  overlay.click();
  assert.equal(doc.body.querySelector(".qiaomu-reader-image-preview"), null, "clicking the backdrop closes it");
  assert.equal(owner.imagePreview, null);

  chip.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(doc.body.querySelector(".qiaomu-reader-image-preview"));
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.body.querySelector(".qiaomu-reader-image-preview"), null, "Esc closes it");
});

test("a prepared task ends the reply with a visible preview and one-click confirm button", async () => {
  const { doc, render } = setup();
  const log = doc.querySelector("main");
  const calls = [];
  const owner = {
    async _confirmWorkshopTask(operation) {
      calls.push(operation);
      return { ok: true, title: "AI 答题页" };
    },
  };
  const card = render.renderAiWorkshopPreview(log, {
    preview: {
      operation: "制作 AI 答题页",
      summary: "用 AI 识别题目和选项，生成可作答、交卷后自动判分的页面。",
      source: "2026江苏",
      output: "2026江苏.AI答题页.html",
    },
    confirmation: { operation: "把文档做成答题页", label: "确认开始" },
  }, owner);
  assert.match(card.textContent, /确认任务/);
  assert.match(card.textContent, /2026江苏/);
  assert.match(card.textContent, /2026江苏\.AI答题页\.html/);
  const button = card.querySelector(".qiaomu-reader-ai-preview-confirm");
  assert.ok(button, "the preview must offer a direct confirmation button");
  assert.equal(button.textContent, "确认开始");
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["把文档做成答题页"]);
  assert.equal(button.textContent, "已提交");
  assert.equal(button.disabled, true);
  assert.match(card.textContent, /可以在任务列表查看进度/);
});

test("a submitted task keeps its card visible as a read-only confirmation", () => {
  const { doc, render } = setup();
  const log = doc.querySelector("main");
  let started = 0;
  const card = render.renderAiWorkshopPreview(log, {
    preview: {
      operation: "制作 AI 答题页",
      source: "2026江苏",
      output: "2026江苏.AI答题页.html",
    },
    confirmation: { operation: "把文档做成答题页" },
    done: true,
  }, { _confirmWorkshopTask: async () => { started += 1; return { ok: true }; } });
  const button = card.querySelector(".qiaomu-reader-ai-preview-confirm");
  assert.equal(button.textContent, "已提交");
  assert.equal(button.disabled, true);
  assert.match(card.textContent, /任务已提交/);
  assert.equal(started, 0);
});

test("a prepared task does not duplicate its confirm button inside the tool step", () => {
  const { doc, render } = setup();
  const log = doc.querySelector("main");
  const owner = { _confirmWorkshopTask: async () => ({ ok: true }) };
  const step = render.renderAiToolStep(log, { name: "prepare_workshop_task", arguments: { operation: "把文档做成答题页" } }, owner);
  step.finish({
    text: "准备开始：AI 答题页",
    confirmation: { operation: "把文档做成答题页", label: "确认开始" },
    preview: { operation: "制作 AI 答题页", source: "2026江苏", output: "2026江苏.AI答题页.html" },
  });
  assert.equal(step.card.querySelector(".qiaomu-reader-ai-tool-confirm-button"), null);
});

test("a tool step shows a fitting icon, its title, status and result", () => {
  const { doc, render } = setup();
  const log = doc.createElement("div");
  doc.body.appendChild(log);
  const search = render.renderAiToolStep(log, { name: "search_book", arguments: { query: "Alice" } });
  assert.match(search.card.querySelector(".qiaomu-reader-ai-tool-title").textContent, /tool-search-book：Alice/);
  assert.equal(search.card.querySelector(".qiaomu-reader-ai-tool-status").textContent, "tool-running");
  assert.ok(search.card.querySelector(".qiaomu-reader-ai-tool-icon svg"), "the step carries an icon");
  search.finish({ text: "命中：Alice", isError: false });
  assert.equal(search.card.querySelector(".qiaomu-reader-ai-tool-status").textContent, "tool-done");
  assert.equal(search.card.querySelector(".qiaomu-reader-ai-tool-text").textContent, "命中：Alice");
  assert.equal(search.card.classList.contains("is-done"), true);

  const pages = render.renderAiToolStep(log, { name: "read_pages", arguments: { start: 26, count: 3 } });
  assert.match(pages.card.querySelector(".qiaomu-reader-ai-tool-title").textContent, /tool-read-pages 26–28/);
  pages.finish({ text: "失败", isError: true });
  assert.equal(pages.card.classList.contains("is-error"), true);
  assert.equal(pages.card.querySelector(".qiaomu-reader-ai-tool-status").textContent, "tool-failed");

  const outline = render.renderAiToolStep(log, { name: "get_book_outline", arguments: {} });
  assert.equal(outline.card.querySelector(".qiaomu-reader-ai-tool-title").textContent, "tool-get-book-outline");

  // A page image the tool read shows as a small preview next to the text.
  const page = render.renderAiToolStep(log, { name: "read_page_image", arguments: { page: 26 } }, { contentEl: doc.body });
  page.finish({
    text: "【第 26 页图片】",
    images: [{ data: "AAAA", mimeType: "image/jpeg", page: 26 }],
    isError: false,
  });
  const thumb = page.card.querySelector(".qiaomu-reader-ai-tool-image");
  assert.ok(thumb, "the page image renders in the step");
  assert.equal(thumb.getAttribute("src"), "data:image/jpeg;base64,AAAA");
});

test("a user turn shows where the question was asked and the chip jumps back", () => {
  const jumps = [];
  const { doc, render } = setup({
    normalizeAiTurnLocation: (value) => (value?.page ? { label: value.label || "", page: value.page, percent: value.percent || 0 } : null),
    locationLine: (location) => [location.label, `page-0:${location.page}`, `${Math.round(location.percent * 100)}%`].filter(Boolean).join(" · "),
    jumpToAiLocation: (owner, location) => { jumps.push({ owner, location }); },
  });
  const owner = { contentEl: doc.body };
  const log = doc.createElement("div");
  doc.body.appendChild(log);
  const bubble = render.renderAiUserTurn(log, {
    role: "user",
    content: "这里是什么意思？",
    location: { label: "第三章", page: 12, percent: 0.34 },
  }, owner);
  const chip = bubble.querySelector(".qiaomu-reader-ai-location-chip");
  assert.ok(chip, "the location chip renders");
  assert.match(chip.textContent, /第三章 · page-0:12 · 34%/);
  chip.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(jumps.length, 1);
  assert.equal(jumps[0].owner, owner);
  assert.deepEqual(jumps[0].location, { label: "第三章", page: 12, percent: 0.34 });

  const plain = render.renderAiUserTurn(log, { role: "user", content: "没有位置" }, owner);
  assert.equal(plain.querySelector(".qiaomu-reader-ai-location-chip"), null);
});

test("a text attachment chip never opens a preview", () => {
  const { doc, render } = setup();
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  render.renderAiAttachmentList(host, [{ id: "t1", kind: "text", name: "notes.md", bytes: 10, text: "x" }], { owner: { contentEl: host } });
  const chip = host.querySelector(".qiaomu-reader-ai-attach-chip");
  assert.equal(chip.getAttribute("role"), null);
  assert.equal(chip.tabIndex, -1);
  chip.dispatchEvent(new doc.defaultView.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(doc.body.querySelector(".qiaomu-reader-image-preview"), null);
});

test("bindAiSlashPrompts filters prompts, chooses with the keyboard and closes", () => {
  const { doc, render } = setup({
    aiQuickPrompts: () => [
      { id: "explain", name: "explain-it", prompt: "p1" },
      { id: "quiz", name: "quiz-me", prompt: "p2" },
    ],
  });
  const menu = doc.createElement("div");
  const input = doc.createElement("input");
  const submitted = [];
  const chat = { busy: false, inputController: { submit: (prompt) => submitted.push(prompt), isComposing: () => false } };
  const controller = render.bindAiSlashPrompts(menu, input, chat);
  input.value = "/quiz";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  assert.equal(menu.hidden, false);
  assert.equal(menu.querySelectorAll(".qiaomu-reader-ai-slash-item").length, 1);
  input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(submitted, ["p2"]);
  assert.equal(menu.hidden, true);
  input.value = "plain";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  assert.equal(menu.hidden, true);
  input.value = "/";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  assert.equal(menu.querySelectorAll(".qiaomu-reader-ai-slash-item").length, 2);
  input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(menu.hidden, true);
  controller.close();
});

test("ReaderNameModal saves a trimmed title and reports failures", async () => {
  const { render } = setup();
  const freshMain = () => {
    const { window } = new JSDOM("<main></main>");
    installDomExtensions(window);
    return window.document.querySelector("main");
  };
  const saved = [];
  const modal = new render.ReaderNameModal({}, "Rename", "old", async (title) => { saved.push(title); });
  modal.contentEl = freshMain();
  modal.onOpen();
  const input = modal.contentEl.querySelector("input");
  assert.equal(input.value, "old");
  input.value = "  New Title  ";
  modal.contentEl.querySelector("button").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, ["New Title"]);
  assert.equal(modal.closed, true);

  const failing = new render.ReaderNameModal({}, "Rename", "old", async () => { throw new Error("no"); });
  failing.contentEl = freshMain();
  failing.onOpen();
  failing.contentEl.querySelector("input").value = "x";
  failing.contentEl.querySelector("button").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(failing.contentEl.querySelector(".qiaomu-reader-title-error").textContent, /saving-failed/);
  assert.equal(failing.contentEl.querySelector("button").disabled, false);
});
