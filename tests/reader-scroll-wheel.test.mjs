// 滚动模式的下一条体验约束:滚轮只滚动,不许被抢去翻页/翻章。
// (实测:滚动模式下每次滚到「当前挂载到的边界」就整节跳过去 —— 那个边界不是书的边界。)
import assert from "node:assert/strict";
import test from "node:test";

import { createReaderChrome } from "../packages/reader/src/reader-chrome.js";

function harness(settings, extra = {}) {
  const events = [];
  const view = {
    bookHtml: "<p>x</p>",
    _openingBook: false,
    _closed: false,
    engine: extra.engine === false ? null : {},
    plugin: { settings },
    pager: extra.pager,
    panelOpen: false,
    _selectionMenuOpen: false,
    _commentEditing: false,
    nav: (dir) => events.push(dir),
    areaEl: null,
  };
  return { view, events };
}

test("scrolling mode leaves the wheel to the scroller", () => {
  const chrome = createReaderChrome({ readerIsPdf: () => false, warn: () => {} });
  const { view, events } = harness({ readMode: "scroll" });
  let prevented = 0;
  const event = {
    deltaY: 120,
    target: { closest: () => null },
    preventDefault: () => { prevented += 1; },
  };
  chrome.handleReaderWheel(view, event);
  assert.equal(prevented, 0, "滚轮不能被 preventDefault(否则页面滚不动)");
  assert.deepEqual(events, [], "也不能翻页/翻章");
});

test("paged mode still turns the page on a wheel gesture", () => {
  const chrome = createReaderChrome({ readerIsPdf: () => false, warn: () => {} });
  const { view, events } = harness({ readMode: "pages" });
  let prevented = 0;
  const event = {
    deltaY: -120,
    target: { closest: () => null },
    preventDefault: () => { prevented += 1; },
  };
  chrome.handleReaderWheel(view, event);
  assert.equal(prevented, 1);
  assert.deepEqual(events, ["prev"]);
  // 冷却窗口内的第二次滚轮只被吞掉,不重复翻页。
  const again = { deltaY: -120, target: { closest: () => null }, preventDefault: () => { prevented += 1; } };
  chrome.handleReaderWheel(view, again);
  assert.equal(prevented, 2);
  assert.deepEqual(events, ["prev"]);
});

test("PDF scrolling mode also keeps the wheel as a scroll", () => {
  const chrome = createReaderChrome({ readerIsPdf: () => false, warn: () => {} });
  const { view, events } = harness({ readMode: "scroll" }, { engine: false, pager: { scrollMode: true } });
  let prevented = 0;
  const event = { deltaY: 120, target: { closest: () => null }, preventDefault: () => { prevented += 1; } };
  chrome.handleReaderWheel(view, event);
  assert.equal(prevented, 0);
  assert.deepEqual(events, []);
});
