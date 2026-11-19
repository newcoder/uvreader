import assert from "node:assert/strict";
import test from "node:test";

import { pdfImageBoxesFromOps } from "../packages/reader/src/pdf-image-boxes.js";

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  paintImageXObject: 6,
  paintInlineImageXObject: 7,
};

// PDF user space is y-up; this fake viewport flips it to a 600×800 CSS page.
const viewport = {
  width: 600,
  height: 800,
  convertToViewportPoint: (x, y) => [x, 800 - y],
};

test("image operator transforms become normalised page boxes", () => {
  const boxes = pdfImageBoxesFromOps(
    [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    [null, [300, 0, 0, 200, 100, 400], ["img", 300, 200], null],
    { ops: OPS, viewport },
  );
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].bbox.map((value) => Math.round(value * 1000) / 1000), [0.167, 0.25, 0.667, 0.5]);
  assert.equal(boxes[0].name, "图片");
});

test("form XObject matrices nest with the current transform", () => {
  const boxes = pdfImageBoxesFromOps(
    [
      OPS.save,
      OPS.transform,
      OPS.paintFormXObjectBegin,
      OPS.paintInlineImageXObject,
      OPS.paintFormXObjectEnd,
      OPS.restore,
    ],
    [
      null,
      [1, 0, 0, 1, 60, 100],
      [{ 0: 2, 1: 0, 2: 0, 3: 2, 4: 10, 5: 20 }, [0, 0, 100, 100]],
      [[1, 2, 3], 10, 10],
      null,
      null,
    ],
    { ops: OPS, viewport },
  );
  // Unit square ×2, then +10/+20, then +60/+100: x 70..72, y 120..122.
  assert.equal(boxes.length, 0, "tiny boxes are filtered out");
  const bigger = pdfImageBoxesFromOps(
    [OPS.paintFormXObjectBegin, OPS.paintImageXObject, OPS.paintFormXObjectEnd],
    [[{ 0: 200, 1: 0, 2: 0, 3: 100, 4: 50, 5: 100 }, [0, 0, 1, 1]], ["img", 1, 1], null],
    { ops: OPS, viewport },
  );
  assert.deepEqual(bigger.map((box) => box.bbox.map((value) => Math.round(value * 1000) / 1000)), [
    [0.083, 0.75, 0.417, 0.875],
  ]);
});

test("duplicate boxes are collapsed and unsupported input is ignored", () => {
  const boxes = pdfImageBoxesFromOps(
    [OPS.transform, OPS.paintImageXObject, OPS.paintImageXObject],
    [[240, 0, 0, 160, 30, 40], ["a", 1, 1], ["b", 1, 1]],
    { ops: OPS, viewport },
  );
  assert.equal(boxes.length, 1);
  assert.deepEqual(pdfImageBoxesFromOps(null, null, { ops: OPS, viewport }), []);
  assert.deepEqual(pdfImageBoxesFromOps([], [], { ops: OPS }), []);
});
