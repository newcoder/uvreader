import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("reader engine module exposes its interface under a DOM global environment", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.customElements = dom.window.customElements;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.DOMParser = dom.window.DOMParser;

  try {
    const engine = await import("../packages/reader/src/reader-engine.js");
    assert.equal(typeof engine.EpubEngine, "function");
    assert.equal(typeof engine.SEARCH_PREFIX, "string");
    assert.ok(engine.SEARCH_PREFIX.length > 0);
    assert.equal(typeof engine.HIGHLIGHT_PAINTS, "object");

    const instance = new engine.EpubEngine(document.body);
    assert.equal(typeof instance.open, "function");
    assert.equal(typeof instance.destroy, "function");
    assert.equal(typeof instance.next, "function");
    assert.equal(typeof instance.prev, "function");
    assert.equal(typeof instance.goTo, "function");
    assert.equal(typeof instance.setExtraCss, "function");
    assert.equal(typeof instance.addHighlight, "function");
    assert.equal(typeof instance.removeHighlight, "function");
    assert.equal(typeof instance.search, "function");
    assert.equal(instance.currentLocation(), null);
    assert.equal(instance.visibleText(), "");
    assert.deepEqual(instance.toc(), []);
    assert.deepEqual(instance.metadata(), { title: "", author: "" });
    instance.destroy();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.customElements;
    delete globalThis.HTMLElement;
    delete globalThis.Node;
    delete globalThis.NodeFilter;
    delete globalThis.DOMParser;
  }
});
