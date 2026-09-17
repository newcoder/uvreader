// OnboardingModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.

export function createOnboardingModal({
  Modal, setIcon, ONBOARD_SLIDES, qiaomuReaderTranslate,
}) {
  return class OnboardingModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin || null;
    this.idx = 0;
    this._finished = false;
  }
  onOpen() {
    this.modalEl.addClass("qiaomu-reader-onb-modal");
    this.scope.register([], "ArrowRight", (e) => {
      e.preventDefault();
      this._go(1);
    });
    this.scope.register([], "ArrowLeft", (e) => {
      e.preventDefault();
      this._go(-1);
    });
    this._render();
  }
  _go(dir) {
    const n = this.idx + dir;
    if (n < 0 || n >= ONBOARD_SLIDES.length) return;
    this.idx = n;
    this._render();
    this.contentEl.querySelector(".qiaomu-reader-onb-next,.qiaomu-reader-onb-start")?.focus();
  }
  _markSeen() {
    if (this._finished) return;
    this._finished = true;
    if (this.plugin && !this.plugin.settings.onboarded) {
      this.plugin.settings.onboarded = true;
      this.plugin.saveAll();
    }
  }
  _render() {
    const { contentEl } = this;
    contentEl.empty();
    const s = ONBOARD_SLIDES[this.idx];
    const total = ONBOARD_SLIDES.length;
    const last = this.idx === total - 1;
    const card = contentEl.createDiv("qiaomu-reader-onb-card qiaomu-reader-welcome-card");
    const image = card.createDiv("qiaomu-reader-onb-icon");
    image.setAttribute("aria-hidden", "true");
    setIcon(image, s.icon);
    card.createDiv("qiaomu-reader-onb-title").setText(qiaomuReaderTranslate(s.title));
    const body = card.createDiv("qiaomu-reader-onb-body");
    body.createEl("p").setText(qiaomuReaderTranslate(s.body));
    const dots = contentEl.createDiv("qiaomu-reader-onb-dots");
    ONBOARD_SLIDES.forEach((_, i) => {
      const d = dots.createEl("button", { cls: "qiaomu-reader-onb-dot" + (i === this.idx ? " qiaomu-reader-onb-dot-on" : "") });
      d.setAttribute("aria-current", i === this.idx ? "step" : "false");
      d.setAttribute("aria-label", qiaomuReaderTranslate("screen-0", i + 1));
      d.addEventListener("click", () => {
        this._go(i - this.idx);
      });
    });
    const nav = contentEl.createDiv("qiaomu-reader-onb-nav");
    const prev = nav.createEl("button", { text: qiaomuReaderTranslate("back-2") });
    prev.addClass("qiaomu-reader-onb-prev");
    prev.disabled = this.idx === 0;
    prev.addEventListener("click", () => this._go(-1));
    nav.createDiv("qiaomu-reader-onb-counter").setText(`${this.idx + 1} / ${total}`);
    const next = nav.createEl("button", { text: last ? qiaomuReaderTranslate("start-reading") : qiaomuReaderTranslate("next") });
    next.addClass(last ? "qiaomu-reader-onb-start" : "qiaomu-reader-onb-next");
    next.addEventListener("click", () => {
      if (last) {
        this._startReading();
      } else this._go(1);
    });
    if (!last) {
      const skip = contentEl.createEl("button", { cls: "qiaomu-reader-onb-skip", text: qiaomuReaderTranslate("skip") });
      skip.addEventListener("click", () => this._startReading());
    }
  }
  _startReading() {
    this._markSeen();
    this.close();
    if (this.plugin) void this.plugin.openLibrary();
  }

  onClose() {
    this._markSeen();
    this.contentEl.empty();
  }
};
}
