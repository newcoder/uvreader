// WhatsNewModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createWhatsNewModal({
  Modal, OnboardingModal, qiaomuReaderTranslate,
}) {
  return class WhatsNewModal extends Modal {
  constructor(app, plugin, releases, noteFile) {
    super(app);
    this.plugin = plugin;
    this.releases = releases;
    this.noteFile = noteFile || null;
  }
  onOpen() {
    const c = this.contentEl;
    this.modalEl.addClass("qiaomu-reader-onb-modal");
    c.empty();
    const card = c.createDiv("qiaomu-reader-onb-card qiaomu-reader-wn-card");
    card.createDiv("qiaomu-reader-onb-emoji").setText("✨");
    card.createDiv("qiaomu-reader-onb-title").setText(qiaomuReaderTranslate("what-s-new"));
    card.createDiv("qiaomu-reader-wn-sub").setText(`UV Reader · ${this.plugin.manifest.version}`);
    const wrap = card.createDiv("qiaomu-reader-wn-wrap");
    for (const r of this.releases) {
      const grp = wrap.createDiv("qiaomu-reader-wn-rel");
      grp.createDiv("qiaomu-reader-wn-ver").setText(r.v);
      const ul = grp.createDiv("qiaomu-reader-wn-list");
      for (const it of r.items) {
        const row = ul.createDiv("qiaomu-reader-wn-item");
        row.createSpan({ cls: "qiaomu-reader-wn-dot", text: "✦" });
        row.createSpan({ text: qiaomuReaderTranslate(it) });
      }
    }
    const nav = c.createDiv("qiaomu-reader-onb-nav qiaomu-reader-wn-nav");
    const ok = nav.createEl("button", { text: qiaomuReaderTranslate("got-it") });
    ok.addClass("qiaomu-reader-onb-start", "qiaomu-reader-wn-ok");
    ok.addEventListener("click", () => this.close());
    if (this.noteFile) {
      const open = c.createDiv("qiaomu-reader-onb-skip");
      open.setText(qiaomuReaderTranslate("saved-as-the-note-0-open-it", this.noteFile.basename));
      open.addEventListener("click", () => {
        this.close();
        this.app.workspace.getLeaf(true).openFile(this.noteFile);
      });
    }
    const help = c.createDiv("qiaomu-reader-onb-skip");
    help.setText(qiaomuReaderTranslate("guide-every-setting-step-by-step"));
    help.addEventListener("click", () => {
      this.close();
      new OnboardingModal(this.app, this.plugin).open();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
}
