// Zoom/pan controller for a standalone image. Fit width keeps the aspect
// ratio and centers the image in the reading area; wheel zoom and left-drag
// pan work both when the image lives in its own iframe and when it is mounted
// directly in the reader page. Panning is available even before the image
// exceeds the viewport, with a small edge allowance so it cannot be lost.
export function createImageZoom({
  image,
  doc,
  host,
  onChange = () => {},
  fitOnLoad = true,
  eventTarget = doc,
  rootStyle = true,
} = {}) {
  if (!image || !doc || !host) return null;
  const win = doc.defaultView || globalThis.window;
  const listeners = eventTarget || doc;
  const marker = "data-qbr-image-zoom";
  const state = {
    scale: 1,
    fitScale: 1,
    x: 0,
    y: 0,
    fit: true,
    dragging: false,
    drag: null,
    destroyed: false,
  };
  const style = doc.createElement("style");
  style.setAttribute("data-qbr-image-zoom", "");
  image.setAttribute(marker, "");
  style.textContent = [
    rootStyle ? "html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:transparent!important;}" : "",
    `[${marker}]{position:absolute!important;left:0!important;top:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;transform-origin:0 0!important;user-select:none!important;-webkit-user-drag:none!important;cursor:grab;touch-action:none!important;}`,
    `[${marker}].qbr-image-dragging{cursor:grabbing!important;}`,
  ].join("");
  doc.head?.append(style);
  image.style.width = "auto";
  image.style.height = "auto";
  image.style.maxWidth = "none";
  image.style.maxHeight = "none";
  image.style.position = "absolute";
  image.style.left = "0";
  image.style.top = "0";
  image.style.transformOrigin = "0 0";
  image.style.userSelect = "none";
  image.style.webkitUserDrag = "none";
  image.style.touchAction = "none";

  const viewport = () => ({
    w: Math.max(1, Number(host.clientWidth) || Number(win?.innerWidth) || 1),
    h: Math.max(1, Number(host.clientHeight) || Number(win?.innerHeight) || 1),
  });
  const natural = () => ({
    w: Number(image.naturalWidth) || Number(image.width) || 0,
    h: Number(image.naturalHeight) || Number(image.height) || 0,
  });
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const emit = () => {
    try { onChange({ fit: state.fit, scale: state.scale }); } catch { /* view may be closing */ }
  };
  const apply = () => {
    image.style.transform = `translate(${Math.round(state.x)}px, ${Math.round(state.y)}px) scale(${state.scale})`;
    image.classList.toggle("qbr-image-dragging", state.dragging);
    emit();
  };
  const bounds = () => {
    const { w, h } = viewport();
    const n = natural();
    const width = n.w * state.scale;
    const height = n.h * state.scale;
    // Panning is always available. When the image is smaller than the viewport
    // it may move within the free space plus a small margin; the margin is
    // capped so that at least part of the image stays visible. Once it is
    // larger than the viewport the usual edge-to-edge pan limits apply.
    if (width > w) state.x = clamp(state.x, w - width, 0);
    else {
      const margin = Math.min(w * 0.25, width * 0.5);
      state.x = clamp(state.x, -margin, w - width + margin);
    }
    if (height > h) state.y = clamp(state.y, h - height, 0);
    else {
      const margin = Math.min(h * 0.25, height * 0.5);
      state.y = clamp(state.y, -margin, h - height + margin);
    }
  };
  const fitWidth = () => {
    const n = natural();
    const { w, h } = viewport();
    if (!n.w || !n.h) return false;
    state.fitScale = w / n.w;
    state.scale = state.fitScale;
    state.fit = true;
    state.x = 0;
    state.y = (h - n.h * state.scale) / 2;
    bounds();
    apply();
    return true;
  };
  const zoomAt = (factor, cx, cy) => {
    const n = natural();
    if (!n.w || !n.h) return false;
    const next = clamp(state.scale * factor, Math.min(0.1, state.fitScale * 0.2), 8);
    if (Math.abs(next - state.scale) < 0.001) return false;
    const px = (Number(cx) - state.x) / state.scale;
    const py = (Number(cy) - state.y) / state.scale;
    state.scale = next;
    state.x = Number(cx) - px * next;
    state.y = Number(cy) - py * next;
    state.fit = Math.abs(next - state.fitScale) < 0.001;
    bounds();
    apply();
    return true;
  };
  const zoomBy = (factor) => {
    const { w, h } = viewport();
    return zoomAt(factor, w / 2, h / 2);
  };

  const onWheel = (event) => {
    if (state.destroyed) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = Number(event.deltaY) || 0;
    if (!delta) return;
    zoomAt(Math.exp(-delta * 0.0015), event.clientX, event.clientY);
  };
  const inImagePage = (target) => target === host
    || (!!target?.closest?.("img") && host.contains(target));
  const startDrag = (event, pointerId = null) => {
    if (state.destroyed || state.dragging || event.button !== 0) return false;
    if (!inImagePage(event.target)) return false;
    event.preventDefault();
    event.stopPropagation();
    state.dragging = true;
    state.drag = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: state.x,
      y: state.y,
    };
    if (pointerId != null) {
      try { image.setPointerCapture?.(pointerId); } catch { /* capture is optional */ }
    }
    apply();
    return true;
  };
  const moveDrag = (event) => {
    if (!state.dragging || !state.drag) return false;
    event.preventDefault();
    event.stopPropagation();
    state.x = state.drag.x + event.clientX - state.drag.startX;
    state.y = state.drag.y + event.clientY - state.drag.startY;
    state.fit = false;
    bounds();
    apply();
    return true;
  };
  const endDrag = (event) => {
    if (!state.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    state.dragging = false;
    const pointerId = state.drag?.pointerId;
    state.drag = null;
    if (pointerId != null) {
      try { image.releasePointerCapture?.(pointerId); } catch { /* gone */ }
    }
    apply();
  };
  const onPointerDown = (event) => { startDrag(event, event.pointerId); };
  const onMouseDown = (event) => {
    // Pointer events normally start the drag. Mouse events are retained as a
    // fallback for environments that do not deliver pointerdown, and pressing
    // the background of the image page should count as pressing the image.
    if (state.dragging) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    startDrag(event, null);
  };
  const onPointerMove = (event) => {
    if (state.drag?.pointerId == null) return;
    moveDrag(event);
  };
  const onMouseMove = (event) => {
    if (state.drag?.pointerId != null) return;
    moveDrag(event);
  };
  const onPointerUp = (event) => {
    if (state.drag?.pointerId == null) return;
    endDrag(event);
  };
  const onMouseUp = (event) => { endDrag(event); };
  // The normal engine click handler opens the image lightbox. In the image
  // book, the page itself is the viewer, so a click must not replace it.
  const onClick = (event) => {
    if (state.destroyed) return;
    if (!inImagePage(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  };
  const resize = () => {
    if (state.destroyed) return;
    if (state.fit) fitWidth();
    else { bounds(); apply(); }
  };
  let observer = null;
  if (host && typeof win?.ResizeObserver === "function") {
    observer = new win.ResizeObserver(resize);
    observer.observe(host);
  } else {
    win?.addEventListener?.("resize", resize);
  }
  const onLoad = () => {
    if (state.destroyed) return;
    if (fitOnLoad || state.fit) fitWidth();
  };
  listeners.addEventListener("wheel", onWheel, { passive: false, capture: true });
  listeners.addEventListener("pointerdown", onPointerDown, true);
  listeners.addEventListener("mousedown", onMouseDown, true);
  // Move/up live on the document so a drag that leaves the image page (or
  // loses pointer capture) still pans and always ends cleanly.
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerUp, true);
  doc.addEventListener("mousemove", onMouseMove, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  listeners.addEventListener("click", onClick, true);
  image.addEventListener("load", onLoad);
  if (image.complete && natural().w) {
    if (fitOnLoad) fitWidth();
  } else if (fitOnLoad) {
    onLoad();
  }

  return {
    fitWidth,
    zoomAt,
    zoomBy,
    resize,
    get state() { return { ...state }; },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      observer?.disconnect();
      win?.removeEventListener?.("resize", resize);
      listeners.removeEventListener("wheel", onWheel, { capture: true });
      listeners.removeEventListener("pointerdown", onPointerDown, true);
      listeners.removeEventListener("mousedown", onMouseDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      doc.removeEventListener("pointercancel", onPointerUp, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      doc.removeEventListener("mouseup", onMouseUp, true);
      listeners.removeEventListener("click", onClick, true);
      image.removeEventListener("load", onLoad);
      style.remove();
      image.removeAttribute(marker);
      image.classList.remove("qbr-image-dragging");
    },
  };
}
