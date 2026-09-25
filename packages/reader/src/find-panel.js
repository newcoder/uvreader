// buildFindPanelFor lives here so the reader logic stays host-agnostic.
import { nextSearchIndex, searchBookBlocks, searchableQuery } from "./reader-search.js";
import { restoreReadingAnchor } from "./reader-experience.js";

export function createBuildFindPanelFor({
  Notice, bindComposingSearch, chapterForBlock, clearFoundIn, markFoundIn, pageForBlock, prepareNavigationPanel, qiaomuReaderTranslate, readerIsPdf, readerSearchTexts, rememberReaderJump,
}) {
  function buildFindPanelFor(view, panel, { close }) {
  view._disposeFindPanel?.();
  prepareNavigationPanel(panel, qiaomuReaderTranslate("search-the-book"));
  const box = panel.createDiv("qiaomu-reader-toc-find");
  const input = box.createEl("input", { type: "text", cls: "qiaomu-reader-toc-find-input" });
  input.placeholder = qiaomuReaderTranslate("what-to-find-in-the-book");
  input.setAttribute("aria-label", input.placeholder);
  const info = panel.createDiv("qiaomu-reader-find-info");
  info.setAttribute("aria-live", "polite");
  const controls = panel.createDiv("qiaomu-reader-find-controls");
  const prev = controls.createEl("button", { text: qiaomuReaderTranslate("previous-match") });
  const next = controls.createEl("button", { text: qiaomuReaderTranslate("next-match") });
  const expand = controls.createEl("button", { text: qiaomuReaderTranslate("search-results") });
  const clearBtn = controls.createEl("button", { cls: "qiaomu-reader-find-off" });
  clearBtn.setText(qiaomuReaderTranslate("clear-highlight"));
  const done = controls.createEl("button", { text: qiaomuReaderTranslate("close") });
  const finish = () => { close(); view.findBtn?.focus(); };
  done.addEventListener("click", finish);
  const list = panel.createDiv("qiaomu-reader-toc-list");
  let matches = [], cursor = -1, lastQuery = "";
  const ime = { active: false };
  view._disposeFindPanel = () => cancelTyping();
  const update = () => {
    prev.disabled = next.disabled = !matches.length;
    info.setText(!lastQuery ? qiaomuReaderTranslate("enter-one-chinese-character-or-at-least-two-characters") : matches.length ? `${cursor < 0 ? "—" : cursor + 1} / ${matches.length}${matches.length === 300 ? "+" : ""}` : qiaomuReaderTranslate("nothing-found"));
    Array.from(list.children).forEach((el, i) => el.toggleClass("qiaomu-reader-toc-active", i === cursor));
  };
  const visit = (index) => {
    const hit = matches[index];
    if (!hit) return;
    if (!view._searchReturnSaved) { rememberReaderJump(view); view._searchReturnSaved = true; }
    cursor = index;
    if (view.engine && hit.cfi) {
      const engine = view.engine;
      void engine.goTo(hit.cfi).then(() => {
        if (view.engine !== engine || view._closed) return;
        panel.addClass("qiaomu-reader-find-browsing");
        update();
      }).catch(() => {
        if (view.engine === engine && !view._closed) new Notice(qiaomuReaderTranslate("highlight-not-found"));
      });
      return;
    }
    const [cur, total] = restoreReadingAnchor(view.pager, { block: hit.block, offset: hit.offset, pct: view.pager.currentPct });
    (view.updateUI || view._updateUI).call(view, cur, total);
    void view.plugin.saveProgress(view.file.path, cur, total, view.pager.currentBlockIndex());
    panel.addClass("qiaomu-reader-find-browsing");
    markFoundIn(view, lastQuery);
    update();
  };
  const step = (direction) => {
    cancelTyping();
    if (lastQuery !== input.value) search();
    visit(nextSearchIndex(cursor, direction, matches.length));
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  expand.addEventListener("click", () => panel.removeClass("qiaomu-reader-find-browsing"));
  clearBtn.addEventListener("click", () => {
    matches = []; cursor = -1; lastQuery = "";
    view._searchReturnSaved = false;
    cancelTyping(); clearFoundIn(view);
    if (view.engine) void view.engine.clearSearchHits();
    list.empty();
    update();
    input.value = ""; input.focus();
  });
  view._findInput = input;
  const search = () => {
    if (view._findInput !== input || !panel.isConnected) return;
    const query = input.value;
    lastQuery = query;
    cursor = -1;
    matches = [];
    panel.removeClass("qiaomu-reader-find-browsing");
    list.empty();
    if (!searchableQuery(query)) {
      update();
      info.setText(qiaomuReaderTranslate("enter-one-chinese-character-or-at-least-two-characters"));
      clearFoundIn(view); return;
    }
    if (view.engine) {
      // Engine formats: stream matches from the library's own searcher; each
      // hit arrives as a CFI and is painted as an outline by the engine.
      const collected = [];
      matches = collected;
      lastQuery = query;
      update();
      void (async () => {
        try {
          for await (const h of view.engine.search(query)) {
            if (view._findInput !== input || !panel.isConnected || lastQuery !== query || collected.length >= 300) return;
            collected.push(h);
            const row = list.createEl("button", { cls: "qiaomu-reader-toc-item qiaomu-reader-find-item" });
            row.createDiv("qiaomu-reader-find-text").setText(String(h.excerpt || ""));
            row.addEventListener("click", () => {
              const idx = collected.indexOf(h);
              visit(idx < 0 ? collected.length - 1 : idx);
            });
            update();
          }
        } catch (e) { console.warn("UV Reader: book search failed", e); }
        if (view._findInput === input && !panel.hasClass("qiaomu-reader-find-browsing")) update();
      })();
      return;
    }
    if (!view._findCorpus) view._findCorpus = readerSearchTexts(view.pager && view.pager.flow);
    matches = searchBookBlocks(view._findCorpus, query);
    update();
    if (!matches.length) {
      info.setText(qiaomuReaderTranslate("nothing-found"));
      clearFoundIn(view); return;
    }
    markFoundIn(view, query);
    for (const [index, h] of matches.entries()) {
      const row = list.createEl("button", { cls: "qiaomu-reader-toc-item qiaomu-reader-find-item" });
      const line = row.createDiv("qiaomu-reader-find-text");
      for (const seg of [{ text: h.pre }, { cls: "qiaomu-reader-find-hit", text: h.hit }, { text: h.post }]) {
        line.createSpan(seg);
      }
      const page = pageForBlock(view.pager.flow, h.block);
      const label = readerIsPdf(view) && page ? qiaomuReaderTranslate("page-0", page) : chapterForBlock(view.tocItems || [], h.block);
      if (label) row.createDiv("qiaomu-reader-toc-where").setText(label);
      row.addEventListener("click", () => visit(index));
    }
  };
  // The toolbar's search box hands its query over: fill the input, run the
  // same search and reveal the first hit when results are already available.
  view._searchFromToolbar = (query) => {
    const value = String(query ?? "");
    input.value = value;
    if (lastQuery !== value) search();
    if (matches.length) visit(0);
  };
  const cleared = () => { if (view.findBoxEl) view.findBoxEl.value = ""; };
  clearBtn.addEventListener("click", cleared);
  const cancelTyping = bindComposingSearch(input, ime, search);
  panel.onkeydown = (e) => {
    if (ime.active || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
    if (e.target === input && ["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      step(e.key === "ArrowUp" || e.shiftKey ? -1 : 1);
    }
  };
  update();
}
  return buildFindPanelFor;
}
