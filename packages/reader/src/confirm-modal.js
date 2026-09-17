// ConfirmModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createConfirmModal({
  Modal, qiaomuReaderTranslate,
}) {
  return class ConfirmModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
  }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("qiaomu-reader-confirm-modal");
    contentEl.empty();
    if (this.opts.title) contentEl.createDiv("qiaomu-reader-confirm-title").setText(this.opts.title);
    if (this.opts.body) contentEl.createDiv("qiaomu-reader-confirm-body").setText(this.opts.body);
    const btns = contentEl.createDiv("qiaomu-reader-confirm-btns");
    const no = btns.createEl("button", { text: this.opts.cancelText || qiaomuReaderTranslate("no") });
    no.addClass("qiaomu-reader-confirm-no");
    no.addEventListener("click", () => {
      this._done = true;
      this.close();
      this.opts.onNo && this.opts.onNo();
    });
    const yes = btns.createEl("button", { text: this.opts.okText || qiaomuReaderTranslate("yes") });
    yes.addClass("qiaomu-reader-confirm-yes");
    yes.addEventListener("click", () => {
      this._done = true;
      this.close();
      this.opts.onYes && this.opts.onYes();
    });
    window.setTimeout(() => yes.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
};
}
