// Pinned pinyin annotations: the shared behaviour behind the selection chip's
// pin button. The owner is either the reader view or the reader modal; both
// expose file/plugin/engine. Engine formats anchor a pin by CFI, fixed-layout
// pages (PDF) by block and offset.
function pinAnchor(owner, sel) {
  if (!owner || !sel) return null;
  if (owner.engine) return sel.cfi ? { cfi: sel.cfi } : null;
  return Number.isInteger(sel.block)
    ? { block: sel.block, occ: sel.occ, pre: sel.pre, post: sel.post }
    : null;
}

export function pinyinPinFor(owner, sel) {
  if (!owner?.file) return null;
  const anchor = pinAnchor(owner, sel);
  if (!anchor) return null;
  const pins = owner.plugin.getPins(owner.file.path);
  if (anchor.cfi) return pins.find((pin) => pin.cfi === anchor.cfi) || null;
  return pins.find((pin) => !pin.cfi && pin.block === anchor.block
    && (pin.occ || 0) === (anchor.occ || 0) && pin.text === (sel.text || "")) || null;
}

export function togglePinyinPin(owner, sel, info, { notice, translate }) {
  if (!owner?.file) return null;
  const anchor = pinAnchor(owner, sel);
  if (!anchor) {
    notice(translate("pinyin-pin-unsupported"));
    return null;
  }
  const existing = pinyinPinFor(owner, sel);
  if (existing) {
    owner.plugin.removePin(owner.file.path, existing.id);
    if (anchor.cfi) void owner.engine.removePin(existing.id);
    else owner._renderFlowPins?.();
    notice(translate("pinyin-unpinned"));
    return null;
  }
  const pin = {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...anchor,
    text: sel.text || "",
    pinyin: info?.pinyin || "",
    gloss: info?.gloss || "",
    created: Date.now(),
  };
  owner.plugin.addPin(owner.file.path, pin);
  if (anchor.cfi) void owner.engine.addPin(pin.id, pin.cfi, pin);
  else owner._renderFlowPins?.();
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
