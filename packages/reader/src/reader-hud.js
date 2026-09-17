// Reader chrome helpers: boot veil, focus/blur plumbing and the footnote popup.
// The host injects notices, the platform check and engine highlight jumps.
import { docOf, winOf } from "./reader-dom.js";
import { iconLabel } from "./reader-icons.js";
import { waitForReaderFrame } from "./reader-load.js";
import { captureReadingAnchor, restoreReadingAnchor } from "./reader-experience.js";

export function createReaderHud({ translate, notice, window, platform, isPdf, jumpToHighlight, escapeSelector = (value) => String(value) }) {
  function showVeil(view, text) {
    const host = view && view.areaEl && view.areaEl.parentElement;
    if (!host) return;
    hideVeil(view);
    const veil = host.createDiv("qiaomu-reader-veil");
    const sk = veil.createDiv("qiaomu-reader-veil-skel");
    for (let i = 0; i < 8; i++) sk.createDiv("qiaomu-reader-veil-line");
    view._veilText = veil.createDiv({ cls: "qiaomu-reader-veil-text", text: text || translate("laying-out-the-pages") });
    view._veil = veil;
  }

  function markSlowLayout(view, delay = 3000) {
    const veil = view?._veil;
    if (!veil) return;
    const win = winOf(veil);
    win.setTimeout(() => {
      if (view?._veil !== veil || !view._veilText?.isConnected) return;
      view._veilText.setText(translate("this-document-has-many-pages-layout-is-still-in-progress"));
    }, delay);
  }

  async function paintVeil(view) {
    const veil = view?._veil;
    if (!veil) return;
    const win = winOf(veil);
    // A single animation frame still runs before paint. Waiting for the next
    // frame gives Chromium one complete paint opportunity before PDF pagination
    // occupies the main thread for a large fixed-layout document.
    await waitForReaderFrame(win);
    await waitForReaderFrame(win);
  }

  function hideVeil(view) {
    if (view && view._veil) {
      view._veil.remove();
      view._veil = null;
      view._veilText = null;
    }
  }

  function blurOnTapOutside(root, field) {
    if (!root || !field) return;
    root.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (t === field) return;
      if (t instanceof HTMLElement && t.closest(".qiaomu-reader-ai-bar, .qiaomu-reader-find-bar, input, textarea")) return;
      if (docOf(field).activeElement === field) field.blur();
    });
  }

  function autoFocus(el, delayMs) {
    if (!el || isMobile()) return;
    if (delayMs) window.setTimeout(() => { try { el.focus(); } catch { /* optional step; a failure here must not interrupt reading */ } }, delayMs);
    else { try { el.focus(); } catch { /* optional step; a failure here must not interrupt reading */ } }
  }

  function isMobile(app) {
    try {
      if (platform && typeof platform.isMobile === "boolean") return platform.isMobile;
    } catch { /* optional step; a failure here must not interrupt reading */ }
    return !!(app && app.isMobile);
  }

  function positionPopup(view, anchorRect, estW, estH) {
    const { hlPopup: pop } = view;
    const { contentEl: root } = view;
    pop.style.maxWidth = `${Math.max(120, root.clientWidth - 16)}px`;
    if (isMobile(view.app)) {
      const rootBox = root.getBoundingClientRect();
      const popH = pop.offsetHeight || estH || 92;
      const popW = pop.offsetWidth || estW || 260;
      const viewport = docOf(root).defaultView?.visualViewport;
      const visibleBottom = viewport ? Math.min(rootBox.bottom, viewport.offsetTop + viewport.height) : rootBox.bottom;
      const floorY = visibleBottom - rootBox.top - popH - 74;
      const anchored = false;
      const top = Math.max(8, floorY);
      pop.classList.add("qiaomu-reader-hl-popup-docked");
      pop.style.removeProperty("bottom");
      const topPx = Math.round(Math.max(8, top));
      pop.style.top = `${topPx}px`;
      const wantLeft = anchored
        ? anchorRect.left - rootBox.left + anchorRect.width / 2 - popW / 2
        : (rootBox.width - popW) / 2;
      pop.style.left = `${Math.round(clampNum(wantLeft, 8, rootBox.width - popW - 8))}px`;
      return;
    }
    pop.classList.remove("qiaomu-reader-hl-popup-docked");
    const rootBox = root.getBoundingClientRect();
    const popW = pop.offsetWidth || estW, popH = pop.offsetHeight || estH;
    let left = anchorRect.left - rootBox.left + anchorRect.width / 2 - popW / 2;
    let top = anchorRect.top - rootBox.top - popH - 10;
    if (top < 4) top = anchorRect.bottom - rootBox.top + 10;
    left = clampNum(left, 6, root.clientWidth - popW - 6);
    top = clampNum(top, 6, rootBox.height - popH - 6);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  }

  function clampNum(value, low, high) {
    return Math.max(low, Math.min(value, high));
  }

  function follow(view, ref) {
    const flow = view.pager && view.pager.flow;
    if (!flow || !ref) return false;
    const target = flow.querySelector(`[data-qiaomu-reader-id="${escapeSelector(ref)}"]`);
    if (!target) return false;
    const from = captureReadingAnchor(view.pager);
    const fRect = flow.getBoundingClientRect();
    const x = target.getBoundingClientRect().left - fRect.left;
    const spread = Math.max(0, Math.min(
      Math.floor(Math.round(x / (view.pager.sw / (view.pager.cols || 1))) / (view.pager.cols || 1)),
      view.pager.total - 1));
    let cur, tot;
    if (view.pager.scrollMode) {
      const clip = view.pager.clip;
      clip.scrollTop += target.getBoundingClientRect().top - clip.getBoundingClientRect().top;
      view.pager.spread = Math.min(view.pager.total - 1, Math.floor(clip.scrollTop / Math.max(1, clip.clientHeight)));
      [cur, tot] = [view.pager.spread, view.pager.total];
    } else [cur, tot] = view.pager.jumpTo(spread);
    (view.updateUI || view._updateUI).call(view, cur, tot);
    if (view.file) void view.plugin.saveProgress(view.file.path, cur, tot, view.pager.currentBlockIndex());
    showReturn(view, from);
    return true;
  }

  function showReturn(view, spread) {
    hideReturn(view);
    const host = view.contentEl;
    if (!host) return;
    const pill = host.createDiv("qiaomu-reader-note-back");
    view.contentEl.addClass("qiaomu-reader-has-return");
    iconLabel(pill, "arrow-left", translate("return-to-previous-reading-position"));
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    const go = () => {
      if (view.engine) {
        if (!spread?.cfi) return;
        void jumpToHighlight(view, { cfi: spread.cfi })
          .then(() => hideReturn(view))
          .catch(() => notice(translate("highlight-not-found")));
        return;
      }
      if (!isPdf(view)) return;
      const [cur, tot] = typeof spread === "object" ? restoreReadingAnchor(view.pager, spread) : view.pager.jumpTo(spread);
      (view.updateUI || view._updateUI).call(view, cur, tot);
      if (view.file) void view.plugin.saveProgress(view.file.path, cur, tot, view.pager.currentBlockIndex());
      hideReturn(view);
    };
    pill.addEventListener("click", go);
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    view._noteBackEl = pill;
  }

  function hideReturn(view) {
    if (view._noteBackEl) { view._noteBackEl.remove(); view._noteBackEl = null; }
    view.contentEl?.removeClass("qiaomu-reader-has-return");
  }

  return {
    showVeil, markSlowLayout, paintVeil, hideVeil, blurOnTapOutside, autoFocus, isMobile,
    positionPopup, clampNum, follow, showReturn, hideReturn,
  };
}
