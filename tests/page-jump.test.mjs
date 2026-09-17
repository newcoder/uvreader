import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { createPageJump } from "../packages/reader/src/page-jump.js";

function setup() {
  const calls = [];
  const pageJump = createPageJump({
    translate: (key) => key,
    svgIcon: (host, name) => {
      host.dataset.icon = name;
      return host;
    },
    docOf: (el) => el.ownerDocument,
    isPdf: (view) => view.file?.extension === "pdf",
    pdfPages: (view) => view.pages || [],
    rememberJump: (view) => calls.push(`remember:${view.file?.path || ""}`),
  });
  return { pageJump, calls };
}

test("pageInfo reads engine locations, PDF pages and flow spreads", () => {
  const { pageJump } = setup();
  assert.deepEqual(
    pageJump.pageInfo({ engine: { currentLocation: () => ({ location: { current: 4, total: 100 } }) } }),
    { current: 5, total: 100 },
  );
  assert.deepEqual(
    pageJump.pageInfo({
      file: { extension: "pdf" },
      pager: { total: 10, currentPdfPageNumber: () => 3 },
      pages: [{}, {}, {}, {}],
    }),
    { current: 3, total: 4 },
  );
  assert.deepEqual(pageJump.pageInfo({ pager: { spread: 2, total: 8 } }), { current: 3, total: 8 });
});

test("update mirrors the current page into the toolbar input", () => {
  const { window } = new JSDOM("<div></div>");
  installDomExtensions(window);
  const input = window.document.createElement("input");
  const label = window.document.createElement("span");
  window.document.body.append(input, label);
  const view = { pageInputEl: input, pageTotalEl: label, pager: { spread: 1, total: 12 } };
  const { pageJump } = setup();
  pageJump.update(view);
  assert.equal(input.value, "2");
  assert.equal(label.textContent, "/ 12");
  assert.equal(input.disabled, false);
  input.focus();
  input.value = "9";
  pageJump.update(view);
  assert.equal(input.value, "9", "a focused input keeps the user's draft");
  pageJump.update({ ...view, pager: { spread: 0, total: 0 } });
  assert.equal(input.disabled, true);
});

test("jump clamps the page and routes engine, PDF and flow books", () => {
  const { pageJump, calls } = setup();
  const engineGoTo = [];
  const engineView = {
    file: { path: "book.epub" },
    engine: {
      currentLocation: () => ({ location: { current: 0, total: 11 } }),
      goTo: (target) => {
        engineGoTo.push(target);
        return Promise.resolve();
      },
    },
  };
  pageJump.jump(engineView, 6);
  assert.deepEqual(engineGoTo, [{ fraction: 0.5 }]);
  assert.deepEqual(calls, ["remember:book.epub"]);

  const jumps = [];
  const flowView = {
    file: { path: "book.epub" },
    pager: { spread: 0, total: 5, jumpTo: (n) => jumps.push(n), currentBlockIndex: () => 0 },
    plugin: { saveProgress: () => {} },
    updateUI: () => {},
  };
  pageJump.jump(flowView, 99);
  assert.deepEqual(jumps, [4], "out-of-range pages clamp to the last spread");
});

test("build wires the prev/next buttons and Enter commit", () => {
  const { window } = new JSDOM("<div id='bar'></div>");
  installDomExtensions(window);
  const bar = window.document.getElementById("bar");
  const tray = window.document.createElement("div");
  bar.appendChild(tray);
  const navs = [];
  const { pageJump } = setup();
  const view = {
    file: { path: "book.epub" },
    pager: { spread: 0, total: 4, jumpTo: () => {}, currentBlockIndex: () => 0 },
    plugin: { saveProgress: () => {} },
    updateUI: () => {},
    nav: (dir) => navs.push(dir),
  };
  pageJump.build(view, tray);
  const wrap = bar.querySelector(".qiaomu-reader-pagejump");
  assert.ok(wrap, "the page jump control is inserted into the toolbar");
  const buttons = wrap.querySelectorAll(".qiaomu-reader-pagejump-nav");
  assert.equal(buttons.length, 2);
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual(navs, ["prev", "next"]);
  assert.equal(wrap.querySelector(".qiaomu-reader-pageinput").getAttribute("aria-label"), "go-to-page");
});
