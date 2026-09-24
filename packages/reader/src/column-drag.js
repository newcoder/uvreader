// Column divider drags: the workspace sidebars and the docked highlights
// splitter. While one is active the reader holds its reflow so the divider
// follows the pointer frame by frame; the layout lands once the drag ends.
// A sidebar drag changes the reading area width continuously, and re-paginating
// (or re-blurring the pages) on every frame is what made the drag stutter on
// large documents.
const DRAG_CLASS = "qbr-split-dragging";
const SPLITTER_SELECTOR = ".qbr-splitter, .qiaomu-reader-splitter";

const watchers = new Set();
let depth = 0;

export function columnDragActive() {
  return depth > 0;
}

function notify(active) {
  for (const watcher of [...watchers]) {
    try { watcher(active); } catch { /* a watcher must never break the drag */ }
  }
}

export function beginColumnDrag() {
  depth += 1;
  if (depth === 1) notify(true);
}

export function endColumnDrag() {
  if (depth === 0) return;
  depth -= 1;
  if (depth === 0) notify(false);
}

// Calls the watcher on every drag start and end; returns the unsubscribe.
export function onColumnDrag(watcher) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

// Watches a root that contains the dividers (the workspace or a reader modal).
// The drag session starts on the divider's pointerdown and ends when the
// pointer is released anywhere, including outside the window.
export function installColumnDragWatch(root, doc = root?.ownerDocument || globalThis.document) {
  if (!root?.addEventListener || !doc) return () => {};
  const onDown = (event) => {
    if (event.button !== 0 || !event.target?.closest?.(SPLITTER_SELECTOR)) return;
    const html = doc.documentElement;
    beginColumnDrag();
    html?.classList?.add(DRAG_CLASS);
    const finish = () => {
      doc.removeEventListener("pointerup", finish, true);
      doc.removeEventListener("pointercancel", finish, true);
      html?.classList?.remove(DRAG_CLASS);
      endColumnDrag();
    };
    doc.addEventListener("pointerup", finish, true);
    doc.addEventListener("pointercancel", finish, true);
  };
  root.addEventListener("pointerdown", onDown, true);
  return () => root.removeEventListener("pointerdown", onDown, true);
}
