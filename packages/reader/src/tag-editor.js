// Tag editor for one book, opened from the book menus ("标签…"). The host
// supplies the Modal base class and the tag helpers, so the module runs
// outside Obsidian; nothing here touches the host API directly.
export function createTagEditor({ Modal, parseBookTags, allBookTags, bookTagsOf, qiaomuReaderTranslate }) {
  return class TagEditorModal extends Modal {
    constructor(app, plugin, file, onSaved = null) {
      super(app);
      this.plugin = plugin;
      this.file = file;
      this.onSaved = typeof onSaved === "function" ? onSaved : null;
    }
    onOpen() {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.addClass("qiaomu-reader-tag-editor");
      const title = contentEl.createDiv("qiaomu-reader-tag-editor-title");
      title.createSpan({ text: qiaomuReaderTranslate("tags") });
      title.createSpan({ cls: "qiaomu-reader-tag-editor-book", text: ` · ${this.file?.basename || ""}` });
      contentEl.createDiv("qiaomu-reader-tag-editor-hint").setText(qiaomuReaderTranslate("tag-editor-hint"));

      const chips = contentEl.createDiv("qiaomu-reader-tag-editor-chips");
      const current = new Set(bookTagsOf(this.plugin.settings, this.file.path));
      const selected = new Set(current);
      const chipEls = new Map();
      const addChip = (name, on) => {
        const existing = chipEls.get(name);
        if (existing) return existing;
        const chip = chips.createEl("button", {
          cls: `qiaomu-reader-tag-chip${on ? " qiaomu-reader-tag-on" : ""}`,
          text: name,
          attr: { type: "button", "aria-pressed": String(Boolean(on)) },
        });
        chip.addEventListener("click", () => {
          const next = !selected.has(name);
          if (next) selected.add(name); else selected.delete(name);
          chip.toggleClass("qiaomu-reader-tag-on", next);
          chip.setAttribute("aria-pressed", String(next));
        });
        chipEls.set(name, chip);
        return chip;
      };
      const known = [...new Set([...allBookTags(this.plugin.settings), ...current])];
      for (const name of known) addChip(name, current.has(name));

      const input = contentEl.createEl("input", {
        cls: "qiaomu-reader-tag-input",
        attr: { type: "text", placeholder: qiaomuReaderTranslate("new-tag-placeholder"), spellcheck: "false" },
      });
      const commitTyped = () => {
        let added = false;
        for (const name of parseBookTags(input.value)) {
          if (selected.has(name)) continue;
          selected.add(name);
          addChip(name, true);
          added = true;
        }
        input.value = "";
        return added;
      };
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        // Enter adds the typed tags; an empty input saves and closes.
        if (!commitTyped()) this._save(selected);
      });

      const foot = contentEl.createDiv("qiaomu-reader-tag-editor-foot");
      const cancel = foot.createEl("button", { attr: { type: "button" }, text: qiaomuReaderTranslate("cancel") });
      const save = foot.createEl("button", { cls: "mod-cta", attr: { type: "button" }, text: qiaomuReaderTranslate("save") });
      cancel.addEventListener("click", () => this.close());
      save.addEventListener("click", () => {
        commitTyped();
        this._save(selected);
      });
    }
    async _save(selected) {
      try {
        await this.plugin.setBookTags(this.file.path, [...selected]);
      } catch (error) {
        console.warn("UV Reader: could not save tags", error);
      }
      this.close();
      this.onSaved?.();
    }
    onClose() {
      this.contentEl.empty();
    }
  };
}
