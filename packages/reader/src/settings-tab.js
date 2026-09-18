// SettingsTab assembly. The host supplies the PluginSettingTab base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { AI_PROVIDERS, AI_PROVIDER_CATEGORIES, normalizeAiBase } from "./ai-providers.js";
import { READER_THEME_CHOICES } from "./reader-themes.js";
import { UI_LANGUAGES } from "./i18n-languages.js";
import { selectionActionPreferences } from "./selection-preferences.js";
import { svgIcon } from "./reader-icons.js";

export function createSettingsTab({
  Notice, Platform, PluginSettingTab, SecretComponent, Setting, setIcon, HL_COLORS, OnboardingModal, QUOTE_TEMPLATE_DEFAULT, SettingsGroupModal, TRANSLATION_LANGUAGE_CHOICES, VIEW_TYPE, WHATS_NEW, WhatsNewModal, addFolderPathControl, addMarkdownFilePathControl, aiConfig, aiConnectionErrorMessage, aiSetupMessage, aiSetupState, aiTestConnection, bindSettingsTabKeys, buildCustomFontInput, buildPageButtonsSetting, copyToClipboard, ensureAiCliReady, fmtReadTime, openPluginAiSettings, qiaomuReaderDeviceKey, qiaomuReaderFontLabel, qiaomuReaderReaderFonts, qiaomuReaderSetLanguage, qiaomuReaderTranslate, readerThemeLabel, readerTimer, readerTodayKey, readingStats, selectedReaderTheme, setReaderTheme, testAndEnableAi, withSliderValue,
}) {
  return class SettingsTab extends PluginSettingTab {
  _group(c, { name, desc, build }) {
    new Setting(c)
      .setName(name)
      .setDesc(desc)
      .addButton((b) => b
        .setButtonText(qiaomuReaderTranslate("configure"))
        .onClick(() => new SettingsGroupModal(this.app, name, build).open()));
  }
  _sectionIntro(c, title, desc) {
    const intro = c.createDiv("qiaomu-reader-settings-intro");
    intro.createEl("h2", { text: title });
    intro.createDiv({ text: desc });
  }
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  hide() {
    this._settingsCard?.classList.remove("qiaomu-reader-settings-card");
    this._settingsCard = null;
  }
  getSettingDefinitions() {
    return [{
      name: qiaomuReaderTranslate("qiaomu-book-reader-settings"),
      desc: qiaomuReaderTranslate("reading-themes-fonts-notes-ai-translation-folders-syncing-and-da"),
      searchable: true,
      render: (setting) => {
        const c = setting.settingEl;
        c.empty();
        c.addClass("qiaomu-reader-settings-definition");
        this._settingsCard?.classList.remove("qiaomu-reader-settings-card");
        this._settingsCard = c.closest(".setting-items");
        this._settingsCard?.classList.add("qiaomu-reader-settings-card");
        this._render(c);
      },
    }];
  }
  _redraw() {
    const el = this.containerEl;
    const scroller = el.scrollHeight > el.clientHeight ? el : (el.closest(".vertical-tab-content") || el.parentElement || el);
    const y = scroller.scrollTop;
    if (typeof this.update === "function") this.update();
    else this.display();
    scroller.scrollTop = y;
    window.requestAnimationFrame(() => { scroller.scrollTop = y; });
  }
  display() {
    this._render(this.containerEl);
  }
  _render(root) {
    this.plugin._watchQuietUiDocument(root.ownerDocument);
    root.empty();
    root.addClass("qiaomu-reader-settings-root");
    const tabs = this._settingsTabs();
    if (!this._tab || !tabs.some((t) => t.id === this._tab)) { this._tab = "look"; }
    const head = root.createDiv("qiaomu-reader-settings-head");
    const headText = head.createDiv("qiaomu-reader-settings-head-text");
    headText.createEl("h2", { text: "UV Reader" });

    const language = head.createEl("select", { cls: "dropdown qiaomu-reader-settings-language" });
    for (const { id: value, label } of UI_LANGUAGES) {
      language.createEl("option", { text: label, attr: { value } });
    }
    language.value = this.plugin.settings.language || "zh";
    language.setAttr("aria-label", qiaomuReaderTranslate("interface-language"));
    language.addEventListener("change", async () => {
      await this._applyUiLanguage(language.value);
    });
    const layout = root.createDiv("qiaomu-reader-settings-layout");
    const bar = layout.createDiv("qiaomu-reader-set-tabs");
    bar.setAttribute("role", "tablist");
    for (const tab of tabs) {
      const el = bar.createEl("button", { cls: "qiaomu-reader-set-tab", attr: { type: "button", role: "tab", "aria-selected": String(tab.id === this._tab), tabindex: tab.id === this._tab ? "0" : "-1" } });
      el.setText(tab.label);
      if (tab.id === this._tab) el.addClass("qiaomu-reader-set-tab-on");
      el.addEventListener("click", () => { this._tab = tab.id; this._redraw(); });
    }
    bindSettingsTabKeys(bar);
    const body = layout.createDiv("qiaomu-reader-set-body");
    body.setAttribute("role", "tabpanel");
    body.dataset.tab = this._tab;
    this._drawSettingsTab(body);
  }
  _settingsTabs() {
    return [
      { id: "look", label: qiaomuReaderTranslate("reading-appearance") },
      { id: "read", label: qiaomuReaderTranslate("page-turning-2") },
      { id: "notes", label: qiaomuReaderTranslate("notes") },
      { id: "translate", label: qiaomuReaderTranslate("ai-translation") },
      { id: "data", label: qiaomuReaderTranslate("data") },
      { id: "about", label: qiaomuReaderTranslate("about") }
    ];
  }
  async _applyUiLanguage(v) {
    this.plugin.settings.language = v; this.plugin.settings.languagePicked = true;
    qiaomuReaderSetLanguage(v);
    await this.plugin.saveAll(); this._redraw();
    new Notice(qiaomuReaderTranslate("interface-language-updated-reopen-existing-book-tabs-and-chats-t"));
  }
  _drawSettingsTab(body) {
    const drawers = {
      read: (host) => this._tabReading(host),
      look: (host) => this._groupAppearance(host),
      notes: (host) => this._tabNotes(host),
      translate: (host) => this._tabTranslate(host),
      data: (host) => this._tabData(host),
      about: (host) => this._tabAbout(host),
    };
    (drawers[this._tab] || drawers.about)(body);
  }
  _statsCard(c) {
    const st = readingStats(this.plugin.settings.readingLog, this.plugin.settings.lifetimeSeconds, readerTodayKey());
    const card = c.createDiv({ cls: "qiaomu-reader-stats" });

    const head = card.createDiv({ cls: "qiaomu-reader-stats-head" });
    const total = head.createDiv({ cls: "qiaomu-reader-stats-total" });
    total.createDiv({ cls: "qiaomu-reader-stats-big", text: fmtReadTime(st.total) });
    total.createDiv({ cls: "qiaomu-reader-stats-cap", text: qiaomuReaderTranslate("all-time-with-books") });
    if (st.streak > 0) {
      const fl = head.createDiv({ cls: "qiaomu-reader-stats-streak" });
      fl.createSpan({ cls: "qiaomu-reader-stats-flame", text: "🔥" });
      fl.createSpan({ text: qiaomuReaderTranslate("0-day-streak", st.streak) });
    }

    const grid = card.createDiv({ cls: "qiaomu-reader-stats-grid" });
    const cell = (label, value) => {
      const d = grid.createDiv({ cls: "qiaomu-reader-stats-cell" });
      d.createDiv({ cls: "qiaomu-reader-stats-val", text: value });
      d.createDiv({ cls: "qiaomu-reader-stats-lab", text: label });
    };
    cell(qiaomuReaderTranslate("today"), fmtReadTime(st.today));
    cell(qiaomuReaderTranslate("days-with-a-book"), st.daysRead ? String(st.daysRead) : "—");
    cell(qiaomuReaderTranslate("daily-average"), fmtReadTime(st.avgPerDay));
    cell(qiaomuReaderTranslate("best-day"), fmtReadTime(st.best));

    const peak = st.recent.reduce((a, r) => Math.max(a, r.sec), 0);
    if (peak > 0) {
      const chart = card.createDiv({ cls: "qiaomu-reader-stats-chart" });
      const bars = chart.createDiv({ cls: "qiaomu-reader-stats-bars" });
      for (const r of st.recent) {
        const col = bars.createDiv({ cls: "qiaomu-reader-stats-bar" + (r.sec > 0 ? " is-read" : "") });
        const fill = col.createDiv({ cls: "qiaomu-reader-stats-fill" });
        fill.style.height = r.sec > 0 ? Math.max(8, Math.round(r.sec / peak * 100)) + "%" : "2px";
        col.setAttr("aria-label", r.key + " — " + fmtReadTime(r.sec));
        col.setAttr("title", r.key + " — " + fmtReadTime(r.sec));
      }
      const legend = chart.createDiv({ cls: "qiaomu-reader-stats-legend" });
      legend.createSpan({ text: qiaomuReaderTranslate("14-days-ago") });
      legend.createSpan({ text: qiaomuReaderTranslate("today") });
    } else {
      card.createDiv({ cls: "qiaomu-reader-stats-empty", text: qiaomuReaderTranslate("open-a-book-and-start-the-timer-your-reading-history-will-appear") });
    }
  }

  // Two shared builders for the settings tab rows below: everything else in
  // this tab is data plus an onChange handler.
  _readingDropdown(c, nameKey, descKey, options, value, onChange) {
    new Setting(c)
      .setName(qiaomuReaderTranslate(nameKey))
      .setDesc(qiaomuReaderTranslate(descKey))
      .addDropdown((dropdown) => {
        for (const [optValue, optLabel] of options) dropdown.addOption(optValue, optLabel);
        dropdown.setValue(value).onChange(onChange);
      });
  }
  _readingToggle(c, nameKey, descKey, value, onChange) {
    new Setting(c)
      .setName(qiaomuReaderTranslate(nameKey))
      .setDesc(qiaomuReaderTranslate(descKey))
      .addToggle((toggle) => toggle.setValue(value).onChange(onChange));
  }
  _repaginateOpenBooks() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && view.bookHtml) void view.repaginate();
    }
    const mobile = this.plugin._openReaderModal;
    if (mobile?.bookHtml) void mobile._repaginate();
  }
  _tabReading(c) {
    const t = qiaomuReaderTranslate;
    const s = this.plugin.settings;
    this._sectionIntro(c, t("turning-and-layout"), t("choose-how-you-read-and-turn-pages-the-defaults-handle-the-rest"));

    this._readingDropdown(c,
      "page-turning-2",
      "buttons-arrows-keys-swipe-by-click-clicking-the-left-right-part",
      [["buttons", t("buttons")], ["click", t("by-mouse-click")]],
      s.navMode || "buttons",
      async (v) => {
        s.navMode = v; await this.plugin.saveAll();
        const readers = this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view);
        if (this.plugin._openReaderModal) readers.push(this.plugin._openReaderModal);
        for (const reader of readers) (reader.contentEl || reader.containerEl).classList.toggle("qiaomu-reader-navclick", v === "click");
      });

    this._readingDropdown(c,
      "how-to-read",
      "progress-saves-automatically-while-you-turn-pages-scroll-and-clo",
      [["pages", t("in-pages")], ["scroll", t("by-scrolling")]],
      s.readMode || "pages",
      async (v) => {
        s.readMode = v;
        await this.plugin.saveAll();
        this._repaginateOpenBooks();
        this._redraw();
      });

    if (s.readMode !== "scroll") this._readingDropdown(c,
      "pages-side-by-side", "two-pages-are-shown-only-on-a-wide-screen",
      [["1", t("one")], ["2", t("two")]], String(s.columns || "2"),
      async value => { s.columns = value; await this.plugin.saveAll(); this._repaginateOpenBooks(); });
    buildPageButtonsSetting(c, this.plugin);
    this._selectionToolbarSettings(this._settingsDisclosure(c, "selection-toolbar"));
    const extras = c.createEl("details", { cls: "qiaomu-reader-settings-disclosure" });
    extras.createEl("summary", { text: t("reading-goal") });
    c = extras.createDiv("qiaomu-reader-settings-disclosure-body");
    c.createEl("h3", { cls: "qiaomu-reader-set-h", text: t("reading-goal") });
    this._readingToggle(c,
      "reading-goal-timer",
      "a-countdown-to-your-daily-goal-for-example-15-minutes-start-it-w",
      s.timerEnabled !== false,
      async (v) => {
        s.timerEnabled = v; await this.plugin.saveAll();
        const readers = this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view);
        if (this.plugin._openReaderModal) readers.push(this.plugin._openReaderModal);
        for (const reader of readers) {
          if (!v) readerTimer.pause(reader);
          readerTimer.updateGoalBar(reader); readerTimer.updateButton(reader);
        }
      });
    new Setting(c)
      .setName(t("daily-goal-minutes"))
      .setDesc(t("how-many-minutes-a-day-you-want-to-read-today-s-progress-is-in-t"))
      .addSlider((slider) => withSliderValue(slider.setLimits(5, 120, 5).setValue(s.dailyGoalMin || 15))
        .onChange(async (v) => { s.dailyGoalMin = v; await this.plugin.saveAll(); }));

    c.createEl("h3", { cls: "qiaomu-reader-set-h", text: t("reading-statistics") });
    this._statsCard(c);
  }
  _saveAll() {
    return this.plugin.saveAll();
  }
  _groupAi(c, redraw, options = {}) {
    const plugin = this.plugin;
    const s = plugin.settings;
    const cfg = aiConfig(plugin);
    c.addClass("qiaomu-reader-ai-setup");
    this._aiProviderRow(c, s, redraw);
    if (!cfg.provider) return;
    const p = cfg.provider;
    this._aiModelPicker(c, s, p, redraw);
    const needsSecret = p.needsKey && !cfg.key;
    if (needsSecret || cfg.id === "custom") this._aiSecretRow(c, s, p);
    if (cfg.id === "custom") this._aiBaseRow(c, s, p);
    const feedback = c.createDiv("qiaomu-reader-ai-setup-feedback");
    feedback.setAttribute("role", "status");
    const paintStatus = () => {
      if (feedback.getAttribute("role") === "alert") return;
      const state = aiSetupState(plugin);
      feedback.empty();
      setIcon(feedback.createSpan("qiaomu-reader-ai-setup-status-icon"), state.enabled ? "circle-check" : "circle");
      feedback.createSpan({ text: state.enabled ? qiaomuReaderTranslate("ai-ready-to-use") : qiaomuReaderTranslate("ai-connect-on-start") });
    };
    paintStatus();
    c.addEventListener("change", () => window.setTimeout(paintStatus, 0));
    const advanced = this._settingsDisclosure(c, "advanced");
    advanced.parentElement.setAttribute("data-ai-advanced", "");
    if (p.supportsThinking) this._aiThinkingRow(advanced, s);
    const connection = this._settingsDisclosure(advanced, "ai-connection-settings");
    connection.parentElement.setAttribute("data-ai-connection", "");
    if (p.needsKey && !needsSecret) this._aiSecretRow(connection, s, p);
    if (cfg.id !== "custom") this._aiBaseRow(connection, s, p);
    this._aiTestRow(connection, p, options);
    const behavior = this._settingsDisclosure(advanced, "ai-response-preferences");
    this._aiTailRows(behavior, s, p, cfg);
  }
  _settingsDisclosure(host, key) {
    const details = host.createEl("details", { cls: "qiaomu-reader-settings-disclosure" });
    details.createEl("summary", { text: qiaomuReaderTranslate(key) });
    return details.createDiv("qiaomu-reader-settings-disclosure-body");
  }
  _selectionToolbarSettings(host) {
    const s = this.plugin.settings, t = qiaomuReaderTranslate;
    const render = () => {
      host.empty();
      new Setting(host).setName(t("selection-show-labels"))
        .addToggle(toggle => toggle.setValue(s.selectionShowLabels === true).onChange(async value => {
          s.selectionShowLabels = value; await this.plugin.saveAll();
        }));
      host.createEl("p", { cls: "qiaomu-reader-set-note", text: t("selection-hidden-in-more") });
      const items = selectionActionPreferences(s.selectionActions);
      const labels = { highlight: "highlight-action", comment: "annotate-action", ai: "ask-ai-action", translate: "translate", copy: "copy" };
      const save = async (focus) => {
        s.selectionActions = items; await this.plugin.saveAll(); render();
        if (focus) host.querySelector(focus)?.focus();
      };
      items.forEach((item, index) => {
        const row = new Setting(host).setName(t(labels[item.id]));
        for (const [direction, delta, icon] of [["up", -1, "arrow-up"], ["down", 1, "arrow-down"]]) {
          row.addButton(button => {
            button.setIcon(icon).setDisabled(index + delta < 0 || index + delta >= items.length);
            button.buttonEl.setAttribute("aria-label", t(direction === "up" ? "selection-move-up" : "selection-move-down"));
            button.buttonEl.dataset.selectionMove = item.id + "-" + direction;
            button.onClick(async () => {
              [items[index], items[index + delta]] = [items[index + delta], items[index]];
              await save(`[data-selection-move="${item.id}-${direction}"]`);
            });
          });
        }
        row.addToggle(toggle => {
          toggle.toggleEl.dataset.selectionVisible = item.id;
          toggle.setValue(item.visible).onChange(async value => {
            item.visible = value; await save(`[data-selection-visible="${item.id}"]`);
          });
        });
      });
      new Setting(host).addButton(button => button.setButtonText(t("restore-defaults")).onClick(async () => {
        s.selectionActions = null; s.selectionShowLabels = false; await this.plugin.saveAll(); render();
      }));
    };
    render();
  }
  _aiProviderRow(host, s, redraw) {
    new Setting(host).setName(qiaomuReaderTranslate("ai-service")).addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", qiaomuReaderTranslate("ai-service"));
      dropdown.addOption("", qiaomuReaderTranslate("choose-a-service"));
      for (const category of AI_PROVIDER_CATEGORIES) {
        const group = dropdown.selectEl.createEl("optgroup", { attr: { label: qiaomuReaderTranslate(category.label) } });
        for (const [id, p] of Object.entries(AI_PROVIDERS)) {
          if (p.category !== category.id || (p.desktopOnly && !Platform.isDesktopApp)) continue;
          group.createEl("option", { text: qiaomuReaderTranslate(p.label), attr: { value: id } });
        }
      }
      dropdown.setValue(s.aiProvider || "").onChange(async choice => {
        s.aiProvider = choice;
        s.aiModel = s.aiModels && s.aiModels[choice] || "";
        s.aiEnabled = false;
        s.aiNeedsVerification = Boolean(choice);
        await this._saveAll();
        redraw();
      });
    });
  }
  _aiModelPicker(host, s, p, redraw) {
    const models = [...new Set([p.model, ...(p.models || [])].filter(Boolean))];
    const custom = Boolean(s.aiModel && !models.includes(s.aiModel)) || (!p.model && !s.aiModel);
    const saveModel = async value => {
      s.aiModel = value;
      s.aiModels = { ...s.aiModels, [s.aiProvider]: value };
      s.aiEnabled = false;
      s.aiNeedsVerification = true;
      await this._saveAll();
    };
    let inputRow;
    new Setting(host).setName(qiaomuReaderTranslate("model-2")).addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", qiaomuReaderTranslate("model-2"));
      dropdown.addOption("", qiaomuReaderTranslate("default-model"));
      for (const model of models) dropdown.addOption(model, model);
      dropdown.addOption("__custom__", qiaomuReaderTranslate("ai-custom-model"));
      dropdown.setValue(custom ? "__custom__" : s.aiModel || "");
      dropdown.onChange(async value => {
        if (value === "__custom__") {
          inputRow.settingEl.removeClass("qiaomu-reader-hidden");
          inputRow.controlEl.querySelector("input")?.focus();
          return;
        }
        await saveModel(value); redraw();
      });
    });
    inputRow = new Setting(host).setName(qiaomuReaderTranslate("model-id"))
      .addText(field => field.setValue(s.aiModel || "").setPlaceholder(p.model || "model-id").onChange(value => saveModel(value.trim())));
    inputRow.settingEl.toggleClass("qiaomu-reader-hidden", !custom);
  }
  _aiSecretRow(host, s, p) {
    if (!s.aiSecrets || typeof s.aiSecrets !== "object") s.aiSecrets = {};
    const secretId = s.aiSecrets[s.aiProvider] || "";
    const keySetting = new Setting(host)
      .setName(qiaomuReaderTranslate(s.aiProvider === "custom" ? "api-key-optional" : "api-key"))
      .setDesc(qiaomuReaderTranslate("the-key-is-stored-in-obsidian-secretstorage-and-is-not-written-t"));
    if (typeof SecretComponent === "function" && this.app.secretStorage) {
      keySetting.addComponent((el) => new SecretComponent(this.app, el)
        .setValue(secretId)
        .onChange(async (value) => {
          s.aiSecrets = { ...s.aiSecrets, [s.aiProvider]: value || "" };
          s.aiSecret = "";
          s.aiKey = "";
          s.aiEnabled = false;
          s.aiNeedsVerification = true;
          await this._saveAll();
        }));
    }
    if (p.apiKeyUrl) {
      keySetting.addButton((b) => b.setButtonText(qiaomuReaderTranslate("get-api-key")).onClick(() => window.open(p.apiKeyUrl, "_blank")));
    }
  }
  _aiThinkingRow(host, s) {
    if (!s.aiThinking || typeof s.aiThinking !== "object") s.aiThinking = {};
    this._readingToggle(host,
      "thinking-mode",
      "turn-it-on-for-deeper-analysis-or-off-when-response-speed-matter",
      s.aiThinking[s.aiProvider] !== false,
      async (value) => {
        s.aiThinking[s.aiProvider] = value;
        await this._saveAll();
      });
  }
  _aiBaseRow(host, s, p) {
    if (!s.aiBases || typeof s.aiBases !== "object") s.aiBases = {};
    new Setting(host)
      .setName(qiaomuReaderTranslate("base-url"))
      .setDesc(qiaomuReaderTranslate("usually-leave-this-empty-change-it-only-for-regional-endpoints-p"))
      .addText((field) => field.setPlaceholder(p.base || "https://…/v1").setValue(s.aiBases[s.aiProvider] || "").onChange(async (value) => {
        s.aiBases = { ...s.aiBases, [s.aiProvider]: normalizeAiBase(value) };
        s.aiBase = "";
        s.aiEnabled = false;
        s.aiNeedsVerification = true;
        await this._saveAll();
      }));
  }
  _aiTestRow(host, p, options) {
    new Setting(host)
      .setName(qiaomuReaderTranslate("test-connection"))
      .setDesc(qiaomuReaderTranslate("sends-a-minimal-test-with-no-book-content-cloud-services-may-cha"))
      .addButton((b) => b.setButtonText(options.enableOnSuccess ? qiaomuReaderTranslate("test-and-enable") : qiaomuReaderTranslate("run-test")).setCta().onClick(async () => {
        const idleText = options.enableOnSuccess ? qiaomuReaderTranslate("test-and-enable") : qiaomuReaderTranslate("run-test");
        b.setDisabled(true).setButtonText(qiaomuReaderTranslate("testing"));
        try {
          const result = options.enableOnSuccess
            ? await testAndEnableAi(this.plugin, (text) => b.setButtonText(text))
            : await aiTestConnection(this.plugin);
          if (options.enableOnSuccess) {
            new Notice(qiaomuReaderTranslate("ai-assistance-enabled-0-1-ms", result.model, result.latency));
            if (typeof options.onReady === "function") options.onReady(result);
          } else {
            new Notice(qiaomuReaderTranslate("connected-0-1-ms", result.model, result.latency));
          }
        } catch (e) {
          new Notice(aiConnectionErrorMessage(e), 9000);
        } finally {
          b.setDisabled(false).setButtonText(idleText);
        }
      }));
  }
  _aiTailRows(host, s, p, cfg) {
    new Setting(host)
      .setName(qiaomuReaderTranslate("custom-reading-prompt"))
      .setDesc(qiaomuReaderTranslate("leave-empty-to-use-the-built-in-reading-assistant-your-text-repl"))
      .addTextArea((field) => {
        field.inputEl.rows = 6;
        field.inputEl.addClass("qiaomu-reader-ai-sys");
        field.setPlaceholder(qiaomuReaderTranslate("for-example-explain-in-plain-language-and-point-out-hidden-assum"));
        field.setValue(s.aiSystem || "");
        field.onChange(async (value) => {
          s.aiSystem = value;
          await this._saveAll();
        });
      });
    new Setting(host)
      .setName(qiaomuReaderTranslate("response-language"))
      .setDesc(qiaomuReaderTranslate("the-language-used-for-ai-explanations-and-follow-up-questions"))
      .addText((field) => field.setPlaceholder("中文").setValue(s.aiInto || "中文").onChange(async (value) => {
        s.aiInto = value.trim() || "中文";
        await this._saveAll();
      }));
    host.createEl("div", {
      cls: "qiaomu-reader-set-note",
      text: p.local
        ? qiaomuReaderTranslate("local-models-run-on-this-device-only-a-phone-cannot-reach-the-co")
        : qiaomuReaderTranslate("only-when-you-use-ai-are-the-selected-passage-book-title-and-que", cfg.base),
    });
  }
  _groupAppearance(host) {
    const { settings: s } = this.plugin;
    this._sectionIntro(host, qiaomuReaderTranslate("text-and-background"), qiaomuReaderTranslate("these-controls-stay-in-sync-with-reading-settings-inside-the-rea"));
    const applyAppearance = async (repaginate = true) => {
      await this._saveAll();
      const readers = this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view);
      if (this.plugin._openReaderModal) readers.push(this.plugin._openReaderModal);
      for (const view of readers) {
        if (!view) continue;
        if (typeof view.applyVars === "function") view.applyVars();
        else if (typeof view._applyTheme === "function") view._applyTheme();
        if (repaginate && view.bookHtml && typeof view.repaginate === "function") await view.repaginate();
        else if (repaginate && typeof view._applyContentStyle === "function") view._applyContentStyle();
      }
    };
    this._readingDropdown(host,
      "theme-2",
      "choose-a-page-background-for-your-current-environment",
      READER_THEME_CHOICES.map((id) => [id, readerThemeLabel(id)]),
      selectedReaderTheme(s),
      async (id) => {
        setReaderTheme(s, id);
        await applyAppearance(false);
      });
    this._readingDropdown(host,
      "body-font",
      "used-for-the-book-text-chinese-and-english-font-names-keep-their",
      qiaomuReaderReaderFonts().map((font) => [font.id, qiaomuReaderFontLabel(font)]),
      s.fontFamily || "georgia",
      async (font) => {
        s.fontFamily = font;
        refreshCustomFont();
        await applyAppearance(true);
      });
    const refreshCustomFont = buildCustomFontInput(host, this.plugin, () => applyAppearance(true));
    new Setting(host)
      .setName(qiaomuReaderTranslate("font-size-2"))
      .setDesc(qiaomuReaderTranslate("the-book-text-size-synced-with-the-in-reader-control"))
      .addSlider((slider) => withSliderValue(slider.setLimits(12, 32, 1).setValue(s.fontSize || 18)).onChange(async (size) => {
        s.fontSize = size;
        await applyAppearance(true);
      }));
    new Setting(host)
      .setName(qiaomuReaderTranslate("line-spacing-2"))
      .setDesc(qiaomuReaderTranslate("fine-tune-between-1-4-and-2-2-a-range-of-1-6-1-9-usually-works-w"))
      .addSlider((slider) => withSliderValue(slider
        .setLimits(1.4, 2.2, 0.05)
        .setValue(s.lineHeight || 1.8), 2)
        .onChange(async (value) => {
          s.lineHeight = Math.round(value * 20) / 20;
          await applyAppearance(true);
        }));
    this._appearanceAdvancedRows(host, s, applyAppearance);
  }
  _appearanceAdvancedRows(host, s, applyAppearance) {
    const advanced = host.createEl("details", { cls: "qiaomu-reader-settings-disclosure" });
    advanced.createEl("summary", { text: qiaomuReaderTranslate("more-appearance-options") });
    const body = advanced.createDiv("qiaomu-reader-settings-disclosure-body");
    body.createEl("h3", { text: qiaomuReaderTranslate("display-and-devices") });
    new Setting(body)
      .setName(qiaomuReaderTranslate("a-separate-look-on-each-device"))
      .setDesc(qiaomuReaderTranslate("font-size-theme-typeface-line-spacing-column-count-and-alignment",
        qiaomuReaderTranslate({ desktop: "computer", tablet: "tablet", phone: "phone" }[qiaomuReaderDeviceKey()])))
      .addToggle((toggle) => toggle.setValue(s.perDevice === true).onChange(async (enabled) => {
        s.perDevice = enabled;
        await this._saveAll(); this.display();
      }));
    this._readingToggle(body,
      "e-ink-reader-mode",
      "for-obsidian-on-an-android-e-ink-reader-removes-animations-fades",
      s.einkMode === true,
      async (enabled) => {
        s.einkMode = enabled;
        await applyAppearance(true);
      });
    body.createEl("h3", { text: qiaomuReaderTranslate("layout-details") });
    this._readingDropdown(body,
      "text-alignment",
      "how-text-is-aligned-in-the-reading-column-you-can-also-change-it",
      [["left", qiaomuReaderTranslate("left")], ["justify", qiaomuReaderTranslate("justify")], ["center", qiaomuReaderTranslate("center")], ["right", qiaomuReaderTranslate("right")]],
      s.textAlign || "left",
      async (next) => { s.textAlign = next; await applyAppearance(true); });
    this._readingToggle(body,
      "immersive",
      "the-top-and-bottom-controls-fully-retract-after-a-couple-of-seco",
      s.immersive !== false,
      async (enabled) => {
        s.immersive = enabled;
        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
          if (typeof leaf.view._armImmersive === "function") leaf.view._armImmersive();
        });
        if (typeof this.plugin._openReaderModal?._armImmersive === "function") {
          this.plugin._openReaderModal._armImmersive();
        }
        await this._saveAll();
      });
    if (Platform.isMobile) this._appearanceMobileInsetRow(body, s);
  }
  _appearanceMobileInsetRow(host, s) {
    new Setting(host)
      .setName(qiaomuReaderTranslate("top-inset-on-mobile"))
      .setDesc(qiaomuReaderTranslate("normally-the-system-reports-the-height-of-the-status-bar-and-the"))
      .addText((field) => {
        field.setPlaceholder("0");
        field.setValue(String(s.mobileTopInset || 0));
        field.onChange(async (raw) => {
          const inset = Math.max(0, Math.min(120, Number(String(raw).replace(/[^\d]/g, "")) || 0));
          s.mobileTopInset = inset;
          await this._saveAll();
        });
      });
  }
  _tabNotes(c) {
    const tx = (s) => qiaomuReaderTranslate(s);
    const settings = this.plugin.settings;
    const persist = async (key, v, after) => {
      this.plugin.settings[key] = v; await this.plugin.saveAll();
      if (after) after(v);
    };
    // defaultOn: the setting counts as enabled unless explicitly switched off
    const toggle = (setting, key, defaultOn, after) => setting.addToggle((t) => t
      .setValue(defaultOn ? settings[key] !== false : settings[key] === true)
      .onChange(async (v) => persist(key, v, after)));
    const choose = (setting, options, current, apply) => setting.addDropdown((d) => {
      for (const [value, label] of options) d.addOption(value, label);
      d.setValue(current).onChange(apply);
    });
    const pickFolder = (setting, key, label, placeholder) => addFolderPathControl(setting, this.app, { value: settings[key], label, placeholder, commit: (v) => persist(key, v) });
    const pickFile = (setting, key, label, placeholder) => addMarkdownFilePathControl(setting, this.app, { value: settings[key], label, placeholder, commit: (v) => persist(key, v) });
    this._sectionIntro(c, tx("notes"), tx("one-book-note-collects-the-whole-book-use-a-separate-note-only-f"));
    c.createEl("h3", { text: tx("where-notes-go") });
    pickFolder(new Setting(c)
      .setName(tx("folder-for-new-notes"))
      .setDesc(tx("where-separate-notes-go-the-ones-you-make-from-a-passage-with-cr")), "notesFolder", tx("folder-for-new-notes"));
    toggle(new Setting(c)
      .setName(tx("keep-notes-next-to-the-book"))
      .setDesc(tx("a-note-made-from-a-highlight-is-created-in-the-same-folder-as-th")), "notesNextToBook", false);
    choose(new Setting(c)
      .setName(tx("where-a-new-note-opens"))
      .setDesc(tx("beside-the-book-splits-the-pane-so-the-book-stays-in-view-in-a-n")), [
      ["split", tx("beside-the-book")],
      ["tab", tx("in-a-new-tab")],
      ["none", tx("don-t-open-it")],
    ], settings.noteOpenMode || "split", (v) => persist("noteOpenMode", v));
    toggle(new Setting(c)
      .setName(tx("ask-for-the-note-title"))
      .setDesc(tx("before-a-note-is-created-from-a-highlight-a-dialog-offers-a-shor")), "askNoteTitle", true, () => this._redraw());
    if (settings.askNoteTitle === false) {
      toggle(new Setting(c)
        .setName(tx("short-titles-no-questions"))
        .setDesc(tx("the-title-is-chosen-automatically-the-passage-s-first-sentence-o")), "shortNoteTitles", true);
    }
    c.createEl("h3", { text: tx("quotes-and-highlights") });
    choose(new Setting(c)
      .setName(tx("default-highlight-colour"))
      .setDesc(tx("which-colour-to-use-when-you-comment-on-a-passage-without-pickin")), HL_COLORS.map((col) => [col.id, col.label()]), settings.defaultHlColor || HL_COLORS[0].id, (v) => persist("defaultHlColor", v));
    const quoteOptions = this._settingsDisclosure(c, "ai-note-format-options");
    const quoteFmt = new Setting(quoteOptions)
      .setName(tx("shape-of-a-copied-quote"))
      .setDesc(tx("what-the-copy-as-a-quote-button-puts-on-the-clipboard-available"))
      .addTextArea((box) => {
        box.setPlaceholder(QUOTE_TEMPLATE_DEFAULT)
          .setValue(settings.quoteTemplate || "")
          .onChange(async (v) => persist("quoteTemplate", v));
        box.inputEl.rows = 4;
        box.inputEl.addClass("qiaomu-reader-tpl-input");
      });
    toggle(new Setting(c)
      .setName(tx("link-back-to-the-book-under-each-quote"))
      .setDesc(tx("every-exported-quote-gets-a-link-that-opens-the-book-at-the-exac")), "quoteBacklinks", true);
    toggle(new Setting(c)
      .setName(tx("keep-highlight-color-on-export"))
      .setDesc(tx("each-quote-is-wrapped-in-a-colored-mark-the-highlight-color-show")), "exportColors", true);
    c.createEl("h3", { text: tx("the-book-note") });
    toggle(new Setting(c)
      .setName(tx("a-separate-note-per-book"))
      .setDesc(tx("the-first-time-a-book-is-opened-a-reading-note-named-after-it-is")), "autoBookNote", false, (v) => {
      if (v) new Notice(tx("this-is-an-early-version-of-the-feature-check-the-result-on-a-co"), 6e3);
    });
    toggle(new Setting(c)
      .setName(tx("quotes-straight-into-the-book-note"))
      .setDesc(tx("every-new-highlight-and-comment-change-is-synchronised-to-this-b")), "quotesToBookNote", false);
    pickFolder(new Setting(c)
      .setName(tx("book-notes-folder-for-links"))
      .setDesc(tx("where-book-notes-live-one-per-book-collecting-every-quote-from-i")), "bookNotesFolder", tx("book-notes-folder-for-links"), tx("3-resources-book-base"));
    pickFile(new Setting(c)
      .setName(tx("reading-note-template"))
      .setDesc(tx("used-only-for-the-single-reading-note-created-for-a-book-where-h")), "bookNoteTemplate", tx("reading-note-template"), tx("templates-template-md"));
    toggle(new Setting(c)
      .setName(tx("progress-in-the-book-note-s-properties"))
      .setDesc(tx("adds-reading-progress-a-percentage-and-reading-updated-a-date-to")), "progressToFrontmatter", false);
    quoteFmt.settingEl.addClass("qiaomu-reader-set-stacked");
    c = this._settingsDisclosure(c, "ai-note-template-options");
    pickFile(new Setting(c)
      .setName(tx("note-template"))
      .setDesc(tx("path-to-your-templater-template-applied-to-each-new-highlight-no")), "noteTemplate", tx("note-template"), tx("templates-template-md"));
    toggle(new Setting(c)
      .setName(tx("keep-what-s-new-as-a-note"))
      .setDesc(tx("after-the-plugin-updates-a-note-listing-the-changes-appears-in-y")), "whatsNewNote", true);
    c.createEl("div", { cls: "qiaomu-reader-set-note", text: tx("tip-the-template-can-be-overridden-per-book-open-the-book-press") });
  }
  _tabTranslate(host) {
    this._sectionIntro(host, qiaomuReaderTranslate("ai-translation"), qiaomuReaderTranslate("enable-only-the-online-features-you-need-normal-reading-stays-of"));
    const state = aiSetupState(this.plugin);
    const cfg = aiConfig(this.plugin);
    this._renderAiStatusSetting(host, state, cfg);
    host.createEl("h3", { cls: "qiaomu-reader-set-h", text: qiaomuReaderTranslate("selection-translation") });
    this._translateSelectionRows(host);
    host.createEl("div", { cls: "qiaomu-reader-set-note", text: qiaomuReaderTranslate("translation-is-a-separate-network-request-to-google-if-you-need") });
  }
  _renderAiStatusSetting(host, state, cfg) {
    const setup = new Setting(host);
    setup.settingEl.addClass("qiaomu-reader-ai-system-status");
    if (!state.ready) {
      const heading = state.kind === "unconfigured" ? qiaomuReaderTranslate("ai-assistance-is-not-set-up") : qiaomuReaderTranslate("ai-assistance-needs-one-more-step");
      setup
        .setName(heading)
        .setDesc(aiSetupMessage(state))
        .addButton((btn) => btn
          .setButtonText(state.kind === "unconfigured" ? qiaomuReaderTranslate("start-setup") : qiaomuReaderTranslate("continue-setup"))
          .setCta()
          .onClick(() => openPluginAiSettings(this.app, this.plugin, () => this._redraw())));
      return;
    }
    const modelName = cfg.model || qiaomuReaderTranslate("default-model");
    setup
      .setName(qiaomuReaderTranslate("ai-assistance-is-set-up"))
      .setDesc(`${qiaomuReaderTranslate(cfg.provider.label)} · ${modelName}`)
      .addButton((btn) => btn
        .setButtonText(qiaomuReaderTranslate("change-service"))
        .onClick(() => openPluginAiSettings(this.app, this.plugin, () => this._redraw())));
    this._addAiStatusBadge(setup, state);
    new Setting(host)
      .setName(qiaomuReaderTranslate("enable-ai-assistance"))
      .setDesc(qiaomuReaderTranslate("turning-this-off-keeps-the-service-and-key-and-only-hides-the-ai"))
      .addToggle((toggle) => toggle.setValue(state.enabled).onChange(async (v) => {
        this.plugin.settings.aiEnabled = v; await this.plugin.saveAll(); this._redraw();
      }));

  }
  _addAiStatusBadge(setup, state) {
    const badge = setup.nameEl.createSpan({
      cls: `qiaomu-reader-ai-status-badge ${state.enabled ? "is-ready" : "is-off"}`,
      text: state.enabled ? qiaomuReaderTranslate("ready") : qiaomuReaderTranslate("off-2"),
    });
    badge.setAttr("aria-label", state.enabled ? qiaomuReaderTranslate("ready") : qiaomuReaderTranslate("off-2"));
  }
  _translateSelectionRows(host) {
    new Setting(host)
      .setName(qiaomuReaderTranslate("translate-button-in-the-selection-popup"))
      .setDesc(qiaomuReaderTranslate("adds-a-translate-button-to-the-popup-that-appears-when-you-selec"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.translateEnabled === true).onChange(async (v) => {
        this.plugin.settings.translateEnabled = v; await this.plugin.saveAll();
        if (v) new Notice(qiaomuReaderTranslate("this-is-an-early-version-of-the-feature-translation-uses-the-fre"), 1e4);
      }));
    new Setting(host)
      .setName(qiaomuReaderTranslate("translate-into"))
      .setDesc(qiaomuReaderTranslate("the-language-to-translate-the-selected-fragment-into-the-source"))
      .addDropdown((dropdown) => {
        TRANSLATION_LANGUAGE_CHOICES.forEach(([value, label]) => dropdown.addOption(value, qiaomuReaderTranslate(label)));
        dropdown.setValue(this.plugin.settings.translateTo || "zh-CN")
          .onChange(async (v) => { this.plugin.settings.translateTo = v; await this.plugin.saveAll(); });
      });
  }
  _unreadableStoreCard(c, detail) {
    const tx = (s) => qiaomuReaderTranslate(s);
    const card = c.createDiv({ cls: "qiaomu-reader-store-recovery" });
    const title = card.createDiv({ cls: "qiaomu-reader-store-recovery-title" });
    const mark = title.createSpan({ cls: "qiaomu-reader-store-recovery-icon" });
    setIcon(mark, "triangle-alert");
    title.createSpan({ text: tx("the-0-file-cannot-be-read", detail.label) });
    card.createDiv({ cls: "qiaomu-reader-store-recovery-copy", text: tx("to-avoid-overwriting-recoverable-data-the-plugin-has-paused-writ") });
    const fileLine = card.createDiv({ cls: "qiaomu-reader-store-recovery-path" });
    fileLine.createSpan({ text: tx("file") });
    fileLine.createEl("code", { text: detail.path });
    if (detail.backupPath) {
      const backupLine = card.createDiv({ cls: "qiaomu-reader-store-recovery-path" });
      backupLine.createSpan({ text: tx("preserved-copy-of-the-original-content") });
      backupLine.createEl("code", { text: detail.backupPath });
    } else if (detail.recoveryHint) {
      const hintLine = card.createDiv({ cls: "qiaomu-reader-store-recovery-path" });
      hintLine.createSpan({ text: tx("check-recent-rescue-backups") });
      hintLine.createEl("code", { text: detail.recoveryHint });
    }
    const actions = card.createDiv({ cls: "qiaomu-reader-store-recovery-actions" });
    const reveal = actions.createEl("button", { text: tx("show-in-file-list") });
    reveal.addEventListener("click", () => {
      const target = this.app.vault.getAbstractFileByPath(detail.path);
      const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
      if (!(target && explorer)) {
        new Notice(tx("the-file-list-could-not-be-opened-find-the-file-manually-using-t"));
        return;
      }
      this.app.workspace.revealLeaf(explorer);
      const treeView = explorer.view;
      if (treeView && typeof treeView.revealInFolder === "function") treeView.revealInFolder(target);
    });
    const retry = actions.createEl("button", { cls: "mod-cta", text: tx("check-again") });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.setText(tx("checking-2"));
      const recovered = await this.plugin.retryUnreadableStore(detail.path);
      if (recovered) {
        new Notice(tx("the-data-file-is-readable-again-automatic-saving-has-resumed")); this._redraw();
        return;
      }
      retry.disabled = false;
      retry.setText(tx("check-again"));
      new Notice(tx("the-file-is-still-unreadable-the-plugin-will-keep-writes-paused"), 8000);
    });
  }
  _tabData(c) {
    const tx = (s) => qiaomuReaderTranslate(s);
    const settings = this.plugin.settings;
    const persist = async (key, v, after) => {
      this.plugin.settings[key] = v; await this.plugin.saveAll();
      if (after) after(v);
    };
    // data files live in the vault too, so the local store is refreshed first
    const persistViaDisk = async (key, v) => {
      this.plugin.settings[key] = v; await this.plugin._saveLocalData(); await this.plugin.saveAll();
    };
    const choose = (setting, options, current, apply) => setting.addDropdown((d) => {
      for (const [value, label] of options) d.addOption(value, label);
      d.setValue(current).onChange(apply);
    });
    this._sectionIntro(c, tx("data"), tx("books-progress-and-sync-live-here-usually-there-is-nothing-to-ch"));
    new Setting(c)
      .setName(tx("starter-books"))
      .setDesc(tx("starter-books-description"))
      .addButton(button => button.setButtonText(tx("add-starter-books")).onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.ensureStarterBooks(true);
          new Notice(tx("starter-books-added"));
        } catch { new Notice(tx("starter-books-failed")); }
        finally { button.setDisabled(false); }
      }));
    const unreadableStores = [...this.plugin._unreadableStores.values()];
    if (unreadableStores.length) {
      c.createEl("h3", { text: tx("needs-attention") });
      for (const detail of unreadableStores) this._unreadableStoreCard(c, detail);
    }
    addFolderPathControl(new Setting(c).setName(tx("books-folder")).setDesc(tx("empty-the-whole-vault")), this.app, {
      value: settings.booksFolder,
      label: tx("books-folder"),
      placeholder: "0. Files/3. PDF-files",
      commit: (v) => persistViaDisk("booksFolder", v),
    });
    const dataRoot = c;
    c = this._settingsDisclosure(dataRoot, "ai-storage-sync-options");
    addFolderPathControl(new Setting(c)
      .setName(tx("reading-data-folder"))
      .setDesc(tx("where-reading-progress-highlights-and-rescue-backups-are-kept-re")), this.app, {
      value: settings.dataFolder,
      label: tx("reading-data-folder"),
      placeholder: tx("next-to-the-books"),
      commit: (v) => persistViaDisk("dataFolder", v),
    });

    c.createEl("h3", { text: tx("syncing-across-devices") });
    const syncInfo = c.createEl("div", { cls: "qiaomu-reader-set-note" });
    const storePaths = [this.plugin._progressFilePath(), this.plugin._highlightsFilePath()];
    const addLine = (parts) => {
      const row = syncInfo.createDiv();
      for (const item of parts) {
        if (typeof item === "string") row.appendText(item);
        else row.createEl(item.tag, { text: item.text });
      }
      return row;
    };
    addLine([
      { tag: "span", text: tx("reading-progress-and-highlights-are-stored") },
      { tag: "b", text: tx("as-files-right-in-the-vault") },
      tx("next-to-the-books-2"),
    ]);
    for (const p of storePaths) addLine(["• ", { tag: "code", text: p }]);
    addLine([
      tx("so-they-travel-between-pc-and-phone-by"),
      { tag: "b", text: tx("any") },
      tx("means-you-use-to-sync-the-vault-itself-obsidian-sync-icloud-goog"),
    ]);
    addLine([
      tx("appearance-settings-and-the-cover-cache-are-local-in-the-plugin-2"),
      { tag: "code", text: "data.json" }, tx("and-are-intentionally-not-synced"),
    ]);
    choose(new Setting(c)
      .setName(tx("sync-method"))
      .setDesc(tx("tells-the-plugin-how-eagerly-to-re-read-the-progress-files-when")), [
      ["auto", tx("auto-recommended")],
      ["obsidian", "Obsidian Sync"],
      ["remotely", "Remotely Save / self-hosted"],
      ["cloud", tx("icloud-google-drive-folder")],
      ["none", tx("no-syncing")],
    ], settings.syncMode || "auto", (v) => persist("syncMode", v, () => this._redraw()));
    if (settings.syncMode === "cloud") {
      c.createEl("div", { cls: "qiaomu-reader-set-note", text: tx("cloud-folders-icloud-drive-update-with-a-delay-if-you-only-read") });
    }

    c = this._settingsDisclosure(dataRoot, "cleanup");
    const thumbSet = new Setting(c).setName(tx("cover-cache")).setDesc(tx("saved-0-2", Object.keys(this.plugin.thumbCache).length)).addButton((b) => b.setButtonText(tx("clear")).onClick(async () => {
      this.plugin.thumbCache = {}; await this.plugin._saveThumbCache();
      new Notice(tx("cache-cleared"));
      thumbSet.setDesc(tx("saved-0-2", 0));
    }));
    const progSet = new Setting(c).setName(tx("progress")).setDesc(tx("books-0", Object.keys(this.plugin.progress).length)).addButton((b) => b.setButtonText(tx("clear")).setWarning().onClick(async () => {
      this.plugin.progress = {}; await this.plugin.saveAll();
      new Notice(tx("progress-cleared"));
      progSet.setDesc(tx("books-0", 0));
    }));
    const hlTotal = Object.values(this.plugin.highlights)
      .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    const hlSet = new Setting(c).setName(tx("highlights")).setDesc(tx("total-0", hlTotal)).addButton((b) => b.setButtonText(tx("clear-all-2")).setWarning().onClick(async () => {
      this.plugin.highlights = {}; await this.plugin._saveHighlightsToVault();
      new Notice(tx("highlights-cleared"));
      hlSet.setDesc(tx("total-0", 0));
    }));
    const memoryKeys = ["bookNoteLinks", "bookNotePrompted", "bookTags", "bookTemplates"];
    const memoryDesc = (count) => tx("books-0-linked-notes-categories-per-book-templates-and-the-alrea", count);
    const usedBookMemory = () => {
      const prefs = this.plugin.settings;
      return new Set(memoryKeys.flatMap((key) => Object.keys(prefs[key] || {}))).size;
    };
    const memorySet = new Setting(c)
      .setName(tx("what-the-reader-remembers"))
      .setDesc(memoryDesc(usedBookMemory()));
    let primed = false;
    memorySet.addButton((b) => b.setButtonText(tx("forget-all-books")).setWarning().onClick(async () => {
      if (!primed) {
        primed = true;
        b.setButtonText(tx("really-forget"));
        window.setTimeout(() => { if (primed) { primed = false; b.setButtonText(tx("forget-all-books")); } }, 4e3);
        return;
      }
      primed = false;
      b.setButtonText(tx("forget-all-books"));
      const prefs = this.plugin.settings;
      for (const key of memoryKeys) prefs[key] = {}; await this.plugin.saveAll();
      new Notice(tx("done-the-reader-will-ask-about-a-note-again-when-you-open-a-book"));
      memorySet.setDesc(memoryDesc(0));
    }));
  }
  _tabAbout(c) {
    this._sectionIntro(c, qiaomuReaderTranslate("about"), qiaomuReaderTranslate("help-updates-and-contact-information"));
    new Setting(c)
      .setName(qiaomuReaderTranslate("feedback-and-bugs"))
      .setDesc(qiaomuReaderTranslate("report-a-bug-or-suggest-a-feature-and-we-will-follow-up-on-githu"))
      .addButton((b) => b.setCta().setButtonText(qiaomuReaderTranslate("open-github-issues")).onClick(() => {
        window.open("https://github.com/newcoder/uvreader/issues", "_blank");
      }));
    new Setting(c)
      .setName(qiaomuReaderTranslate("plugin-guide"))
      .setDesc(qiaomuReaderTranslate("21-screens-of-explanation-formats-highlights-the-book-note-synci"))
      .addButton((b) => b.setButtonText(qiaomuReaderTranslate("open-the-guide")).onClick(() => new OnboardingModal(this.app, this.plugin).open()));
    new Setting(c)
      .setName(qiaomuReaderTranslate("what-s-new"))
      .setDesc(qiaomuReaderTranslate("changes-from-recent-versions"))
      .addButton((b) => b.setButtonText(qiaomuReaderTranslate("show")).onClick(() => {
        new WhatsNewModal(this.app, this.plugin, WHATS_NEW.slice(0, 4)).open();
      }));
    const about = c.createEl("div", { cls: "qiaomu-reader-set-note" });
    about.createEl("b", { text: "UV Reader" });
    about.appendText(qiaomuReaderTranslate("version-0-adapted-and-maintained-by-qiaomu", this.plugin.manifest.version));
    about.createEl("br");
    about.createEl("a", { text: "qiaomu.ai", href: "https://qiaomu.ai" });
    about.appendText(" · ");
    about.createEl("a", { text: "X @vista8", href: "https://x.com/vista8" });
    about.appendText(" · ");
    about.createEl("a", { text: "GitHub @joeseesun", href: "https://github.com/joeseesun" });
  }
};
}
