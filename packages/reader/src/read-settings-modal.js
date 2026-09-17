// ReadSettingsModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { READER_THEME_CHOICES } from "./reader-themes.js";
import { cliReasoningEfforts, effectiveCliEffort } from "./ai-cli.js";
import { docOf } from "./reader-dom.js";
import { ensureBundledReaderFont } from "./bundled-fonts.js";
import { resolveReaderFont } from "./reader-appearance.js";
import { svgIcon } from "./reader-icons.js";

export function createReadSettingsModal({
  Modal, Setting, FONTS, aiConfig, aiSetupMessage, aiSetupState, bindSettingsTabKeys, buildCustomFontInput, buildPageButtonsSetting, buildReaderExtraSettings, createPdfZoomSettings, ensureSelectedReaderFont, openPluginAiSettings, panelSection, persistCurrentReaderPosition, qiaomuReaderDeviceKey, qiaomuReaderFontLabel, qiaomuReaderReaderFonts, qiaomuReaderTheme, qiaomuReaderTranslate, readerHud, readerIsPdf, readerThemeLabel, selectedReaderTheme, setReaderTheme,
}) {
  return class ReadSettingsModal extends Modal {
  constructor(app, view, initialTab = "reading") {
    super(app);
    this.view = view;
    this.tab = ["reading", "layout", "ai"].includes(initialTab) ? initialTab : "reading";
  }
  async _apply(нуженПересчёт) {
    const v = this.view;
    window.clearTimeout(this._saveT);
    this._saveT = window.setTimeout(() => { v.plugin.saveAll(); }, 500);
    if (typeof v.applyVars === "function") v.applyVars();
    if (typeof v._applyTheme === "function") v._applyTheme();
    if (нуженПересчёт && v.bookHtml) {
      if (typeof v.repaginate === "function") await v.repaginate();
      else if (typeof v._repaginate === "function") await v._repaginate();
      await persistCurrentReaderPosition(v);
    }
    this._paintPreview();
  }
  _paintPreview() {
    const p = this.previewEl;
    if (!p) return;
    const s = this.view.plugin.settings;
    const t = qiaomuReaderTheme(s);
    void ensureSelectedReaderFont(docOf(p), this.view.plugin, s);
    p.style.fontFamily = resolveReaderFont(s, FONTS);
    p.style.fontSize = `${s.fontSize || 18}px`;
    p.style.lineHeight = String(s.lineHeight || 1.8);
    p.style.textAlign = s.textAlign || "left";
    p.style.background = t.bg;
    p.style.color = t.text;
  }
  _seg(host, label, items, current, onPick, hint, компактный) {
    host.createDiv("qiaomu-reader-pan-sec").setText(label);
    const row = host.createDiv("qiaomu-reader-col-row qiaomu-reader-rs-seg" + (компактный ? " qiaomu-reader-rs-num" : ""));
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    const btns = [];
    for (const [value, text, шрифт] of items) {
      const b = row.createEl("button", { cls: "qiaomu-reader-col-btn", attr: { type: "button", "aria-pressed": String(value === current()) } });
      b.setText(text);
      if (шрифт) b.style.fontFamily = шрифт;
      if (value === current()) b.addClass("active");
      b.addEventListener("click", async () => {
        for (const x of btns) { x.removeClass("active"); x.setAttribute("aria-pressed", "false"); }
        b.addClass("active");
        b.setAttribute("aria-pressed", "true");
        await onPick(value);
      });
      btns.push(b);
    }
    if (hint) host.createDiv("qiaomu-reader-pan-hint").setText(hint);
    return row;
  }
  _drawAi(c) {
    const plugin = this.view.plugin;
    const s = plugin.settings;
    const cfg = aiConfig(plugin);
    const state = aiSetupState(plugin);
    const section = c.createDiv("qiaomu-reader-rs-ai-card");
    if (!state.ready) {
      section.addClass("qiaomu-reader-ai-setup-empty");
      const icon = section.createDiv("qiaomu-reader-ai-setup-icon");
      svgIcon(icon, "wand-sparkles");
      section.createDiv({ cls: "qiaomu-reader-ai-setup-title", text: state.kind === "unconfigured"
        ? qiaomuReaderTranslate("ai-assistance-is-not-set-up")
        : qiaomuReaderTranslate("ai-assistance-needs-one-more-step") });
      section.createDiv({ cls: "qiaomu-reader-ai-setup-desc", text: aiSetupMessage(state) });
      const start = section.createEl("button", {
        cls: "mod-cta qiaomu-reader-ai-setup-cta",
        text: state.kind === "unconfigured" ? qiaomuReaderTranslate("start-setup") : qiaomuReaderTranslate("continue-setup"),
      });
      start.addEventListener("click", () => openPluginAiSettings(this.app, plugin, () => this._draw()));
    } else {
      const providerName = qiaomuReaderTranslate(cfg.provider.label);
      const modelName = cfg.model || (cfg.transport === "cli" ? qiaomuReaderTranslate("model-default") : qiaomuReaderTranslate("default-model"));
      const status = new Setting(section)
        .setName(qiaomuReaderTranslate("ai-assistance-is-set-up"))
        .setDesc(`${providerName} · ${modelName}`)
        .addButton((button) => button
          .setButtonText(qiaomuReaderTranslate("change-service"))
          .onClick(() => openPluginAiSettings(this.app, plugin, () => this._draw())));
      status.settingEl.addClass("qiaomu-reader-ai-status-row");
      const badge = status.nameEl.createSpan({
        cls: `qiaomu-reader-ai-status-badge ${state.enabled ? "is-ready" : "is-off"}`,
        text: state.enabled ? qiaomuReaderTranslate("ready") : qiaomuReaderTranslate("off-2"),
      });
      badge.setAttr("aria-label", state.enabled ? qiaomuReaderTranslate("ready") : qiaomuReaderTranslate("off-2"));
      new Setting(section)
        .setName(qiaomuReaderTranslate("enable-ai-assistance"))
        .setDesc(qiaomuReaderTranslate("ai-entry-setting-description"))
        .addToggle((toggle) => toggle
          .setValue(state.enabled)
          .onChange(async (value) => {
            s.aiEnabled = value;
            await plugin.saveAll();
            this._draw();
          }));
    }

    if (state.ready && cfg.transport === "cli") {
      if (!s.aiCliEfforts || typeof s.aiCliEfforts !== "object") s.aiCliEfforts = {};
      const labels = {
        "": qiaomuReaderTranslate("model-default"),
        minimal: qiaomuReaderTranslate("minimal"),
        low: qiaomuReaderTranslate("low"),
        medium: qiaomuReaderTranslate("medium"),
        high: qiaomuReaderTranslate("high"),
        xhigh: qiaomuReaderTranslate("extra-high"),
        max: qiaomuReaderTranslate("maximum"),
      };
      new Setting(section)
        .setName(qiaomuReaderTranslate("reasoning-effort"))
        .setDesc(qiaomuReaderTranslate("low-is-faster-for-everyday-reading-raise-it-for-difficult-passag"))
        .addDropdown((dropdown) => {
          cliReasoningEfforts(s.aiProvider).forEach((value) => dropdown.addOption(value, labels[value] || value));
          dropdown.setValue(effectiveCliEffort(s.aiProvider, s.aiCliEfforts[s.aiProvider])).onChange(async (value) => {
            s.aiCliEfforts[s.aiProvider] = value;
            await plugin.saveAll();
          });
        });
    } else if (state.ready && cfg.provider.supportsThinking) {
      if (!s.aiThinking || typeof s.aiThinking !== "object") s.aiThinking = {};
      new Setting(section)
        .setName(qiaomuReaderTranslate("thinking-mode-2"))
        .setDesc(qiaomuReaderTranslate("turn-this-on-for-deeper-analysis-turn-it-off-for-faster-answers"))
        .addToggle((toggle) => toggle
          .setValue(s.aiThinking[s.aiProvider] !== false)
          .onChange(async (value) => {
            s.aiThinking[s.aiProvider] = value;
            await plugin.saveAll();
          }));
    }

    if (state.ready) {
      new Setting(section)
        .setName(qiaomuReaderTranslate("response-language"))
        .setDesc(qiaomuReaderTranslate("language-used-for-ai-explanations-and-follow-up-questions"))
        .addText((text) => text
          .setPlaceholder("中文")
          .setValue(s.aiInto || "中文")
          .onChange(async (value) => {
            s.aiInto = value.trim() || "中文";
            await plugin.saveAll();
          }));


    }

    const privacy = c.createDiv("qiaomu-reader-rs-ai-privacy");
    svgIcon(privacy.createSpan({ cls: "qiaomu-reader-rs-ai-privacy-icon" }), "shield-check");
    privacy.createSpan({ text: qiaomuReaderTranslate("regular-reading-stays-offline-the-selected-passage-book-title-an") });
  }
  onOpen() {
    this.modalEl.addClass("qiaomu-reader-rs-modal");
    this.contentEl.addClass("qiaomu-reader-rs");
    this._draw();
  }
  _draw() {
    let c = this.contentEl;
    c.empty();
    const head = c.createDiv("qiaomu-reader-rs-head");
    head.createDiv("qiaomu-reader-rs-title").setText(qiaomuReaderTranslate("reading-settings"));
    const tabs = c.createDiv("qiaomu-reader-rs-tabs");
    tabs.setAttribute("role", "tablist");
    [["reading", qiaomuReaderTranslate("text-and-background")], ["layout", qiaomuReaderTranslate("turning-and-layout")], ["ai", qiaomuReaderTranslate("ai-reading")]].forEach(([id, label]) => {
      const button = tabs.createEl("button", { cls: "qiaomu-reader-rs-tab", text: label });
      button.type = "button";
      button.setAttribute("role", "tab");
      button.tabIndex = this.tab === id ? 0 : -1;
      button.toggleClass("is-active", this.tab === id);
      button.setAttr("aria-selected", this.tab === id ? "true" : "false");
      button.addEventListener("click", () => {
        if (this.tab === id) return;
        this.tab = id;
        this._draw();
      });
    });
    bindSettingsTabKeys(tabs);
    c = c.createDiv("qiaomu-reader-rs-body");
    c.setAttribute("role", "tabpanel");
    c.dataset.tab = this.tab;
    if (this.tab === "ai") {
      this.previewEl = null;
      this._drawAi(c);
      return;
    }
    if (this.tab === "layout") {
      this.previewEl = null;
      const card = c.createDiv("qiaomu-reader-rs-card");
      this._fillPageControls(card, this.view, this.view.plugin.settings);
      this._fillExtrasAndFoot(c, this.view);
    } else this._drawReadingTab(c);
  }
  _drawReadingTab(body) {
    const view = this.view;
    const settings = view.plugin.settings;
    this._mountPreview(body, view);
    this._themeCard(body, settings);
    const text = body.createDiv("qiaomu-reader-rs-card");
    if (readerIsPdf(view)) this._fillPdfScale(text, view);
    else this._fillTypography(text, view, settings);
  }

  _mountPreview(body, view) {
    this.previewEl = body.createDiv("qiaomu-reader-rs-preview");
    this.previewEl.hidden = readerIsPdf(view);
    this.previewEl.setText(qiaomuReaderTranslate("reading-is-not-about-remembering-everything-but-about-finding-id"));
    const repaint = () => this._paintPreview();
    repaint();
    body.addEventListener("click", () => window.setTimeout(repaint, 80), true);
  }
  _themeCard(body, settings) {
    const card = body.createDiv("qiaomu-reader-rs-card qiaomu-reader-rs-theme-card");
    this._seg(
      card,
      qiaomuReaderTranslate("theme"),
      READER_THEME_CHOICES.map((id) => [id, readerThemeLabel(id)]),
      () => selectedReaderTheme(settings),
      async (theme) => {
        setReaderTheme(settings, theme); await this._apply(false);
      }
    );
  }
  _fillTypography(colA, view, settings) {
    colA.createDiv("qiaomu-reader-rs-h").setText(qiaomuReaderTranslate("text-and-font"));
    qiaomuReaderReaderFonts().forEach((font) => {
      void ensureBundledReaderFont(docOf(colA), font.id);
    });
    colA.createDiv("qiaomu-reader-pan-sec").setText(qiaomuReaderTranslate("font-size"));
    const szRow = colA.createDiv("qiaomu-reader-sz-row qiaomu-reader-rs-size-control");
    const szMinus = szRow.createEl("button", { cls: "qiaomu-reader-sz-btn", text: "A−" });
    szMinus.type = "button";
    szMinus.setAttr("aria-label", qiaomuReaderTranslate("decrease-text-size"));
    const szLabel = szRow.createDiv("qiaomu-reader-sz-label");
    szLabel.setText(`${settings.fontSize}px`);
    const szPlus = szRow.createEl("button", { cls: "qiaomu-reader-sz-btn", text: "A+" });
    szPlus.type = "button";
    szPlus.setAttr("aria-label", qiaomuReaderTranslate("increase-text-size"));
    const bumpSize = async (delta) => {
      settings.fontSize = readerHud.clampNum((settings.fontSize || 18) + delta, 12, 32);
      szLabel.setText(`${settings.fontSize}px`); await this._apply(true);
    };
    szMinus.addEventListener("click", () => bumpSize(-1));
    szPlus.addEventListener("click", () => bumpSize(1));
    new Setting(colA).setName(qiaomuReaderTranslate("font")).addDropdown(dropdown => {
      for (const font of qiaomuReaderReaderFonts()) dropdown.addOption(font.id, qiaomuReaderFontLabel(font));
      dropdown.setValue(settings.fontFamily).onChange(async font => {
        settings.fontFamily = font; refreshCustomFont(); await this._apply(true);
      });
    });
    const refreshCustomFont = buildCustomFontInput(colA, view.plugin, () => this._apply(true));
    const lineHead = colA.createDiv("qiaomu-reader-rs-range-head");
    lineHead.createSpan({ text: qiaomuReaderTranslate("line-spacing") });
    const lineValue = lineHead.createSpan({ cls: "qiaomu-reader-rs-range-value" });
    const lineLabel = (value) => value <= 1.5 ? qiaomuReaderTranslate("compact")
      : value <= 1.7 ? qiaomuReaderTranslate("standard")
        : value <= 1.95 ? qiaomuReaderTranslate("comfortable") : qiaomuReaderTranslate("spacious");
    const updateLineValue = (value) => {
      lineValue.setText(`${lineLabel(value)} · ${value.toFixed(2)}`);
    };
    const lineRange = colA.createEl("input", {
      cls: "qiaomu-reader-rs-range",
      type: "range",
      attr: { min: "1.4", max: "2.2", step: "0.05", value: String(settings.lineHeight || 1.8) },
    });
    lineRange.setAttr("aria-label", qiaomuReaderTranslate("line-spacing"));
    const lineEnds = colA.createDiv("qiaomu-reader-rs-range-ends");
    lineEnds.createSpan({ text: qiaomuReaderTranslate("compact") });
    lineEnds.createSpan({ text: qiaomuReaderTranslate("spacious") });
    updateLineValue(Number(lineRange.value));
    lineRange.addEventListener("input", () => {
      const value = Math.round(Number(lineRange.value) * 20) / 20;
      settings.lineHeight = value;
      updateLineValue(value); void this._apply(true);
    });
    lineRange.addEventListener("change", async () => {
      settings.lineHeight = Math.round(Number(lineRange.value) * 20) / 20; await this._apply(true);
    });
  }
  _fillPdfScale(colA, view) {
    colA.createDiv("qiaomu-reader-rs-h").setText(qiaomuReaderTranslate("pdf-zoom"));
    createPdfZoomSettings(colA, view);
    colA.createDiv("qiaomu-reader-pan-hint").setText(qiaomuReaderTranslate("pinch-with-two-fingers-or-use-cmd-ctrl-wheel-for-continuous-zoom"));
  }
  _fillPageControls(colB, view, settings) {
    colB.createDiv("qiaomu-reader-rs-h").setText(qiaomuReaderTranslate("page-layout"));
    this._seg(
      colB,
      qiaomuReaderTranslate("reading-mode"),
      [["pages", qiaomuReaderTranslate("pages")], ["scroll", qiaomuReaderTranslate("scrolling")]],
      () => settings.readMode || "pages",
      async (mode) => {
        if (mode === (settings.readMode || "pages")) return;
        const reader = this.view;
        try {
          if (reader.file && reader.pager) {
            await persistCurrentReaderPosition(reader);
          }
        } catch { /* best-effort progress save */ }
        settings.readMode = mode; await this._apply(true); this._draw();
      }
    );
    if (settings.readMode !== "scroll" && qiaomuReaderDeviceKey() !== "phone") this._seg(
      colB,
      qiaomuReaderTranslate("pages-side-by-side"),
      [["1", qiaomuReaderTranslate("one")], ["2", qiaomuReaderTranslate("two")]],
      () => String(settings.columns || "2"),
      async (count) => {
        settings.columns = count; await this._apply(true);
      },
      qiaomuReaderTranslate("two-pages-are-shown-only-on-a-wide-screen")
    );

  }
  _fillExtrasAndFoot(body, view) {
    const more = body.createDiv("qiaomu-reader-rs-more");
    const moreBody = panelSection(view, more, {
      label: qiaomuReaderTranslate("more-settings"),
      emoji: "",
      settingKey: "readerAdvOpen"
    });
    buildReaderExtraSettings(view, moreBody, false);
    buildPageButtonsSetting(moreBody, view.plugin);
  }

  onClose() {
    window.clearTimeout(this._saveT);
    if (this.view && this.view.plugin) this.view.plugin.saveAll();
    if (this.view) this.view._histRow = null;
    this.contentEl.empty();
  }
};
}
