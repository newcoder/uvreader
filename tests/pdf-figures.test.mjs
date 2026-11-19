import assert from "node:assert/strict";
import test from "node:test";

import {
  normalisePdfFigureBbox,
  pdfFigureCropRect,
  pdfFigureManifestData,
  pdfFigureManifestFromData,
  pdfFiguresFromLayout,
} from "../packages/reader/src/pdf-figures.js";

test("figure boxes accept normalised and 0–1000 coordinates", () => {
  assert.deepEqual(normalisePdfFigureBbox([0.1, 0.2, 0.5, 0.6]), [0.1, 0.2, 0.5, 0.6]);
  assert.deepEqual(normalisePdfFigureBbox([100, 200, 500, 600]), [0.1, 0.2, 0.5, 0.6]);
  assert.deepEqual(normalisePdfFigureBbox([0.5, 0.6, 0.1, 0.2]), [0.1, 0.2, 0.5, 0.6]);
  assert.deepEqual(normalisePdfFigureBbox([-1, -2, 2, 3]), [0, 0, 1, 1]);
  assert.equal(normalisePdfFigureBbox([0.2, 0.2, 0.2, 0.8]), null);
  assert.equal(normalisePdfFigureBbox("nope"), null);
});

test("the reader manifest drops bad rows and duplicate boxes", () => {
  const manifest = pdfFigureManifestFromData({
    figures: [
      { page: 4, bbox: [0.1, 0.1, 0.4, 0.5], name: "插图" },
      { page: 4, bbox: [0.1, 0.1, 0.4, 0.5], name: "插图" },
      { page: 0, bbox: [0.1, 0.1, 0.4, 0.5] },
      { page: 5, bbox: [0.5, 0.5, 0.5, 0.6] },
      { page: 6, bbox: [0.2, 0.2, 0.8, 0.9], name: "表格" },
    ],
  });
  assert.equal(manifest.figures.length, 2);
  assert.deepEqual(manifest.figures[0], { page: 4, bbox: [0.1, 0.1, 0.4, 0.5], name: "插图", type: "image" });
  assert.deepEqual(manifest.figures[1], { page: 6, bbox: [0.2, 0.2, 0.8, 0.9], name: "表格", type: "table" });
  assert.equal(pdfFigureManifestFromData({ figures: [] }), null);
  assert.equal(pdfFigureManifestFromData(null), null);
});

test("layout image and table blocks become a sorted figure manifest", () => {
  const layout = {
    pages: [
      {
        page: 9,
        blocks: [
          { type: "text", bbox: [0.1, 0.1, 0.9, 0.2], text: "正文" },
          { type: "table", bbox: [100, 300, 900, 500] },
          { type: "image", bbox: [0.6, 0.1, 0.9, 0.4] },
          { type: "image", bbox: [0.1, 0.1, 0.12, 0.12] },
        ],
      },
      {
        page: 3,
        blocks: [{ type: "image", bbox: [0.2, 0.7, 0.8, 0.95] }],
      },
    ],
  };
  const figures = pdfFiguresFromLayout(layout);
  assert.deepEqual(figures.map((figure) => [figure.page, figure.name]), [
    [3, "插图"],
    [9, "插图"],
    [9, "表格"],
  ]);
  assert.deepEqual(figures[2].bbox, [0.1, 0.3, 0.9, 0.5]);
});

test("the sidecar round-trips through the reader parser", () => {
  const data = pdfFigureManifestData([
    { page: 20, bbox: [0.05, 0.1, 0.3, 0.3], name: "插图" },
    { page: 0, bbox: [0.1, 0.1, 0.2, 0.2] },
  ], { source: "书.pdf" });
  assert.equal(data.version, 1);
  assert.equal(data.source, "书.pdf");
  assert.equal(data.figures.length, 1);
  assert.deepEqual(pdfFigureManifestFromData(data), {
    figures: [{ page: 20, bbox: [0.05, 0.1, 0.3, 0.3], name: "插图", type: "image" }],
  });
});

test("crop rectangles clamp to the page and keep padding inside it", () => {
  assert.deepEqual(pdfFigureCropRect([0.25, 0.25, 0.75, 0.75], 400, 800, { padding: 5 }), {
    x: 95, y: 195, width: 210, height: 410,
  });
  assert.deepEqual(pdfFigureCropRect([0, 0, 1, 1], 100, 200, { padding: 10 }), {
    x: 0, y: 0, width: 100, height: 200,
  });
  assert.equal(pdfFigureCropRect([0.5, 0.5, 0.5001, 0.5001], 10, 10), null);
  assert.equal(pdfFigureCropRect([0.1, 0.1, 0.2, 0.2], 0, 100), null);
});
