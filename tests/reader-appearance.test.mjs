import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import { FONT_FILE_ACCEPT, importedReaderFonts } from "../packages/reader/src/reader-fonts.js";
import { normalizeCustomFontFamily, resolveReaderFont, readerTextCss, syncPageButtons } from "../packages/reader/src/reader-appearance.js";

const source = fs.readFileSync(new URL("../packages/reader/src/wire.js", import.meta.url), "utf8");
const fontInputSource = fs.readFileSync(new URL("../packages/reader/src/custom-font-input.js", import.meta.url), "utf8");

test("custom fonts accept Chinese names, spaces, quoted commas and generic fallbacks", () => {
  assert.equal(normalizeCustomFontFamily("  思源宋体, PingFang SC, sans-serif "), '"思源宋体", "PingFang SC", sans-serif');
  assert.equal(normalizeCustomFontFamily("'Font, Special', ui-serif"), '"Font, Special", ui-serif');
  assert.equal(normalizeCustomFontFamily('"serif", serif'), '"serif", serif');
});

test("custom fonts cannot escape the generated CSS or silently drop invalid suffixes", () => {
  for (const input of ['serif; color:red', '</style><script>1</script>', 'url(https://example.com/font)', 'var(--font)',
    'serif,', ',serif', 'serif,,sans-serif', '"unterminated', 'serif\\x', 'a\nb', 'a'.repeat(501), "a'bad"]) {
    assert.equal(normalizeCustomFontFamily(input), null, input);
  }
});

test("empty, corrupt and unknown stored fonts safely fall back; built-ins still resolve", () => {
  const fonts = { georgia: "Georgia,serif", kaiti: "KaiTi,serif" };
  for (const customFontFamily of ["", null, {}, "serif;color:red"]) {
    assert.equal(resolveReaderFont({ fontFamily: "custom", customFontFamily }, fonts), fonts.georgia);
  }
  assert.equal(resolveReaderFont({ fontFamily: "unknown" }, fonts), fonts.georgia);
  assert.equal(resolveReaderFont({ fontFamily: "kaiti", customFontFamily: "ignored" }, fonts), fonts.kaiti);
  assert.equal(resolveReaderFont({ fontFamily: "custom", customFontFamily: "楷体" }, fonts), '"楷体"');
});

test("always-on arrows retain handlers, move outside immersive chrome and return in order", () => {
  const dom = new JSDOM('<div id="root" class="qiaomu-reader-immersive"><div id="toolbar"><button id="prev"></button><span>page</span><button id="next"></button></div></div>');
  const doc = dom.window.document;
  const elements = { root: doc.getElementById("root"), toolbar: doc.getElementById("toolbar"), previous: doc.getElementById("prev"), next: doc.getElementById("next") };
  const view = { plugin: { settings: {} }, _pageButtons: elements };
  let page = 4;
  elements.previous.addEventListener("click", () => page--);
  elements.next.addEventListener("click", () => page++);
  syncPageButtons(view);
  assert.equal(elements.previous.parentElement, elements.toolbar);
  view.plugin.settings.pageButtonsVisibility = "always";
  for (let i = 0; i < 3; i++) syncPageButtons(view);
  assert.equal(elements.previous.parentElement, elements.root);
  assert.equal(elements.next.parentElement, elements.root);
  assert.equal(elements.root.querySelectorAll("button").length, 2);
  elements.next.click();
  assert.equal(page, 5);
  elements.previous.click();
  assert.equal(page, 4);
  view.plugin.settings.pageButtonsVisibility = "hover";
  syncPageButtons(view);
  assert.equal(elements.toolbar.firstElementChild, elements.previous);
  assert.equal(elements.toolbar.lastElementChild, elements.next);
  assert.equal(elements.root.querySelectorAll(".qiaomu-reader-page-edge").length, 0);
  dom.window.close();
});

test("returning arrows preserve the shared navigation tools and page location order", () => {
  const dom = new JSDOM('<div id="root"><div id="toolbar" class="qiaomu-reader-navigation"><div class="qiaomu-reader-navigation-tools">contents / search</div><button id="prev"></button><div class="qiaomu-reader-bot-center">page</div><button id="next"></button></div></div>');
  const doc = dom.window.document;
  const toolbar = doc.getElementById("toolbar");
  const view = { plugin: { settings: { pageButtonsVisibility: "always" } }, _pageButtons: { root: doc.getElementById("root"), toolbar, previous: doc.getElementById("prev"), next: doc.getElementById("next") } };
  const tools = toolbar.firstElementChild;
  syncPageButtons(view);
  assert.equal(toolbar.children.length, 2);
  assert.equal(toolbar.firstElementChild, tools);
  view.plugin.settings.pageButtonsVisibility = "hover";
  syncPageButtons(view);
  assert.deepEqual([...toolbar.children].map((el) => el.id || el.className), ["qiaomu-reader-navigation-tools", "prev", "qiaomu-reader-bot-center", "next"]);
  dom.window.close();
});

test("custom font editor reveals on selection, commits on change and preserves last valid value", async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const { document, HTMLElement, Event } = dom.window;
  HTMLElement.prototype.createEl = function(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.text) element.textContent = options.text;
    if (options.type) element.type = options.type;
    element.className = options.cls || "";
    for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
    this.append(element);
    return element;
  };
  HTMLElement.prototype.createDiv = function(options) { return this.createEl("div", typeof options === "string" ? { cls: options } : options); };
  HTMLElement.prototype.empty = function() { this.replaceChildren(); };
  HTMLElement.prototype.setText = function(value) { this.textContent = value; };
  const code = fontInputSource.slice(fontInputSource.indexOf("export function createBuildCustomFontInput(")).replace("export function", "function");
  const build = vm.runInNewContext(`${code}\ncreateBuildCustomFontInput({ FONTS: { georgia: "Georgia,serif" }, ReaderFontPicker: undefined, qiaomuReaderTranslate: (s) => s })`, { qiaomuReaderTranslate: (s) => s, normalizeCustomFontFamily, FONT_FILE_ACCEPT, importedReaderFonts, resolveReaderFont, listSystemFonts: async () => [], readerFontStore: () => ({}), docOf: (el) => el.ownerDocument, winOf: (el) => el.ownerDocument.defaultView, FONTS: { georgia: "Georgia,serif" } });
  const settings = { fontFamily: "georgia", customFontFamily: "" };
  let applies = 0;
  const host = document.getElementById("host");
  const refresh = build(host, { settings, _saveLocalData: async () => true }, async () => applies++);
  assert.equal(host.firstElementChild.hidden, true);
  settings.fontFamily = "custom";
  refresh();
  assert.equal(host.firstElementChild.hidden, false);
  const input = host.querySelector('input[type="text"]');
  input.value = "宋体, serif";
  input.dispatchEvent(new Event("input"));
  assert.equal(applies, 0);
  input.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applies, 1);
  assert.equal(settings.customFontFamily, '"宋体", serif');
  input.value = "serif;display:none";
  input.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(applies, 1);
  assert.equal(settings.customFontFamily, '"宋体", serif');
  input.value = "";
  input.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settings.customFontFamily, "");
  assert.equal(input.getAttribute("aria-invalid"), "false");
  dom.window.close();
});


test("chosen typography overrides MOBI paragraph alignment and author prose styles without flattening headings", () => {
  const dom = new JSDOM('<head><style>p{font-size:15px;font-family:serif;line-height:1.1;text-align:justify}h1{font-size:40px}code{font-family:monospace}</style></head><body><h1>标题</h1><p align="justify">正文 <em>强调</em></p><code>code</code></body>');
  const doc = dom.window.document;
  const style = doc.createElement("style");
  style.textContent = readerTextCss({ fontSize: 24, lineHeight: 1.9, textAlign: "left" }, { bg: "#eaf0e8", text: "#243029" }, "sans-serif");
  doc.head.append(style);
  const prose = dom.window.getComputedStyle(doc.querySelector("p"));
  assert.equal(prose.fontSize, "24px");
  assert.equal(prose.fontFamily, "sans-serif");
  assert.equal(prose.lineHeight, "1.9");
  assert.equal(prose.textAlign, "left");
  assert.equal(dom.window.getComputedStyle(doc.querySelector("h1")).fontSize, "40px");
  assert.equal(dom.window.getComputedStyle(doc.querySelector("code")).fontFamily, "monospace");
  dom.window.close();
});

test("automatic theme resolves host colors for a separate book document and refreshes on theme changes", () => {
  const host = new JSDOM('<div style="--background-primary:#181a1b;--text-normal:#d9d7d1"></div>');
  const book = new JSDOM('<head></head><body><p>正文</p></body>');
  const root = host.window.document.querySelector("div");
  const style = book.window.document.createElement("style");
  book.window.document.head.append(style);
  const update = () => { style.textContent = readerTextCss({}, { bg: "var(--background-primary)", text: "var(--text-normal)" }, "serif", root); };
  update();
  assert.equal(book.window.getComputedStyle(book.window.document.body).backgroundColor, "rgb(24, 26, 27)");
  assert.equal(book.window.getComputedStyle(book.window.document.body).color, "rgb(217, 215, 209)");
  root.style.setProperty("--background-primary", "#ffffff");
  root.style.setProperty("--text-normal", "#222222");
  update();
  assert.equal(book.window.getComputedStyle(book.window.document.body).backgroundColor, "rgb(255, 255, 255)");
  assert.equal(book.window.getComputedStyle(book.window.document.body).color, "rgb(34, 34, 34)");
  book.window.close();
  host.window.close();
});
