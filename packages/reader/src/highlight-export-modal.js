// HighlightExportModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createHighlightExportModal({
  Modal, exportHighlightsSeparate, exportHighlightsToBookNote, qiaomuReaderTranslate, splitExportedHighlights,
}) {
  return class HighlightExportModal extends Modal {
  constructor(app, plugin, bookFile, highlights, noteText, noteName) {
    super(app);
    this.plugin = plugin;
    this.bookFile = bookFile;
    this.noteName = noteName || "";
    const split = splitExportedHighlights(noteText, highlights);
    this.already = new Set(split.already);
    this.items = highlights.map((hl) => ({ hl, on: !split.already.includes(hl) }));
    this.newCount = split.fresh.length;
  }
  onOpen() {
    const body = this.contentEl;
    body.addClass("qiaomu-reader-exp-modal");
    body.createDiv("qiaomu-reader-info-title").setText(qiaomuReaderTranslate("what-to-copy-into-the-note"));
    body.createDiv("qiaomu-reader-info-sub").setText(this._exportSubtitle());
    const bar = body.createDiv("qiaomu-reader-exp-bar");
    const counter = bar.createSpan({ cls: "qiaomu-reader-exp-count" });
    const link = (label, apply) => {
      const el = bar.createSpan({ cls: "qiaomu-reader-exp-link", text: label });
      el.addEventListener("click", () => { apply(); sync(); });
      return el;
    };
    link(qiaomuReaderTranslate("select-all"), () => this.items.forEach((entry) => entry.on = true));
    link(qiaomuReaderTranslate("clear-all"), () => this.items.forEach((entry) => entry.on = false));
    if (this.already.size) link(qiaomuReaderTranslate("new-only"), () => this.items.forEach((entry) => entry.on = !this.already.has(entry.hl)));
    const list = body.createDiv("qiaomu-reader-exp-list");
    const rows = this.items.map((entry) => {
      const rowEl = list.createDiv("qiaomu-reader-exp-row");
      const checkbox = rowEl.createEl("input", { type: "checkbox" });
      checkbox.addClass("qiaomu-reader-exp-box");
      checkbox.checked = entry.on;
      const cell = rowEl.createDiv("qiaomu-reader-exp-body");
      const snippet = (entry.hl.text || "").replace(/\s+/g, " ").trim();
      cell.createDiv("qiaomu-reader-exp-text").setText(snippet.length > 220 ? snippet.slice(0, 220) + "…" : snippet);
      if (this.already.has(entry.hl)) {
        rowEl.addClass("qiaomu-reader-exp-done");
        cell.createDiv("qiaomu-reader-exp-tag").setText(qiaomuReaderTranslate("already-in-the-note"));
      }
      const flip = () => {
        entry.on = !entry.on;
        checkbox.checked = entry.on;
        sync();
      };
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation(); entry.on = checkbox.checked;
        sync();
      });
      rowEl.addEventListener("click", flip);
      return { entry, checkbox };
    });
    const sync = () => {
      for (const r of rows) r.checkbox.checked = r.entry.on;
      const n = this.items.filter((entry) => entry.on).length;
      counter.setText(qiaomuReaderTranslate("ticked-0-of-1", n, this.items.length));
      toBookNote.disabled = !n || !this.noteName;
      toSeparate.disabled = !n;
    };
    const foot = body.createDiv("qiaomu-reader-setup-foot");
    const toBookNote = foot.createEl("button", { text: qiaomuReaderTranslate("into-the-book-s-note") });
    toBookNote.addClass("qiaomu-reader-setup-btn", "qiaomu-reader-setup-btn-primary");
    const toSeparate = foot.createEl("button", { text: qiaomuReaderTranslate("as-separate-notes") });
    toSeparate.addClass("qiaomu-reader-setup-btn");
    const picked = () => this.items.filter((entry) => entry.on).map((entry) => entry.hl);
    toBookNote.addEventListener("click", () => {
      const selection = picked();
      this.close();
      exportHighlightsToBookNote(this.app, this.plugin, this.bookFile, selection);
    });
    toSeparate.addEventListener("click", () => {
      const selection = picked();
      this.close();
      exportHighlightsSeparate(this.app, this.plugin, this.bookFile, selection);
    });
    sync();
  }
  _exportSubtitle() {
    if (!this.noteName) return qiaomuReaderTranslate("no-book-note-linked-separate-notes-only");
    if (this.already.size) return qiaomuReaderTranslate("note-0-1-already-there-2-new-ones-ticked", this.noteName, this.already.size, this.newCount);
    return qiaomuReaderTranslate("note-0-none-of-the-1-are-there-yet", this.noteName, this.items.length);
  }
  onClose() {
    this.contentEl.empty();
  }
};
}
