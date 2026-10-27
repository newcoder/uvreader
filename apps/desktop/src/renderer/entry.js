import { Notice, configureHost, createApp, installDomExtensions } from "obsidian";
import { marked } from "marked";

import QiaomuBookReader from "../../../../packages/reader/src/main.js";
import { READER_THEMES, migrateReaderTheme } from "../../../../packages/reader/src/reader-themes.js";
import { setIconProvider } from "../../../../packages/reader/src/reader-icons.js";
import { isBookFile } from "../shared/books.js";
import { iconResolver, rasterIconMarkup } from "./icons.js";
import { protectLatexDelimiters, renderMathIn, restoreLatexDelimiters } from "./math.js";
import { isBlockedHref, sanitizeHtml } from "./sanitize.js";
import { createHomeView, createNoteView, createSettingsView, createTocView, createWorkshopView } from "./views.js";
import { createQuizView } from "./quiz-view.js";
import { createQuizListView } from "./quiz-list-view.js";
import { openWorkshopCapabilitiesModal } from "./workshop-capabilities-view.js";
import { workshopCapabilitiesFor } from "../shared/workshop-capabilities.js";

const bridge = window.qbrDesktop || { paths: {} };
const READER_VIEW = "qiaomu-reader";
const LIBRARY_VIEW = "qiaomu-reader-library";
const HOME_VIEW = "qbr-home";
const NOTE_VIEW = "qbr-note";
const TOC_VIEW = "qbr-toc";
const SETTINGS_VIEW = "qbr-settings";
const WORKSHOP_VIEW = "qbr-workshop";
const QUIZ_VIEW = "qbr-quiz";
const QUIZ_LIST_VIEW = "qbr-quiz-list";

function renderMarkdown(markdown) {
  const protectedSource = protectLatexDelimiters(markdown);
  const html = sanitizeHtml(document, marked.parse(String(protectedSource || "")));
  return restoreLatexDelimiters(html);
}

function setOpening(visible, name = "", hint = "正在打开…") {
  const opening = document.getElementById("opening");
  if (!opening) return;
  const label = opening.querySelector("[data-name]");
  if (label) label.textContent = name;
  const hintEl = opening.querySelector(".qbr-opening-hint");
  if (hintEl) hintEl.textContent = hint;
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
  // The reader's toolbar icons come from the sliced sheet where a match
  // exists (raster masks, currentColor); everything else keeps its inline SVG.
  setIconProvider(rasterIconMarkup);
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

  // Defense in depth for the privileged renderer: a javascript: link that
  // bypassed the markdown sanitizer must never run.
  document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor) return;
    if (isBlockedHref(anchor.getAttribute("href"))) event.preventDefault();
  });

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

  // 本地 MinerU 常驻服务:配了地址/程序就随应用一起拉起(失败不影响阅读;面板里可关)。
  // 冒烟测试不拉服务(免得起 GPU 模型拖慢启动自检)。
  // 带上 sidecar python / 目录:找不到程序时会按它们的同目录 / .venv 布局自动找 mineru-kit。
  const mineruSettings = () => ({
    exe: String(plugin.settings?.mineruLocalExe || ""),
    url: String(plugin.settings?.mineruLocalUrl || ""),
    autoStart: plugin.settings?.mineruLocalAutoStart !== false,
    ocrPython: String(plugin.settings?.ocrPython || ""),
    ocrSidecarDir: String(plugin.settings?.ocrSidecarDir || ""),
  });
  if (!bridge.smoke) {
    void bridge.mineru?.ensure?.(mineruSettings())
      .then((result) => {
        // 控制台只放 ASCII:Windows 终端默认 GBK,中文日志会显示成乱码;
        // 中文提示在书坊面板的状态行里(那里渲染正常)。
        const tried = Array.isArray(result?.tried) && result.tried.length ? result.tried.join(", ") : "mineru-kit";
        if (result?.status === "running") {
          console.log(`[qbr] local MinerU running ${result.url}${result.version ? ` v${result.version}` : ""} (${result.managed ? "started by app" : "already running"})`);
        } else if (result?.status === "missing") {
          console.log(`[qbr] local MinerU missing: mineru-kit not found; tried: ${tried}`);
        } else {
          console.log(`[qbr] local MinerU ${result?.status || "unknown"} ${result?.url || ""} ${String(result?.tail || "").trim()}`.trim());
        }
      })
      .catch((error) => console.warn("[qbr] local MinerU failed", String(error?.message || error)));
  }

  // 书坊引擎:独立服务,应用重启不会自动带起它 —— 按设置自动拉起(没装就什么都不做)。
  // 只拉应用自己装/起的引擎(有 pid 记录),手工起的那个不去碰。
  if (!bridge.smoke) {
    void bridge.engine?.autoStart?.({
      engineUrl: String(plugin.settings?.engineUrl || ""),
      engineToken: String(plugin.settings?.engineToken || ""),
      // 书坊关掉时别去拉引擎(书坊页都没有,起来也是白占内存)。
      engineAutoStart: plugin.settings?.workshopEnabled !== false && plugin.settings?.engineAutoStart !== false,
    })
      .then((result) => {
        if (result?.skipped === "disabled" || result?.skipped === "not-installed") return;
        if (result?.skipped === "running") return;
        if (result?.ok) {
          console.log(`[qbr] workshop engine running ${result.engineUrl} v${result.version || "?"}`);
        } else if (result?.skipped === "failed") {
          console.log(`[qbr] workshop engine not started: ${String(result.error || "").slice(0, 120)}`);
        }
      })
      .catch((error) => console.warn("[qbr] workshop engine auto-start failed", String(error?.message || error)));
  }

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
      showError(`不支持的格式：${filePath}\n支持：epub、pdf、fb2、fbz、mobi、azw、azw3、cbz、png、jpg、jpeg、webp、gif、bmp`);
      return false;
    }
    const normalized = String(filePath).replace(/\\/g, "/");
    const name = normalized.split("/").pop() || normalized;
    const vaultRoot = String(bridge.paths?.vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const absolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//");
    let target = "";
    if (!absolute && app.vault.getAbstractFileByPath(normalized)) {
      // Home cards and recent lists hand over vault-relative paths. The book is
      // already in the library; opening it must not copy it again.
      target = normalized;
    } else if (vaultRoot && absolute && normalized.toLowerCase().startsWith(`${vaultRoot.toLowerCase()}/`)) {
      target = normalized.slice(vaultRoot.length + 1);
    }
    if (!target) {
      // A book opened from outside the library (home page, "open with",
      // dropped on the shell) is copied in first so it lives with the rest
      // and appears in the library, auto-tagged 导入.
      setOpening(true, name, "正在加入书库…");
      try {
        target = String(await plugin.importBookToLibrary?.(filePath) || "");
      } catch (error) {
        console.error("UV Reader: could not add the book to the library", error);
        target = "";
      }
      if (!target) {
        setOpening(false);
        showError(`无法加入书库：${filePath}`);
        return false;
      }
    }
    const file = app.vault.getAbstractFileByPath(target);
    if (!file) {
      setOpening(false);
      showError(`文件不存在：${filePath}`);
      return false;
    }
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

  function absoluteQuizPath(filePath) {
    const path = String(filePath || "").replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(path) || path.startsWith("/")) return path;
    const root = String(bridge.paths?.vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return root ? `${root}/${path.replace(/^\/+/, "")}` : path;
  }

  async function openQuiz(filePath) {
    if (!filePath) return false;
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: QUIZ_VIEW,
      state: { path: absoluteQuizPath(filePath) },
      active: true,
    });
    await app.workspace.revealLeaf(leaf);
    return true;
  }
  window.qbrOpenQuiz = (filePath) => void openQuiz(filePath);

  async function openQuizList() {
    const existing = app.workspace.getLeavesOfType(QUIZ_LIST_VIEW)[0];
    if (existing) {
      try { await existing.view?.render?.(true); } catch { /* keep the existing list usable */ }
      await app.workspace.revealLeaf(existing);
      return true;
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: QUIZ_LIST_VIEW, active: true });
    await app.workspace.revealLeaf(leaf);
    return true;
  }
  window.qbrOpenQuizList = () => openQuizList();

  async function pickAndOpen() {
    const filePath = await bridge.openBookDialog?.();
    if (filePath) await openBook(filePath);
  }

  app.viewFactories.set(HOME_VIEW, (leaf) => createHomeView(leaf, {
    app,
    plugin,
    onOpenBook: (filePath) => void openBook(filePath),
    onOpenFileDialog: () => void pickAndOpen(),
  }));
  app.viewFactories.set(NOTE_VIEW, (leaf) => createNoteView(leaf, {
    app,
    renderMarkdown,
    openPath: bridge.openPath,
  }));
  app.viewFactories.set(SETTINGS_VIEW, (leaf) => createSettingsView(leaf, { plugin }));
  app.viewFactories.set(TOC_VIEW, (leaf) => createTocView(leaf, { app }));
  app.viewFactories.set(WORKSHOP_VIEW, (leaf) => createWorkshopView(leaf, { app, plugin }));
  app.viewFactories.set(QUIZ_VIEW, (leaf) => createQuizView(leaf, { app, plugin }));
  app.viewFactories.set(QUIZ_LIST_VIEW, (leaf) => createQuizListView(leaf, { app, plugin }));

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

  async function openWorkshopCapability(capability) {
    if (!capability) return false;
    if (capability.action === "ai-prompt" && typeof plugin.primeAiPrompt === "function") {
      return plugin.primeAiPrompt(capability.prompt || capability.title || "");
    }
    if (plugin.settings?.workshopEnabled === false) return false;
    const view = await showOwnView(WORKSHOP_VIEW);
    if (typeof view?.openCapability === "function") view.openCapability(capability);
    else view?.selectTool?.(capability.tool || "tasks");
    return true;
  }

  // Shared entry points for the AI sidebar and native notifications. They only
  // navigate and preselect an outcome; starting work still happens in workshop.
  window.qbrOpenWorkshop = async (target = "tasks", options = {}) => {
    if (plugin.settings?.workshopEnabled === false) return false;
    const view = await showOwnView(WORKSHOP_VIEW);
    if (options?.taskId && typeof view?.focusTask === "function") view.focusTask(String(options.taskId));
    else if (target && typeof target === "object") await openWorkshopCapability(target);
    else view?.selectTool?.(String(target || "tasks"));
    return true;
  };

  plugin.workshopCapabilities = ({ extension = "", readerView = null } = {}) => workshopCapabilitiesFor({ extension, readerView });
  plugin.openWorkshopCapabilities = ({ extension = "", readerView = null, inAi = false } = {}) => {
    if (!inAi && plugin.settings?.workshopEnabled === false) return;
    openWorkshopCapabilitiesModal(app, {
      extension,
      readerView,
      actionLabel: inAi ? "问 AI" : "去书坊",
      lead: inAi
        ? "点一下，我会直接在对话里和你确认参数；不会自动开始，也不会跳转页面。"
        : "这些操作会用于当前文档，不会自动开始；选择后会先确认参数。",
      onPick: (capability) => {
        if (capability.action === "export-toc" && readerView
          && (typeof readerView.exportNavigationCopy === "function" || typeof readerView.exportEpubWithToc === "function")) {
          const exportAction = readerView.exportNavigationCopy || readerView.exportEpubWithToc;
          void exportAction.call(readerView);
        } else if (inAi) {
          const prompt = capability.prompt || `我想${capability.title}。`;
          void plugin.askAiPrompt?.(prompt);
        } else {
          void openWorkshopCapability(capability);
        }
      },
    });
  };
  plugin.openWorkshopCapability = (capability) => openWorkshopCapability(capability);

  bridge.workshop?.onOpenTask?.((taskId) => {
    void window.qbrOpenWorkshop("tasks", { taskId });
  });
  const workshopStartedAt = Date.now();
  const finishedTaskIds = new Set();
  const announceFinishedTask = (task = {}) => {
    const id = String(task.id || "");
    if (id && finishedTaskIds.has(id)) return;
    if (id) finishedTaskIds.add(id);
    // Keep AI completions for the current app session even when the card was
    // placed successfully. Re-rendering a sidebar rebuilds its DOM and would
    // otherwise drop the only copy of the card.
    if (task.origin === "assistant") {
      plugin._aiTaskCompletions ||= [];
      if (task.id && !plugin._aiTaskCompletions.some((item) => item.id === task.id)) {
        plugin._aiTaskCompletions.push(task);
        if (plugin._aiTaskCompletions.length > 10) plugin._aiTaskCompletions.splice(0, plugin._aiTaskCompletions.length - 10);
      }
    }
    try {
      for (const leaf of app.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat")) {
        const aiView = leaf?.view;
        if (task.origin === "assistant" && typeof aiView?.showWorkshopTaskFinished === "function") {
          aiView.showWorkshopTaskFinished(task);
        }
      }
    } catch (error) {
      console.warn("[qbr] could not place the task card in the AI conversation", error);
    }
    const output = String(task.output || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
    const message = task.status === "done"
      ? `处理完成：${task.title || "任务"}${output ? `（${output}）` : ""}`
      : `处理未完成：${task.title || "任务"}，可在任务里查看原因。`;
    new Notice(message, 8000);
  };
  bridge.workshop?.onFinished?.((task = {}) => announceFinishedTask(task));
  // Event delivery is the fast path, but a task that finishes while the
  // renderer is rebuilding (or after a reload) must not be silent. Poll the
  // queue as a deduplicated fallback; the 10s cadence keeps idle CPU/IO low.
  let workshopPolling = false;
  const pollWorkshop = async () => {
    if (workshopPolling || !bridge.workshop?.list) return;
    workshopPolling = true;
    try {
      const state = await bridge.workshop.list();
      for (const task of state?.tasks || []) {
        if (task.status !== "done" && task.status !== "failed") continue;
        // Also pick up a task that finished moments before a reload, so a
        // restart cannot turn a just-finished job into silence.
        if (Number(task.finishedAt) < workshopStartedAt - 15 * 60_000) continue;
        announceFinishedTask(task);
      }
    } catch {
      // the next tick retries
    } finally {
      workshopPolling = false;
    }
  };
  const flushAiTaskCompletions = () => {
    if (!plugin._aiTaskCompletions?.length) return;
    for (const leaf of app.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat")) {
      try { leaf?.view?._flushTaskCompletions?.(); } catch { /* view is rebuilding */ }
    }
  };
  void pollWorkshop();
  const workshopPoll = window.setInterval(() => {
    void pollWorkshop();
    // A mounted-but-hidden sidebar may not get a render event when it becomes
    // visible. Re-apply queued completions on the same fallback cadence.
    flushAiTaskCompletions();
  }, 10000);
  app.workspace.on("active-leaf-change", flushAiTaskCompletions);
  app.workspace.on("layout-change", flushAiTaskCompletions);
  window.addEventListener("focus", flushAiTaskCompletions);
  window.addEventListener("beforeunload", () => window.clearInterval(workshopPoll), { once: true });

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
    if (route === "workshop" && plugin.settings?.workshopEnabled !== false) {
      await showOwnView(WORKSHOP_VIEW);
      return;
    }
    await showOwnView(HOME_VIEW);
  }

  const navButtons = [...document.querySelectorAll("[data-route]")];
  for (const button of navButtons) {
    // The three page glyphs are the shell's inline icons: an open book with a
    // sparkle for 悦空间, three books for 书库 and a book with a wand for 书坊
    // (see docs/workshop.md §2.1); settings keeps the sliders glyph.
    const markup = iconResolver({ home: "reading-space", library: "books", workshop: "workshop", settings: "sliders" }[button.dataset.route] || "");
    if (markup) button.insertAdjacentHTML("afterbegin", markup);
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
  // The reader toolbar's toggles mirror what is open. The view syncs the AI
  // sidebar and highlights dock itself; the TOC button is ours (the TOC lives
  // in a workspace leaf on the left).
  function syncReaderToolButtons(reader = app.workspace.getLeavesOfType(READER_VIEW)[0]?.view) {
    reader?._syncToolButtons?.();
    if (!reader?.tocBtn) return;
    const open = Boolean(app.workspace.getLeavesOfType(TOC_VIEW)[0]) && app.workspace.leftSplit?.collapsed !== true;
    reader.tocBtn.toggleClass("qiaomu-reader-ibtn-on", open);
    reader.tocBtn.setAttribute("aria-expanded", String(open));
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
    syncWindowTitle();
    syncReaderToolButtons(reader);
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
  syncWindowTitle();
  syncReadingTheme();

  function syncChrome() {
    const type = app.workspace.activeLeaf?.view?.getViewType?.() || "";
    document.body.classList.toggle("qbr-reading", type === READER_VIEW);
    // 书坊入口可整体关闭(灰度/回退);默认开启。
    const workshopNav = navButtons.find((button) => button.dataset.route === "workshop");
    if (workshopNav) workshopNav.hidden = plugin.settings?.workshopEnabled === false;
    const route = type === LIBRARY_VIEW ? "library"
      : type === SETTINGS_VIEW ? "settings"
        : type === WORKSHOP_VIEW ? "workshop"
          : type === HOME_VIEW || type === QUIZ_LIST_VIEW ? "home" : "";
    for (const button of navButtons) button.classList.toggle("is-active", button.dataset.route === route);
  }
  app.workspace.on("active-leaf-change", syncChrome);
  app.workspace.on("layout-change", syncChrome);
  syncChrome();

  app.qbrDesktopOpenNote = async (note) => {
    const leaf = app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: NOTE_VIEW, state: { path: note.path } });
    return leaf;
  };

  app.qbrDesktopOpenToc = async (readerView) => {
    const existing = app.workspace.getLeavesOfType(TOC_VIEW)[0];
    if (existing && !app.workspace.leftSplit.collapsed) {
      existing.detach();
      syncReaderToolButtons(readerView);
      return;
    }
    const leaf = app.workspace.getLeftLeaf();
    await leaf.setViewState({ type: TOC_VIEW, state: { path: readerView?.file?.path || "" } });
    syncReaderToolButtons(readerView);
  };
  app.qbrDesktopCloseToc = (readerView) => {
    for (const leaf of app.workspace.getLeavesOfType(TOC_VIEW)) leaf.detach();
    syncReaderToolButtons(readerView);
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
