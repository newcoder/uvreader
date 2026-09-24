import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  beginColumnDrag,
  columnDragActive,
  endColumnDrag,
  installColumnDragWatch,
  onColumnDrag,
} from "../packages/reader/src/column-drag.js";

test("a drag session is active between begin and end and notifies watchers once per session", () => {
  const seen = [];
  const off = onColumnDrag((active) => seen.push(active));
  try {
    assert.equal(columnDragActive(), false);
    beginColumnDrag();
    assert.equal(columnDragActive(), true);
    beginColumnDrag();
    assert.deepEqual(seen, [true], "nested drags keep the session open");
    endColumnDrag();
    assert.equal(columnDragActive(), true);
    endColumnDrag();
    assert.equal(columnDragActive(), false);
    assert.deepEqual(seen, [true, false], "the drag ends exactly once");
  } finally {
    off();
  }
});

test("an end without a matching begin is ignored", () => {
  const seen = [];
  const off = onColumnDrag((active) => seen.push(active));
  try {
    endColumnDrag();
    assert.deepEqual(seen, []);
    assert.equal(columnDragActive(), false);
  } finally {
    off();
  }
});

test("watchers are unsubscribed and a throwing watcher does not break the drag", () => {
  const seen = [];
  const offBad = onColumnDrag(() => { throw new Error("boom"); });
  const off = onColumnDrag((active) => seen.push(active));
  try {
    beginColumnDrag();
    endColumnDrag();
    assert.deepEqual(seen, [true, false]);
    off();
    beginColumnDrag();
    endColumnDrag();
    assert.deepEqual(seen, [true, false], "an unsubscribed watcher stays silent");
  } finally {
    offBad();
  }
});

test("the watch starts the session on a divider pointerdown and ends it on release", () => {
  const dom = new JSDOM(`<div id="root"><div id="view"></div><div class="qbr-splitter" id="handle"></div></div>`);
  const { document } = dom.window;
  const root = document.getElementById("root");
  const off = installColumnDragWatch(root, document);
  const seen = [];
  const seenOff = onColumnDrag((active) => seen.push(active));
  const down = (target) => target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  try {
    down(document.getElementById("view"));
    assert.equal(columnDragActive(), false, "a pointerdown elsewhere is not a drag");
    down(document.getElementById("handle"));
    assert.equal(columnDragActive(), true);
    assert.equal(document.documentElement.classList.contains("qbr-split-dragging"), true);
    document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
    assert.equal(columnDragActive(), false);
    assert.equal(document.documentElement.classList.contains("qbr-split-dragging"), false);
    assert.deepEqual(seen, [true, false]);
    // A cancelled pointer ends the session too instead of leaving it stuck.
    down(document.getElementById("handle"));
    document.dispatchEvent(new dom.window.MouseEvent("pointercancel", { bubbles: true }));
    assert.equal(columnDragActive(), false);
    assert.equal(document.documentElement.classList.contains("qbr-split-dragging"), false);
  } finally {
    seenOff();
    off();
  }
});
