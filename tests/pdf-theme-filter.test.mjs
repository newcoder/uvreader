import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { applyPdfPageThemeFilter, PDF_THEME_FILTER_ID } from "../packages/reader/src/pdf-theme-filter.js";

test("the PDF theme filter installs once, updates in place, and disables for e-ink", () => {
  const dom = new JSDOM("<body></body>");
  const { document } = dom.window;
  const url = applyPdfPageThemeFilter(document, { theme: "night" });
  assert.equal(url, `url(#${PDF_THEME_FILTER_ID})`);
  const filter = document.getElementById(PDF_THEME_FILTER_ID);
  assert.ok(filter);
  assert.equal(filter.getAttribute("color-interpolation-filters"), "sRGB");
  assert.equal(filter.querySelector("feColorMatrix").getAttribute("values"), "0");
  const transfers = filter.querySelectorAll("feComponentTransfer");
  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].getAttribute("in"), "gray");
  assert.equal(transfers[0].getAttribute("result"), "levels");
  assert.equal(transfers[1].getAttribute("in"), "levels");
  assert.equal(transfers[1].querySelectorAll("feFuncR, feFuncG, feFuncB").length, 3);
  assert.equal(applyPdfPageThemeFilter(document, { theme: "night" }), url);
  assert.equal(document.querySelectorAll(`#${PDF_THEME_FILTER_ID}`).length, 1);
  applyPdfPageThemeFilter(document, { theme: "paper" });
  assert.equal(document.querySelectorAll(`#${PDF_THEME_FILTER_ID}`).length, 1);
  assert.equal(document.getElementById("qiaomu-reader-pdf-theme-filter-svg").dataset.theme, "paper");
  assert.equal(applyPdfPageThemeFilter(document, { theme: "night", einkMode: true }), "none");
  dom.window.close();
});
