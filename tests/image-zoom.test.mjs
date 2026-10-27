import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createImageZoom } from "../packages/reader/src/image-zoom.js";

function setup() {
  const { window } = new JSDOM("<body><div id='host'></div></body>", { pretendToBeVisual: true });
  const host = window.document.getElementById("host");
  Object.defineProperty(host, "clientWidth", { value: 600 });
  Object.defineProperty(host, "clientHeight", { value: 400 });
  const image = window.document.createElement("img");
  image.src = "cover.png";
  Object.defineProperty(image, "naturalWidth", { value: 1200 });
  Object.defineProperty(image, "naturalHeight", { value: 800 });
  window.document.body.append(image);
  return { window, doc: window.document, host, image };
}

test("fit width preserves the aspect ratio and centers a short image", () => {
  const { doc, host, image } = setup();
  const zoom = createImageZoom({ image, doc, host });
  assert.equal(zoom.fitWidth(), true);
  assert.equal(zoom.state.fit, true);
  assert.ok(Math.abs(zoom.state.scale - 0.5) < 0.001);
  assert.match(image.style.transform, /translate\(0px, 0px\) scale\(0\.5\)/);
  zoom.destroy();
});

test("wheel zoom leaves fit mode and drag panning changes the offset", () => {
  const { doc, host, image } = setup();
  const zoom = createImageZoom({ image, doc, host });
  zoom.fitWidth();
  assert.equal(zoom.zoomBy(2), true);
  assert.equal(zoom.state.fit, false);
  assert.ok(zoom.state.scale > 0.5);
  zoom.destroy();
});

test("mouse drag pans even when it starts on the image page background", () => {
  const { window, doc, image } = setup();
  const page = doc.createElement("div");
  page.append(image);
  Object.defineProperty(page, "clientWidth", { value: 600 });
  Object.defineProperty(page, "clientHeight", { value: 400 });
  doc.body.append(page);
  const zoom = createImageZoom({ image, doc, host: page, eventTarget: page });
  zoom.fitWidth();
  zoom.zoomBy(2);
  const before = zoom.state.x;
  page.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300, clientY: 200 }));
  doc.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 360, clientY: 230 }));
  doc.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 360, clientY: 230 }));
  assert.equal(zoom.state.dragging, false);
  assert.notEqual(zoom.state.x, before);
  zoom.destroy();
});

test("the image can be dragged before it is larger than the viewport", () => {
  const { window, doc, image } = setup();
  const page = doc.createElement("div");
  page.append(image);
  Object.defineProperty(page, "clientWidth", { value: 600 });
  Object.defineProperty(page, "clientHeight", { value: 400 });
  doc.body.append(page);
  const zoom = createImageZoom({ image, doc, host: page, eventTarget: page });
  zoom.fitWidth();
  const before = { x: zoom.state.x, y: zoom.state.y };
  page.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300, clientY: 200 }));
  doc.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 340, clientY: 230 }));
  doc.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 340, clientY: 230 }));
  assert.equal(zoom.state.dragging, false);
  assert.notDeepEqual({ x: zoom.state.x, y: zoom.state.y }, before);
  zoom.destroy();
});
