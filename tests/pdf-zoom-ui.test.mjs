import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { PDF_ZOOM_DEFAULT, PDF_ZOOM_MAX, PDF_ZOOM_MIN, clampPdfZoom } from "../packages/reader/src/pdf-zoom.js";
import { createPdfZoomUi } from "../packages/reader/src/pdf-zoom-ui.js";

function setup() {
  const { window } = new JSDOM("<div id='content'><div id='flow'><div class='qiaomu-reader-pdf-page-break'><div class='qiaomu-reader-pdf-page-surface'></div></div></div><div id='clip'></div></div>");
  installDomExtensions(window);
  const doc = window.document;
  const ui = createPdfZoomUi({
    translate: (key, value) => (value === undefined ? key : `${key}:${value}`),
    isPdf: (view) => view?.file?.extension === "pdf",
  });
  const pager = { flow: doc.getElementById("flow"), clip: doc.getElementById("clip"), scrollMode: false, total: 1, spread: 0 };
  const view = {
    file: { extension: "pdf" },
    pdfZoom: PDF_ZOOM_DEFAULT,
    pdfZoomMode: "page",
    contentEl: doc.getElementById("content"),
    pager,
    bookHtml: null,
  };
  return { window, doc, ui, view, pager };
}

test("syncControls mirrors zoom into the labels and disabled states", () => {
  const { doc, ui, view } = setup();
  view.pdfZoomLabelEl = doc.createElement("button");
  view.pdfZoomSettingsLabelEl = doc.createElement("span");
  view.pdfZoomOutEl = doc.createElement("button");
  view.pdfZoomInEl = doc.createElement("button");
  ui.syncControls(view);
  assert.equal(view.pdfZoomLabelEl.textContent, "100%");
  assert.equal(view.pdfZoomLabelEl.getAttribute("aria-label"), "pdf-zoom-options-0:100%");
  assert.equal(view.pdfZoomLabelEl.getAttribute("title"), "pdf-zoom-options-0:100%");
  assert.equal(view.pdfZoomOutEl.disabled, false);
  assert.equal(view.pdfZoomInEl.disabled, false);
  assert.equal(view.contentEl.classList.contains("qiaomu-reader-pdf-document"), true);
  view.pdfZoom = PDF_ZOOM_MIN;
  ui.syncControls(view);
  assert.equal(view.pdfZoomOutEl.disabled, true, "zooming out stops at the minimum");
  view.pdfZoom = PDF_ZOOM_MAX;
  ui.syncControls(view);
  assert.equal(view.pdfZoomInEl.disabled, true, "zooming in stops at the maximum");
});

test("apply clamps the zoom, updates the flow variable and ignores non-PDF views", () => {
  const { ui, view, pager } = setup();
  ui.apply(view, 2.5, null, "custom");
  assert.equal(view.pdfZoom, clampPdfZoom(2.5));
  assert.equal(pager.pdfZoom, clampPdfZoom(2.5));
  assert.equal(pager.flow.style.getPropertyValue("--qiaomu-reader-pdf-zoom"), String(clampPdfZoom(2.5)));
  assert.equal(view.pdfZoomMode, "custom");
  ui.apply(view, 99);
  assert.equal(view.pdfZoom, PDF_ZOOM_MAX, "values above the range clamp to the maximum");
  const other = { file: { extension: "epub" }, pdfZoom: 1 };
  ui.apply(other, 2);
  assert.equal(other.pdfZoom, 1, "EPUB views are left untouched");
});

test("change steps the zoom and setPanMode toggles the pan affordance", () => {
  const { ui, view } = setup();
  ui.change(view, 1);
  assert.ok(view.pdfZoom > PDF_ZOOM_DEFAULT, "zoom in raises the scale");
  ui.change(view, -1);
  assert.equal(Math.round(view.pdfZoom * 1000), Math.round(PDF_ZOOM_DEFAULT * 1000));
  const pan = (view.pdfPanButton = view.contentEl.ownerDocument.createElement("button"));
  ui.setPanMode(view, true);
  assert.equal(view.pdfPanMode, true);
  assert.equal(pan.getAttribute("aria-pressed"), "true");
  assert.equal(view.contentEl.classList.contains("qiaomu-reader-pdf-pan"), true);
});
