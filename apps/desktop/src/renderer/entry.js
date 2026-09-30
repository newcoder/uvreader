import { configureHost, createApp, installDomExtensions } from "obsidian";
import { marked } from "marked";

import QiaomuBookReader from "../../../../packages/reader/src/main.js";
import { READER_THEMES, migrateReaderTheme } from "../../../../packages/reader/src/reader-themes.js";
import { isBookFile } from "../shared/books.js";
import { iconResolver } from "./icons.js";
import { renderMathIn } from "./math.js";
import { createHomeView, createNoteView, createSettingsView, createTocView } from "./views.js";

const bridge = window.qbrDesktop || { paths: {} };
const READER_VIEW = "qiaomu-reader";
const LIBRARY_VIEW = "qiaomu-reader-library";
const HOME_VIEW = "qbr-home";
const NOTE_VIEW = "qbr-note";
const TOC_VIEW = "qbr-toc";
const SETTINGS_VIEW = "qbr-settings";

function renderMarkdown(markdown) {
  const template = document.createElement("template");
  template.innerHTML = marked.parse(String(markdown || ""));
  template.content.querySelectorAll("script,iframe,object,embed,link,style").forEach((element) => element.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  });
  return template.innerHTML;
}

function setOpening(visible, name = "") {
  const opening = document.getElementById("opening");
  if (!opening) return;
  const label = opening.querySelector("[data-name]");
  if (label) label.textContent = name;
  opening.hidden = !visible;
}

function showError(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = String(message || "发生未知错误");
  toast.hidden = false;
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => {
    toast.hidden = true;
  }, 6000);
}

// The AI sidebar, home page and settings should use the same palette as the
// book page instead of the shell's default dark theme. Reading themes that
// simply reference the host variables (auto) are left to the shell defaults.
const READING_THEME_MAP = [
  ["--background-primary", "--qiaomu-reader-bg"],
  ["--background-primary-alt", "--qiaomu-reader-ui"],
  ["--background-secondary", "--qiaomu-reader-ui"],
  ["--background-modifier-border", "--qiaomu-reader-border"],
  ["--text-normal", "--qiaomu-reader-text"],
  ["--text-muted", "--qiaomu-reader-muted"],
  ["--text-faint", "--qiaomu-reader-muted"],
  ["--interactive-accent", "--qiaomu-reader-accent"],
  ["--interactive-accent-hover", "--qiaomu-reader-accent"],
  ["--text-accent", "--qiaomu-reader-accent"],
  ["--code-background", "--qiaomu-reader-ui"],
];

function colorLuminance(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || "").trim());
  if (!match) return null;
  const number = Number.parseInt(match[1], 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function boot() {
  installDomExtensions(window);
  window.activeDocument = document;
  window.activeWindow = window;
  window.addEventListener("error", (event) => {
    console.error("UV Reader desktop error", event.error?.stack || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("UV Reader desktop rejection", event.reason?.stack || String(event.reason));
  });
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(...args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : arg)));
  }

  const requireFn = typeof window.require === "function" ? window.require.bind(window) : null;
  configureHost({
    fs: requireFn ? requireFn("fs") : null,
    path: requireFn ? requireFn("path") : null,
    os: requireFn ? requireFn("os") : null,
    vaultRoot: bridge.paths?.vaultRoot || "",
    dataRoot: bridge.paths?.dataRoot || "",
    vaultName: "UV Reader",
    fetchImpl: (url, options) => window.fetch(url, options),
    iconResolver,
    renderMarkdown: (markdown, element) => {
      element.innerHTML = renderMarkdown(markdown);
      renderMathIn(element);
    },
    secrets: bridge.secrets || null,
  });

  const app = createApp({
    workspaceEl: document.getElementById("workspace"),
    dataDefaults: {
      onboarded: true,
      language: "zh",
      lastSeenVersion: __QBR_VERSION__,
      bookNotesFolder: "notes",
      dataFolder: "plugin",
    },
  });
  const plugin = new QiaomuBookReader(app, {
    id: "qiaomu-reader",
    name: "UV Reader",
    version: __QBR_VERSION__,
    dir: "plugin",
  });
  await plugin.onload();
  app.workspace.markLayoutReady();

  window.__qbrApp = app;
  window.__qbrPlugin = plugin;

  // The product is 纽扣 in the Chinese UI and UV Reader everywhere else; the
  // toolbar brand and the window titles follow the interface language.
  const displayName = () => (String(plugin.settings?.language || "zh").toLowerCase().startsWith("zh") ? "纽扣" : "UV Reader");
  // Reading theme → shell palette. When a reader is open its inline variables
  // win (they carry the live eink toggle); otherwise the saved settings paint
  // home/library/settings directly, so a theme change applies without opening
  // a book and survives a restart.
  const THEME_VAR_KEY = {
    "--qiaomu-reader-bg": "bg",
    "--qiaomu-reader-ui": "ui",
    "--qiaomu-reader-text": "text",
    "--qiaomu-reader-accent": "accent",
    "--qiaomu-reader-border": "border",
    "--qiaomu-reader-muted": "muted",
  };
  const themeFromSettings = () => {
    const settings = plugin.settings || {};
    if (settings.einkMode === true) return READER_THEMES.eink;
    return READER_THEMES[migrateReaderTheme(settings.theme)] || READER_THEMES.auto;
  };
  const brandEl = document.querySelector(".qbr-nav-brand");
  function applyBrand() {
    if (brandEl) brandEl.textContent = displayName();
    syncWindowTitle();
  }

  async function waitForReaderReady(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const view = app.workspace.getLeavesOfType(READER_VIEW)[0]?.view;
      if (view) {
        const engineReady = Boolean(view.engine?.currentLocation?.());
        const pagerReady = Boolean(view.pager?.total > 0);
        if (engineReady || pagerReady) {
          return { ready: true, detail: `engine=${engineReady} pages=${view.pager?.total || 0}` };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ready: false, detail: "reader did not become ready" };
  }

  async function openBook(filePath) {
    if (!filePath) return false;
    if (!isBookFile(filePath)) {
      showError(`不支持的格式：${filePath}\n支持：epub、pdf、fb2、fbz、mobi、azw、azw3、cbz`);
      return false;
    }
    const normalized = String(filePath).replace(/\\/g, "/");
    const file = app.vault.getAbstractFileByPath(normalized);
    if (!file) {
      showError(`文件不存在：${filePath}`);
      return false;
    }
    const name = normalized.split("/").pop() || normalized;
    setOpening(true, name);
    try {
      await plugin.openFile(file);
    } catch (error) {
      setOpening(false);
      showError(`无法打开：${filePath}\n${error?.message || error}`);
      console.error("UV Reader: could not open the book", error);
      return false;
    }
    const state = await waitForReaderReady();
    setOpening(false);
    if (!state.ready) {
      showError(`打开超时：${name}\n${state.detail}`);
      return false;
    }
    watchReadingTheme();
    return true;
  }

  async function pickAndOpen() {
    const filePath = await bridge.openBookDialog?.();
    if (filePath) await openBook(filePath);
  }

  app.viewFactories.set(HOME_VIEW, (leaf) => createHomeView(leaf, {
    app,
    plugin,
    onOpenBook: (filePath) => void openBook(filePath),
    onOpenLibrary: () => void showRoute("library"),
    onOpenFileDialog: () => void pickAndOpen(),
  }));
  app.viewFactories.set(NOTE_VIEW, (leaf) => createNoteView(leaf, {
    app,
    renderMarkdown,
    openPath: bridge.openPath,
  }));
  app.viewFactories.set(SETTINGS_VIEW, (leaf) => createSettingsView(leaf, { plugin }));
  app.viewFactories.set(TOC_VIEW, (leaf) => createTocView(leaf, { app }));

  async function showOwnView(type) {
    const existing = app.workspace.getLeavesOfType(type);
    if (existing.length) {
      app.workspace.setActiveLeaf(existing[0]);
      return existing[0].view;
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type });
    return leaf.view;
  }

  async function showRoute(route) {
    // The AI companion is part of the reading session; any route away from the
    // reader closes its sidebar without touching the saved preference.
    plugin.closeReadingCompanion?.();
    if (route === "library") {
      await plugin.openLibrary();
      return;
    }
    if (route === "settings") {
      await showOwnView(SETTINGS_VIEW);
      return;
    }
    await showOwnView(HOME_VIEW);
  }

  const navButtons = [...document.querySelectorAll("[data-route]")];
  for (const button of navButtons) {
    button.addEventListener("click", () => void showRoute(button.dataset.route));
  }

  let observedReaderEl = null;
  let themeObserver = null;
  let observedTitleEl = null;
  let titleObserver = null;
  function syncReadingTheme() {
    const reader = app.workspace.getLeavesOfType(READER_VIEW)[0]?.view;
    const source = reader?.contentEl;
    const fromSettings = source ? null : themeFromSettings();
    const readVar = (variable) => (source
      ? source.style.getPropertyValue(variable)
      : String(fromSettings?.[THEME_VAR_KEY[variable]] || ""));
    // A value that is empty (reader not styled yet) or a var() reference
    // (theme "auto") means "no override": drop what an earlier theme set on
    // the shell instead of leaving stale colours behind.
    const body = document.body.style;
    const applyVar = (target, value) => {
      if (value && !value.startsWith("var(")) body.setProperty(target, value);
      else if (!source) body.removeProperty(target);
    };
    for (const [target, variable] of READING_THEME_MAP) applyVar(target, readVar(variable));
    const bg = readVar("--qiaomu-reader-bg");
    const ui = readVar("--qiaomu-reader-ui");
    const text = readVar("--qiaomu-reader-text");
    const accent = readVar("--qiaomu-reader-accent");
    const resolved = (value) => Boolean(value) && !value.startsWith("var(");
    if (resolved(ui)) {
      body.setProperty("--interactive-normal", ui);
      body.setProperty("--background-modifier-form-field", ui);
    } else if (!source) {
      body.removeProperty("--interactive-normal");
      body.removeProperty("--background-modifier-form-field");
    }
    if (resolved(ui) && resolved(text)) {
      body.setProperty("--interactive-hover", `color-mix(in srgb, ${text} 10%, ${ui})`);
      body.setProperty("--background-modifier-hover", `color-mix(in srgb, ${text} 8%, transparent)`);
      body.setProperty("--background-modifier-active-hover", `color-mix(in srgb, ${text} 14%, transparent)`);
    } else if (!source) {
      body.removeProperty("--interactive-hover");
      body.removeProperty("--background-modifier-hover");
      body.removeProperty("--background-modifier-active-hover");
    }
    if (resolved(accent)) body.setProperty("--selection-color", `color-mix(in srgb, ${accent} 30%, transparent)`);
    else if (!source) body.removeProperty("--selection-color");
    const accentLuminance = colorLuminance(resolved(accent) ? accent : "");
    if (accentLuminance !== null) {
      body.setProperty("--text-on-accent", accentLuminance > 0.55 ? (bg || "#111111") : "#ffffff");
    } else if (!source) {
      body.removeProperty("--text-on-accent");
    }
    const luminance = colorLuminance(resolved(bg) ? bg : "");
    if (luminance !== null) body.colorScheme = luminance > 0.55 ? "light" : "dark";
    else if (!source) body.removeProperty("color-scheme");
  }
  function watchReadingTheme() {
    const reader = app.workspace.getLeavesOfType(READER_VIEW)[0]?.view;
    const element = reader?.contentEl;
    if (element && element !== observedReaderEl) {
      themeObserver?.disconnect();
      observedReaderEl = element;
      themeObserver = new MutationObserver(syncReadingTheme);
      themeObserver.observe(element, { attributes: true, attributeFilter: ["style"] });
    }
    // The reader swaps books inside the same leaf, which emits no workspace
    // event; the toolbar title text is the reliable signal for that.
    const titleEl = reader?.titleEl;
    if (titleEl && titleEl !== observedTitleEl) {
      titleObserver?.disconnect();
      observedTitleEl = titleEl;
      titleObserver = new MutationObserver(() => syncWindowTitle());
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    syncReadingTheme();
    applyBrand();
  }
  function syncWindowTitle() {
    const reader = app.workspace.getLeavesOfType(READER_VIEW)[0]?.view;
    const active = app.workspace.activeLeaf?.view;
    const reading = active?.getViewType?.() === READER_VIEW;
    const name = reading ? (active?.file?.basename || reader?.file?.basename || "") : "";
    document.title = name ? `${name} — ${displayName()}` : displayName();
  }
  app.workspace.on("active-leaf-change", watchReadingTheme);
  app.workspace.on("layout-change", watchReadingTheme);
  applyBrand();
  syncReadingTheme();

  function syncChrome() {
    const type = app.workspace.activeLeaf?.view?.getViewType?.() || "";
    document.body.classList.toggle("qbr-reading", type === READER_VIEW);
    const route = type === LIBRARY_VIEW ? "library"
      : type === SETTINGS_VIEW ? "settings"
        : type === HOME_VIEW ? "home" : "";
    for (const button of navButtons) button.classList.toggle("is-active", button.dataset.route === route);
  }
  app.workspace.on("active-leaf-change", syncChrome);
  app.workspace.on("layout-change", syncChrome);

  app.qbrDesktopOpenNote = async (note) => {
    const leaf = app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: NOTE_VIEW, state: { path: note.path } });
    return leaf;
  };

  app.qbrDesktopOpenToc = async (readerView) => {
    const existing = app.workspace.getLeavesOfType(TOC_VIEW)[0];
    if (existing && !app.workspace.leftSplit.collapsed) {
      existing.detach();
      return;
    }
    const leaf = app.workspace.getLeftLeaf();
    await leaf.setViewState({ type: TOC_VIEW, state: { path: readerView?.file?.path || "" } });
  };

  bridge.onOpenBook?.((filePath) => {
    void openBook(filePath);
  });

  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    const filePath = file ? (bridge.pathForFile ? bridge.pathForFile(file) : file.path) : "";
    if (filePath) void openBook(filePath);
  });

  const launch = bridge.getLaunchFile ? await bridge.getLaunchFile() : "";
  if (launch) {
    const opened = await openBook(launch);
    if (opened) {
      await plugin.saveAll?.();
      await Promise.allSettled([
        plugin._progressQueue?.drain?.(),
        plugin._localDataQueue?.drain?.(),
        plugin._hlChain,
        plugin._thumbSaveChain,
      ].filter(Boolean));
    }
    await bridge.reportBoot?.({ ok: opened, file: launch, detail: opened ? "ready" : "open failed" });
  } else {
    await showRoute("home");
    await bridge.reportBoot?.({ ok: true, detail: "home" });
  }
}

boot().catch(async (error) => {
  console.error("UV Reader desktop failed to start", error);
  showError(error?.stack || String(error));
  await bridge.reportBoot?.({ ok: false, error: String(error?.stack || error) });
});
