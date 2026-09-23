import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The engine module subclasses foliate's custom elements, so the DOM globals
// must exist before it is imported.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.customElements = dom.window.customElements;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.DOMParser = dom.window.DOMParser;

const { pinyinPinShape } = await import("../packages/reader/src/reader-engine.js");
const doc = dom.window.document;

test("a pinned reading draws the pinyin above its text with a dotted rule", () => {
  const rects = [{ left: 100, top: 200, right: 118, bottom: 224, width: 18, height: 24 }];
  const shape = pinyinPinShape(rects, { pinyin: "bēn", color: "#333333" }, doc);
  assert.equal(shape.tagName.toLowerCase(), "g");
  const line = shape.querySelector("line");
  assert.equal(line.getAttribute("y1"), "223");
  assert.equal(line.getAttribute("x1"), "100");
  assert.equal(line.getAttribute("x2"), "118");
  assert.equal(line.getAttribute("stroke-dasharray"), "2 2");
  assert.equal(line.getAttribute("stroke"), "#333333");
  const label = shape.querySelector("text");
  assert.equal(label.textContent, "bēn");
  assert.equal(label.getAttribute("x"), "109");
  assert.equal(label.getAttribute("text-anchor"), "middle");
  assert.ok(Number(label.getAttribute("y")) < 200, "the reading sits above the text");
  assert.equal(label.getAttribute("fill"), "#333333");
});

test("an empty selection paints nothing and a missing reading keeps the marker", () => {
  assert.equal(pinyinPinShape([], { pinyin: "bēn" }, doc).children.length, 0);
  const rects = [{ left: 0, top: 10, right: 12, bottom: 30, width: 12, height: 20 }];
  const bare = pinyinPinShape(rects, {}, doc);
  assert.equal(bare.querySelector("text"), null);
  assert.equal(bare.querySelectorAll("line").length, 1);
});
