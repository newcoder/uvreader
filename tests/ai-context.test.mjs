import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createAiContext } from "../packages/reader/src/ai-context.js";

const translate = (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key);
const desktop = { isDesktopApp: true };

function makeContext(overrides = {}) {
  return createAiContext({ translate, platform: desktop, win: globalThis, locateHl: () => null, ...overrides });
}

function makePlugin(settings = {}, app = {}) {
  return { settings: { aiSecrets: {}, aiBases: {}, aiModels: {}, aiThinking: {}, aiCliEfforts: {}, ...settings }, app };
}

test("aiConfig reads provider defaults, overrides and the secret storage key", () => {
  const ctx = makeContext();
  const plugin = makePlugin(
    {
      aiProvider: "deepseek",
      aiModels: { deepseek: "deepseek-v4-pro" },
      aiSecrets: { deepseek: "s1" },
      aiKey: "plaintext-fallback",
      aiThinking: { deepseek: false },
    },
    { secretStorage: { getSecret: (id) => (id === "s1" ? "secret-key" : "") } },
  );
  const cfg = ctx.aiConfig(plugin);
  assert.equal(cfg.id, "deepseek");
  assert.equal(cfg.base, "https://api.deepseek.com");
  assert.equal(cfg.model, "deepseek-v4-pro");
  assert.equal(cfg.key, "secret-key");
  assert.equal(cfg.thinking, false);
  assert.equal(cfg.needsKey, true);
});

test("aiConfig falls back to the legacy plaintext key and empty config", () => {
  const ctx = makeContext();
  const legacy = makePlugin({ aiProvider: "deepseek", aiKey: "plain" });
  assert.equal(ctx.aiConfig(legacy).key, "plain");
  const none = ctx.aiConfig(makePlugin({}));
  assert.deepEqual(none, { id: "", provider: null, base: "", model: "", key: "", needsKey: false });
});

test("aiSetupState tracks readiness", () => {
  const ctx = makeContext();
  const ready = makePlugin({
    aiProvider: "deepseek",
    aiKey: "k",
    aiEnabled: true,
  });
  const state = ctx.aiSetupState(ready);
  assert.equal(state.kind, "ready");
  assert.equal(state.enabled, true);
  const missingKey = ctx.aiSetupState(makePlugin({ aiProvider: "deepseek" }));
  assert.equal(missingKey.reason, "key");
});

test("aiSetupMessage maps every setup reason to a translation key", () => {
  const ctx = makeContext();
  assert.equal(ctx.aiSetupMessage({ reason: "key" }), "select-or-create-an-api-key-then-complete-the-test-to-start-usin");
  assert.equal(ctx.aiSetupMessage({ reason: "model" }), "choose-a-model-then-complete-the-test-to-start-using-ai");
  assert.equal(ctx.aiSetupMessage({ reason: "base" }), "enter-the-base-url-then-complete-the-test-to-start-using-ai");
  assert.equal(ctx.aiSetupMessage({ reason: "desktop" }), "this-service-works-only-in-obsidian-desktop-change-the-service-o");
  assert.equal(ctx.aiSetupMessage({ reason: "verify" }), "settings-changed-complete-the-connection-test-to-enable-ai-assis");
  assert.equal(ctx.aiSetupMessage({ reason: "" }), "choose-an-ai-service-and-complete-the-connection-test-then-selec");
});

test("quick prompts translate the default set without sharing state", () => {
  const ctx = makeContext();
  const prompts = ctx.aiQuickPrompts();
  assert.equal(prompts.length, 6);
  assert.equal(prompts[0].name, "explain-it");
  assert.equal(prompts[0].prompt, "explain-this-passage-in-simple-easy-to-understand-language");
  prompts[0].name = "mutated";
  assert.equal(ctx.defaultAiQuickPrompts()[0].name, "explain-it");
});

test("normalizeAiTurnContext clamps kinds, labels and text length", () => {
  const ctx = makeContext();
  assert.equal(ctx.normalizeAiTurnContext(null), null);
  assert.equal(ctx.normalizeAiTurnContext({ text: "   " }), null);
  const selection = ctx.normalizeAiTurnContext({ text: "  hello  ", kind: "weird" });
  assert.deepEqual(selection, { kind: "selection", label: "selection", text: "hello", page: "" });
  const doc = ctx.normalizeAiTurnContext({ text: "body", kind: "document", page: "p.1" });
  assert.equal(doc.kind, "document");
  assert.equal(doc.label, "full-pdf");
  assert.equal(doc.page, "p.1");
  const page = ctx.normalizeAiTurnContext({ text: "body", kind: "page" });
  assert.equal(page.label, "current-page");
});

test("normalizeAiChatHistory migrates legacy text into the first user turn", () => {
  const ctx = makeContext();
  const history = ctx.normalizeAiChatHistory([
    {
      id: "c1",
      title: "T",
      book: "Book",
      bookPath: "Books/a.epub",
      text: "legacy selection",
      updatedAt: 42,
      turns: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer", interrupted: true, savedNotePath: "notes/a.md" },
        { role: "assistant", content: "" },
      ],
    },
    { id: "", turns: [{ role: "user", content: "orphan" }] },
    "not-an-item",
  ]);
  assert.equal(history.length, 1);
  const chat = history[0];
  assert.equal(chat.contextVersion, 1);
  assert.equal(chat.updatedAt, 42);
  assert.equal(chat.turns.length, 2, "empty assistant content is dropped");
  assert.equal(chat.turns[1].interrupted, true);
  assert.equal(chat.turns[1].savedNotePath, "notes/a.md");
  assert.equal(chat.turns[0].context.kind, "selection");
  assert.equal(chat.turns[0].context.text, "legacy selection");
});

test("aiMessages turns UI turns and structured context into model messages", () => {
  const ctx = makeContext();
  const turns = [
    { role: "user", content: "what is this?", context: { kind: "page", text: "page body", page: "p.7" } },
    { role: "assistant", content: "an answer" },
  ];
  const msgs = ctx.aiMessages("fallback", { aiInto: "English" }, turns, "My Book");
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /English/);
  assert.match(msgs[1].content, /书名：《My Book》/);
  assert.match(msgs[1].content, /上下文：current-page（p.7）/);
  assert.match(msgs[1].content, /page body/);
  assert.match(msgs[1].content, /问题：what is this\?/);
  assert.deepEqual(msgs[2], { role: "assistant", content: "an answer" });
  const custom = ctx.aiMessages("fallback", { aiSystem: "  custom system  " }, [], "");
  assert.equal(custom[0].content, "custom system");
  assert.equal(custom.length, 1);
});

test("stored conversations keep attachment metadata but never the base64 payload", () => {
  const ctx = makeContext();
  const history = ctx.normalizeAiChatHistory([{
    id: "c2",
    title: "T",
    bookPath: "Books/a.epub",
    updatedAt: 7,
    turns: [{
      role: "user",
      content: "look",
      attachments: [
        { id: "att-1", kind: "image", name: "shot.png", mimeType: "image/png", bytes: 1200, thumb: "data:image/jpeg;base64,QQ==", file: "plugin/ai-files/att-1.png", data: "SHOULD_NOT_PERSIST" },
        { id: "", kind: "image" },
      ],
    }, { role: "assistant", content: "seen" }],
  }]);
  const attachments = history[0].turns[0].attachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].file, "plugin/ai-files/att-1.png");
  assert.equal("data" in attachments[0], false);
  assert.equal("text" in attachments[0], false);
});

test("aiMessages sends attachment parts after the prompt and text files inline", () => {
  const ctx = makeContext();
  const turns = [{
    role: "user",
    content: "看图",
    attachments: [
      { id: "att-1", kind: "image", mimeType: "image/png", data: "AAAA", bytes: 3 },
      { id: "att-2", kind: "text", name: "notes.md", text: "hello", bytes: 5 },
    ],
  }];
  const msgs = ctx.aiMessages("", { aiInto: "中文" }, turns, "Book");
  const content = msgs[1].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /看图/);
  assert.match(content[1].text, /【附件：notes.md】/);
  assert.deepEqual(content[2], { type: "image", data: "AAAA", mimeType: "image/png" });
  const plain = ctx.aiMessages("", { aiInto: "中文" }, [{ role: "user", content: "plain" }], "");
  assert.equal(typeof plain[1].content, "string");
});

test("aiChatTitle and aiTurnsHaveDocumentContext summarize the thread", () => {
  const ctx = makeContext();
  assert.equal(ctx.aiChatTitle([{ role: "user", content: "  hello   world " }], ""), "hello world");
  assert.equal(ctx.aiChatTitle([], "fallback text"), "fallback text");
  assert.equal(ctx.aiChatTitle([], ""), "ai-reading");
  const long = ctx.aiChatTitle([{ role: "user", content: "x".repeat(60) }], "");
  assert.equal(long.length, 35);
  assert.equal(long.endsWith("…"), true);
  assert.equal(ctx.aiTurnsHaveDocumentContext([{ role: "user", context: { kind: "document", text: "t" } }]), true);
  assert.equal(ctx.aiTurnsHaveDocumentContext([{ role: "user", context: { kind: "page", text: "t" } }]), false);
});

test("newAiSessionKey prefers crypto.randomUUID", () => {
  const ctx = makeContext({ win: { crypto: { randomUUID: () => "uuid-1" } } });
  assert.equal(ctx.newAiSessionKey(), "uuid-1");
  const fallback = makeContext({ win: {} });
  assert.match(fallback.newAiSessionKey(), /^reader-\d+-/);
});

test("AI source painting, clearing and restoring share one CSS highlight", () => {
  const dom = new JSDOM("<main><p>hello world</p></main>");
  const win = dom.window;
  const highlights = new Map();
  win.CSS = { highlights: { set: (key, value) => highlights.set(key, value), delete: (key) => highlights.delete(key) } };
  win.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges; } };
  const doc = win.document;
  const block = doc.querySelector("p");
  const ctx = createAiContext({
    translate,
    platform: desktop,
    win,
    locateHl: () => ({ start: 0, len: 5 }),
  });
  const view = {
    contentEl: doc.querySelector("main"),
    pager: { blockEl: () => block },
    _pendingSel: { parts: [{ block: 0, text: "hello", start: 0, len: 5 }] },
  };
  const range = doc.createRange();
  range.selectNodeContents(block);
  ctx.paintAiSource(view, range);
  assert.equal(view._aiSourceParts.length, 1);
  assert.equal(view._aiSourceRange instanceof win.Range, true);
  assert.equal(highlights.get("qiaomu-reader-ai-source").ranges.length, 1);
  ctx.clearAiSource(view);
  assert.equal(highlights.has("qiaomu-reader-ai-source"), false);
  assert.equal(view._aiSourceParts, null);
  ctx.paintAiSource(view, range);
  view._aiSourceRange = null;
  ctx.restoreAiSource(view);
  const restored = highlights.get("qiaomu-reader-ai-source");
  assert.equal(restored.ranges.length, 1);
  assert.equal(restored.ranges[0].toString(), "hello");
});

test("restoreAiSource without stored parts or highlight support is a no-op", () => {
  const ctx = makeContext();
  const view = { contentEl: { ownerDocument: { defaultView: {} } }, pager: {} };
  ctx.restoreAiSource(view);
  assert.equal(view._aiSourceParts, undefined);
});
