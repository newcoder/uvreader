// TranslateModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createTranslateModal({
  Menu, Modal, Notice, setIcon, copyToClipboard, currentTranslationNote, dailyNoteProvider, openNoteBesideBook, qiaomuReaderTranslate, saveTranslationNote, translateText,
}) {
  return class TranslateModal extends Modal {
  constructor(app, plugin, text, bookFile, source = {}) {
    super(app);
    this.plugin = plugin;
    this.text = text;
    this.bookFile = bookFile;
    this.source = { ...source, text };
    this.noteTarget = currentTranslationNote(plugin);
    this.savedTargets = new Map();
  }
  async onOpen() {
    const { contentEl: root } = this;
    root.empty();
    root.createEl("h3", { text: qiaomuReaderTranslate("translation") });
    this._textBox(root, qiaomuReaderTranslate("original")).setText(this.text);
    const outEl = this._textBox(root, qiaomuReaderTranslate("translation"));
    outEl.setText(qiaomuReaderTranslate("translating"));
    let tr = "";
    try {
      tr = await translateText(this.text, this.plugin.settings.translateTo || "zh-CN");
      outEl.setText(tr || qiaomuReaderTranslate("the-translator-returned-nothing"));
    } catch (e) {
      console.error("UV Reader: translate failed", e);
      outEl.setText(this._failureText(e));
      return;
    }
    this._footerActions(root, tr);
  }
  _textBox(root, label) {
    const wrap = root.createDiv();
    wrap.addClass("qiaomu-reader-tr-box");
    const head = wrap.createDiv();
    head.setText(label);
    head.addClass("qiaomu-reader-tr-label");
    const body = wrap.createDiv();
    for (const [prop, value] of [
      ["max-height", "180px"],
      ["overflow", "auto"],
      ["padding", "10px 12px"],
      ["border", "1px solid var(--background-modifier-border)"],
      ["border-radius", "8px"],
      ["background", "var(--background-secondary)"],
      ["line-height", "1.55"],
      ["white-space", "pre-wrap"],
      ["user-select", "text"],
    ]) body.style.setProperty(prop, value);
    return body;
  }
  _failureText(error) {
    const why = error && error.qiaomuReaderReason;
    if (why === "limit") return qiaomuReaderTranslate("google-is-rate-limiting-translations-wait-a-minute-and-try-again");
    if (why === "http") return qiaomuReaderTranslate("the-translator-answered-with-error-0-your-connection-is-fine-try", error.qiaomuReaderStatus);
    return qiaomuReaderTranslate("could-not-reach-the-translator-it-looks-like-there-is-no-interne");
  }
  _footerActions(root, tr) {
    if (!tr || this._closed) return;
    const foot = root.createDiv("qiaomu-reader-translation-actions");
    const copy = foot.createEl("button", { text: qiaomuReaderTranslate("copy-translation") });
    copy.addEventListener("click", async () => {
      const copied = await copyToClipboard(tr);
      new Notice(qiaomuReaderTranslate(copied ? "copied" : "could-not-copy"));
    });
    const group = foot.createDiv("qiaomu-reader-translation-save");
    const save = group.createEl("button", { cls: "mod-cta", text: qiaomuReaderTranslate("translation-save-book") });
    save.addEventListener("click", () => void this._saveTranslation("book", tr));
    const more = group.createEl("button", { attr: { "aria-label": qiaomuReaderTranslate("translation-save-to"), "aria-haspopup": "menu" } });
    setIcon(more, "chevron-down");
    more.addEventListener("click", () => {
      const menu = new Menu().setUseNativeMenu(false);
      const targets = [
        ["book", "book-open", qiaomuReaderTranslate("translation-save-book"), true],
        ["current", "file-text", this.noteTarget ? qiaomuReaderTranslate("translation-current-note", this.noteTarget.file.basename) : qiaomuReaderTranslate("translation-no-current-note"), !!(this.noteTarget && currentTranslationNote(this.plugin, this.noteTarget))],
        ["new", "file-plus", qiaomuReaderTranslate("create-new-note"), true],
        ["daily", "calendar", qiaomuReaderTranslate("translation-daily-note"), !!dailyNoteProvider(this.app)],
      ];
      for (const [id, icon, label, available] of targets) menu.addItem(item => item.setTitle(label).setIcon(icon).setDisabled(!available || this._saving).onClick(() => void this._saveTranslation(id, tr)));
      if (!dailyNoteProvider(this.app)) menu.addItem(item => item.setTitle(qiaomuReaderTranslate("translation-enable-daily")).setIcon("settings").onClick(() => { this.app.setting.open(); this.app.setting.openTabById("core-plugins"); }));
      const rect = more.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
    this.saveButtons = [save, more];
    this.saveStatus = root.createDiv({ cls: "qiaomu-reader-translation-status", attr: { role: "status" } });
  }
  async _saveTranslation(destination, translation) {
    if (this._saving) return;
    this._saving = true;
    this.saveButtons?.forEach(button => button.disabled = true);
    try {
      const file = await saveTranslationNote(this, destination, translation);
      if (!file) throw new Error("No note was saved");
      this.savedTargets.set(destination, file);
      if (this._closed) return;
      this.saveStatus.empty();
      this.saveStatus.createSpan({ text: qiaomuReaderTranslate("translation-saved", file.basename) });
      this.saveStatus.createEl("button", { text: qiaomuReaderTranslate("translation-open-note") }).addEventListener("click", () => void openNoteBesideBook(this.app, this.plugin, file));
    } catch (error) {
      console.error("UV Reader: translation save failed", error);
      if (!this._closed) { this.saveStatus.setAttribute("role", "alert"); this.saveStatus.setText(qiaomuReaderTranslate("translation-save-failed")); }
    } finally { this._saving = false; this.saveButtons?.forEach(button => button.disabled = false); }
  }
  onClose() { this._closed = true; this.contentEl.empty(); }

};
}
