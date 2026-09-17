// CreateFolderModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createCreateFolderModal({
  Modal, Notice, Setting, TFolder, qiaomuReaderPath, qiaomuReaderTranslate, readerHud,
}) {
  return class CreateFolderModal extends Modal {
  constructor(app, initialPath, onCreated) {
    super(app);
    this._initialPath = qiaomuReaderPath(initialPath);
    this._onCreated = onCreated;
  }
  onOpen() {
    this.modalEl.addClass("qiaomu-reader-create-folder-modal");
    this.setTitle(qiaomuReaderTranslate("new-folder"));
    const errorEl = this.contentEl.createDiv({ cls: "qiaomu-reader-folder-create-error" });
    errorEl.setAttr("aria-live", "polite");
    let input;
    new Setting(this.contentEl)
      .setName(qiaomuReaderTranslate("folder-path"))
      .setDesc(qiaomuReaderTranslate("a-path-inside-the-vault-for-example-notes-books"))
      .addText((text) => {
        input = text;
        text.setPlaceholder(qiaomuReaderTranslate("notes-books"));
        text.setValue(this._initialPath);
      });
    const actions = new Setting(this.contentEl);
    actions.settingEl.addClass("qiaomu-reader-folder-create-actions");
    actions
      .addButton((button) => button
        .setButtonText(qiaomuReaderTranslate("cancel"))
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText(qiaomuReaderTranslate("create"))
        .setCta()
        .onClick(async () => {
          const path = qiaomuReaderPath(input && input.getValue());
          errorEl.empty();
          if (!path) {
            errorEl.setText(qiaomuReaderTranslate("enter-a-folder-path"));
            input && input.inputEl.focus();
            return;
          }
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing && !(existing instanceof TFolder)) {
            errorEl.setText(qiaomuReaderTranslate("a-file-already-exists-at-this-path"));
            input && input.inputEl.focus();
            return;
          }
          try {
            if (!existing) await this.app.vault.createFolder(path);
            this.close();
            this._onCreated(path);
            new Notice(qiaomuReaderTranslate("folder-created-0", path));
          } catch (error) {
            console.warn("UV Reader: could not create folder", error);
            errorEl.setText(qiaomuReaderTranslate("could-not-create-the-folder-check-the-path-and-try-again"));
          }
        }));
    const submit = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      actions.controlEl.querySelector("button.mod-cta")?.click();
    };
    input && input.inputEl.addEventListener("keydown", submit);
    readerHud.autoFocus(input && input.inputEl, 30);
  }
  onClose() {
    this.contentEl.empty();
  }
};
}
