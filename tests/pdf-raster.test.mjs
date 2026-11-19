import assert from "node:assert/strict";
import test from "node:test";

import {
  PDF_RASTER_MAX_PIXELS,
  pdfLegacyRasterScale,
  pdfRasterDpr,
  pdfRasterNeedsUpgrade,
  pdfRasterPlan,
} from "../packages/reader/src/pdf-raster.js";

test("the legacy scale keeps the old 1600px thumbnail rule", () => {
  assert.equal(pdfLegacyRasterScale(612, 792), 2);
  const scale = pdfLegacyRasterScale(1200, 2000);
  assert.equal(scale, 1);
});

test("a screen plan uses the CSS box, the device pixel ratio and a supersample", () => {
  const plan = pdfRasterPlan({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 300,
    cssHeight: 400,
    devicePixelRatio: 2,
  });
  assert.equal(plan.legacy, false);
  assert.equal(plan.limited, false);
  assert.equal(plan.scale, 2);
  assert.deepEqual([plan.pixelWidth, plan.pixelHeight], [1200, 1600]);
});

test("a zoomed page grows the canvas instead of stretching the old bitmap", () => {
  const plan = pdfRasterPlan({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 600,
    cssHeight: 800,
    devicePixelRatio: 2,
  });
  assert.equal(plan.scale, 4);
  assert.deepEqual([plan.pixelWidth, plan.pixelHeight], [2400, 3200]);
});

test("a huge box is clamped by an absolute pixel budget and reports itself limited", () => {
  const plan = pdfRasterPlan({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 6000,
    cssHeight: 8000,
    devicePixelRatio: 2,
  });
  assert.equal(plan.limited, true);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= PDF_RASTER_MAX_PIXELS);
});

test("missing screen measurements fall back to the legacy thumbnail", () => {
  const plan = pdfRasterPlan({ pageWidth: 600, pageHeight: 800 });
  assert.equal(plan.legacy, true);
  assert.equal(plan.scale, 2);
  assert.deepEqual([plan.pixelWidth, plan.pixelHeight], [1200, 1600]);
});

test("device pixel ratio is kept in a sane range", () => {
  assert.equal(pdfRasterDpr(undefined), 1);
  assert.equal(pdfRasterDpr(0), 1);
  assert.equal(pdfRasterDpr(1.5), 1.5);
  assert.equal(pdfRasterDpr(8), 4);
});

test("a loaded page asks for a new bitmap only when the new box outgrows it", () => {
  const base = { pixelWidth: 1200, pixelHeight: 1600, cssWidth: 300, cssHeight: 400, devicePixelRatio: 2 };
  assert.equal(pdfRasterNeedsUpgrade(base), false, "the current bitmap is already 2x the screen pixels");
  assert.equal(pdfRasterNeedsUpgrade({ ...base, cssWidth: 375, cssHeight: 500 }), true, "a 125% zoom needs more pixels");
  assert.equal(pdfRasterNeedsUpgrade({ ...base, cssWidth: 150, cssHeight: 200 }), false, "zooming out keeps the sharper bitmap");
  assert.equal(pdfRasterNeedsUpgrade({ ...base, pixelWidth: 0 }), false);
  assert.equal(pdfRasterNeedsUpgrade({ ...base, cssWidth: 0 }), false);
});
