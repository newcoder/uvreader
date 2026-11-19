// Figure sidecars for scanned/layout-preserving PDFs.
//
// The converted page is still one raster image, so illustrations are not
// separate PDF objects and cannot be clicked in a viewer. The conversion writes
// a small JSON sidecar with the image/table boxes; the reader overlays invisible
// hotspots and crops the already-rendered page bitmap on click. Everything here
// is pure so the manifest, layout extraction and crop maths stay testable.

export const PDF_FIGURES_VERSION = 1;
const MIN_SIDE = 0.035;
const MIN_AREA = 0.0025;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// MinerU middle_json uses 0..1; content_list uses 0..1000. Accept both and
// return a top-left-origin box clamped to the page.
export function normalisePdfFigureBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  let values = bbox.slice(0, 4).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (values.every((value) => value >= 0) && values.some((value) => value > 1.5)) {
    values = values.map((value) => value / 1000);
  }
  let [x0, y0, x1, y1] = values;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = clamp01(x0);
  y0 = clamp01(y0);
  x1 = clamp01(x1);
  y1 = clamp01(y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

// Sidecar JSON → reader manifest. Bad rows are dropped instead of breaking the
// whole book; an empty or malformed sidecar simply means "no hotspots".
export function pdfFigureManifestFromData(data) {
  const figures = [];
  const seen = new Set();
  for (const item of Array.isArray(data?.figures) ? data.figures : []) {
    const page = Math.round(Number(item?.page)) || 0;
    const bbox = normalisePdfFigureBbox(item?.bbox);
    if (!page || !bbox) continue;
    const key = `${page}\u0000${bbox.map((value) => value.toFixed(5)).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push({
      page,
      bbox,
      name: String(item?.name || "").trim(),
      type: item?.type === "table" || String(item?.name || "").trim() === "表格" ? "table" : "image",
    });
  }
  return figures.length ? { figures } : null;
}

// Reader manifest → sidecar JSON.
export function pdfFigureManifestData(figures, { source = "" } = {}) {
  return {
    version: PDF_FIGURES_VERSION,
    source: String(source || ""),
    figures: (Array.isArray(figures) ? figures : [])
      .map((figure) => ({
        page: Math.round(Number(figure?.page)) || 0,
        bbox: normalisePdfFigureBbox(figure?.bbox),
        name: String(figure?.name || "").trim(),
        type: figure?.type === "table" ? "table" : "image",
      }))
      .filter((figure) => figure.page && figure.bbox),
  };
}

// MinerU layout → figure rows. Tables count as figures too: the reader shows
// the table crop, which is often more readable than the surrounding page.
export function pdfFiguresFromLayout(layout, options = {}) {
  const minSide = Number(options.minSide) || MIN_SIDE;
  const minArea = Number(options.minArea) || MIN_AREA;
  const figures = [];
  const seen = new Set();
  for (const page of Array.isArray(layout?.pages) ? layout.pages : []) {
    const pageNumber = Math.round(Number(page?.page)) || 0;
    if (!pageNumber) continue;
    for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
      const type = String(block?.type || "");
      if (type !== "image" && type !== "table") continue;
      const bbox = normalisePdfFigureBbox(block?.bbox);
      if (!bbox) continue;
      const width = bbox[2] - bbox[0];
      const height = bbox[3] - bbox[1];
      if (width < minSide || height < minSide || width * height < minArea) continue;
      const key = `${pageNumber}\u0000${bbox.map((value) => value.toFixed(5)).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      figures.push({
        page: pageNumber,
        bbox,
        name: type === "table" ? "表格" : "插图",
        type,
      });
    }
  }
  figures.sort((left, right) => left.page - right.page || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
  return figures;
}

// Normalised box → integer source pixels for canvas cropping. `padding` is in
// source pixels and gives the preview a little breathing room around the crop.
export function pdfFigureCropRect(bbox, width, height, { padding = 0 } = {}) {
  const pageWidth = Math.round(Number(width)) || 0;
  const pageHeight = Math.round(Number(height)) || 0;
  const box = normalisePdfFigureBbox(bbox);
  if (!pageWidth || !pageHeight || !box) return null;
  const pad = Math.max(0, Math.round(Number(padding)) || 0);
  const x = Math.max(0, Math.floor(box[0] * pageWidth) - pad);
  const y = Math.max(0, Math.floor(box[1] * pageHeight) - pad);
  const right = Math.min(pageWidth, Math.ceil(box[2] * pageWidth) + pad);
  const bottom = Math.min(pageHeight, Math.ceil(box[3] * pageHeight) + pad);
  const cropWidth = right - x;
  const cropHeight = bottom - y;
  if (cropWidth < 2 || cropHeight < 2) return null;
  return { x, y, width: cropWidth, height: cropHeight };
}
