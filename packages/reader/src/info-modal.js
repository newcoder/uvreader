// InfoModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { svgIcon } from "./reader-icons.js";

export function createInfoModal({
  Modal, qiaomuReaderTranslate,
}) {
  return class InfoModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin || null;
    this.file = file || null;
  }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("qiaomu-reader-info-modal");
    contentEl.empty();
    contentEl.createDiv("qiaomu-reader-info-title").setText(`UV Reader · ${qiaomuReaderTranslate("plugin-guide")}`);
    contentEl.createDiv("qiaomu-reader-info-sub").setText(qiaomuReaderTranslate("what-each-button-does-and-why"));
    const groups = [
      { head: qiaomuReaderTranslate("top-bar"), rows: [
        ["note", qiaomuReaderTranslate("the-book-note"), qiaomuReaderTranslate("opens-this-book-s-reading-note-beside-the-text-if-the-note-does")],
        ["search", qiaomuReaderTranslate("search"), qiaomuReaderTranslate("search-across-the-whole-book-s-text-a-list-of-matches-with-conte")],
        ["highlighter", qiaomuReaderTranslate("highlights"), qiaomuReaderTranslate("opens-every-highlight-you-have-made-in-this-book-click-a-row-to")],
        ["list", qiaomuReaderTranslate("contents"), qiaomuReaderTranslate("the-book-s-contents-pdf-bookmarks-headings-the-book-s-own-printe")],
        ["sliders", qiaomuReaderTranslate("settings"), qiaomuReaderTranslate("theme-font-text-size-column-count-and-the-jump-back-block-a-list")],
        ["info", qiaomuReaderTranslate("help"), qiaomuReaderTranslate("this-window")]
      ] },
      { head: qiaomuReaderTranslate("reading-and-navigation"), rows: [
        ["chevron-left", qiaomuReaderTranslate("turn-pages"), qiaomuReaderTranslate("the-arrows-at-the-bottom-of-the-screen-the-keys-and-space-or-a-f")]
      ] },
      { head: qiaomuReaderTranslate("highlights-and-notes"), rows: [
        ["highlighter", qiaomuReaderTranslate("highlight-text"), qiaomuReaderTranslate("select-a-fragment-with-the-mouse-or-a-finger-a-color-palette-pop")],
        ["note", qiaomuReaderTranslate("create-a-note-from-a-highlight"), qiaomuReaderTranslate("right-click-the-highlighted-text-create-new-note-the-note-is-cre")],
        ["download", qiaomuReaderTranslate("move-highlights-into-notes"), qiaomuReaderTranslate("the-button-at-the-top-of-the-highlights-panel-it-opens-a-list-wh")]
      ] }
    ];
    groups.forEach((g) => {
      contentEl.createDiv("qiaomu-reader-info-group").setText(g.head);
      g.rows.forEach(([ic, title, desc]) => {
        const row = contentEl.createDiv("qiaomu-reader-info-row");
        const ig = row.createDiv("qiaomu-reader-info-ic");
        svgIcon(ig, ic);
        const tx = row.createDiv("qiaomu-reader-info-tx");
        tx.createDiv("qiaomu-reader-info-rowtitle").setText(title);
        tx.createDiv("qiaomu-reader-info-rowdesc").setText(desc);
      });
    });
    const note = contentEl.createDiv("qiaomu-reader-info-note");
    note.createDiv("qiaomu-reader-info-rowtitle").setText(qiaomuReaderTranslate("about-autosave"));
    note.createDiv("qiaomu-reader-info-rowdesc").setText(qiaomuReaderTranslate("your-position-is-saved-automatically-on-every-page-turn-and-kept"));
  }
  onClose() {
    let _a, _b;
    (_b = (_a = this._pdfLazy) == null ? void 0 : _a.destroy) == null ? void 0 : _b.call(_a);
    this._pdfLazy = null;
    this.contentEl.empty();
  }
};
}
