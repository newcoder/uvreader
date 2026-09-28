// Page position and jump control for the reader toolbar. The host injects the
// document helpers, i18n and page navigation so this module stays host-agnostic.
export function createPageJump({ translate, svgIcon, docOf, isPdf, pdfPages, rememberJump }) {
  // Engine books count foliate locations, PDFs count original pages, flow books
  // count spreads.
  function pageInfo(view) {
    if (view.engine) {
      const detail = view._engineLocation || view.engine.currentLocation?.();
      const total = Number(detail?.location?.total) || 0;
      const current = Number(detail?.location?.current);
      return { current: Number.isFinite(current) ? current + 1 : 1, total };
    }
    if (isPdf(view)) {
      const pages = pdfPages(view);
      return { current: view.pager?.currentPdfPageNumber?.() || 1, total: pages.length || view.pager?.total || 0 };
    }
    return { current: (view.pager?.spread || 0) + 1, total: view.pager?.total || 0 };
  }

  function update(view) {
    const input = view.pageInputEl;
    const label = view.pageTotalEl;
    if (!input || !label) return;
    const { current, total } = pageInfo(view);
    if (docOf(input).activeElement !== input) input.value = total ? String(current) : "";
    label.setText(`/ ${total || 0}`);
    input.disabled = !total;
  }

  function jump(view, page) {
    const { total } = pageInfo(view);
    if (!total || !view.file) return;
    const n = Math.max(1, Math.min(total, Math.round(page)));
    rememberJump(view);
    if (view.engine) {
      const fraction = total > 1 ? (n - 1) / (total - 1) : 0;
      void view.engine.goTo({ fraction }).catch((error) => {
        console.warn("UV Reader: could not jump to the requested page", error);
      });
      return;
    }
    const pager = view.pager;
    if (isPdf(view)) {
      const pages = pdfPages(view);
      if (pages.length) {
        if (pager.scrollMode) {
          pager.clip.scrollTop += pages[n - 1].getBoundingClientRect().top - pager.clip.getBoundingClientRect().top;
          pager.spread = Math.min(pager.total - 1, Math.floor(pager.clip.scrollTop / Math.max(1, pager.clip.clientHeight)));
        } else {
          const x = pages[n - 1].getBoundingClientRect().left - pager.flow.getBoundingClientRect().left;
          pager.jumpTo(Math.floor(Math.round(x / (pager.sw / (pager.cols || 1))) / (pager.cols || 1)));
        }
      }
    } else pager.jumpTo(n - 1);
    (view.updateUI || view._updateUI).call(view, pager.spread, pager.total);
    void view.plugin.saveProgress(view.file.path, pager.spread, pager.total, pager.currentBlockIndex());
  }

  function build(view, tray) {
    const topBar = tray?.parentElement;
    if (!topBar) return;
    const wrap = topBar.createDiv("qiaomu-reader-pagejump");
    const prev = wrap.createEl("button", {
      cls: "qiaomu-reader-pagejump-nav",
      attr: { type: "button", "aria-label": translate("back-3") },
    });
    svgIcon(prev, "chevron-left");
    prev.addEventListener("click", () => view.nav("prev"));
    const input = wrap.createEl("input", {
      cls: "qiaomu-reader-pageinput",
      attr: { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": translate("go-to-page") },
    });
    const total = wrap.createSpan({ cls: "qiaomu-reader-pagetotal" });
    const next = wrap.createEl("button", {
      cls: "qiaomu-reader-pagejump-nav",
      attr: { type: "button", "aria-label": translate("next-2") },
    });
    svgIcon(next, "chevron-right");
    next.addEventListener("click", () => view.nav("next"));
    topBar.insertBefore(wrap, tray);
    view.pageInputEl = input;
    view.pageTotalEl = total;
    view.pageJumpEl = wrap;
    // The bar is centred by CSS; on narrow windows the side clusters grow past
    // the centre and the centred nav would sit under them (the search box and
    // settings live right after it). Clamp it into the free gap instead of
    // insisting on the exact centre, so it only moves when space runs out.
    const win = wrap.ownerDocument?.defaultView || window;
    const raf = typeof win.requestAnimationFrame === "function"
      ? (fn) => win.requestAnimationFrame(fn)
      : (fn) => win.setTimeout(fn, 16);
    const place = () => {
      const bar = wrap.parentElement;
      if (!bar || !wrap.isConnected || !wrap.offsetWidth) return;
      const barRect = bar.getBoundingClientRect();
      if (!barRect.width) return;
      // The desktop bar hides the title, so the button tray (search, settings,
      // zoom) is left-aligned and its right edge creeps toward the middle as
      // the window narrows. Stay centred while it fits, then shift right just
      // enough to clear the tray with a margin; never move left of centre, the
      // page total and input always stay visible.
      const tray = wrap.nextElementSibling;
      const half = wrap.offsetWidth / 2;
      const trayRight = tray ? tray.getBoundingClientRect().right : barRect.left;
      const leftBound = trayRight - barRect.left + 12 + half;
      const centre = barRect.width / 2;
      const left = Math.max(half, Math.min(barRect.width - half, Math.max(centre, leftBound)));
      wrap.style.left = `${Math.round(left)}px`;
    };
    view.pageJumpPlace = () => { raf(place); };
    win.addEventListener("resize", view.pageJumpPlace);
    view.pageJumpOff = () => win.removeEventListener("resize", view.pageJumpPlace);
    if (typeof win.ResizeObserver === "function") {
      view.pageJumpObs = new win.ResizeObserver(() => view.pageJumpPlace());
      view.pageJumpObs.observe(topBar);
      view.pageJumpObs.observe(tray);
    }
    view.pageJumpPlace();
    const commit = () => {
      const value = Number(input.value.trim());
      if (!Number.isFinite(value) || value < 1) {
        update(view);
        return;
      }
      jump(view, value);
    };
    input.addEventListener("focus", () => input.select());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        commit();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        update(view);
        input.blur();
      }
    });
    input.addEventListener("blur", commit);
    update(view);
  }

  return { pageInfo, update, jump, build };
}
