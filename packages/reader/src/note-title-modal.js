// NoteTitleModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createNoteTitleModal({
  Modal, FolderSuggest, allVaultTags, bookNoteLinkFor, notesFolderPath, parseNoteTags, qiaomuReaderPath, qiaomuReaderTranslate, readerHud, sanitizeNoteTitle, suggestNoteTitle,
}) {
  return class NoteTitleModal extends Modal {
  constructor(app, plugin, fragment, bookFile, onDone, options = {}) {
    super(app);
    this.plugin = plugin;
    this.fragment = fragment;
    this.bookFile = bookFile || null;
    this.onDone = onDone;
    this.kind = options.kind || "selection";
    this._answered = false;
  }
  onOpen() {
    const { contentEl: root } = this;
    root.addClass("qiaomu-reader-title-modal");
    const asAnswer = this.kind === "ai-answer";
    root.createDiv("qiaomu-reader-info-title").setText(qiaomuReaderTranslate(asAnswer ? "save-ai-answer" : "new-note-from-a-highlight"));
    const titleInput = this._textField(root, qiaomuReaderTranslate("title"));
    titleInput.value = asAnswer ? this.fragment : suggestNoteTitle(this.fragment);
    if (asAnswer) root.createDiv("qiaomu-reader-setup-hint").setText(qiaomuReaderTranslate("title-suggested-locally-from-the-reply-edit-it-freely-no-extra-m"));
    const error = root.createDiv("qiaomu-reader-title-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    titleInput.addEventListener("input", () => {
      titleInput.removeAttribute("aria-invalid");
      error.hidden = true;
    });
    this._offerFullFragment(root, asAnswer, titleInput);
    const folderInput = this._textField(root, qiaomuReaderTranslate("folder"), notesFolderPath(this.app) || qiaomuReaderTranslate("vault-root"));
    const savedFolder = this.plugin.settings.lastNoteFolder;
    folderInput.value = savedFolder || "";
    this._suggestFolders(folderInput);
    const tagField = this._textField(root, qiaomuReaderTranslate("tags"), qiaomuReaderTranslate("for-example-ideas-psychology"));
    tagField.value = this.plugin.settings.lastNoteTags || "";
    this._attachTagSuggestions(root, tagField);
    root.createDiv("qiaomu-reader-setup-hint").setText(qiaomuReaderTranslate(asAnswer
      ? "the-ai-answer-will-be-the-note-body-with-the-attached-source-kep"
      : "the-folder-and-tags-are-remembered-for-the-next-note-the-passage"));
    const foot = root.createDiv("qiaomu-reader-setup-foot");
    const ok = foot.createEl("button", { text: qiaomuReaderTranslate(asAnswer ? "save-to-note" : "create-note") });
    ok.addClass("qiaomu-reader-setup-btn", "qiaomu-reader-setup-btn-primary");
    this._toBookButton(foot, asAnswer, titleInput);
    const cancelBtn = foot.createEl("button", { text: qiaomuReaderTranslate("cancel") });
    cancelBtn.addClass("qiaomu-reader-setup-btn", "qiaomu-reader-setup-btn-quiet");
    const submitForm = () => {
      if (this._answered) return;
      const title = titleInput.value.trim();
      if (!title.replace(/[\\/:*?"<>|#^[\].\s]/g, "")) {
        titleInput.setAttribute("aria-invalid", "true");
        error.setText(qiaomuReaderTranslate("enter-a-valid-note-title"));
        error.hidden = false;
        titleInput.focus();
        return;
      }
      this._answered = true; ok.disabled = true;
      cancelBtn.disabled = true;
      ok.setText(qiaomuReaderTranslate("saving"));
      const folderPath = qiaomuReaderPath(folderInput.value.trim());
      const tagList = parseNoteTags(tagField.value);
      this.plugin.settings.lastNoteFolder = folderPath;
      this.plugin.settings.lastNoteTags = tagField.value.trim();
      this.close();
      this.onDone({ title, folder: folderPath, tags: tagList });
      // Folder/tag preferences must not leave a submit pending after Escape.
      void this.plugin._saveLocalData().catch(() => { /* optional preferences */ });
    };
    ok.addEventListener("click", submitForm);
    cancelBtn.addEventListener("click", () => this.close());
    for (const field of [titleInput, folderInput, tagField]) {
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault(); submitForm();
        }
      });
    }
    readerHud.autoFocus(titleInput, 30);
  }
  _textField(root, label, hint) {
    const wrap = root.createDiv("qiaomu-reader-setup-field");
    wrap.createDiv("qiaomu-reader-setup-label").setText(label);
    const input = wrap.createEl("input", { type: "text" });
    input.setAttribute("aria-label", label);
    input.addClass("qiaomu-reader-setup-input");
    if (hint) input.placeholder = hint;
    return input;
  }
  _offerFullFragment(root, asAnswer, titleInput) {
    const full = asAnswer ? "" : sanitizeNoteTitle(this.fragment);
    if (!full || full === titleInput.value) return;
    const alt = root.createDiv("qiaomu-reader-title-alt");
    alt.setText(qiaomuReaderTranslate("use-the-whole-passage-as-the-title"));
    alt.addEventListener("click", () => {
      titleInput.value = full;
      titleInput.focus();
    });
  }
  _suggestFolders(input) {
    if (!FolderSuggest) return;
    try { new FolderSuggest(this.app, input); } catch { /* folder suggestion is optional; ignore failures */ }
  }
  _attachTagSuggestions(root, tagField) {
    const vaultTags = allVaultTags(this.app);
    if (!vaultTags.length) return;
    const datalist = root.createEl("datalist");
    datalist.id = "qiaomu-reader-note-tags-" + Math.random().toString(36).slice(2, 8);
    vaultTags.forEach((t) => datalist.createEl("option", { value: t }));
    tagField.setAttr("list", datalist.id);
  }
  _toBookButton(foot, asAnswer, titleInput) {
    const bookNoteName = this.bookFile ? bookNoteLinkFor(this.plugin, this.bookFile) : "";
    if (!((asAnswer && this.bookFile) || bookNoteName)) return null;
    const toBook = foot.createEl("button", { text: qiaomuReaderTranslate(asAnswer ? "append-to-book-note" : "into-the-book-s-note") });
    toBook.addClass("qiaomu-reader-setup-btn", "qiaomu-reader-setup-btn-quiet");
    toBook.setAttribute("aria-label", asAnswer ? qiaomuReaderTranslate("append-to-book-note") : qiaomuReaderTranslate("append-the-quote-to-0-instead-of-making-a-separate-note", bookNoteName));
    const pickToBook = () => {
      if (this._answered) return;
      this._answered = true; this.close();
      this.onDone({ toBookNote: true, title: titleInput.value });
    };
    toBook.addEventListener("click", pickToBook);
    return toBook;
  }
  onClose() {
    this.contentEl.empty();
    if (!this._answered) this.onDone(null);
  }
};
}
