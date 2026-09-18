import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { createReaderChrome } from "../packages/reader/src/reader-chrome.js";
import { docOf, selOf } from "../packages/reader/src/reader-dom.js";
import { iconLabel, svgIcon } from "../packages/reader/src/reader-icons.js";
import { READER_THEME_CHOICES } from "../packages/reader/src/reader-themes.js";
import { PDF_ZOOM_DEFAULT, clampPdfZoom } from "../packages/reader/src/pdf-zoom.js";

function setup(overrides = {}) {
  const { window } = new JSDOM("<main><div id='root'></div></main>", { pretendToBeVisual: true });
  installDomExtensions(window);
  const calls = { picked: 0, nav: [], syncButtons: 0, navigation: [], selection: 0, zoom: 0 };
  const chrome = createReaderChrome({
    translate: (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key),
    Menu: class { addItem() { return this; } showAtMouseEvent() {} },
    Scope: class { register() {} },
    svgIcon,
    iconLabel,
    docOf,
    selOf,
    window,
    readerIsPdf: () => false,
    clampPdfZoom,
    PDF_ZOOM_DEFAULT,
    readerHud: { follow: () => false },
    selectionHud: { beginReaderSelection() {}, openReaderSelectionContext() {}, handleAreaNavClick() {} },
    addReadingMenuActions() {},
    openReaderPagePicker: () => { calls.picked += 1; },
    syncPageButtons: () => { calls.syncButtons += 1; },
    addReaderNavigation: (...args) => { calls.navigation.push(args); },
    setupReaderSelection: () => { calls.selection += 1; },
    setupPdfZoomInteractions: () => { calls.zoom += 1; },
    buildPageButtonsSetting() {},
    buildBookSettings() {},
    buildCustomFontInput: () => () => {},
    createPdfZoomSettings() {},
    READER_THEME_CHOICES,
    readerThemeLabel: (id) => id,
    selectedReaderTheme: () => "auto",
    setReaderTheme: (settings, id) => { settings.theme = id; },
    qiaomuReaderReaderFonts: () => [],
    qiaomuReaderFontLabel: (font) => font.id,
    ensureBundledReaderFont: async () => {},
    ...overrides,
  });
  return { window, doc: window.document, chrome, calls };
}

function makeView(doc, settings = {}) {
  return {
    app: { keymap: { pushScope() {}, popScope() {} } },
    contentEl: doc.querySelector("main"),
    plugin: { settings, saveAll: async () => {}, _saveLocalData: async () => {} },
  };
}

test("setReaderTitle truncates by glyph and keeps the full aria label", () => {
  const { doc, chrome } = setup();
  const el = doc.createElement("div");
  chrome.setReaderTitle(el, "一二三四五六七八九十一二三四五六七八九十二");
  assert.equal(el.textContent, "一二三四五六七八九十一二三四五六七八…");
  assert.equal(el.getAttribute("aria-label"), "一二三四五六七八九十一二三四五六七八九十二");
  chrome.setReaderTitle(el, "short");
  assert.equal(el.textContent, "short");
  assert.equal(el.getAttribute("aria-label"), "short");
});

test("buildReaderTopBar wires the back button and title", () => {
  const { doc, chrome } = setup();
  const view = makeView(doc);
  let backs = 0;
  const tray = chrome.buildReaderTopBar(view, {
    backAttr: { "aria-label": "back" },
    onBack: () => { backs += 1; },
    title: "Book Title",
  });
  assert.ok(view.contentEl.querySelector(".qiaomu-reader-top"));
  assert.equal(view.titleEl.textContent, "Book Title");
  assert.equal(tray.className, "qiaomu-reader-top-right");
  view.contentEl.querySelector(".qiaomu-reader-ibtn").click();
  assert.equal(backs, 1);
});

test("buildReaderBotNav turns pages and opens the page picker", () => {
  const { doc, chrome, calls } = setup();
  const view = makeView(doc, { navMode: "buttons" });
  const nav = [];
  view.nav = (dir) => nav.push(dir);
  const bot = doc.createElement("div");
  chrome.buildReaderBotNav(view, view.contentEl, bot, { buttonType: true });
  const buttons = bot.querySelectorAll("button.qiaomu-reader-navbtn");
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual(nav, ["prev", "next"]);
  assert.equal(calls.syncButtons, 1);
  assert.equal(calls.navigation.length, 1);
  view.locEl.click();
  assert.equal(calls.picked, 1);
  assert.equal(view.pctEl.textContent, "0%");
  assert.equal(view._pageButtons.previous, buttons[0]);
});

test("buildReaderMoreButton defers to the host menu fill", () => {
  const { doc, chrome } = setup();
  const tray = doc.createElement("div");
  const view = makeView(doc);
  let filled = 0;
  chrome.buildReaderMoreButton(tray, view, () => { filled += 1; });
  const more = tray.querySelector(".qiaomu-reader-b-more");
  assert.equal(more.getAttribute("aria-label"), "more");
  more.click();
  assert.equal(filled, 1);
});

test("panelSection persists its open state", async () => {
  const { doc, chrome } = setup();
  const settings = {};
  const view = makeView(doc, settings);
  let saved = 0;
  view.plugin._saveLocalData = async () => { saved += 1; };
  const host = doc.createElement("div");
  const body = chrome.panelSection(view, host, { label: "More", emoji: "x", settingKey: "readerAdvOpen" });
  assert.equal(settings.readerAdvOpen, undefined);
  const hdr = host.querySelector(".qiaomu-reader-pan-adv-hdr");
  hdr.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settings.readerAdvOpen, true);
  assert.equal(saved, 1);
  assert.ok(host.querySelector(".qiaomu-reader-pan-adv-on"));
  assert.ok(body._qiaomuReaderCount);
});

test("readerSettLineHeightRow applies and persists a line height", async () => {
  const { doc, chrome } = setup();
  const view = makeView(doc, { lineHeight: 1.8 });
  let applied = 0, saved = 0;
  view.plugin.saveAll = async () => { saved += 1; };
  const host = doc.createElement("div");
  chrome.readerSettLineHeightRow(host, view, async () => { applied += 1; });
  const buttons = host.querySelectorAll(".qiaomu-reader-lh-btn");
  assert.equal(buttons.length, 4);
  assert.ok(buttons[2].classList.contains("active"), "the current line height starts active");
  buttons[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.plugin.settings.lineHeight, 1.4);
  assert.equal(applied, 1);
  assert.equal(saved, 1);
  assert.ok(buttons[0].classList.contains("active"));
  assert.equal(buttons[2].classList.contains("active"), false);
});

test("handleReaderWheel pages in paged mode and respects the cooldown", () => {
  const { chrome } = setup();
  const nav = [];
  const view = { bookHtml: "<p>x</p>", plugin: { settings: { readMode: "paged" } }, nav: (dir) => nav.push(dir), pager: {} };
  const event = { deltaY: 120, preventDefault() {}, target: null };
  chrome.handleReaderWheel(view, event);
  assert.deepEqual(nav, ["next"]);
  chrome.handleReaderWheel(view, { ...event, deltaY: -120 });
  assert.deepEqual(nav, ["next"], "the second turn waits for the cooldown");
  view._wheelTurnAt = 0;
  chrome.handleReaderWheel(view, { ...event, deltaY: -120 });
  assert.deepEqual(nav, ["next", "prev"]);
});

test("handleReaderWheel only turns at the scroll edge in scroll mode", () => {
  const { chrome } = setup();
  const nav = [];
  const clip = { scrollTop: 100, clientHeight: 400, scrollHeight: 2000 };
  const view = { bookHtml: "<p>x</p>", plugin: { settings: {} }, nav: (dir) => nav.push(dir), pager: { scrollMode: true, clip } };
  chrome.handleReaderWheel(view, { deltaY: 120, preventDefault() {}, target: null });
  assert.deepEqual(nav, [], "mid-scroll wheels stay with the scroller");
  clip.scrollTop = 1600;
  chrome.handleReaderWheel(view, { deltaY: 120, preventDefault() {}, target: null });
  assert.deepEqual(nav, ["next"]);
});

test("handleReaderWheel ignores zoomed PDFs and open panels", () => {
  const { chrome } = setup({ readerIsPdf: () => true });
  const nav = [];
  const view = { bookHtml: "<p>x</p>", plugin: { settings: {} }, nav: (dir) => nav.push(dir), pager: {} };
  chrome.handleReaderWheel(view, { deltaY: 120, preventDefault() {}, target: null });
  assert.deepEqual(nav, []);
  const other = setup();
  const view2 = { bookHtml: "<p>x</p>", plugin: { settings: {} }, nav: (dir) => nav.push(dir), pager: {}, panelOpen: "toc" };
  other.chrome.handleReaderWheel(view2, { deltaY: 120, preventDefault() {}, target: null });
  assert.deepEqual(nav, []);
});

test("attachEngineChrome forwards wheel events from the iframe document", () => {
  const { doc, chrome } = setup();
  const nav = [];
  const view = { bookHtml: "<p>x</p>", plugin: { settings: {} }, nav: (dir) => nav.push(dir), pager: {}, areaEl: doc.createElement("div") };
  chrome.attachEngineChrome(view, doc, 0);
  const event = new doc.defaultView.WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
  doc.dispatchEvent(event);
  assert.deepEqual(nav, ["next"]);
});

test("attachReaderSwipeNav pages on a horizontal swipe and defers on selection", () => {
  const { doc, chrome } = setup();
  const nav = [];
  const view = makeView(doc);
  view.areaEl = doc.createElement("div");
  view.nav = (dir) => nav.push(dir);
  doc.body.appendChild(view.areaEl);
  chrome.attachReaderSwipeNav(view);
  const touch = (type, x, y = 0) => {
    const event = new doc.defaultView.Event(type, { cancelable: true, bubbles: true });
    event.touches = [{ clientX: x, clientY: y }];
    event.changedTouches = event.touches;
    view.areaEl.dispatchEvent(event);
  };
  touch("touchstart", 200, 10);
  touch("touchmove", 120, 12);
  touch("touchend", 120, 12);
  assert.deepEqual(nav, ["next"], "a left swipe turns forward");
  touch("touchstart", 120, 10);
  touch("touchmove", 220, 12);
  touch("touchend", 220, 12);
  assert.deepEqual(nav, ["next", "prev"]);
  doc.getSelection = () => ({ isCollapsed: false });
  touch("touchstart", 200, 10);
  touch("touchmove", 100, 12);
  touch("touchend", 100, 12);
  assert.deepEqual(nav, ["next", "prev"], "a live selection defers to scrolling");
});

test("openImageLightbox opens, zooms, and closes on backdrop, close button or Escape", () => {
  const { doc, chrome } = setup();
  const app = { keymap: { pushScope() {}, popScope() {} } };
  chrome.openImageLightbox("cover.png", app, doc.body);
  const layer = doc.querySelector(".qiaomu-reader-lightbox");
  assert.ok(layer);
  assert.equal(layer.querySelector("img").getAttribute("src"), "cover.png");
  layer.querySelector("img").click();
  assert.ok(layer.querySelector("img").classList.contains("qiaomu-reader-lightbox-zoom"));
  layer.querySelector(".qiaomu-reader-lightbox-close").click();
  assert.equal(doc.querySelector(".qiaomu-reader-lightbox"), null);
  chrome.openImageLightbox("cover.png", app, doc.body);
  const key = new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  doc.dispatchEvent(key);
  assert.equal(doc.querySelector(".qiaomu-reader-lightbox"), null);
  chrome.openImageLightbox("cover.png", app, doc.body);
  const second = doc.querySelector(".qiaomu-reader-lightbox");
  second.dispatchEvent(new doc.defaultView.Event("click", { bubbles: true }));
  assert.equal(doc.querySelector(".qiaomu-reader-lightbox"), null);
});

test("wireReaderChrome connects zoom gestures and immersive chrome", () => {
  const { doc, chrome, calls } = setup();
  const view = makeView(doc, { immersive: false });
  const root = doc.querySelector("#root");
  chrome.wireReaderChrome(view, root);
  assert.equal(calls.zoom, 1);
  assert.equal(typeof view._armImmersive, "function");
  view._armImmersive();
  assert.equal(root.classList.contains("qiaomu-reader-immersive"), false);
});
