// Recovery of highlights that only exist in the plugin's save-point backups.
// A bad write (an interrupted sync, a bug that replaced a book's list) can
// leave the per-book file shorter than the backups; the settings action offers
// to merge those records back. Only ids that are absent from the current list
// are collected, so a deliberate deletion is not resurrected once the current
// list has moved on.
export function collectMissingHighlights(backups = {}, current = {}) {
  const books = [];
  let total = 0;
  for (const [bookPath, snapshots] of Object.entries(backups || {})) {
    const known = new Set((Array.isArray(current?.[bookPath]) ? current[bookPath] : []).map((item) => item?.id).filter(Boolean));
    const missing = new Map();
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
        if (!item?.id || known.has(item.id) || missing.has(item.id)) continue;
        missing.set(item.id, item);
      }
    }
    if (!missing.size) continue;
    const items = [...missing.values()].sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
    books.push({ bookPath, items });
    total += items.length;
  }
  books.sort((a, b) => String(a.bookPath).localeCompare(String(b.bookPath)));
  return { books, total };
}
