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
