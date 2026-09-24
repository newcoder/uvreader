import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { SHOT_MIN_SIZE, planRegionStitch, openShotOverlay, clampShotRect } from "../packages/reader/src/reader-shot.js";

function makeHost() {
  const dom = new JSDOM("<div id='area'></div>");
  const { window } = dom;
  const { HTMLElement } = window;
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
  HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };
  HTMLElement.prototype.createDiv = function (options) {
    const el = window.document.createElement("div");
    if (typeof options === "string") el.className = options;
    else if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    this.append(el);
    return el;
  };
  const host = window.document.getElementById("area");
  host.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, width: 600, height: 400, right: 700, bottom: 450 });
  return { dom, window, host };
}

function open(host, window) {
  const overlay = openShotOverlay({ host, translate: (key) => key });
  const el = host.querySelector(".qiaomu-reader-shot");
  const send = (type, x, y, button = 0) => el.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y }),
  );
  return { overlay, el, send };
}

function settled(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the overlay did not settle")), 1000)),
  ]);
}

test("a drag returns the viewport rectangle it drew", async () => {
  const { window, host } = makeHost();
  const { overlay, el, send } = open(host, window);
  send("pointerdown", 200, 100);
  send("pointermove", 340, 260);
  const size = el.querySelector(".qiaomu-reader-shot-size");
  assert.equal(size.hidden, false);
  assert.equal(size.textContent, "140 × 160");
  send("pointerup", 340, 260);
  assert.deepEqual(await settled(overlay.promise), { x: 200, y: 100, width: 140, height: 160 });
  assert.equal(host.querySelector(".qiaomu-reader-shot"), null, "the overlay removes itself");
});

test("a box smaller than the minimum is treated as a cancel", async () => {
  const { window, host } = makeHost();
  const { overlay, send } = open(host, window);
  send("pointerdown", 200, 100);
  send("pointerup", 200 + SHOT_MIN_SIZE - 2, 100 + SHOT_MIN_SIZE - 2);
  assert.equal(await settled(overlay.promise), null);
});

test("Escape and a right click cancel", async () => {
  const { window, host } = makeHost();
  const first = open(host, window);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await settled(first.overlay.promise), null);
  assert.equal(window.document.querySelector(".qiaomu-reader-shot"), null);

  const second = open(host, window);
  second.send("contextmenu", 200, 100, 2);
  assert.equal(await settled(second.overlay.promise), null);

  // A later overlay still works after the earlier key listener was removed.
  const third = open(host, window);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  third.send("pointerdown", 150, 80);
  third.send("pointerup", 400, 300);
  assert.deepEqual(await settled(third.overlay.promise), { x: 150, y: 80, width: 250, height: 220 });
});

test("clampShotRect never leaves the reading area", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 50 };
  assert.deepEqual(clampShotRect({ x: -10, y: -10, width: 40, height: 40 }, bounds), { x: 0, y: 0, width: 30, height: 30 });
  assert.deepEqual(clampShotRect({ x: 90, y: 40, width: 40, height: 40 }, bounds), { x: 90, y: 40, width: 10, height: 10 });
});

test("a cross-page region is cropped per page and stitched on one canvas", () => {
  const region = { x: 300, y: 100, width: 150, height: 100 };
  const left = { rect: { x: 100, y: 100, width: 250, height: 400 }, imageWidth: 500, imageHeight: 800 };
  const right = { rect: { x: 400, y: 100, width: 200, height: 400 }, imageWidth: 400, imageHeight: 800 };
  const plan = planRegionStitch(region, [left, right]);
  assert.equal(plan.ratio, 2, "crisp output at the page-image resolution");
  assert.equal(plan.width, 300);
  assert.equal(plan.height, 200);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items[0].source, { x: 400, y: 0, width: 100, height: 200 });
  assert.deepEqual(plan.items[0].target, { x: 0, y: 0, width: 100, height: 200 });
  assert.deepEqual(plan.items[1].source, { x: 0, y: 0, width: 100, height: 200 });
  assert.deepEqual(plan.items[1].target, { x: 200, y: 0, width: 100, height: 200 });
});

test("a region that misses every page yields no plan", () => {
  const region = { x: 0, y: 0, width: 50, height: 50 };
  assert.equal(planRegionStitch(region, [{ rect: { x: 100, y: 100, width: 100, height: 100 }, imageWidth: 200, imageHeight: 200 }]), null);
  assert.equal(planRegionStitch(region, [{ rect: { x: 0, y: 0, width: 0, height: 0 }, imageWidth: 0, imageHeight: 0 }]), null);
});
