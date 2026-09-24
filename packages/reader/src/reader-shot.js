// Drag-box screenshot overlay for the reading area. The module owns only the
// selection UI and the geometry; capturing the pixels is the caller's job, so
// the same overlay serves the desktop screen capture and the PDF fallback.
//
// The box may span pages: the returned rectangle is the viewport-space region
// the reader drew, and nothing here assumes a single page.

export const SHOT_MIN_SIZE = 24;

function rectFromPoints(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function clampShotRect(rect, bounds) {
  const left = Math.max(bounds.x, rect.x);
  const top = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// The PDF fallback for hosts without a screen-capture bridge: how each
// intersected page image is cropped and where its fragment lands on the
// stitched canvas. `pages` entries are { rect, imageWidth, imageHeight } in
// viewport and natural pixels; multi-page boxes are stitched side by side.
export function planRegionStitch(region, pages, maxRatio = 2) {
  const items = [];
  for (const page of pages || []) {
    const overlap = clampShotRect(region, page.rect || { x: 0, y: 0, width: 0, height: 0 });
    if (overlap.width < 1 || overlap.height < 1) continue;
    const width = page.rect.width || 0;
    const height = page.rect.height || 0;
    if (!width || !height || !page.imageWidth || !page.imageHeight) continue;
    items.push({
      page,
      source: {
        x: ((overlap.x - page.rect.x) / width) * page.imageWidth,
        y: ((overlap.y - page.rect.y) / height) * page.imageHeight,
        width: (overlap.width / width) * page.imageWidth,
        height: (overlap.height / height) * page.imageHeight,
      },
      target: {
        x: overlap.x - region.x,
        y: overlap.y - region.y,
        width: overlap.width,
        height: overlap.height,
      },
    });
  }
  if (!items.length) return null;
  const ratios = items.map((item) => item.page.imageWidth / (item.page.rect.width || 1));
  const ratio = Math.max(1, Math.min(maxRatio, ...ratios));
  return {
    ratio,
    width: Math.max(1, Math.ceil(region.width * ratio)),
    height: Math.max(1, Math.ceil(region.height * ratio)),
    items: items.map((item) => ({
      page: item.page,
      source: item.source,
      target: {
        x: item.target.x * ratio,
        y: item.target.y * ratio,
        width: item.target.width * ratio,
        height: item.target.height * ratio,
      },
    })),
  };
}

// Overlay lifecycle: `shown` resolves with the drawn rect, or null when the
// reader cancels (Esc, right click, or a box that is too small).
export function openShotOverlay({ host, translate = (key) => key, minSize = SHOT_MIN_SIZE }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView || globalThis;
  const overlay = host.createDiv("qiaomu-reader-shot");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", translate("screenshot"));
  const box = overlay.createDiv("qiaomu-reader-shot-box");
  box.hidden = true;
  const size = overlay.createDiv("qiaomu-reader-shot-size");
  size.hidden = true;
  const hint = overlay.createDiv({ cls: "qiaomu-reader-shot-hint", text: translate("drag-to-select-a-region-esc-cancels") });

  let start = null;
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const cleanup = () => {
    doc.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const bounds = () => {
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  const paint = (event) => {
    if (!start) return;
    const rect = rectFromPoints(start, { x: event.clientX, y: event.clientY });
    const area = bounds();
    box.hidden = false;
    box.style.left = `${rect.x - area.x}px`;
    box.style.top = `${rect.y - area.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    size.hidden = false;
    size.setText(`${Math.round(rect.width)} × ${Math.round(rect.height)}`);
    size.style.left = `${rect.x - area.x + rect.width / 2}px`;
    size.style.top = `${Math.max(0, rect.y - area.y - 26)}px`;
    hint.hidden = true;
  };
  const onDown = (event) => {
    if (event.button !== 0) { finish(null); return; }
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    overlay.setPointerCapture?.(event.pointerId);
    paint(event);
  };
  const onMove = (event) => { if (start) paint(event); };
  const onUp = (event) => {
    if (!start) return;
    const rect = clampShotRect(rectFromPoints(start, { x: event.clientX, y: event.clientY }), bounds());
    start = null;
    if (rect.width < minSize || rect.height < minSize) { finish(null); return; }
    finish(rect);
  };
  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(null);
  }

  overlay.addEventListener("pointerdown", onDown);
  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerup", onUp);
  overlay.addEventListener("pointercancel", () => finish(null));
  overlay.addEventListener("contextmenu", (event) => { event.preventDefault(); finish(null); });
  doc.addEventListener("keydown", onKey, true);
  win.requestAnimationFrame?.(() => overlay.addClass("qiaomu-reader-shot-on"));
  return { promise, cancel: () => finish(null) };
}
