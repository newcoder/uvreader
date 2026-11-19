// PDF.js operator list → axis-aligned image boxes on the page.
//
// A normal (digital) PDF draws photos and figures as image XObjects; the
// reproducer can read the page operator list and track the graphics-state
// transform stack to recover each image's unit-square placement. The reader
// then overlays the unfiltered page raster inside those boxes, so the theme
// filter only changes paper/text and leaves pictures in their original colours.
//
// Scanned pages that are one full-page image will get a full-page box; callers
// that have a figure sidecar skip this path, and the layout-converted pipeline
// uses sidecar boxes instead.

const IDENTITY = [1, 0, 0, 1, 0, 0];

function matrixFrom(value) {
  if (Array.isArray(value) && value.length >= 6) return value.slice(0, 6).map(Number);
  if (value && typeof value === "object") {
    const values = [0, 1, 2, 3, 4, 5].map((index) => Number(value[index]));
    if (values.every((number) => Number.isFinite(number))) return values;
  }
  return IDENTITY;
}

function multiply(left, right) {
  const [a, b, c, d, e, f] = left;
  const [A, B, C, D, E, F] = right;
  return [
    a * A + c * B,
    b * A + d * B,
    a * C + c * D,
    b * C + d * D,
    a * E + c * F + e,
    b * E + d * F + f,
  ];
}

function apply(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function pdfImageBoxesFromOps(fnArray, argsArray, options = {}) {
  const {
    ops,
    viewport,
    minSide = 0.025,
    minArea = 0.0015,
    // A box that covers the page is the page raster itself (scanned pages and
    // layout-preserved PDFs), not an illustration. Restoring it "unfiltered"
    // would paint the whole page over the reading-theme filter.
    maxArea = 0.9,
    maxBoxes = 80,
  } = options;
  if (!ops || !viewport?.convertToViewportPoint || !Array.isArray(fnArray)) return [];
  const width = Number(viewport.width) || 0;
  const height = Number(viewport.height) || 0;
  if (!width || !height) return [];

  let ctm = IDENTITY;
  const stack = [];
  const boxes = [];
  const seen = new Set();
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintJpegXObject,
    ops.paintImageMaskXObject,
    ops.paintSolidColorImageMask,
  ].filter((value) => Number.isFinite(value)));

  const addBox = () => {
    const points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => {
      const [px, py] = apply(ctm, x, y);
      return viewport.convertToViewportPoint(px, py);
    });
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const x0 = clamp01(Math.min(...xs) / width);
    const y0 = clamp01(Math.min(...ys) / height);
    const x1 = clamp01(Math.max(...xs) / width);
    const y1 = clamp01(Math.max(...ys) / height);
    const boxWidth = x1 - x0;
    const boxHeight = y1 - y0;
    if (boxWidth < minSide || boxHeight < minSide || boxWidth * boxHeight < minArea) return;
    if (boxWidth * boxHeight >= maxArea) return;
    const key = [x0, y0, x1, y1].map((value) => value.toFixed(4)).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    boxes.push({ bbox: [x0, y0, x1, y1], name: "图片" });
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray?.[index];
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      ctm = stack.pop() || IDENTITY;
    } else if (fn === ops.transform) {
      ctm = multiply(ctm, matrixFrom(args));
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      ctm = multiply(ctm, matrixFrom(args?.[0]));
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() || IDENTITY;
    } else if (imageOps.has(fn)) {
      addBox();
      if (boxes.length >= maxBoxes) break;
    }
  }
  boxes.sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
  return boxes;
}
