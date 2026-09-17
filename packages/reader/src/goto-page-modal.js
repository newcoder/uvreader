// GoToPageModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createGoToPageModal({
  Modal, qiaomuReaderTranslate, readerHud,
}) {
  return class GoToPageModal extends Modal {
  constructor(app, total, current, onSubmit) {
    super(app);
    this.total = total;
    this.current = current || 0;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("qiaomu-reader-confirm-modal");
    contentEl.empty();
    contentEl.createDiv("qiaomu-reader-confirm-title").setText(qiaomuReaderTranslate("go-to-page"));
    const input = contentEl.createEl("input", { cls: "qiaomu-reader-gotopage-input", attr: { type: "text", placeholder: `1–${this.total} / 50%`, "aria-label": qiaomuReaderTranslate("page-number-or-percentage") } });
    const error = contentEl.createDiv({ cls: "qiaomu-reader-title-error", attr: { role: "alert" } });
    input.value = String(this.current + 1);
    const submit = () => {
      const raw = input.value.trim();
      const percent = /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(raw);
      const value = Number(percent ? raw.slice(0, -1) : raw);
      if ((!percent && !/^\d+$/.test(raw)) || !Number.isFinite(value) || value < (percent ? 0 : 1) || value > (percent ? 100 : this.total)) {
        error.setText(qiaomuReaderTranslate("enter-a-valid-page-number-or-0-100")); return;
      }
      const n = percent ? 1 + Math.round((this.total - 1) * value / 100) : value;
      this.close();
      this.onSubmit(n);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    const btns = contentEl.createDiv("qiaomu-reader-confirm-btns");
    const go = btns.createEl("button", { text: qiaomuReaderTranslate("go") });
    go.addClass("qiaomu-reader-confirm-yes");
    go.addEventListener("click", submit);
    readerHud.autoFocus(input, 0);
  }
  onClose() {
    this.contentEl.empty();
  }
};
}
