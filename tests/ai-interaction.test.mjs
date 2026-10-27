import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import { isNonChineseSource } from "../packages/reader/src/ai-source-language.js";
import { bindAiComposer } from "../packages/reader/src/ai-composer.js";
import { suggestAiNoteTitle } from "../packages/reader/src/ai-note-title.js";
import { shouldFollowContext } from "../packages/reader/src/reader-experience.js";
import { verifiedQuotes } from "../packages/reader/src/reading-workflow.js";

const source = fs.readFileSync(new URL("../packages/reader/src/wire.js", import.meta.url), "utf8");
const aiContextSource = fs.readFileSync(new URL("../packages/reader/src/ai-context.js", import.meta.url), "utf8");
const aiRenderSource = fs.readFileSync(new URL("../packages/reader/src/ai-render.js", import.meta.url), "utf8");
const viewSource = fs.readFileSync(new URL("../packages/reader/src/reader-view.js", import.meta.url), "utf8");
const modalSource = fs.readFileSync(new URL("../packages/reader/src/reader-modal.js", import.meta.url), "utf8");
const explainModalSource = fs.readFileSync(new URL("../packages/reader/src/ai-explain-modal.js", import.meta.url), "utf8");
const chatViewSource = fs.readFileSync(new URL("../packages/reader/src/ai-chat-view.js", import.meta.url), "utf8");
const noteTitleSource = fs.readFileSync(new URL("../packages/reader/src/note-title-modal.js", import.meta.url), "utf8");
const streamingSource = fs.readFileSync(new URL("../packages/reader/src/ai-streaming-markdown.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function dom() {
  const { window } = new JSDOM("<main></main>");
  const proto = window.HTMLElement.prototype;
  proto.createEl = function(tag, opts = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (typeof opts === "string") el.className = opts;
    else { el.className = opts.cls || ""; el.textContent = opts.text || ""; }
    this.append(el);
    return el;
  };
  proto.createDiv = function(opts) { return this.createEl("div", opts); };
  proto.createSpan = function(opts) { return this.createEl("span", opts); };
  proto.addClass = function(...names) { this.classList.add(...names); };
  proto.removeClass = function(...names) { this.classList.remove(...names); };
  proto.setText = function(text) { this.textContent = text; };
  proto.empty = function() { this.replaceChildren(); };
  proto.setCssProps = function(props) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); };
  return window;
}

function composer() {
  const window = dom();
  const input = window.document.createElement("textarea");
  const send = window.document.createElement("button");
  window.document.body.append(input, send);
  const calls = [];
  let settle;
  const chat = {
    busy: false, canCancel: true, _setSending() {},
    async _send(text) {
      this.busy = true;
      calls.push(text);
      const result = await new Promise((resolve) => { settle = resolve; });
      this.busy = false;
      return result;
    },
  };
  bindAiComposer(input, send, chat);
  const enter = (opts = {}) => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...opts }));
  const type = (text) => { input.value = text; input.dispatchEvent(new window.Event("input")); };
  return { window, input, send, chat, calls, enter, type, finish: (result) => settle(result) };
}

test("quick prompts send immediately, preserve existing drafts, and remain visible while busy", () => {
  const renderSource = aiRenderSource.slice(aiRenderSource.indexOf("function contextualAiQuickPrompts("), aiRenderSource.indexOf("function bindAiSlashPrompts("));
  const sendingStart = explainModalSource.indexOf("  _setSending(busy) {");
  const sendingSource = explainModalSource.slice(sendingStart, explainModalSource.indexOf("\n  _watchKeyboard() {", sendingStart));
  const items = ["解释一下", "举个例子", "总结要点", "自定义问题"].map((name) => ({ name, prompt: `prompt:${name}` }));
  let menu;
  class Menu {
    constructor() { this.entries = []; menu = this; }
    addItem(build) {
      const entry = { setTitle(title) { this.title = title; return this; }, onClick(fn) { this.click = fn; return this; } };
      build(entry); this.entries.push(entry);
    }
    showAtMouseEvent() {}
  }
  const iconsSource = fs.readFileSync(new URL("../packages/reader/src/reader-icons.js", import.meta.url), "utf8");
  const runtimeIcon = vm.runInNewContext(iconsSource.slice(iconsSource.indexOf("function icon(n)")) + "\nicon");
  const sandbox = { isNonChineseSource, docOf: el => el.ownerDocument, aiQuickPrompts: () => items, translate: (s) => s, qiaomuReaderTranslate: (s) => s, Menu, svgIcon(host, name) { host.innerHTML = runtimeIcon(name); } };
  const helpers = vm.runInNewContext(`${renderSource}\n({renderAiComposerPrompts})`, sandbox);
  const render = helpers.renderAiComposerPrompts;
  const setSending = vm.runInNewContext(`({${sendingSource}})._setSending`, sandbox);
  for (const turns of [[], [{ role: "assistant", content: "Existing answer" }]]) {
    const window = dom();
    const host = window.document.querySelector("main");
    const calls = [];
    const send = window.document.createElement("button");
    send.toggleClass = (name, enabled) => send.classList.toggle(name, enabled);
    const chat = { plugin: { settings: {} }, turns, _send: (prompt) => calls.push(prompt), sendEl: send, canCancel: true };
    chat.inputEl = host.createEl("textarea");
    const row = render(host, chat);
    assert.equal(row.hidden, false);
    assert.equal(host.querySelector(".qiaomu-reader-ai-prompt-expand"), null);
    assert.equal(chat.quickPromptButtons.length, 4);
    chat.quickPromptButtons[0].click();
    assert.deepEqual(calls, [items[0].prompt], "choosing a suggestion sends immediately");
    chat.inputEl.value = "my existing question";
    chat.quickPromptButtons[1].click();
    assert.equal(chat.inputEl.value, "my existing question", "existing draft is not overwritten");
    chat.busy = true;
    setSending.call(chat, true);
    assert.ok(send.querySelector("svg rect"), "stop generation must have a visible square icon");
    assert.equal(row.hidden, false, "suggestions retain their position during generation");
    assert.ok(chat.quickPromptButtons.every((button) => button.disabled));
    chat.quickPromptButtons[1].click();
    assert.equal(calls.length, 2);
    chat.busy = false;
    chat.inputEl.value = "";
    setSending.call(chat, false);
    assert.equal(row.hidden, false);
    assert.ok(chat.quickPromptButtons.every((button) => !button.disabled));
    chat.quickPromptButtons[3].click();
    assert.equal(menu.entries[0].title, "自定义问题");
    menu.entries[0].click();
    assert.equal(calls.at(-1), items[3].prompt);
    chat.pendingContext = { text: "Reading is a conversation with the author." };
    const refreshedRow = render(host, chat);
    assert.equal(row.isConnected, false, "refresh replaces the old prompt row in place");
    assert.equal(host.querySelectorAll(".qiaomu-reader-ai-composer-prompts").length, 1);
    assert.equal(chat.quickPromptButtons.length, 4);
    assert.equal(refreshedRow.isConnected, true);
  }
  items.length = 0;
  const host = dom().document.querySelector("main");
  assert.equal(render(host, { plugin: { settings: {} } }), null);
  assert.equal(host.children.length, 0, "empty settings do not leave an unused expander");
  assert.doesNotMatch(source, /promptExpand|promptRow/);
});

test("IME candidate confirmation, Shift+Enter and composing keyCode do not submit", async () => {
  const c = composer();
  c.type("解释这段话");
  c.input.dispatchEvent(new c.window.CompositionEvent("compositionstart"));
  c.enter();
  c.input.dispatchEvent(new c.window.CompositionEvent("compositionend"));
  c.enter({ isComposing: true });
  c.enter({ keyCode: 229 });
  c.enter({ shiftKey: true });
  assert.deepEqual(c.calls, []);
  assert.equal(c.input.value, "解释这段话");
  c.enter();
  assert.deepEqual(c.calls, ["解释这段话"]);
  c.finish(true);
  await tick();
});

test("Enter during generation preserves the next draft; an earlier failure does not overwrite it", async () => {
  const c = composer();
  c.type("第一个问题");
  c.enter();
  c.type("尚未发送的追问");
  c.enter();
  assert.equal(c.input.value, "尚未发送的追问");
  assert.equal(c.calls.length, 1);
  c.finish(false);
  await tick();
  assert.equal(c.input.value, "尚未发送的追问");
});

test("failed sends restore untouched input, but respect a deliberately cleared draft", async () => {
  const c = composer();
  c.type("请解释");
  c.enter();
  c.finish(false);
  await tick();
  assert.equal(c.input.value, "请解释");
  c.enter();
  c.type("新草稿");
  c.type("");
  c.finish(false);
  await tick();
  assert.equal(c.input.value, "");
});

function chatHarness(explain, overrides = {}) {
  const window = dom();
  const context = {
    window, AbortController, Modal: class {}, console: { error() {} },
    qiaomuReaderTranslate: (s) => s, translate: (s) => s, newAiSessionKey: () => window.crypto.randomUUID(),
    normalizeAiTurnContext: (value) => value ? { ...value } : null,
    svgIcon() {}, verifiedQuotes, aiExplain: explain, copyToClipboard: async () => true, Notice: class {},
    createNoteFromAiAnswer: async () => null,
    prepareAiTurns: async (_chat, turns) => ({ turns: turns || [], vision: false }),
    aiTurnsHaveAttachments: (turns) => (turns || []).some((turn) => turn?.attachments?.length > 0),
    prepareAiTools: null,
    aiExplainStep: null,
    readerAiPosition: () => null,
    renderAiToolStep: () => ({ card: null, finish() {} }),
    stripAiAttachmentData: (list) => list || [],
    renderAiAttachmentList: () => ({ row: null, empty: true }),
    removeAiAttachment: async () => {},
    noteAiImageFailure: async () => {},
    renderAiUserTurn: (log, turn) => log.createDiv({ cls: "qiaomu-reader-ai-msg-me", text: turn.content }),
    createAiStreamingMarkdownRenderer: (_owner, el, _path, opts) => ({
      update(text) { const follow = opts.beforeRender(); el.setText(text); opts.afterRender(follow); },
      async finish(text) { const follow = opts.beforeRender(); el.setText(text); opts.afterRender(follow); },
      dispose() {},
    }),
    ...overrides,
  };
  const helpers = aiRenderSource.slice(aiRenderSource.indexOf("function aiLogFollowsTail("), aiRenderSource.indexOf("const createAiStreamingMarkdownRenderer = createAiStreamingMarkdownRendererFactory({"));
  // The explain modal lives in its own module now: evaluate its factory with
  // the same stubs, reusing the sliced chat helpers as ports.
  const explainFactory = explainModalSource.slice(explainModalSource.indexOf("export function createAiExplainModal(")).replace("export function", "function");
  const portNames = explainFactory.slice(explainFactory.indexOf("{") + 1, explainFactory.indexOf("})")).split(",").map((name) => name.trim()).filter(Boolean);
  const ports = `{ ${portNames.map((name) => `${name}: typeof ${name} === \"undefined\" ? undefined : ${name}`).join(", ")} }`;
  const { Chat, createLog } = vm.runInNewContext(`${helpers}\n${explainFactory}\n({ Chat: createAiExplainModal(${ports}), createLog: createAiChatLog })`, context);
  const chat = Object.create(Chat.prototype);
  Object.assign(chat, { plugin: { settings: {} }, app: {}, turns: [], structuredContext: true,
    book: "测试书", bookFile: { path: "books/test.epub" },
    pendingContext: { kind: "selection", text: "原文" },
    aiSessionKey: "initial", _setSending() {}, persisted: 0,
    async _persistSession() { this.persisted += 1; },
  });
  chat.log = createLog(window.document.querySelector("main"), chat);
  return { chat, window };
}

test("a prepared workshop task renders its preview after the final answer", async () => {
  const steps = [
    {
      answer: "我先准备。",
      toolCalls: [{ id: "call-1", name: "prepare_workshop_task", arguments: { operation: "把文档做成答题页" } }],
    },
    { answer: "预览已生成，请确认。", toolCalls: [] },
  ];
  let pending = null;
  const { chat } = chatHarness(async () => "", {
    aiExplainStep: async () => steps.shift(),
    prepareAiTools: async () => ({
      definitions: [],
      async run() {
        return {
          text: "准备开始：制作 AI 答题页",
          blocks: [{ type: "text", text: "准备开始：制作 AI 答题页" }],
          images: [],
          confirmation: { operation: "把文档做成答题页", label: "确认开始" },
          preview: {
            operation: "制作 AI 答题页",
            summary: "识别题目并生成答题页。",
            source: "2026江苏",
            output: "2026江苏.AI答题页.html",
          },
        };
      },
    }),
    renderAiWorkshopPreview: (log, value) => {
      pending = value;
      return log.createDiv({ cls: "preview-test", text: `预览：${value.preview.output}` });
    },
  });
  assert.equal(await chat._send("把这份试卷做成答题页"), true);
  assert.equal(pending.preview.output, "2026江苏.AI答题页.html");
  assert.equal(pending.confirmation.operation, "把文档做成答题页");
  const text = chat.log.textContent;
  assert.ok(text.indexOf("预览已生成") >= 0);
  assert.ok(text.indexOf("预览已生成") < text.indexOf("预览：2026江苏.AI答题页.html"),
    "the confirmable preview must come after the model's explanation");
  assert.ok(chat.log.querySelector(".preview-test"));
});

test("mobile AI header owns a safe close control that closes once", () => {
  const window = dom();
  const helper = aiRenderSource.slice(aiRenderSource.indexOf("function renderMobileAiHeader("), aiRenderSource.indexOf("function renderAiUserTurn(log, turn, owner = null) {"));
  const render = vm.runInNewContext(`${helper}\nrenderMobileAiHeader`, {
    translate: (key) => key,
    renderAiHeadMeta() {},
    svgIcon(button, name) { button.dataset.icon = name; },
    openReadSettings() {},
    openPluginAiSettings() {},
  });
  const host = window.document.querySelector("main");
  let closed = 0;
  let bubbled = 0;
  host.addEventListener("click", () => { bubbled += 1; });
  const { close } = render(host, { app: {}, plugin: {}, readerView: null, close() { closed += 1; } });
  assert.equal(host.querySelector(".qiaomu-reader-ai-head-actions")?.lastElementChild, close);
  assert.equal(close.dataset.icon, "x");
  assert.equal(close.getAttribute("aria-label"), "close");
  close.click();
  assert.equal(closed, 1);
  assert.equal(bubbled, 0);
  window.close();
});

for (const reason of ["cancelled", "timeout", "http"]) {
  test(`${reason} keeps partial Markdown, source, actions and history`, async () => {
    const { chat } = chatHarness(async (_text, _plugin, _turns, _book, { onDelta }) => {
      onDelta({ content: "## 已输出\n\n有价值的内容" });
      throw Object.assign(new Error(reason), { qiaomuReaderReason: reason });
    });
    assert.equal(await chat._send("解释原文"), true);
    assert.equal(chat.turns.length, 2);
    assert.equal(chat.turns[0].context.text, "原文");
    assert.equal(chat.turns[1].content, "## 已输出\n\n有价值的内容");
    assert.equal(chat.turns[1].interrupted, true);
    assert.match(chat.log.textContent, /有价值的内容/);
    assert.equal(chat.log.querySelectorAll(".qiaomu-reader-ai-act").length, 3);
    assert.equal(chat.busy, false);
    assert.equal(chat.persisted, 1);
    assert.notEqual(chat.aiSessionKey, "initial");
  });
}

test("a failure before content leaves no unanswered model turn", async () => {
  const { chat } = chatHarness(async () => { throw Object.assign(new Error(), { qiaomuReaderReason: "timeout" }); });
  assert.equal(await chat._send("解释原文"), false);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.busy, false);
});

test("old answer regeneration cannot mutate a later question", async () => {
  const { chat } = chatHarness(async () => "回答");
  await chat._send("问题一");
  const oldButton = chat.log.querySelector(".qiaomu-reader-ai-regenerate");
  await chat._send("问题二");
  assert.equal(oldButton.isConnected, false);
  oldButton.click();
  assert.equal(chat.turns.length, 4);
  assert.equal(chat.turns[2].content, "问题二");
  assert.equal(chat.log.querySelectorAll(".qiaomu-reader-ai-regenerate").length, 1);
});

test("answer completion respects reading earlier text and offers a jump back", async () => {
  let finish;
  const { chat, window } = chatHarness(async () => new Promise((resolve) => { finish = resolve; }));
  Object.defineProperties(chat.log, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  const running = chat._send("问题");
  chat.log.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100 }));
  chat.log.scrollTop = 100;
  chat.log.dispatchEvent(new window.Event("scroll"));
  finish("完成的回答");
  await running;
  assert.equal(chat.log.scrollTop, 100);
  const jump = window.document.querySelector(".qiaomu-reader-ai-jump-latest");
  assert.equal(jump.hidden, false);
  jump.click();
  assert.equal(chat.log.scrollTop, 1000);
  assert.equal(jump.hidden, true);
});

test("saving an answer writes once, keeps the conversation open, and opens only on a second click", async () => {
  let saved;
  let writes = 0;
  let opens = 0;
  let closes = 0;
  const { chat } = chatHarness(async () => "AI 回答正文", {
    createNoteFromAiAnswer: async (...args) => { writes++; saved = args; return { path: "notes/answer.md" }; },
  });
  chat.app.workspace = { async openLinkText(path) { opens++; assert.equal(path, "notes/answer.md"); } };
  chat.app.vault = { getAbstractFileByPath: (path) => ({ path }) };
  chat.close = () => { closes++; };
  await chat._send("为什么");
  const button = [...chat.log.querySelectorAll(".qiaomu-reader-ai-act")].find((el) => el.textContent === "save-ai-response");
  button.click();
  await tick();
  assert.equal(saved[2], "AI 回答正文");
  assert.equal(saved[3], "为什么");
  assert.equal(saved[4].text, "原文");
  assert.equal(saved[6].open, false);
  assert.equal(button.textContent, "saved-open-note");
  assert.equal(opens, 0);
  assert.equal(closes, 0);
  button.click();
  await tick();
  assert.equal(opens, 1);
  assert.equal(writes, 1);
});

test("sending refreshes the page once and freezes source while generation continues", async () => {
  let finish;
  const { chat } = chatHarness(async () => new Promise((resolve) => { finish = resolve; }));
  chat._prepareContext = () => { chat.pendingContext = { kind: "page", text: "发送瞬间页面" }; };
  const pending = chat._send("解释");
  chat.pendingContext.text = "后来翻到的页面";
  assert.equal(chat.turns[0].context.text, "发送瞬间页面");
  finish("回答");
  await pending;
  assert.equal(chat.turns[0].context.text, "发送瞬间页面");
});

test("the position at submit time is attached to that turn", async () => {
  let turnsAtRequest = null;
  const { chat } = chatHarness(async (_text, _plugin, turns) => {
    turnsAtRequest = turns.map((turn) => turn.location || null);
    return "回答";
  }, {
    readerAiPosition: () => ({ label: "第三章", page: 12, percent: 0.34 }),
  });
  await chat._send("这里是什么意思？");
  assert.deepEqual(chat.turns[0].location, { label: "第三章", page: 12, percent: 0.34 });
  assert.equal(chat.turns[1].role, "assistant");
  assert.equal("location" in chat.turns[1], false, "only the question carries the position");
  assert.deepEqual(turnsAtRequest, [{ label: "第三章", page: 12, percent: 0.34 }]);
});

test("a tool-calling round runs the tool and answers with its results", async () => {
  const calls = [];
  let steps = 0;
  const { chat } = chatHarness(async () => "should not be used", {
    prepareAiTools: async () => ({
      definitions: [{ name: "search_book", description: "search", parameters: { type: "object" } }],
      run: async (name, args) => {
        calls.push([name, args]);
        return { text: "命中：Alice 掉进兔子洞", isError: false };
      },
    }),
    aiExplainStep: async (_text, _plugin, turns, _book, options) => {
      steps += 1;
      assert.equal(options.tools.length, 1, "the tool schemas travel with the round");
      if (turns.some((turn) => turn.role === "tool")) return { answer: "最终答案", toolCalls: [] };
      return { answer: "我查一下。", toolCalls: [{ id: "call_1", name: "search_book", arguments: { query: "Alice" } }] };
    },
  });
  assert.equal(await chat._send("Alice 在哪里出现"), true);
  assert.equal(steps, 2, "one tool round plus the final answer");
  assert.deepEqual(calls, [["search_book", { query: "Alice" }]]);
  const kinds = chat.turns.map((turn) => turn.role);
  assert.deepEqual(kinds, ["user", "assistant", "tool", "assistant"]);
  assert.deepEqual(chat.turns[1].toolCalls, [{ id: "call_1", name: "search_book", arguments: { query: "Alice" } }]);
  assert.equal(chat.turns[2].toolCallId, "call_1");
  assert.equal(chat.turns[2].content, "命中：Alice 掉进兔子洞");
  assert.equal(chat.turns[3].content, "最终答案");
});

test("answer save captures its original book and retains saved-note metadata", async () => {
  let args;
  const { chat } = chatHarness(async () => "回答", {
    createNoteFromAiAnswer: async (...value) => { args = value; return { path: "notes/original.md" }; },
  });
  const book = chat.bookFile;
  await chat._send("问题");
  chat.bookFile = { path: "books/another.epub" };
  chat.log.querySelectorAll(".qiaomu-reader-ai-act")[1].click();
  await tick();
  assert.equal(args[5], book);
  assert.equal(chat.turns[1].savedNotePath, "notes/original.md");
});

test("re-rendering a saved reply opens its existing note; a deleted note can be saved again", async () => {
  let writes = 0, opens = 0, exists = true;
  const { chat } = chatHarness(async () => "回答", {
    createNoteFromAiAnswer: async () => { writes++; return { path: "notes/saved.md" }; },
  });
  chat.app.vault = { getAbstractFileByPath: (path) => exists ? { path } : null };
  chat.app.workspace = { async openLinkText() { opens++; } };
  await chat._send("问题");
  chat.turns[1].savedNotePath = "notes/saved.md";
  const group = chat.log.createDiv();
  chat._actions(group, "回答", { turn: chat.turns[0], answerTurn: chat.turns[1] });
  const save = group.querySelectorAll("button")[1];
  assert.equal(save.textContent, "saved-open-note");
  save.click();
  await tick();
  assert.equal(opens, 1);
  assert.equal(writes, 0);
  exists = false;
  save.click();
  await tick();
  assert.equal(writes, 1);
});

function sidebarHarness() {
  const window = dom();
  class File { constructor(path) { this.path = path; this.basename = path; } }
  const files = new Map(["a.epub", "b.epub"].map((path) => [path, new File(path)]));
  const normalize = aiContextSource.slice(aiContextSource.indexOf("function normalizeAiChatHistory("), aiContextSource.indexOf("function aiChatTitle("));
  // The chat view lives in its own module now: evaluate its factory with the
  // same stubs, reusing the sliced helpers as ports.
  const chatViewFactory = chatViewSource.slice(chatViewSource.indexOf("export function createAiChatView(")).replace("export function", "function");
  const chatPortNames = chatViewFactory.slice(chatViewFactory.indexOf("{") + 1, chatViewFactory.indexOf("})")).split(",").map((name) => name.trim()).filter(Boolean);
  const chatPorts = `{ ${chatPortNames.map((name) => `${name}: typeof ${name} === "undefined" ? undefined : ${name}`).join(", ")} }`;
  const context = {
    window, ItemView: class {}, TFile: File, qiaomuReaderTranslate: (s) => s, Notice: class {}, svgIcon() {},
    normalizeAiTurnContext: (value) => value?.text ? { kind: value.kind, text: value.text } : null,
    normalizeAiAttachments: (value) => (Array.isArray(value) ? value : []),
    stripAttachmentData: (value) => value || [],
    normalizeToolTurnContent: (value) => String(value || ""),
    normalizeAiTurnLocation: (value) => (value && (value.page || value.label)
      ? { label: value.label || "", page: value.page || 0, percent: value.percent || 0 }
      : null),
    newAiSessionKey: () => window.crypto.randomUUID(), aiChatTitle: () => "会话",
    clearAiSource() {}, readerHud: { autoFocus() {} }, shouldFollowContext,
    bookNoteLinkFor: () => "", aiTurnsHaveDocumentContext: (turns) => turns.some((turn) => turn.context?.kind === "document"),
    readerDefaultAiContext: () => ({ kind: "page", text: "当前页" }),
    renderAiUserTurn: (log, turn) => log.createDiv({ cls: "qiaomu-reader-ai-msg-me", text: turn.content }),
    renderAiMarkdown: async (_owner, element, text) => element.setText(text),
    renderAiWorkshopPreview: (log, pending) => log.createDiv({ cls: "preview-test", text: `预览：${pending.preview.output}` }),
    renderAiHeadMeta: () => {},
    setIcon: () => {},
  };
  const { Chat, normalizeHistory } = vm.runInNewContext(`${normalize}\n${chatViewFactory}\n({ Chat: createAiChatView(${chatPorts}), normalizeHistory: normalizeAiChatHistory })`, context);
  const texts = new Map();
  const chat = new Chat({}, { settings: { aiChatHistory: [] }, aiDraftStore: { texts, set: (key, text) => texts.set(key, text) }, async saveAll() {} });
  chat.app = { vault: { getAbstractFileByPath: (path) => files.get(path) } };
  chat.contentEl = window.document.querySelector("main");
  chat._renderConversation = function() {
    this.contentEl.empty();
    this.inputEl = this.contentEl.createEl("textarea");
    this.pendingContextHost = this.contentEl.createDiv();
  };
  chat._refreshPendingContext = () => {};
  chat._renderUnavailable = () => chat.contentEl.empty();
  return { chat, files, normalizeHistory };
}

test("a stored conversation keeps its workshop preview", () => {
  const { chat, normalizeHistory } = sidebarHarness();
  const preview = {
    operation: "制作 AI 答题页",
    summary: "识别题目并生成答题页。",
    source: "2026江苏",
    output: "2026江苏.AI答题页.html",
  };
  chat.turns = [
    { role: "user", content: "把这份试卷做成答题页" },
    {
      role: "assistant",
      content: "预览已生成。",
      workshopPreview: preview,
      workshopConfirmation: { operation: "把文档做成答题页", label: "确认开始" },
      workshopPreviewId: "call-1",
    },
  ];
  chat._actions = () => {};
  chat.log = chat.contentEl;
  chat._renderStoredTurns();
  const card = chat.log.querySelector(".preview-test");
  assert.ok(card, "a restored reply must keep its preview card");
  assert.match(card.textContent, /2026江苏\.AI答题页\.html/);
  const stored = normalizeHistory([{
    id: "session-1",
    title: "会话",
    bookPath: "a.epub",
    contextVersion: 1,
    turns: chat.turns,
  }])[0];
  assert.equal(stored.turns[1].workshopPreview.operation, "制作 AI 答题页");
  assert.equal(stored.turns[1].workshopPreview.output, "2026江苏.AI答题页.html");
  assert.equal(stored.turns[1].workshopPreviewId, "call-1");
  chat._markWorkshopPreviewDone("call-1", "task-1");
  assert.equal(chat.turns[1].workshopPreviewDone, true);
  assert.equal(chat.turns[1].workshopTaskId, "task-1");
});

test("an older stored reply without preview metadata still gets a confirm card", () => {
  const { chat } = sidebarHarness();
  chat.turns = [
    { role: "user", content: "把这份试卷做成答题页" },
    {
      role: "assistant",
      content: "我先准备一下。",
      toolCalls: [{ id: "call-old", name: "prepare_workshop_task", arguments: { operation: "把文档做成答题页" } }],
    },
    {
      role: "tool",
      toolCallId: "call-old",
      content: "准备开始：制作 AI 答题页\n用 AI 识别题目并生成答题页。\n来源：2026江苏\n结果：2026江苏.AI答题页.html\n还没有开始，也不会修改原文件。",
    },
    { role: "assistant", content: "如果确认没问题，点击确认按钮。" },
  ];
  chat._actions = () => {};
  chat.log = chat.contentEl;
  chat._renderStoredTurns();
  const card = chat.log.querySelector(".preview-test");
  assert.ok(card, "a historical prepare result should still be confirmable");
  assert.match(card.textContent, /2026江苏\.AI答题页\.html/);
});

test("a finished AI task appears as a normal conversation message", () => {
  const { chat, files } = sidebarHarness();
  chat.bookFile = files.get("a.epub");
  chat.log = chat.contentEl;
  chat._scroll = () => {};
  assert.equal(chat.showWorkshopTaskFinished({
    id: "task-1",
    status: "done",
    origin: "assistant",
    kind: "quiz-llm-export",
    title: "AI 答题页",
    bookPath: "a.epub",
    detail: "AI 生成 · 0 MathML · 21 图片内联",
    output: "C:/Users/me/Downloads/2026江苏.AI答题页.html",
  }), true);
  const message = chat.log.querySelector(".qiaomu-reader-ai-msg-ai .qiaomu-reader-ai-msg-text");
  assert.ok(message);
  assert.match(message.textContent, /任务完成/);
  assert.match(message.textContent, /C:\/Users\/me\/Downloads\/2026江苏\.AI答题页\.html/);
  assert.match(message.textContent, /书坊 → 任务/);
  assert.equal(chat.showWorkshopTaskFinished({ id: "task-1", status: "done", bookPath: "a.epub" }), true);
  assert.equal(chat.turns.filter((turn) => turn.taskCompletion?.id === "task-1").length, 1);
});

test("a completion never appears in another document's conversation", () => {
  const { chat, files } = sidebarHarness();
  chat.bookFile = files.get("b.epub");
  chat.log = chat.contentEl;
  chat._scroll = () => {};
  const task = {
    id: "task-other-book",
    status: "done",
    origin: "assistant",
    kind: "docvortex-convert",
    title: "把文档转成 Word",
    bookPath: "a.epub",
    output: "C:/Users/me/Downloads/a.docx",
  };
  assert.equal(chat.showWorkshopTaskFinished(task), false);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.log.querySelector(".qiaomu-reader-ai-msg-text"), null);
  // An older task without a document identity is equally unsafe to place.
  assert.equal(chat.showWorkshopTaskFinished({ ...task, id: "task-legacy", bookPath: "" }), false);
  assert.equal(chat.turns.length, 0);
  chat.bookFile = files.get("a.epub");
  assert.equal(chat.showWorkshopTaskFinished(task), true);
  assert.match(chat.log.textContent, /a\.docx/);
});

test("a completion recorded while detached renders when the sidebar returns", () => {
  const { chat, files } = sidebarHarness();
  chat.bookFile = files.get("a.epub");
  const detached = chat.contentEl.ownerDocument.createElement("div");
  chat.log = detached;
  chat._scroll = () => {};
  const task = {
    id: "task-detached",
    status: "done",
    origin: "assistant",
    kind: "quiz-llm-export",
    title: "AI 答题页",
    bookPath: "a.epub",
    output: "C:/Users/me/Downloads/detached.AI答题页.html",
  };
  assert.equal(chat.showWorkshopTaskFinished(task), false);
  assert.equal(chat.turns.filter((turn) => turn.taskCompletion?.id === task.id).length, 1);
  chat.log = chat.contentEl;
  assert.equal(chat.showWorkshopTaskFinished(task), true);
  assert.equal(chat.log.querySelectorAll(".qiaomu-reader-ai-msg-text").length, 1);
  assert.equal(chat.turns.filter((turn) => turn.taskCompletion?.id === task.id).length, 1);
});

test("a completion that arrived while the sidebar was closed appears when it opens", () => {
  const { chat, files } = sidebarHarness();
  chat.bookFile = files.get("a.epub");
  chat.plugin._aiTaskCompletions = [{
    id: "task-queued",
    status: "done",
    origin: "assistant",
    kind: "quiz-llm-export",
    title: "AI 答题页",
    bookPath: "a.epub",
    output: "C:/Users/me/Downloads/queued.AI答题页.html",
  }];
  chat.log = chat.contentEl;
  chat._scroll = () => {};
  chat._flushTaskCompletions();
  assert.equal(chat.plugin._aiTaskCompletions.length, 1, "completion stays available for the next render");
  assert.equal(chat.turns.filter((turn) => turn.taskCompletion?.id === "task-queued").length, 1);
  assert.match(chat.log.textContent, /queued\.AI答题页\.html/);
  chat._flushTaskCompletions();
  assert.equal(chat.turns.filter((turn) => turn.taskCompletion?.id === "task-queued").length, 1, "the same view does not duplicate messages");
});

test("completion messages are stored with the conversation", async () => {
  const { chat, files, normalizeHistory } = sidebarHarness();
  chat.bookFile = files.get("a.epub");
  chat.turns = [{ role: "user", content: "做成答题页" }, { role: "assistant", content: "已提交" }];
  chat.log = chat.contentEl;
  chat._scroll = () => {};
  const output = "C:/Users/me/Downloads/queued.AI答题页.html";
  chat.showWorkshopTaskFinished({
    id: "task-persisted",
    status: "done",
    origin: "assistant",
    kind: "quiz-llm-export",
    title: "AI 答题页",
    bookPath: "a.epub",
    detail: "a.epub",
    output,
  });
  await chat._persistSession();
  const stored = normalizeHistory(chat.plugin.settings.aiChatHistory)[0];
  const completion = stored.turns.find((turn) => turn.taskCompletion?.id === "task-persisted");
  assert.ok(completion);
  assert.equal(completion.taskCompletion.output, output);
  assert.equal(completion.taskCompletion.bookPath, "a.epub");
  assert.match(completion.content, /文件：C:\/Users\/me\/Downloads\/queued\.AI答题页\.html/);
});

test("stored history drops completions from another document or without an owner", () => {
  const { normalizeHistory } = sidebarHarness();
  const stored = normalizeHistory([{
    id: "session-books",
    title: "会话",
    bookPath: "a.epub",
    contextVersion: 1,
    turns: [
      { role: "user", content: "问题" },
      { role: "assistant", content: "另一个文档的完成消息", taskCompletion: { id: "task-b", bookPath: "b.epub" } },
      { role: "assistant", content: "旧版没有文档信息的完成消息", taskCompletion: { id: "task-old" } },
      { role: "assistant", content: "旧预览", workshopPreview: { operation: "转换" }, workshopTaskId: "task-old-owned" },
      { role: "assistant", content: "旧版但可确认属于本文档的完成消息", taskCompletion: { id: "task-old-owned" } },
      { role: "assistant", content: "本文档的完成消息", taskCompletion: { id: "task-a", bookPath: "a.epub" } },
    ],
  }])[0];
  assert.equal(JSON.stringify(stored.turns.map((turn) => turn.taskCompletion?.id || turn.content)), JSON.stringify(["问题", "旧预览", "task-old-owned", "task-a"]));
  assert.equal(stored.turns[2].taskCompletion.bookPath, "a.epub");
});

test("switching books isolates drafts, including returning to stored history", async () => {
  const { chat, files } = sidebarHarness();
  const select = (path) => chat.setContext({ kind: "page", text: path, bookFile: files.get(path) });
  select("a.epub");
  chat.inputEl.value = "A 的未发送草稿";
  chat.turns = [{ role: "user", content: "A问题" }, { role: "assistant", content: "A回答" }];
  select("b.epub");
  assert.equal(chat.inputEl.value, "");
  chat.inputEl.value = "B 的未发送草稿";
  select("a.epub");
  assert.equal(chat.inputEl.value, "A 的未发送草稿");
  assert.equal(chat.turns[1].content, "A回答");
  select("b.epub");
  assert.equal(chat.inputEl.value, "B 的未发送草稿");
  chat._newChat();
  assert.equal(chat.inputEl.value, "B 的未发送草稿");
  assert.equal(chat.turns.length, 0);
});

test("manual conversation titles survive persistence and reset for new conversations", async () => {
  const { chat, files, normalizeHistory } = sidebarHarness();
  chat.bookFile = files.get("a.epub");
  const session = { id: "renamed", title: "我自己的标题", titleEdited: true, bookPath: "a.epub", contextVersion: 1, turns: [{ role: "user", content: "问题" }, { role: "assistant", content: "答案" }] };
  chat.loadSession(session, { skipPersist: true });
  await chat._persistSession();
  assert.equal(chat.plugin.settings.aiChatHistory[0].title, "我自己的标题");
  assert.equal(normalizeHistory(chat.plugin.settings.aiChatHistory)[0].titleEdited, true);
  chat._newChat();
  assert.equal(chat.sessionTitle, "");
});

test("switching books before a send settles cannot erase the recoverable question", () => {
  const { chat, files } = sidebarHarness();
  chat.setContext({ kind: "page", text: "A", bookFile: files.get("a.epub") });
  chat.plugin.aiDraftStore.set("a.epub", "尚未确认发送的问题");
  chat.inputEl.value = "";
  chat.busy = false;
  chat.inputController = { pending: true };
  chat._rememberDraft();
  assert.equal(chat.drafts.get("a.epub"), "尚未确认发送的问题");
});

test("explicitly detached sources stay detached after persistence and normalization", async () => {
  const { chat, normalizeHistory } = sidebarHarness();
  chat.text = "旧页面";
  chat.turns = [{ role: "user", content: "不引用的问题" }, { role: "assistant", content: "回答", savedNotePath: "notes/a.md" }];
  await chat._persistSession();
  const [record] = normalizeHistory(chat.plugin.settings.aiChatHistory);
  assert.equal(record.turns[0].context, undefined);
  assert.equal(record.turns[1].savedNotePath, "notes/a.md");
  const [legacy] = normalizeHistory([{ id: "old", text: "旧版原文", turns: chat.turns }]);
  assert.equal(legacy.turns[0].context.text, "旧版原文");
});

test("deleting the active history starts fresh without resurrecting it", async () => {
  const { chat, files } = sidebarHarness();
  chat.setContext({ kind: "page", text: "正文", bookFile: files.get("a.epub") });
  chat.turns = [{ role: "user", content: "问题" }, { role: "assistant", content: "回答" }];
  await chat._persistSession();
  const id = chat.chatRecordId;
  await chat._removeHistory((item) => item.id === id);
  assert.equal(chat.turns.length, 0);
  await chat._persistSession();
  assert.equal(chat.plugin.settings.aiChatHistory.length, 0);
});

test("failed history deletion preserves the current conversation and stored items", async () => {
  const { chat } = sidebarHarness();
  chat.turns = [{ role: "user", content: "问题" }, { role: "assistant", content: "回答" }];
  await chat._persistSession();
  chat.plugin.saveAll = async () => { throw new Error("disk full"); };
  await chat._removeHistory(() => true);
  assert.equal(chat.turns.length, 2);
  assert.equal(chat.plugin.settings.aiChatHistory.length, 1);
  assert.equal(chat._historySaving, false);
  await chat._persistSession();
  assert.equal(chat._historySaveFailed, true);
});

test("note-saving integration uses the answer topic, never the generic question", async () => {
  let result;
  const bookNotesSource = fs.readFileSync(new URL("../packages/reader/src/book-notes.js", import.meta.url), "utf8");
  const fn = bookNotesSource.slice(bookNotesSource.indexOf("async function createNoteFromAiAnswer("), bookNotesSource.indexOf("function _escHtml("));
  const save = vm.runInNewContext(`${fn}\ncreateNoteFromAiAnswer`, {
    translate: (s) => s, qiaomuReaderTranslate: (s) => s, suggestAiNoteTitle,
    normalizeAiTurnContext: (context) => context,
    createNoteFromSelection: (...args) => { result = args; },
  });
  const answer = "## 重要性如何放大紧张\n\n**紧张会损害决策质量。**";
  await save({}, {}, answer, "解释一下", { text: "书中原文" }, { path: "a.epub" });
  assert.equal(result[2], "重要性如何放大紧张");
  assert.equal(result[4].noteBody, answer);
  assert.equal(result[4].sourceText, "书中原文");
});

function titleModal() {
  const window = dom();
  const results = [];
  class Modal {
    constructor() { this.contentEl = window.document.querySelector("main"); }
    close() { this.onClose(); }
  }
  // The note title modal lives in its own module now.
  const noteTitleFactory = noteTitleSource.slice(noteTitleSource.indexOf("export function createNoteTitleModal(")).replace("export function", "function");
  const noteTitlePorts = noteTitleFactory.slice(noteTitleFactory.indexOf("{") + 1, noteTitleFactory.indexOf("})")).split(",").map((name) => name.trim()).filter(Boolean);
  const noteTitlePortExpr = `{ ${noteTitlePorts.map((name) => `${name}: typeof ${name} === \"undefined\" ? undefined : ${name}`).join(", ")} }`;
  const NoteModal = vm.runInNewContext(`${noteTitleFactory}\ncreateNoteTitleModal(${noteTitlePortExpr})`, {
    Modal, qiaomuReaderTranslate: (s) => s, sanitizeNoteTitle: (s) => s, suggestNoteTitle: (s) => s,
    notesFolderPath: () => "", allVaultTags: () => [], FolderSuggest: null,
    parseNoteTags: () => [], qiaomuReaderPath: (s) => s, readerHud: { autoFocus() {} },
  });
  const modal = new NoteModal({}, { settings: {}, _saveLocalData: async () => {} }, "重要性如何放大紧张", null, (value) => results.push(value), { kind: "ai-answer" });
  modal.onOpen();
  return { modal, window, results, input: modal.contentEl.querySelector("input") };
}

test("title form allows editing and ignores IME Enter; submit fires once", async () => {
  const { modal, window, input, results } = titleModal();
  assert.equal(input.value, "重要性如何放大紧张");
  assert.ok(input.getAttribute("aria-label"));
  input.value = "我修改的主题";
  const enter = (opts) => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ...opts }));
  enter({ isComposing: true });
  assert.equal(results.length, 0);
  enter();
  enter();
  modal.onClose();
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "我修改的主题");
});

test("invalid note names show an accessible error; cancelling creates nothing", () => {
  const { modal, window, input, results } = titleModal();
  input.value = "///...";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(results.length, 0);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(modal.contentEl.querySelector('[role="alert"]').hidden, false);
  modal.close();
  assert.deepEqual(results, [null]);
});

test("new selections replace prior selection context without replacing the draft or sent source", () => {
  const { chat, files } = sidebarHarness();
  const select = text => chat.setContext({ kind: "selection", text, bookFile: files.get("a.epub") }, { selection: true, silent: true, focusInput: false });
  select("第一段");
  chat.inputEl.value = "我的问题草稿";
  chat.turns = [{ role: "user", content: "解释一下", context: { kind: "selection", text: "第一段" } }];
  select("第二段");
  assert.equal(chat.pendingContext.text, "第二段");
  assert.equal(chat.inputEl.value, "我的问题草稿");
  assert.equal(chat.turns[0].context.text, "第一段");
  chat.busy = true;
  select("第三段");
  select("最后选中的段落");
  chat.setContext({ kind: "page", text: "整页", bookFile: files.get("a.epub") }, { follow: true, silent: true });
  assert.equal(chat.pendingContext.text, "第二段", "active request keeps its source");
  assert.equal(chat._deferredContext.value.text, "最后选中的段落", "page updates must not overwrite a queued selection");
  chat.busy = false;
  chat.setContext(chat._deferredContext.value, chat._deferredContext.options);
  assert.equal(chat.pendingContext.text, "最后选中的段落");
  assert.equal(chat.inputEl.value, "我的问题草稿");
});

test("automatic selection sync only updates an existing AI sidebar and never opens one or sends", () => {
  const start = aiRenderSource.indexOf("function syncOpenAiSelectionContext(");
  const helper = aiRenderSource.slice(start, aiRenderSource.indexOf("function syncOpenAiReaderContext(", start));
  class Chat { setContext(context, options) { this.context = context; this.options = options; } }
  let leaves = [];
  const sync = vm.runInNewContext(`${helper}\nsyncOpenAiSelectionContext`, {
    getAiChatView: () => Chat, AI_CHAT_VIEW_TYPE: "ai", aiSetupState: () => ({ ready: true, enabled: true }),
    translate: x => x, qiaomuReaderTranslate: x => x, paintAiSource() {},
  });
  const view = { _pendingSel: { text: "选中的段落" }, file: { path: "a.epub" }, engine: {}, app: { workspace: { getLeavesOfType: () => leaves } } };
  sync(view);
  assert.deepEqual(leaves, []);
  const chat = new Chat(); leaves = [{ view: chat }];
  sync(view);
  assert.equal(chat.context.text, "选中的段落");
  assert.equal(chat.options.focusInput, false);
  assert.equal(chat.options.selection, true);
  assert.equal(chat.options.silent, true);
  assert.equal(((source + viewSource + modalSource).match(/syncOpenAiSelectionContext\(this, range\)/g) || []).length, 2);
  assert.match(source, /syncOpenAiSelectionContext\(view, range\);/);
});

test("mobile modal renders a real answer without Component methods and unloads rendered children", async () => {
  const children = new Set();
  class Component {
    load() {}
    unload() { for (const child of this.children || []) child.unload(); children.delete(this); }
    addChild(child) { (this.children ||= new Set()).add(child); children.add(child); return child; }
    removeChild(child) { this.children.delete(child); child.unload(); }
  }
  const win = dom();
  const rendererFactory = streamingSource.slice(streamingSource.indexOf("export function createAiStreamingMarkdownRendererFactory(")).replace("export function", "function");
  const render = vm.runInNewContext(`${rendererFactory}\ncreateAiStreamingMarkdownRendererFactory({ Component, MarkdownRenderer: { async render(_app, text, el) { el.setText(text); } }, AI_MARKDOWN_RENDER_INTERVAL_MS: 50, enhanceAiMarkdown() {} })`, { window: win, Component, console, Date, Math, String });
  const { chat, window } = chatHarness(async () => "这首诗写的是幽居自省。", { Component, createAiStreamingMarkdownRenderer: render });
  // Modal is not a Component, unlike the desktop ItemView.
  assert.equal(chat.addChild, undefined);
  chat._markdownComponent = new Component();
  chat._markdownComponent.load();
  chat.contentEl = window.document.querySelector("main");
  chat._actions = () => {};
  assert.equal(await chat._send("解释一下"), true);
  assert.match(chat.log.textContent, /幽居自省/);
  assert.equal(chat.busy, false);
  assert.equal(children.size, 1);
  chat.onClose();
  assert.equal(children.size, 0);
  win.close(); window.close();
});

test("the study companion hides the empty settings entry", () => {
  const { chat } = sidebarHarness();
  chat.readerView = { getViewType: () => "qbr-quiz" };
  chat.contentEl.empty();
  chat._renderHead(chat.contentEl);
  assert.equal(chat.contentEl.querySelector('[aria-label="ai-quiz-settings"]'), null);
  assert.ok(chat.contentEl.querySelector('[aria-label="close"]'));

  chat.readerView = { getViewType: () => "qiaomu-reader" };
  chat.contentEl.empty();
  chat._renderHead(chat.contentEl);
  assert.ok(chat.contentEl.querySelector('[aria-label="ai-reading-settings"]'));
});

test("the export-toc document tool runs the reader action without sending an AI turn", () => {
  const start = chatViewSource.indexOf("  _runDocumentTool(item) {");
  const end = chatViewSource.indexOf("\n  }", start) + 4;
  let exported = 0, sent = 0;
  const notices = [];
  const run = vm.runInNewContext(`({${chatViewSource.slice(start, end)}})._runDocumentTool`, {
    Notice: class { constructor(message) { notices.push(String(message || "")); } },
  });
  const chat = {
    busy: false,
    readerView: { exportEpubWithToc: () => { exported += 1; } },
    _send: () => { sent += 1; },
  };
  assert.equal(run.call(chat, { capability: { action: "export-toc" } }), true);
  assert.equal(exported, 1);
  assert.equal(sent, 0);
  assert.deepEqual(notices, []);
});

test("the study companion keeps document tools out of its quick prompts", () => {
  const start = aiRenderSource.indexOf("function contextualAiQuickPrompts(");
  const end = aiRenderSource.indexOf("function renderAiComposerPrompts(");
  const source = aiRenderSource.slice(start, end);
  const items = [
    { id: "explain", name: "解释一下", prompt: "解释" },
    { id: "document-tools", name: "文档工具", prompt: "文档工具", command: true },
  ];
  const { contextualAiQuickPrompts } = vm.runInNewContext(`${source}\n({contextualAiQuickPrompts})`, {
    aiQuickPrompts: () => items,
  });
  assert.equal(JSON.stringify(contextualAiQuickPrompts({ _isQuizContext: () => true }).map((item) => item.id)), JSON.stringify(["explain"]));
  assert.equal(JSON.stringify(contextualAiQuickPrompts({ _isQuizContext: () => false }).map((item) => item.id)), JSON.stringify(["explain", "document-tools"]));
});

test("the shared AI sidebar names reading and quiz contexts separately", () => {
  const { chat } = sidebarHarness();
  chat.readerView = { getViewType: () => "qiaomu-reader" };
  assert.equal(chat.getDisplayText(), "ai-reading");
  chat.readerView = { getViewType: () => "qbr-quiz" };
  assert.equal(chat.getDisplayText(), "ai-quiz");
  const tab = { text: "", setText(value) { this.text = value; } };
  chat.leaf = { tabHeaderInnerTitleEl: tab };
  chat._syncViewTitle();
  assert.equal(tab.text, "ai-quiz");
});

test("document shortcuts send directly from the AI conversation", () => {
  const { chat } = sidebarHarness();
  const sent = [];
  chat._send = (text) => { sent.push(text); return true; };
  chat.bookFile = { extension: "pdf" };
  chat.plugin.workshopCapabilities = () => [{
    id: "convert-word",
    title: "把文档转成 Word",
    summary: "生成一份 Word 文档。",
    prompt: "我想把这个文档转成 Word。",
    recommended: true,
    primary: true,
  }];
  const host = chat.contentEl;
  chat._renderWorkshopDiscovery(host);
  const buttons = [...host.querySelectorAll(".qiaomu-reader-ai-doc-row")];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].textContent, /^1\.\s*把文档转成 Word$/);
  assert.doesNotMatch(host.textContent, /书坊还能做什么|和 AI 说|适合当前书/);
  buttons[0].click();
  assert.deepEqual(sent, ["我想把这个文档转成 Word。"]);
});

test("More expands every document action inline without a modal", () => {
  const { chat } = sidebarHarness();
  const sent = [];
  let openedModal = 0;
  chat._send = (text) => { sent.push(text); return true; };
  chat._scroll = () => {};
  chat.busy = false;
  chat.bookFile = { extension: "pdf" };
  chat.plugin.workshopCapabilities = () => [
    {
      id: "extract-text",
      title: "把文档正文导出成可编辑文本",
      prompt: "导出正文",
      recommended: true,
      primary: true,
      hidden: false,
    },
    {
      id: "make-ebook",
      title: "制作电子书",
      prompt: "制作电子书",
      recommended: true,
      primary: false,
      hidden: false,
    },
    {
      id: "questions-and-answers",
      title: "整理文档里的题目和答案",
      prompt: "整理题目",
      recommended: true,
      primary: false,
      hidden: false,
    },
  ];
  chat.plugin.openWorkshopCapabilities = () => { openedModal += 1; };
  chat.log = chat.contentEl;
  chat._showDocumentTools();
  const rows = () => [...chat.contentEl.querySelectorAll(".qiaomu-reader-ai-doc-row")];
  assert.equal(rows().length, 1);
  const more = chat.contentEl.querySelector(".qiaomu-reader-ai-workshop-all");
  assert.equal(more?.textContent, "更多...");
  more.click();
  assert.equal(rows().length, 3);
  assert.match(chat.contentEl.textContent, /制作电子书/);
  assert.equal(chat._documentTools.items.length, 3);
  assert.equal(openedModal, 0, "more expands inline instead of opening the modal");
  chat._useDocumentToolNumber("2");
  assert.deepEqual(sent, ["制作电子书"]);
  more.click();
  assert.equal(rows().length, 1);
  assert.equal(more.textContent, "更多...");
});

test("the 文档工具 command renders the current document shortcuts", () => {
  const { chat } = sidebarHarness();
  const sent = [];
  chat._send = (text) => { sent.push(text); return true; };
  chat._scroll = () => {};
  chat.busy = false;
  chat.bookFile = { extension: "pdf" };
  chat.plugin.workshopCapabilities = () => [{
    id: "convert-word",
    title: "把文档转成 Word",
    summary: "生成一份 Word 文档。",
    prompt: "我想把这个文档转成 Word。",
    recommended: true,
    primary: true,
  }];
  chat.log = chat.contentEl;
  assert.equal(chat._showDocumentTools(), true);
  assert.match(chat.contentEl.textContent, /文档工具/);
  assert.match(chat.contentEl.textContent, /我能对文档做什么/);
  assert.match(chat.contentEl.textContent, /输入编号/);
  const action = chat.contentEl.querySelector(".qiaomu-reader-ai-doc-row");
  assert.match(action?.textContent, /^1\.\s*把文档转成 Word$/);
  action.click();
  assert.deepEqual(sent, ["我想把这个文档转成 Word。"]);
  assert.equal(chat._useDocumentToolNumber("1"), true);
  assert.deepEqual(sent, ["我想把这个文档转成 Word。", "我想把这个文档转成 Word。"]);
  assert.equal(chat._useDocumentToolNumber("9"), false);
});


