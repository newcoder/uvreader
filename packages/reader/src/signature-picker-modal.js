// Modal for choosing one of the signatures remembered across PDF forms. The
// controller owns persistence; this module only renders the picker and reports
// the chosen saved signature, a request to import a new one, or a delete.
export function createSignaturePickerModal({ Modal, qiaomuReaderTranslate }) {
  return class SignaturePickerModal extends Modal {
    constructor(app, options = {}) {
      super(app);
      this.signatures = Array.isArray(options.signatures) ? options.signatures.slice() : [];
      this.onPick = options.onPick;
      this.onImport = options.onImport;
      this.onDelete = options.onDelete;
    }

    onOpen() {
      this.modalEl.addClass("qiaomu-reader-signature-modal");
      this.contentEl.empty();
      this.contentEl.createEl("h2", {
        cls: "qiaomu-reader-signature-title",
        text: qiaomuReaderTranslate("choose-signature"),
      });
      this.bodyEl = this.contentEl.createDiv("qiaomu-reader-signature-body");
      this._renderList();
      const importButton = this.contentEl.createEl("button", {
        cls: "qiaomu-reader-signature-import mod-cta",
        text: qiaomuReaderTranslate("import-signature-image"),
        attr: { type: "button" },
      });
      importButton.addEventListener("click", () => {
        this.close();
        this.onImport?.();
      });
    }

    _renderList() {
      this.bodyEl.empty();
      const body = this.bodyEl;
      if (!this.signatures.length) {
        body.createDiv({
          cls: "qiaomu-reader-signature-empty",
          text: qiaomuReaderTranslate("no-saved-signatures"),
        });
        return;
      }
      const grid = body.createDiv("qiaomu-reader-signature-list");
      for (const [index, signature] of this.signatures.entries()) {
        const item = grid.createDiv("qiaomu-reader-signature-item");
        const choice = item.createEl("button", {
          cls: "qiaomu-reader-signature-choice",
          attr: {
            type: "button",
            "aria-label": `${qiaomuReaderTranslate("pdf-signature")} ${index + 1}`,
          },
        });
        choice.createEl("img", {
          attr: {
            src: signature.dataUrl,
            alt: `${qiaomuReaderTranslate("pdf-signature")} ${index + 1}`,
          },
        });
        choice.addEventListener("click", () => {
          this.close();
          this.onPick?.(signature);
        });
        const remove = item.createEl("button", {
          cls: "qiaomu-reader-signature-delete",
          text: "\xD7",
          attr: {
            type: "button",
            "aria-label": qiaomuReaderTranslate("delete"),
          },
        });
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.signatures = this.signatures.filter((entry) => entry.id !== signature.id);
          this.onDelete?.(signature);
          this._renderList();
        });
      }
    }
  };
}
