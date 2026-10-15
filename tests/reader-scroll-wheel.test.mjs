// 滚动模式的下一条体验约束:滚轮平时只滚动,只有在「已挂载内容的边缘」才续读
// 下一节(不是翻页跳转 —— 堆叠渲染把下一节接在下面,视口停在原处)。
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

test("scrolling mode keeps mid-scroll wheels with the scroller", () => {
  const chrome = createReaderChrome({ readerIsPdf: () => false, warn: () => {} });
  const { view, events } = harness({ readMode: "scroll" }, { engine: false, pager: { scrollMode: true, clip: { scrollTop: 100, clientHeight: 400, scrollHeight: 2000 } } });
  let prevented = 0;
  const event = {
    deltaY: 120,
    target: { closest: () => null },
    preventDefault: () => { prevented += 1; },
  };
  chrome.handleReaderWheel(view, event);
  assert.equal(prevented, 0, "中途滚动不能被 preventDefault(否则页面滚不动)");
  assert.deepEqual(events, [], "中途也不翻页");
});

test("scrolling mode continues into the next section at the edge", () => {
  const chrome = createReaderChrome({ readerIsPdf: () => false, warn: () => {} });
  const { view, events } = harness({ readMode: "scroll" }, { engine: false, pager: { scrollMode: true, clip: { scrollTop: 1600, clientHeight: 400, scrollHeight: 2000 } } });
  let prevented = 0;
  const event = { deltaY: 120, target: { closest: () => null }, preventDefault: () => { prevented += 1; } };
  chrome.handleReaderWheel(view, event);
  assert.equal(prevented, 1);
  assert.deepEqual(events, ["next"]);
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
