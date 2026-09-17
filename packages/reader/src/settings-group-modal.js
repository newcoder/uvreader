// SettingsGroupModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createSettingsGroupModal({
  Modal, qiaomuReaderTranslate,
}) {
  return class SettingsGroupModal extends Modal {
  constructor(app, title, build, options = {}) {
    super(app);
    this.title = title;
    this.build = build;
    this.options = options;
  }
  onOpen() {
    this.modalEl.addClass("qiaomu-reader-settings-group");
    this.draw();
  }
  draw() {
    const c = this.contentEl;
    const was = this.bodyEl ? this.bodyEl.scrollTop : 0;
    c.empty();
    c.createEl("h3", { text: this.title });
    this.bodyEl = c.createDiv("qiaomu-reader-group-body");
    this.build(this.bodyEl, () => this.draw());
    const row = c.createDiv("qiaomu-reader-group-actions");
    const doneText = () => this.options.doneText?.() || qiaomuReaderTranslate("confirm");
    const done = row.createEl("button", { cls: "mod-cta", text: doneText() });
    done.addEventListener("click", async () => {
      done.disabled = true;
      this.bodyEl.inert = true;
      try {
        const shouldClose = typeof this.options.onDone === "function"
          ? await this.options.onDone((text) => done.setText(text))
          : true;
        if (shouldClose !== false) this.close();
      } finally {
        done.disabled = false;
        this.bodyEl.inert = false;
        done.setText(doneText());
      }
    });
    if (was) this.bodyEl.scrollTop = was;
  }
  onClose() { this.contentEl.empty(); }
};
}
