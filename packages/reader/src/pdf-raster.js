// Raster budgets for fixed-layout PDF pages.
//
// The page bitmap used to be capped at a 1600px edge and encoded as JPEG 0.82.
// That is enough for a thumbnail, not for text on a HiDPI screen: the browser
// has to stretch the bitmap past its native pixels and the JPEG ringing shows
// on every glyph edge. These helpers size the canvas from the CSS box the page
// is actually drawn in, multiply by devicePixelRatio, and keep a 2x supersample
// budget for anti-aliasing. Everything is clamped so a 300% zoom on a 4K
// display cannot allocate a 100-megapixel canvas.

export const PDF_RASTER_LEGACY_SIDE = 1600;
export const PDF_RASTER_LEGACY_MAX_SCALE = 2;
export const PDF_RASTER_QUALITY = 2;
export const PDF_RASTER_MAX_PIXELS = 12_000_000;
export const PDF_RASTER_MAX_SIDE = 8192;
export const PDF_RASTER_MIN_SCALE = 0.125;
export const PDF_RASTER_UPGRADE_TOLERANCE = 1.12;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function pdfRasterDpr(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(4, Math.max(1, number));
}

// The historical render scale: at least 1, at most 2, and never keeping the
// long edge above 1600px. Kept verbatim for callers that only want a thumbnail
// (AI attachments, screenshots) and for the fallback pass of a timed-out page.
export function pdfLegacyRasterScale(width, height) {
  const pageWidth = positive(width);
  const pageHeight = positive(height);
  if (!pageWidth || !pageHeight) return 1;
  return Math.max(1, Math.min(PDF_RASTER_LEGACY_MAX_SCALE, PDF_RASTER_LEGACY_SIDE / Math.max(pageWidth, pageHeight)));
}

/**
 * Decide the canvas size for one PDF page.
 *
 * `cssWidth` / `cssHeight` describe the page box on screen *after* the reader's
 * zoom transform (getBoundingClientRect already includes it). When they are
 * missing the legacy 1600px rule is used.
 */
export function pdfRasterPlan({
  pageWidth,
  pageHeight,
  cssWidth,
  cssHeight,
  devicePixelRatio = 1,
  quality = PDF_RASTER_QUALITY,
  maxPixels = PDF_RASTER_MAX_PIXELS,
  maxSide = PDF_RASTER_MAX_SIDE,
} = {}) {
  const width = positive(pageWidth) || positive(cssWidth) || 1;
  const height = positive(pageHeight) || positive(cssHeight) || 1;
  const screenWidth = positive(cssWidth);
  const screenHeight = positive(cssHeight);
  const supersample = positive(quality) || PDF_RASTER_QUALITY;
  const dpr = pdfRasterDpr(devicePixelRatio);
  const onScreen = screenWidth > 0 && screenHeight > 0;
  if (!onScreen) {
    const scale = pdfLegacyRasterScale(width, height);
    return {
      scale,
      requestedScale: scale,
      pixelWidth: Math.max(1, Math.ceil(width * scale)),
      pixelHeight: Math.max(1, Math.ceil(height * scale)),
      limited: false,
      legacy: true,
    };
  }

  // Take the larger of the two axes: a rotated page can be wider on screen
  // than its unrotated PDF box and the bitmap must still cover it.
  const requestedScale = Math.max(
    screenWidth * dpr * supersample / width,
    screenHeight * dpr * supersample / height,
  );
  const sideScale = (positive(maxSide) || PDF_RASTER_MAX_SIDE) / Math.max(width, height);
  const areaScale = Math.sqrt((positive(maxPixels) || PDF_RASTER_MAX_PIXELS) / (width * height));
  const cap = Math.max(PDF_RASTER_MIN_SCALE, Math.min(sideScale, areaScale));
  const limited = requestedScale > cap;
  const scale = Math.max(PDF_RASTER_MIN_SCALE, limited ? cap : requestedScale);
  return {
    scale,
    requestedScale,
    pixelWidth: Math.max(1, Math.ceil(width * scale)),
    pixelHeight: Math.max(1, Math.ceil(height * scale)),
    limited,
    legacy: false,
  };
}

/**
 * True when a loaded bitmap no longer has enough pixels for the box it is
 * drawn in. `object-fit: contain` is assumed: the painted width is limited by
 * the box, never by a stretch, so compare against the contained width.
 */
export function pdfRasterNeedsUpgrade({
  pixelWidth,
  pixelHeight,
  cssWidth,
  cssHeight,
  devicePixelRatio = 1,
  quality = PDF_RASTER_QUALITY,
  tolerance = PDF_RASTER_UPGRADE_TOLERANCE,
} = {}) {
  const bitmapWidth = positive(pixelWidth);
  const bitmapHeight = positive(pixelHeight);
  const boxWidth = positive(cssWidth);
  const boxHeight = positive(cssHeight);
  if (!bitmapWidth || !bitmapHeight || !boxWidth || !boxHeight) return false;
  const aspect = bitmapWidth / bitmapHeight;
  const paintedWidth = Math.min(boxWidth, boxHeight * aspect);
  if (!(paintedWidth > 0)) return false;
  const target = paintedWidth * pdfRasterDpr(devicePixelRatio) * (positive(quality) || PDF_RASTER_QUALITY);
  return bitmapWidth * (positive(tolerance) || PDF_RASTER_UPGRADE_TOLERANCE) < target;
}
