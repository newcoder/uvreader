// BookSetupModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createBookSetupModal({
  Modal, Notice, FolderSuggest, allBookTags, bookNoteFiles, bookNotesFolderPath, bookTagsOf, notesFolderPath, parseBookTags, qiaomuReaderTranslate, readerHud, sanitizeNoteTitle, writeBookProperty,
}) {
  return class BookSetupModal extends Modal {
  constructor(app, plugin, file, onDone) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.onDone = onDone || (() => {
    });
    this._answered = false;
    this._step = 1;
  }
  onOpen() {
    this.modalEl.addClass("qiaomu-reader-setup-modal");
    this._renderStep();
  }
  _renderStep() {
    this.contentEl.empty(); if (this._step === 1) this._renderPick(); else this._renderCreate();
  }
  _renderPick() { // step 1: link an existing note
    const host = this.contentEl;
    this._setupHead("a-note-for-this-book", "quotes-and-thoughts-from-this-book-will-link-to-this-note");
    const search = host.createEl("input", { type: "text" });
    search.addClass("qiaomu-reader-setup-input");
    search.placeholder = qiaomuReaderTranslate("search-notes");
    const listEl = host.createDiv("qiaomu-reader-setup-list");
    const notes = bookNoteFiles(this.app);
    const redraw = (query) => {
      listEl.empty(); const needle = (query || "").trim().toLowerCase();
      const pool = needle ? notes.filter((f) => f.basename.toLowerCase().includes(needle)) : notes;
      const shown = pool.slice(0, 200);
      if (notes.length === 0) {
        listEl.createDiv("qiaomu-reader-setup-empty").setText(qiaomuReaderTranslate("no-notes-in-the-vault-yet-create-one-below"));
        return;
      }
      if (shown.length === 0) {
        listEl.createDiv("qiaomu-reader-setup-empty").setText(qiaomuReaderTranslate("nothing-found"));
        return;
      }
      for (const note of shown) {
        const rowEl = listEl.createDiv("qiaomu-reader-setup-row");
        rowEl.createDiv("qiaomu-reader-setup-row-name").setText(note.basename);
        const dir = note.parent && note.parent.path && note.parent.path !== "/" ? note.parent.path : "";
        if (dir) rowEl.createDiv("qiaomu-reader-setup-row-path").setText(dir);
        rowEl.addEventListener("click", async () => {
          this.plugin.settings.bookNoteLinks[this.file.path] = note.path;
          await this.plugin.saveAll(); await writeBookProperty(this.app, note.path, this.file);
          this._finish(qiaomuReaderTranslate("book-note-0", note.basename));
        });
      }
    };
    search.addEventListener("input", () => redraw(search.value));
    redraw("");
    const foot = host.createDiv("qiaomu-reader-setup-foot");
    const create = this._setupButton(foot, "create-a-note", "qiaomu-reader-setup-btn-primary");
    create.addEventListener("click", () => {
      this._step = 2; this._renderStep();
    });
    const skipBtn = this._setupButton(foot, "read-without-a-note", "qiaomu-reader-setup-btn-quiet");
    skipBtn.addEventListener("click", () => this._finish(""));
    this._setupFocus(search);
  }
  _renderCreate() { // step 2: make a fresh note
    const host = this.contentEl;
    const backLink = host.createDiv("qiaomu-reader-setup-back");
    backLink.setText(qiaomuReaderTranslate("back"));
    backLink.addEventListener("click", () => {
      this._step = 1; this._renderStep();
    });
    this._setupHead("create-note");
    const inputRow = (label, initial, hint) => {
      const wrap = host.createDiv("qiaomu-reader-setup-field");
      wrap.createDiv("qiaomu-reader-setup-label").setText(label);
      const el = wrap.createEl("input", { type: "text" });
      el.addClass("qiaomu-reader-setup-input");
      if (initial) el.value = initial; if (hint) el.placeholder = hint;
      return el;
    };
    const nameInput = inputRow(qiaomuReaderTranslate("note-name"), sanitizeNoteTitle(this.file.basename));
    const folderInput = inputRow(qiaomuReaderTranslate("folder"), bookNotesFolderPath(this.app) || notesFolderPath(this.app) || "", qiaomuReaderTranslate("vault-root"));
    try {
      if (FolderSuggest) { new FolderSuggest(this.app, folderInput); }
    } catch { /* suggester is optional */ }
    const tagsInput = inputRow(qiaomuReaderTranslate("category"), bookTagsOf(this.plugin.settings, this.file.path).join(", "), qiaomuReaderTranslate("e-g-psychology-business"));
    const knownTags = allBookTags(this.plugin.settings);
    if (knownTags.length > 0) {
      const dl = host.createEl("datalist");
      dl.id = "qiaomu-reader-setup-tags-" + Math.random().toString(36).slice(2, 8);
      knownTags.forEach((tag) => dl.createEl("option", { value: tag }));
      tagsInput.setAttribute("list", dl.id);
    }
    host.createDiv("qiaomu-reader-setup-hint").setText(qiaomuReaderTranslate("genre-or-topic-books-are-grouped-by-it-in-the-library-separate-s"));
    const foot = host.createDiv("qiaomu-reader-setup-foot");
    const submitBtn = this._setupButton(foot, "create-and-start-reading", "qiaomu-reader-setup-btn-primary");
    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      const created = await this.plugin.createBookNote(this.file, nameInput.value, folderInput.value);
      if (!created) {
        submitBtn.disabled = false;
        return;
      }
      const tags = parseBookTags(tagsInput.value);
      await this.plugin.setBookTags(this.file.path, tags);
      this._finish(qiaomuReaderTranslate("book-note-created-0", created.basename));
    });
    for (const el of [nameInput, folderInput, tagsInput]) el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return; e.preventDefault(); submitBtn.click();
    });
    this._setupFocus(nameInput);
  }
  _setupHead(titleKey, leadKey) {
    this.contentEl.createDiv("qiaomu-reader-info-title").setText(qiaomuReaderTranslate(titleKey));
    const sub = this.contentEl.createDiv("qiaomu-reader-info-sub");
    sub.setText(this.file.basename);
    if (leadKey) this.contentEl.createDiv("qiaomu-reader-setup-lead").setText(qiaomuReaderTranslate(leadKey));
  }
  _setupButton(foot, labelKey, modifier) {
    const btn = foot.createEl("button", { text: qiaomuReaderTranslate(labelKey) });
    btn.addClass("qiaomu-reader-setup-btn", modifier);
    return btn;
  }
  _setupFocus(el) {
    readerHud.autoFocus(el, 30);
    readerHud.blurOnTapOutside(this.contentEl, el);
  }
  async _finish(msg) {
    this._answered = true;
    const s = this.plugin.settings;
    if (!s.bookNotePrompted) s.bookNotePrompted = {};
    s.bookNotePrompted[this.file.path] = true;
    await this.plugin.saveAll();
    if (msg) new Notice(msg);
    this.close();
    this.onDone();
  }
  onClose() {
    this.contentEl.empty();
    if (!this._answered) this.onDone();
  }
};
}
