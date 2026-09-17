import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { createReaderHud } from "../packages/reader/src/reader-hud.js";

function setup({ platformMobile = false } = {}) {
  const { window } = new JSDOM("<main><article></article></main>", { pretendToBeVisual: true });
  installDomExtensions(window);
  const notices = [];
  const timers = [];
  const clock = {
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
  };
  const hud = createReaderHud({
    translate: (key) => key,
    notice: (message) => notices.push(message),
    window: clock,
    platform: { isMobile: platformMobile },
    isPdf: (view) => view?.file?.extension === "pdf",
    jumpToHighlight: async () => true,
    escapeSelector: (value) => value,
  });
  const doc = window.document;
  const view = {
    app: { isMobile: false },
    contentEl: doc.querySelector("main"),
    areaEl: doc.querySelector("article"),
    file: { path: "book.epub" },
    plugin: { saveProgress() {} },
    updateUI() {},
  };
  return { window, doc, hud, view, notices, timers };
}

test("the boot veil renders skeleton lines and is replaced or removed", async () => {
  const { hud, view } = setup();
  hud.showVeil(view, "加载中");
  const veil = view.contentEl.querySelector(".qiaomu-reader-veil");
  assert.ok(veil, "the veil is attached to the reader area");
  assert.equal(veil.querySelectorAll(".qiaomu-reader-veil-line").length, 8);
  assert.equal(veil.querySelector(".qiaomu-reader-veil-text").textContent, "加载中");
  hud.showVeil(view);
  assert.equal(view.contentEl.querySelectorAll(".qiaomu-reader-veil").length, 1, "a second veil replaces the first");
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-veil-text").textContent, "laying-out-the-pages");
  hud.markSlowLayout(view, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-veil-text").textContent, "this-document-has-many-pages-layout-is-still-in-progress");
  hud.hideVeil(view);
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-veil"), null);
  assert.equal(view._veil, null);
  hud.markSlowLayout(view);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-veil"), null, "without a veil the hint is a no-op");
});

test("paintVeil waits for real frames before pagination takes the thread", async () => {
  const { hud, view } = setup();
  hud.showVeil(view);
  await hud.paintVeil(view);
  assert.ok(view._veil, "the veil stays until the caller hides it");
});

test("autoFocus skips mobile hosts and honours the delay", () => {
  const desktop = setup();
  const field = desktop.doc.createElement("input");
  desktop.doc.body.append(field);
  desktop.hud.autoFocus(field);
  assert.equal(desktop.doc.activeElement, field);
  const mobile = setup({ platformMobile: true });
  const mobileField = mobile.doc.createElement("input");
  mobile.doc.body.append(mobileField);
  mobile.hud.autoFocus(mobileField);
  assert.notEqual(mobile.doc.activeElement, mobileField, "mobile keyboards stay closed");
  const delayed = setup();
  const delayedField = delayed.doc.createElement("input");
  delayed.doc.body.append(delayedField);
  delayed.hud.autoFocus(delayedField, 30);
  assert.notEqual(delayed.doc.activeElement, delayedField);
  delayed.timers[0]();
  assert.equal(delayed.doc.activeElement, delayedField);
});

test("follow jumps to the footnote target and offers a way back", () => {
  const { doc, hud, view } = setup();
  const flow = doc.createElement("article");
  const target = doc.createElement("aside");
  target.setAttribute("data-qiaomu-reader-id", "fn1");
  target.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10 });
  flow.append(target);
  flow.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 500 });
  const jumps = [];
  view.pager = {
    flow,
    clip: doc.createElement("div"),
    sw: 400,
    cols: 1,
    total: 4,
    spread: 0,
    scrollMode: false,
    jumpTo: (spread) => { jumps.push(spread); return [spread, 4]; },
    currentBlockIndex: () => 0,
    _blocks: () => [],
    blockEl: () => null,
  };
  assert.equal(hud.follow(view, "missing"), false, "an unknown reference is not followed");
  assert.equal(hud.follow(view, "fn1"), true);
  assert.deepEqual(jumps, [0]);
  const pill = view.contentEl.querySelector(".qiaomu-reader-note-back");
  assert.ok(pill, "the return pill appears");
  assert.equal(pill.getAttribute("tabindex"), "0");
  assert.equal(pill.textContent, "return-to-previous-reading-position");
  view.file = { path: "book.pdf", extension: "pdf" };
  pill.click();
  assert.equal(view.contentEl.querySelector(".qiaomu-reader-note-back"), null, "returning hides the pill");
  assert.equal(view.contentEl.classList.contains("qiaomu-reader-has-return"), false);
});
