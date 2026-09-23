import test from "node:test";
import assert from "node:assert/strict";
import { pinyinPinFor, renderEnginePins, togglePinyinPin } from "../packages/reader/src/pinyin-pins.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function owner(overrides = {}) {
  const store = new Map();
  const calls = { notices: [], added: [], removed: [] };
  const list = (path) => store.get(path) || [];
  const base = {
    file: { path: "Book.epub", extension: "epub" },
    engine: {
      addPin: async (id, cfi, info) => { calls.added.push({ id, cfi, info }); },
      removePin: async (id) => { calls.removed.push(id); },
    },
    plugin: {
      getPins: (path) => [...list(path)],
      addPin: (path, pin) => { store.set(path, [...list(path), pin]); },
      removePin: (path, id) => { store.set(path, list(path).filter((pin) => pin.id !== id)); },
    },
  };
  return {
    ...base, ...overrides, calls, store,
    deps: { notice: (message) => calls.notices.push(message), translate: (key) => key },
  };
}

const selection = { cfi: "epubcfi(/6/2!/4/2,/1:0,/1:1)", text: "犇" };
const info = { pinyin: "bēn", gloss: "群牛受惊奔跑。", single: true };

test("pinning stores the reading on the book and paints it in the engine", () => {
  const view = owner();
  const pin = togglePinyinPin(view, selection, info, view.deps);
  assert.ok(pin?.id, "the new pin is returned");
  assert.equal(view.plugin.getPins("Book.epub").length, 1);
  assert.deepEqual(view.calls.added.map(({ cfi, info: painted }) => [cfi, painted.pinyin, painted.gloss]),
    [[selection.cfi, "bēn", "群牛受惊奔跑。"]]);
  assert.deepEqual(view.calls.notices, ["pinyin-pinned"]);
  assert.equal(pinyinPinFor(view, selection)?.id, pin.id);
});

test("toggling the same selection again removes the pin and its overlay", () => {
  const view = owner();
  const pin = togglePinyinPin(view, selection, info, view.deps);
  assert.equal(togglePinyinPin(view, selection, info, view.deps), null);
  assert.deepEqual(view.plugin.getPins("Book.epub"), []);
  assert.deepEqual(view.calls.removed, [pin.id]);
  assert.deepEqual(view.calls.notices, ["pinyin-pinned", "pinyin-unpinned"]);
  assert.equal(pinyinPinFor(view, selection), null);
});

test("formats without the engine path keep the chip informational", () => {
  const pdf = owner({ file: { path: "Book.pdf", extension: "pdf" } });
  assert.equal(togglePinyinPin(pdf, selection, info, pdf.deps), null);
  assert.deepEqual(pdf.calls.notices, ["pinyin-pin-unsupported"]);
  assert.deepEqual(pdf.plugin.getPins("Book.pdf"), []);
  const bare = owner({ engine: null });
  togglePinyinPin(bare, selection, info, bare.deps);
  assert.deepEqual(bare.calls.notices, ["pinyin-pin-unsupported"]);
});

test("stored pins repaint section by section and a broken anchor never blocks the rest", async () => {
  const view = owner();
  view.plugin.addPin("Book.epub", { id: "p1", cfi: selection.cfi, pinyin: "bēn" });
  view.plugin.addPin("Book.epub", { id: "p2", cfi: "epubcfi(broken)", pinyin: "yuè" });
  view.engine.addPin = async (id) => {
    if (id === "p2") throw new Error("section not rendered");
    view.calls.added.push({ id });
  };
  renderEnginePins(view);
  await tick();
  assert.deepEqual(view.calls.added.map(({ id }) => id), ["p1"]);
});
