// Popup for a pinned pinyin annotation. Shows the full reading and the short
// definition, plus one action that removes the pin. Created lazily per view
// and placed by the reader's shared popup helper so it follows the selection
// toolbar rules (docked on mobile, flipped above the text on desktop).
import { docOf } from "./reader-dom.js";

export function createPinPopup({ translate, positionPopup }) {
  function ensure(view) {
    if (view._pinPopupUI?.pop?.isConnected) return view._pinPopupUI;
    const pop = view.contentEl.createDiv("qiaomu-reader-pin-popup");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", translate("pinyin-note"));
    const reading = pop.createDiv("qiaomu-reader-pin-reading");
    const gloss = pop.createDiv("qiaomu-reader-pin-gloss");
    const remove = pop.createEl("button", { cls: "qiaomu-reader-pin-remove" });
    remove.setAttribute("type", "button");
    remove.setText(translate("remove-pinyin"));
    pop.addEventListener("pointerdown", (event) => event.stopPropagation());
    const ui = { pop, reading, gloss, remove };
    view._pinPopupUI = ui;
    bindDismiss(view, ui);
    return ui;
  }

  function bindDismiss(view, ui) {
    if (view._pinPopupDismiss) return;
    view._pinPopupDismiss = true;
    const doc = docOf(view.contentEl);
    const onDown = (event) => {
      if (!ui.pop.classList.contains("qiaomu-reader-pin-popup-on")) return;
      if (ui.pop.contains(event.target)) return;
      hide(view);
    };
    const onKey = (event) => {
      if (event.key === "Escape") hide(view);
    };
    if (typeof view.registerDomEvent === "function") {
      view.registerDomEvent(doc, "mousedown", onDown);
      view.registerDomEvent(doc, "keydown", onKey);
    } else {
      doc.addEventListener("mousedown", onDown);
      doc.addEventListener("keydown", onKey);
    }
  }

  function show(view, pin, rect, onRemove) {
    if (!view?.contentEl || !pin) return;
    const ui = ensure(view);
    ui.reading.setText(pin.pinyin || "");
    ui.gloss.setText(pin.gloss || "");
    ui.gloss.toggleClass("qiaomu-reader-pin-gloss-empty", !pin.gloss);
    ui.remove.onclick = () => {
      hide(view);
      onRemove?.(pin);
    };
    ui.pop.classList.add("qiaomu-reader-pin-popup-on");
    positionPopup(view, rect, 220, 84, ui.pop);
  }

  function hide(view) {
    view?._pinPopupUI?.pop?.classList.remove("qiaomu-reader-pin-popup-on");
  }

  return { show, hide };
}
