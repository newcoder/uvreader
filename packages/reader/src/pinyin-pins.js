// Pinned pinyin annotations: the shared behaviour behind the selection chip's
// pin button and the engine's per-section repaint. The owner is either the
// reader view or the reader modal; both expose file/plugin/engine.
export function pinyinPinFor(owner, sel) {
  if (!sel?.cfi || !owner?.file) return null;
  return owner.plugin.getPins(owner.file.path).find((pin) => pin.cfi === sel.cfi) || null;
}

export function togglePinyinPin(owner, sel, info, { notice, translate }) {
  if (!owner?.file) return null;
  if (!owner.engine || owner.file.extension === "pdf" || !sel?.cfi) {
    notice(translate("pinyin-pin-unsupported"));
    return null;
  }
  const existing = pinyinPinFor(owner, sel);
  if (existing) {
    owner.plugin.removePin(owner.file.path, existing.id);
    void owner.engine.removePin(existing.id);
    notice(translate("pinyin-unpinned"));
    return null;
  }
  const pin = {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cfi: sel.cfi,
    text: sel.text || "",
    pinyin: info?.pinyin || "",
    gloss: info?.gloss || "",
    created: Date.now(),
  };
  owner.plugin.addPin(owner.file.path, pin);
  void owner.engine.addPin(pin.id, pin.cfi, pin);
  notice(translate("pinyin-pinned"));
  return pin;
}

// Paint the stored pins of the current book. Sections that are not rendered
// yet are skipped; the engine repaints them when their overlay appears.
export function renderEnginePins(owner) {
  if (!owner?.engine || !owner.file) return;
  const engine = owner.engine;
  const path = owner.file.path;
  void (async () => {
    for (const pin of owner.plugin.getPins(path)) {
      if (owner._closed || owner.engine !== engine || owner.file?.path !== path) return;
      if (!pin.cfi) continue;
      try { await engine.addPin(pin.id, pin.cfi, pin); }
      catch { /* the section holding that CFI may not be rendered yet */ }
    }
  })();
}
