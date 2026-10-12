import { ItemView, Notice, setIcon } from "obsidian";

import { iconResolver } from "./icons.js";
import { DOCVORTEX_FORMATS, DOCVORTEX_INPUTS, EBOOK_TARGETS, IMAGE_BOOK_TARGETS, docvortexFormatExt } from "../shared/workshop-formats.js";
import { convertPath, uvtextPath } from "../shared/workshop-names.js";

const BOOK_EXTENSIONS = ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "cbz", "pdf"];

function percentOf(plugin, path) {
  const entry = plugin.progress?.[path];
  const percent = Number(entry?.percent);
  return Number.isFinite(percent) ? percent : 0;
}

function formatOf(file) {
  return String(file?.extension || "").toUpperCase();
}

export function createHomeView(leaf, options) {
  const { app, plugin, onOpenBook, onOpenFileDialog } = options;

  class HomeView extends ItemView {
    getViewType() {
      return "qbr-home";
    }

    getDisplayText() {
      return "首页";
    }

    getIcon() {
      return "book-open";
    }

    async onOpen() {
      this.contentEl.addClass("qbr-home-view");
      this.render();
      // A fresh install has no books yet: install the bundled starter library
      // so the home page has something to open without visiting the library.
      try {
        void plugin.ensureStarterBooks?.(false);
      } catch (error) {
        console.warn("host-shim: starter library install failed", error);
      }
      // The starter library and external tools can add books while the home
      // page stays open; refresh when the available books change.
      this._lastSignature = this.signature();
      this._refreshTimer = setInterval(() => {
        if (this.contentEl && !this.contentEl.isConnected) return;
        const next = this.signature();
        if (next === this._lastSignature) return;
        this._lastSignature = next;
        this.render();
      }, 1500);
    }

    signature() {
      const progress = Object.keys(plugin.progress || {}).length;
      const books = app.vault.getFiles().filter((file) => BOOK_EXTENSIONS.includes(file.extension)
        && plugin.isLibraryBook?.(file) !== false).length;
      const projects = this._projectCount || 0;
      return `${progress}:${books}:${projects}`;
    }

    async onClose() {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
      this.contentEl.empty();
    }

    render() {
      const host = this.contentEl;
      host.empty();
      const head = host.createDiv("qbr-home-head");
      const actions = head.createDiv("qbr-home-actions");
      const open = actions.createEl("button", { cls: "mod-cta", text: "打开书籍…" });
      open.addEventListener("click", () => void onOpenFileDialog());
      const projects = actions.createEl("button", { text: "阅读项目" });
      projects.addEventListener("click", () => plugin.openReadingProjects?.({ mode: "manage" }));

      const recent = Object.entries(plugin.progress || {})
        .filter(([, entry]) => entry && (entry.lastRead || entry.percent))
        .sort((a, b) => (b[1].lastRead || 0) - (a[1].lastRead || 0))
        .slice(0, 8);
      const cards = recent
        .map(([path]) => {
          const file = app.vault.getAbstractFileByPath(path);
          return file ? { file, percent: percentOf(plugin, path) } : null;
        })
        .filter(Boolean);

      const section = (title, note) => {
        const row = host.createDiv("qbr-home-section");
        row.createDiv({ cls: "qbr-home-section-title", text: title });
        if (note) row.createDiv({ cls: "qbr-home-section-note", text: note });
        return row.createDiv("qbr-home-grid");
      };

      if (cards.length) {
        const grid = section("继续阅读");
        for (const { file, percent } of cards) {
          const card = grid.createDiv("qbr-home-card");
          card.createDiv({ cls: "qbr-home-card-format", text: formatOf(file) });
          card.createDiv({ cls: "qbr-home-card-title", text: file.basename });
          const bar = card.createDiv("qbr-home-card-bar");
          bar.createDiv("qbr-home-card-fill").style.width = `${Math.min(100, Math.max(0, percent))}%`;
          card.createDiv({ cls: "qbr-home-card-meta", text: percent ? `${percent}%` : "未开始" });
          card.addEventListener("click", () => void onOpenBook(file.path));
        }
      } else {
        section("继续阅读", "还没有阅读记录，先打开一本书吧。");
      }

      const vaultBooks = app.vault
        .getFiles()
        .filter((file) => BOOK_EXTENSIONS.includes(file.extension) && plugin.isLibraryBook?.(file) !== false)
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0))
        .slice(0, 8);
      const added = section("书库新书");
      if (!vaultBooks.length) {
        added.createDiv({ cls: "qbr-home-section-note", text: "书库还是空的，点“打开书籍…”添加本地文件。" });
      }
      for (const file of vaultBooks) {
        const card = added.createDiv("qbr-home-card");
        card.createDiv({ cls: "qbr-home-card-format", text: formatOf(file) });
        card.createDiv({ cls: "qbr-home-card-title", text: file.basename });
        card.createDiv({ cls: "qbr-home-card-meta", text: percentOf(plugin, file.path) ? `${percentOf(plugin, file.path)}%` : "未开始" });
        card.addEventListener("click", () => void onOpenBook(file.path));
      }

      const projectGrid = section("阅读项目", "把相关图书的进度、划线和会话归到一处，可整组迁移。");
      void this.renderProjects(projectGrid);
    }

    async renderProjects(grid) {
      const projects = await plugin.listReadingProjects?.() || [];
      this._projectCount = projects.length;
      if (!grid.isConnected) return;
      if (!projects.length) {
        grid.createDiv({ cls: "qbr-home-section-note", text: "还没有阅读项目。打开“书库”，在书的菜单里选择“加入阅读项目…”。" });
        return;
      }
      for (const project of projects) {
        const card = grid.createDiv("qbr-home-card");
        card.createDiv({ cls: "qbr-home-card-format", text: "项目" });
        card.createDiv({ cls: "qbr-home-card-title", text: project.name });
        card.createDiv({ cls: "qbr-home-card-meta", text: `${project.books.length} 本` });
        card.addEventListener("click", () => plugin.openReadingProjects?.({ mode: "manage", project: project.name }));
      }
    }
  }

  return new HomeView(leaf);
}

export function createNoteView(leaf, options) {
  const { app, renderMarkdown, openPath } = options;

  class NoteView extends ItemView {
    constructor(hostLeaf) {
      super(hostLeaf);
      this.file = null;
    }

    getViewType() {
      return "qbr-note";
    }

    getDisplayText() {
      return this.file?.basename || "阅读笔记";
    }

    getIcon() {
      return "file-text";
    }

    async setState(state) {
      this.state = state;
      if (state?.path) {
        const file = app.vault.getAbstractFileByPath(state.path);
        if (file) this.file = file;
      }
    }

    async onOpen() {
      this.contentEl.addClass("qbr-note-panel");
      await this.render();
    }

    async onClose() {
      this.contentEl.empty();
    }

    async render() {
      const host = this.contentEl;
      host.empty();
      const head = host.createDiv("qbr-note-head");
      head.createDiv({ cls: "qbr-note-title", text: this.file?.basename || "阅读笔记" });
      const actions = head.createDiv("qbr-note-actions");
      const refresh = actions.createEl("button", { text: "刷新" });
      refresh.addEventListener("click", () => void this.render());
      if (openPath) {
        const external = actions.createEl("button", { text: "在文件中打开" });
        external.addEventListener("click", () => void openPath(this.file?.path || ""));
      }
      const close = actions.createEl("button", { text: "关闭" });
      close.addEventListener("click", () => this.leaf.detach());
      const body = host.createDiv("qbr-note-body");
      if (!this.file) {
        body.createDiv({ cls: "qbr-note-empty", text: "这本书还没有阅读笔记。" });
        return;
      }
      try {
        const data = await app.vault.read(this.file);
        body.innerHTML = renderMarkdown(data);
      } catch (error) {
        body.createDiv({ cls: "qbr-note-empty", text: String(error?.message || error) });
      }
    }
  }

  return new NoteView(leaf);
}

function jumpToTocItem(reader, item) {
  if (!reader || !item) return;
  if (reader.engine && item.href) {
    void reader.engine.goToTocItem(item.href);
    return;
  }
  if (typeof reader._jumpToBlock === "function") reader._jumpToBlock(item.block ?? item);
}

export function createTocView(leaf, options) {
  const { app } = options;

  class TocView extends ItemView {
    getViewType() {
      return "qbr-toc";
    }

    getDisplayText() {
      return "目录";
    }

    getIcon() {
      return "list";
    }

    async onOpen() {
      this.contentEl.addClass("qbr-toc-panel");
      this.render();
      this._timer = setInterval(() => {
        if (!this.contentEl?.isConnected) return;
        const next = this.signature();
        if (next === this._lastSignature) return;
        this._lastSignature = next;
        this.render();
      }, 1200);
    }

    async onClose() {
      clearInterval(this._timer);
      this._timer = null;
      this.contentEl.empty();
    }

    reader() {
      return app.workspace.getLeavesOfType("qiaomu-reader")[0]?.view || null;
    }

    signature() {
      const reader = this.reader();
      return `${reader?.file?.path || ""}:${reader?.tocItems?.length || 0}`;
    }

    render() {
      const host = this.contentEl;
      host.empty();
      const head = host.createDiv("qbr-panel-head");
      head.createDiv({ cls: "qbr-panel-title", text: "目录" });
      const actions = head.createDiv("qbr-panel-actions");
      const close = actions.createEl("button", {
        attr: { type: "button", "aria-label": "关闭" },
      });
      setIcon(close, "x");
      close.addEventListener("click", () => this.leaf.detach());
      const reader = this.reader();
      const items = reader?.tocItems || [];
      const search = host.createEl("input", { cls: "qbr-toc-search", type: "search", placeholder: "搜索目录" });
      const list = host.createDiv("qbr-toc-list");
      const paint = (query) => {
        list.empty();
        const needle = String(query || "").trim().toLowerCase();
        const shown = needle
          ? items.filter((item) => String(item?.label || "").toLowerCase().includes(needle))
          : items;
        if (!shown.length) {
          list.createDiv({ cls: "qbr-toc-empty", text: items.length ? "没有匹配的目录项" : "这本书没有目录" });
          return;
        }
        for (const item of shown) {
          const row = list.createDiv({ cls: "qbr-toc-item", text: String(item?.label || "") });
          row.dataset.level = String(Math.min(2, Number(item?.level) || 0));
          row.addEventListener("click", () => jumpToTocItem(reader, item));
        }
      };
      search.addEventListener("input", () => paint(search.value));
      paint("");
      this._lastSignature = this.signature();
    }
  }

  return new TocView(leaf);
}

export function createSettingsView(leaf, options) {
  const { plugin } = options;

  class SettingsView extends ItemView {
    getViewType() {
      return "qbr-settings";
    }

    getDisplayText() {
      return "设置";
    }

    getIcon() {
      return "settings";
    }

    async onOpen() {
      this.contentEl.addClass("qbr-settings-view");
      const host = this.contentEl.createDiv("qbr-settings-body");
      const tab = plugin.settingsTab;
      if (!tab?.containerEl) {
        host.createDiv({ cls: "qbr-note-empty", text: "设置不可用。" });
        return;
      }
      host.appendChild(tab.containerEl);
      tab.containerEl.addClass("qbr-settings-embedded");
      try {
        tab.display();
      } catch (error) {
        host.createDiv({ cls: "qbr-note-empty", text: String(error?.message || error) });
      }
    }

    async onClose() {
      this.contentEl.empty();
    }
  }

  return new SettingsView(leaf);
}

// 书坊(Workshop):文档处理 / 格式转换 / 电子书制作。本阶段(W0-1)提供页面
// 骨架——左栏工具分组 + 右栏面板 + 路由记忆;各工具在后续阶段接入,见
// docs/workshop-implementation.md。
const WORKSHOP_TOOLS = [
  { id: "ocr", group: "处理", label: "文字层", title: "文字层与可搜索 PDF", en: "Text Layer", icon: "text-select",
    lead: "把扫描 PDF 变成可搜索、可划线的文本;不改原件,阅读器直接可用。" },
  { id: "convert", group: "处理", label: "格式转换", title: "格式转换", en: "Convert", icon: "arrow-right",
    lead: "保持内容与版式的文档互转:Office / ODF / HTML / EPUB / OFD → Markdown / HTML / DOCX / PDF / EPUB。" },
  { id: "extract", group: "处理", label: "内容提取", title: "内容提取(PDF → Doc)", en: "Extract", icon: "file-text",
    lead: "只取内容、可丢版式:PDF / DOCX / 图片 → Markdown / HTML / 结构化 JSON(题库等 schema 模板)。" },
  { id: "book", group: "处理", label: "电子书制作", title: "新建电子书", en: "Make a Book", icon: "book-open",
    lead: "从提取结果、Markdown 或图片制作 EPUB:元数据、章节、封面、样式,可实时预览。" },
  { id: "kindle", group: "发送", label: "发送到 Kindle", title: "发送到 Kindle", en: "Send to Kindle", icon: "external-link",
    lead: "把 EPUB / PDF / DOCX 直接发到你的 Kindle 邮箱;EPUB 原生支持,不需要转 AZW3。" },
  { id: "tasks", group: "队列", label: "任务", title: "任务", en: "Tasks", icon: "history",
    lead: "运行中与最近的任务;取消、重试、打开产物。历史不自动续跑。" },
];

// 任务类型标签与状态文案(队列数据来自主进程)。
const WORKSHOP_KIND_LABELS = {
  probe: "自检",
  "ocr-cache": "文字层",
  "ocr-export": "导出",
  "docvortex-probe": "检测",
  "docvortex-convert": "转换",
  "formula-probe": "公式检测",
  "formula-convert": "公式",
  "calibre-probe": "检测",
  "ebook-convert": "互转",
  "images-cbz": "打包",
};

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function workshopTaskState(task, now = Date.now()) {
  if (task.status === "running") {
    if (task.total) return `运行中 ${task.done}/${task.total}`;
    // 没有总量的任务(DocVortex 等外部 CLI 不报进度)走不确定态,用秒表说明还在跑。
    return `运行中… ${formatElapsed(now - (Number(task.startedAt) || Number(task.createdAt) || now))}`;
  }
  if (task.status === "queued") return "排队中";
  if (task.status === "done") return "已完成";
  if (task.status === "cancelled") return "已取消";
  return "失败";
}

export function createWorkshopView(leaf, options) {
  const app = options?.app;
  const plugin = options?.plugin;
  const bridge = typeof window !== "undefined" ? window.qbrDesktop?.workshop || null : null;

  class WorkshopView extends ItemView {
    getViewType() {
      return "qbr-workshop";
    }

    getDisplayText() {
      return "书坊";
    }

    getIcon() {
      return "workshop";
    }

    async onOpen() {
      this.contentEl.addClass("qbr-workshop-view");
      this._tool = localStorage.getItem("qbr-workshop-tool") || "ocr";
      if (!WORKSHOP_TOOLS.some((tool) => tool.id === this._tool)) this._tool = "ocr";
      this._collapsed = localStorage.getItem("qbr-workshop-rail") === "collapsed";
      this.render();
      if (bridge) {
        this._unsubscribe = bridge.onState((state) => this.renderTasks(state));
        void bridge.list().then((state) => this.renderTasks(state)).catch(() => {});
      } else {
        this.renderTasks({ tasks: [] });
      }
    }

    async onClose() {
      this._unsubscribe?.();
      this._unsubscribe = null;
      if (this._tick) {
        window.clearInterval(this._tick);
        this._tick = null;
      }
      this.contentEl.empty();
    }

    selectTool(id) {
      if (!WORKSHOP_TOOLS.some((tool) => tool.id === id)) return;
      this._tool = id;
      localStorage.setItem("qbr-workshop-tool", id);
      this.syncTools();
    }

    toggleRail() {
      this._collapsed = !this._collapsed;
      localStorage.setItem("qbr-workshop-rail", this._collapsed ? "collapsed" : "open");
      this.contentEl.toggleClass("qbr-workshop-rail-collapsed", this._collapsed);
    }

    syncTools() {
      for (const button of this._railButtons || []) {
        button.classList.toggle("is-active", button.dataset.tool === this._tool);
      }
      for (const panel of this._panels || []) {
        panel.hidden = panel.dataset.tool !== this._tool;
      }
    }

    render() {
      const root = this.contentEl;
      root.empty();
      const head = root.createDiv("qbr-workshop-head");
      const title = head.createDiv("qbr-workshop-title");
      title.createEl("b", { text: "书坊" });
      title.createEl("span", { text: "So Fun" });
      const toggle = head.createEl("button", { cls: "qbr-workshop-toggle", attr: { type: "button", "aria-label": "收起工具栏" } });
      toggle.insertAdjacentHTML("afterbegin", iconResolver("navigator"));
      toggle.addEventListener("click", () => this.toggleRail());
      head.createDiv({ cls: "qbr-workshop-lead", text: "文档处理 · 格式转换 · 电子书制作;产物默认回到书库。" });

      const body = root.createDiv("qbr-workshop-body");
      const rail = body.createDiv("qbr-workshop-rail");
      this._railButtons = [];
      let group = "";
      for (const tool of WORKSHOP_TOOLS) {
        if (tool.group !== group) {
          group = tool.group;
          rail.createDiv({ cls: "group", text: group });
        }
        const button = rail.createEl("button", { attr: { type: "button", "data-tool": tool.id } });
        button.insertAdjacentHTML("afterbegin", iconResolver(tool.icon));
        button.createSpan({ text: tool.label });
        if (tool.id === "tasks") this._taskBadge = button.createSpan({ cls: "badge", text: "" });
        button.addEventListener("click", () => this.selectTool(tool.id));
        this._railButtons.push(button);
      }

      const work = body.createDiv("qbr-workshop-work");
      this._panels = [];
      for (const tool of WORKSHOP_TOOLS) {
        const panel = work.createDiv("qbr-workshop-panel");
        panel.dataset.tool = tool.id;
        const heading = panel.createEl("h2");
        heading.createEl("b", { text: tool.title });
        heading.createEl("span", { text: tool.en });
        panel.createDiv({ cls: "lead", text: tool.lead });
        if (tool.id === "tasks") {
          const actions = panel.createDiv("qbr-workshop-task-toolbar");
          const probe = actions.createEl("button", { cls: "mod-cta", text: "运行环境自检" });
          probe.addEventListener("click", () => this.runSelfCheck());
          const clear = actions.createEl("button", { text: "清空历史" });
          clear.addEventListener("click", () => {
            if (!bridge) return;
            void bridge.clear().then((state) => this.renderTasks(state)).catch(() => {});
          });
          this._taskList = panel.createDiv("qbr-workshop-task-list");
        } else if (tool.id === "ocr") {
          this.renderOcrPanel(panel);
        } else if (tool.id === "convert") {
          this.renderConvertPanel(panel);
        } else if (tool.id === "extract") {
          this.renderExtractPanel(panel);
        } else if (tool.id === "book") {
          this.renderBookPanel(panel);
        } else {
          const card = panel.createDiv("qbr-workshop-card");
          card.createDiv({ cls: "qbr-workshop-soon", text: "该工具将在后续阶段接入(实施计划 docs/workshop-implementation.md)。" });
        }
        this._panels.push(panel);
      }

      const bar = root.createDiv("qbr-workshop-taskbar");
      bar.hidden = true;
      this._taskBarLabel = bar.createSpan({ cls: "qbr-workshop-taskbar-label", text: "" });
      const track = bar.createDiv("qbr-workshop-taskbar-track");
      this._taskBarFill = track.createDiv("qbr-workshop-taskbar-fill");
      this._taskBarMeta = bar.createSpan({ cls: "qbr-workshop-taskbar-meta", text: "" });
      const open = bar.createEl("button", { cls: "qbr-workshop-taskbar-open", text: "查看任务" });
      open.addEventListener("click", () => this.selectTool("tasks"));
      this._taskBar = bar;

      this.syncTools();
      root.toggleClass("qbr-workshop-rail-collapsed", this._collapsed);
    }

    // 环境自检:探测 OCR sidecar(pdf_tool),结果进任务队列。
    runSelfCheck() {
      if (!bridge) return;
      const settings = plugin?.settings || {};
      void bridge.start({
        kind: "probe",
        title: "环境自检",
        detail: "OCR 程序",
        payload: {
          settings: {
            ocrSidecarExe: settings.ocrSidecarExe || "",
            ocrSidecarDir: settings.ocrSidecarDir || "",
            ocrPython: settings.ocrPython || "",
          },
        },
      }).catch((error) => new Notice(String(error?.message || error)));
    }

    // ── 文字层工具(W0-3)──────────────────────────────────────────────
    // 选择书库 PDF 或本地文件(自动导入),批量生成文字层 / 导出 .uvtext.pdf。
    renderOcrPanel(panel) {
      this._ocrSelection ||= [];
      const root = panel.createDiv("qbr-workshop-tool");

      const inputCard = root.createDiv("qbr-workshop-card");
      inputCard.createEl("h3", { text: "选择文件" });
      const pickRow = inputCard.createDiv("qbr-workshop-row");
      const pickVault = pickRow.createEl("button", { text: "选择书库文件…" });
      pickVault.addEventListener("click", () => this.toggleOcrBookList());
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      pickLocal.addEventListener("click", () => void this.pickLocalOcrFiles());
      pickRow.createSpan({ cls: "qbr-workshop-hint", text: "本地文件就地处理,产物落在源文件旁" });
      this._ocrBookList = inputCard.createDiv("qbr-workshop-booklist");
      this._ocrBookList.hidden = true;
      this._ocrChips = inputCard.createDiv("qbr-workshop-chips");

      const modeCard = root.createDiv("qbr-workshop-card");
      modeCard.createEl("h3", { text: "处理方式" });
      this._ocrModeInputs = {};
      const modes = [
        ["cache", "生成文字层", "写入阅读器缓存,打开书即可搜索 / 划线;最快。"],
        ["export", "导出可搜索 PDF 副本", "在源文件旁生成 <源名>.uvtext.pdf(同名覆盖),原页保留,插入不可见文字层。"],
      ];
      for (const [value, label, hint] of modes) {
        const row = modeCard.createEl("label", { cls: "qbr-workshop-opt" });
        const radio = row.createEl("input", { attr: { type: "radio", name: "qbr-ocr-mode", value } });
        radio.checked = value === "cache";
        this._ocrModeInputs[value] = radio;
        const text = row.createDiv("qbr-workshop-opt-text");
        text.createEl("b", { text: label });
        text.createDiv({ cls: "qbr-workshop-opt-hint", text: hint });
      }

      const startRow = root.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始处理" });
      start.addEventListener("click", () => this.startOcrTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "批量:可一次选多本,逐个入队。" });

      this._ocrRecent = root.createDiv("qbr-workshop-recent");
      this.renderOcrChips();
    }

    ocrBooks() {
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => String(file?.extension || "").toLowerCase() === "pdf")
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
    }

    toggleOcrBookList() {
      const list = this._ocrBookList;
      if (!list) return;
      list.hidden = !list.hidden;
      this.refreshOcrBookList();
    }

    refreshOcrBookList() {
      const list = this._ocrBookList;
      if (!list || list.hidden) return;
      list.empty();
      const books = this.ocrBooks();
      if (!books.length) {
        list.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有 PDF。" });
        return;
      }
      for (const file of books) {
        const row = list.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._ocrSelection.includes(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.addOcrFile(file.path);
          else this.removeOcrFile(file.path);
        });
        row.createSpan({ text: file.basename });
      }
    }

    addOcrFile(path) {
      if (!path || this._ocrSelection.includes(path)) return;
      this._ocrSelection.push(path);
      this.renderOcrChips();
    }

    removeOcrFile(path) {
      this._ocrSelection = this._ocrSelection.filter((item) => item !== path);
      this.renderOcrChips();
      this.refreshOcrBookList();
    }

    renderOcrChips() {
      const host = this._ocrChips;
      if (!host) return;
      host.empty();
      if (!this._ocrSelection.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择文件" });
        return;
      }
      for (const path of this._ocrSelection) {
        const chip = host.createSpan({ cls: "qbr-workshop-chip" });
        chip.createSpan({ text: path.split("/").pop() || path });
        const remove = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
        remove.addEventListener("click", () => this.removeOcrFile(path));
      }
    }

    async pickLocalOcrFiles() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      // 就地处理:不导入书库,产物落在源文件旁。
      for (const picked of paths) this.addOcrFile(String(picked).replace(/\\/g, "/"));
      this.refreshOcrBookList();
    }

    startOcrTasks() {
      if (!bridge) return;
      const files = [...this._ocrSelection];
      if (!files.length) {
        new Notice("请先选择 PDF 文件");
        return;
      }
      const settings = plugin?.settings || {};
      const payloadSettings = {
        ocrSidecarExe: settings.ocrSidecarExe || "",
        ocrSidecarDir: settings.ocrSidecarDir || "",
        ocrPython: settings.ocrPython || "",
      };
      const exportMode = Boolean(this._ocrModeInputs?.export?.checked);
      for (const rel of files) {
        const payload = { settings: payloadSettings, source: rel };
        // 导出固定在源文件旁,同名覆盖(可重复执行)。
        if (exportMode) payload.out = uvtextPath(rel);
        void bridge.start({
          kind: exportMode ? "ocr-export" : "ocr-cache",
          title: exportMode ? "导出可搜索 PDF" : "生成文字层",
          detail: rel,
          payload,
        }).catch((error) => new Notice(String(error?.message || error)));
      }
      this.selectTool("tasks");
    }

    // 预设卡片矩阵:ready 的选中,其余标「后续阶段」并提示归属。
    renderPresetMatrix(host, presets) {
      const matrix = host.createDiv("qbr-workshop-matrix");
      for (const preset of presets) {
        const card = matrix.createDiv("qbr-workshop-preset" + (preset.ready ? " is-ready" : " is-planned"));
        card.createEl("b", { text: preset.label });
        card.createDiv({ cls: "qbr-workshop-opt-hint", text: preset.hint });
        if (!preset.ready) card.createSpan({ cls: "qbr-workshop-preset-tag", text: "后续阶段" });
        card.addEventListener("click", () => {
          if (preset.ready) { this._convertPreset = preset.id; return; }
          new Notice(`${preset.label} 将在后续阶段接入(见 docs/workshop-implementation.md)`);
        });
      }
      return matrix;
    }

    // ── 内容提取(PDF/DOCX/图片 → 内容,W1-0)────────────────────────
    renderExtractPanel(panel) {
      const root = panel.createDiv("qbr-workshop-tool");
      const presetCard = root.createDiv("qbr-workshop-card");
      presetCard.createEl("h3", { text: "选择预设" });
      this.renderPresetMatrix(presetCard, [
        { id: "pdf-md", label: "PDF → Markdown / HTML", hint: "文本 / 扫描视觉 / MinerU;可丢版式", ready: false },
        { id: "schema", label: "结构化 JSON / 题库模板", hint: "schema 模板抽取:题目 / 选项 / 答案 / 解析", ready: false },
        { id: "image-text", label: "图片 → 文字", hint: "纯图提字(OCR),产物可再交给转换或制作", ready: false },
      ]);
      const card = root.createDiv("qbr-workshop-card");
      card.createDiv({ cls: "qbr-workshop-soon", text: "内容提取将在后续阶段接入(实施计划 docs/workshop-implementation.md 的 W1-0)。" });
    }

    // ── 电子书制作(W1-2/W1-3 向导;已接:Calibre 互转 + 图片打包)────────
    renderBookPanel(panel) {
      this._bookSelection ||= [];
      this._bookImages ||= [];
      const root = panel.createDiv("qbr-workshop-tool");

      const presetCard = root.createDiv("qbr-workshop-card");
      presetCard.createEl("h3", { text: "选择预设" });
      this.renderPresetMatrix(presetCard, [
        { id: "kindle", label: "EPUB → AZW3 / MOBI", hint: "换 Kindle 主流格式:Calibre,版式不变", ready: true },
        { id: "img-cbz", label: "图片 → CBZ / EPUB", hint: "漫画 / 相册打包成书", ready: true },
        { id: "pdf-clean", label: "PDF → 干净电子书", hint: "内部自动提取 + 重排:去页眉页脚/水印、按标题分章,再加样式与封面", ready: false },
        { id: "md-html-epub", label: "Markdown / HTML → EPUB", hint: "提供内容 + 样式/封面/目录;Markdown 由向导内部转 HTML", ready: false },
        { id: "txt-epub", label: "txt → EPUB", hint: "纯文本按标题 / 空行分章成书", ready: false },
        { id: "office-epub", label: "Office / OFD → EPUB", hint: "内部自动转换(DocVortex),中间环节无感", ready: false },
      ]);

      const convertCard = root.createDiv("qbr-workshop-card");
      convertCard.createEl("h3", { text: "电子书互转(EPUB → AZW3 / MOBI)" });
      const pickRow = convertCard.createDiv("qbr-workshop-row");
      const pickVault = pickRow.createEl("button", { text: "选择书库文件…" });
      pickVault.addEventListener("click", () => this.toggleBookList());
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      pickLocal.addEventListener("click", () => void this.pickLocalBookFiles());
      pickRow.createSpan({ cls: "qbr-workshop-hint", text: "输入 EPUB/MOBI/AZW3/FB2/CBZ;本地文件就地处理" });
      this._bookList = convertCard.createDiv("qbr-workshop-booklist");
      this._bookList.hidden = true;
      this._bookChips = convertCard.createDiv("qbr-workshop-chips");
      const targetRow = convertCard.createDiv("qbr-workshop-row");
      targetRow.createSpan({ cls: "qbr-workshop-hint", text: "目标格式" });
      this._bookFormat = targetRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const target of EBOOK_TARGETS) {
        this._bookFormat.createEl("option", { attr: { value: target.id }, text: target.label });
      }
      const startRow = convertCard.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始转换" });
      start.addEventListener("click", () => this.startBookTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "产物落在源文件旁" });

      const imageCard = root.createDiv("qbr-workshop-card");
      imageCard.createEl("h3", { text: "图片 → CBZ / EPUB" });
      const imgRow = imageCard.createDiv("qbr-workshop-row");
      const pickImages = imgRow.createEl("button", { text: "选择图片…" });
      pickImages.addEventListener("click", () => void this.pickBookImages());
      imgRow.createSpan({ cls: "qbr-workshop-hint", text: "可多选;按文件名自然排序(1 < 2 < 10)" });
      this._bookImageChips = imageCard.createDiv("qbr-workshop-chips");
      const imgTargetRow = imageCard.createDiv("qbr-workshop-row");
      imgTargetRow.createSpan({ cls: "qbr-workshop-hint", text: "打包为" });
      this._bookImageFormat = imgTargetRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const target of IMAGE_BOOK_TARGETS) {
        this._bookImageFormat.createEl("option", { attr: { value: target.id }, text: target.label });
      }
      imageCard.createDiv({ cls: "qbr-workshop-hint", text: "输出:图片所在目录旁 `<目录名>.cbz`(冲突加序号);EPUB 由 CBZ 经 Calibre 转换。" });
      const imgStartRow = imageCard.createDiv("qbr-workshop-row");
      const imgStart = imgStartRow.createEl("button", { cls: "mod-cta", text: "开始打包" });
      imgStart.addEventListener("click", () => this.startImageTasks());
      imgStartRow.createSpan({ cls: "qbr-workshop-hint", text: "Calibre 只在输出 EPUB 时需要" });

      const detectCard = root.createDiv("qbr-workshop-card");
      const detectRow = detectCard.createDiv("qbr-workshop-row");
      const detect = detectRow.createEl("button", { text: "检测 Calibre" });
      detect.addEventListener("click", () => this.probeCalibre());
      this._bookStatus = detectRow.createSpan({ cls: "qbr-workshop-hint", text: "未检测" });
      const pathRow = detectCard.createDiv("qbr-workshop-row");
      pathRow.createSpan({ cls: "qbr-workshop-hint", text: "Calibre 路径" });
      this._bookPath = pathRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空自动检测(常见位置 / PATH)" } });
      this._bookPath.value = String(plugin?.settings?.calibrePath || "");
      this._bookPath.addEventListener("change", () => {
        if (!plugin?.settings) return;
        plugin.settings.calibrePath = this._bookPath.value.trim();
        void plugin.saveAll?.();
      });

      this._bookRecent = root.createDiv("qbr-workshop-recent");
      this.renderBookChips();
      this.renderBookImageChips();
    }

    bookFiles() {
      const wanted = ["epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz"];
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => wanted.includes(String(file?.extension || "").toLowerCase()))
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
    }

    toggleBookList() {
      const list = this._bookList;
      if (!list) return;
      list.hidden = !list.hidden;
      this.refreshBookList();
    }

    refreshBookList() {
      const list = this._bookList;
      if (!list || list.hidden) return;
      list.empty();
      const books = this.bookFiles();
      if (!books.length) {
        list.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有电子书。" });
        return;
      }
      for (const file of books) {
        const row = list.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._bookSelection.includes(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.addBookFile(file.path);
          else this.removeBookFile(file.path);
        });
        row.createSpan({ text: `${file.basename} · ${String(file.extension || "").toUpperCase()}` });
      }
    }

    addBookFile(path) {
      if (!path || this._bookSelection.includes(path)) return;
      this._bookSelection.push(path);
      this.renderBookChips();
    }

    removeBookFile(path) {
      this._bookSelection = this._bookSelection.filter((item) => item !== path);
      this.renderBookChips();
      this.refreshBookList();
    }

    renderBookChips() {
      const host = this._bookChips;
      if (!host) return;
      host.empty();
      if (!this._bookSelection.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择文件" });
        return;
      }
      for (const path of this._bookSelection) {
        const chip = host.createSpan({ cls: "qbr-workshop-chip" });
        chip.createSpan({ text: path.split("/").pop() || path });
        const remove = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
        remove.addEventListener("click", () => this.removeBookFile(path));
      }
    }

    async pickLocalBookFiles() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      for (const picked of paths) this.addBookFile(String(picked).replace(/\\/g, "/"));
      this.refreshBookList();
    }

    bookSettings() {
      const settings = plugin?.settings || {};
      return { calibrePath: String(settings.calibrePath || "") };
    }

    probeCalibre() {
      if (!bridge) return;
      void bridge.start({
        kind: "calibre-probe",
        title: "检测 Calibre",
        detail: "ebook-convert",
        payload: { settings: this.bookSettings() },
      }).catch((error) => new Notice(String(error?.message || error)));
      this.selectTool("tasks");
    }

    startBookTasks() {
      if (!bridge) return;
      const files = [...this._bookSelection];
      if (!files.length) {
        new Notice("请先选择电子书文件");
        return;
      }
      const format = String(this._bookFormat?.value || "azw3");
      const target = EBOOK_TARGETS.find((entry) => entry.id === format) || EBOOK_TARGETS[0];
      const settings = this.bookSettings();
      for (const rel of files) {
        const out = convertPath(rel, target.ext, (candidate) => Boolean(app?.vault?.getAbstractFileByPath?.(candidate)));
        void bridge.start({
          kind: "ebook-convert",
          title: `转为 ${target.label}`,
          detail: rel,
          payload: { settings, source: rel, format, out },
        }).catch((error) => new Notice(String(error?.message || error)));
      }
      this.selectTool("tasks");
    }

    async pickBookImages() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      for (const picked of paths) {
        const normalized = String(picked).replace(/\\/g, "/");
        if (!this._bookImages.includes(normalized)) this._bookImages.push(normalized);
      }
      this.renderBookImageChips();
    }

    renderBookImageChips() {
      const host = this._bookImageChips;
      if (!host) return;
      host.empty();
      if (!this._bookImages.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择图片" });
        return;
      }
      const chip = host.createSpan({ cls: "qbr-workshop-chip" });
      chip.createSpan({ text: `${this._bookImages.length} 张图片` });
      const clear = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
      clear.addEventListener("click", () => {
        this._bookImages = [];
        this.renderBookImageChips();
      });
    }

    startImageTasks() {
      if (!bridge) return;
      const images = [...this._bookImages];
      if (!images.length) {
        new Notice("请先选择图片");
        return;
      }
      const format = String(this._bookImageFormat?.value || "cbz");
      void bridge.start({
        kind: "images-cbz",
        title: format === "epub" ? "图片 → EPUB" : "图片 → CBZ",
        detail: `${images.length} 张图片`,
        payload: { settings: this.bookSettings(), images, format },
      }).catch((error) => new Notice(String(error?.message || error)));
      this.selectTool("tasks");
    }

    // ── 格式转换(DocVortex,W0-4)──────────────────────────────────────
    renderConvertPanel(panel) {
      this._convertSelection ||= [];
      const root = panel.createDiv("qbr-workshop-tool");

      const presetCard = root.createDiv("qbr-workshop-card");
      presetCard.createEl("h3", { text: "选择预设" });
      this._convertPreset = "convert";
      this.renderPresetMatrix(presetCard, [
        { id: "convert", label: "文档互转(DocVortex)", hint: "保持内容与版式:Office/ODF/HTML/EPUB/OFD → md / html / docx / pdf / latex", ready: true },
        { id: "img", label: "图片 → PDF", hint: "打包成 PDF:照片成书、扫描页合成", ready: false },
      ]);

      const inputCard = root.createDiv("qbr-workshop-card");
      inputCard.createEl("h3", { text: "选择文件" });
      const pickRow = inputCard.createDiv("qbr-workshop-row");
      const pickVault = pickRow.createEl("button", { text: "选择书库文件…" });
      pickVault.addEventListener("click", () => this.toggleConvertBookList());
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      pickLocal.addEventListener("click", () => void this.pickLocalConvertFiles());
      pickRow.createSpan({ cls: "qbr-workshop-hint", text: "本地文件就地处理,产物落在源文件旁" });
      this._convertBookList = inputCard.createDiv("qbr-workshop-booklist");
      this._convertBookList.hidden = true;
      this._convertChips = inputCard.createDiv("qbr-workshop-chips");

      const optionCard = root.createDiv("qbr-workshop-card");
      optionCard.createEl("h3", { text: "转换设置" });
      const formatRow = optionCard.createDiv("qbr-workshop-row");
      formatRow.createSpan({ cls: "qbr-workshop-hint", text: "目标格式" });
      this._convertFormat = formatRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const format of DOCVORTEX_FORMATS) {
        this._convertFormat.createEl("option", { attr: { value: format.id }, text: format.label });
      }
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "输出与源文件同目录,用目标扩展名;同名自动加序号。" });
      const parseRow = optionCard.createDiv("qbr-workshop-row");
      parseRow.createSpan({ cls: "qbr-workshop-hint", text: "解析方式" });
      this._convertParse = parseRow.createEl("select", { cls: "qbr-workshop-select" });
      this._convertParse.createEl("option", { attr: { value: "local" }, text: "本地解析(DocVortex 自带 OCR)" });
      this._convertParse.createEl("option", { attr: { value: "mineru" }, text: "公式优先(MinerU 云端,PDF)" });
      this._convertParse.value = localStorage.getItem("qbr-workshop-parse") === "mineru" ? "mineru" : "local";
      this._convertParse.addEventListener("change", () => {
        localStorage.setItem("qbr-workshop-parse", String(this._convertParse.value));
        this.syncConvertTokenRow();
      });
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "公式优先:PDF 先经 MinerU 云端提取(公式转 LaTeX),再交 DocVortex 生成真公式 DOCX / PDF;要 EPUB 走「电子书制作」。需要 MinerU 凭据(下面填写或环境变量),首次较慢。" });
      this._convertTokenRow = optionCard.createDiv("qbr-workshop-row");
      this._convertTokenRow.createSpan({ cls: "qbr-workshop-hint", text: "MinerU 凭据" });
      this._convertToken = this._convertTokenRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空用环境变量 MINERU_API_KEY" } });
      this._convertToken.value = String(plugin?.settings?.mineruToken || "");
      this._convertToken.addEventListener("change", () => {
        if (!plugin?.settings) return;
        plugin.settings.mineruToken = this._convertToken.value.trim();
        void plugin.saveAll?.();
        new Notice("MinerU 凭据已保存；新任务生效。");
      });
      this._convertTokenRow.createSpan({ cls: "qbr-workshop-hint", text: "填一次长期生效；用环境变量的话，设完需重启应用。" });
      this.syncConvertTokenRow();
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "扫描件由 DocVortex 自带 OCR 识别（首次会下载约 220MB 模型）；数学公式与上下标识别有限。" });
      const detectRow = optionCard.createDiv("qbr-workshop-row");
      const detect = detectRow.createEl("button", { text: "检测 DocVortex" });
      detect.addEventListener("click", () => this.probeDocvortex());
      this._convertStatus = detectRow.createSpan({ cls: "qbr-workshop-hint", text: "未检测" });
      const detectFormula = detectRow.createEl("button", { text: "检测公式链路" });
      detectFormula.addEventListener("click", () => this.probeFormulaChain());
      this._formulaStatus = detectRow.createSpan({ cls: "qbr-workshop-hint", text: "" });
      const pathRow = optionCard.createDiv("qbr-workshop-row");
      pathRow.createSpan({ cls: "qbr-workshop-hint", text: "DocVortex 路径" });
      this._convertPath = pathRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空自动检测(PATH / python -m docvortex)" } });
      this._convertPath.value = String(plugin?.settings?.docvortexPath || "");
      this._convertPath.addEventListener("change", () => {
        if (!plugin?.settings) return;
        plugin.settings.docvortexPath = this._convertPath.value.trim();
        void plugin.saveAll?.();
      });

      const startRow = root.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始转换" });
      start.addEventListener("click", () => this.startConvertTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "批量:可一次选多本,逐个入队。" });

      this._convertRecent = root.createDiv("qbr-workshop-recent");
      this.renderConvertChips();
    }

    convertBooks() {
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => DOCVORTEX_INPUTS.includes(String(file?.extension || "").toLowerCase()))
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
    }

    toggleConvertBookList() {
      const list = this._convertBookList;
      if (!list) return;
      list.hidden = !list.hidden;
      this.refreshConvertBookList();
    }

    refreshConvertBookList() {
      const list = this._convertBookList;
      if (!list || list.hidden) return;
      list.empty();
      const books = this.convertBooks();
      if (!books.length) {
        list.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有可转换的文档。" });
        return;
      }
      for (const file of books) {
        const row = list.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._convertSelection.includes(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.addConvertFile(file.path);
          else this.removeConvertFile(file.path);
        });
        row.createSpan({ text: `${file.basename} · ${String(file.extension || "").toUpperCase()}` });
      }
    }

    addConvertFile(path) {
      if (!path || this._convertSelection.includes(path)) return;
      this._convertSelection.push(path);
      this.renderConvertChips();
    }

    removeConvertFile(path) {
      this._convertSelection = this._convertSelection.filter((item) => item !== path);
      this.renderConvertChips();
      this.refreshConvertBookList();
    }

    renderConvertChips() {
      const host = this._convertChips;
      if (!host) return;
      host.empty();
      if (!this._convertSelection.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择文件" });
        return;
      }
      for (const path of this._convertSelection) {
        const chip = host.createSpan({ cls: "qbr-workshop-chip" });
        chip.createSpan({ text: path.split("/").pop() || path });
        const remove = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
        remove.addEventListener("click", () => this.removeConvertFile(path));
      }
    }

    async pickLocalConvertFiles() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      // 就地处理:不导入书库,产物落在源文件旁。
      for (const picked of paths) this.addConvertFile(String(picked).replace(/\\/g, "/"));
      this.refreshConvertBookList();
    }

    docvortexSettings() {
      const settings = plugin?.settings || {};
      return {
        docvortexPath: String(settings.docvortexPath || ""),
        docvortexPython: String(settings.docvortexPython || settings.ocrPython || ""),
      };
    }

    probeDocvortex() {
      if (!bridge) return;
      void bridge.start({
        kind: "docvortex-probe",
        title: "检测 DocVortex",
        detail: "文档互转",
        payload: { settings: this.docvortexSettings() },
      }).catch((error) => new Notice(String(error?.message || error)));
      this.selectTool("tasks");
    }

    formulaSettings() {
      const settings = plugin?.settings || {};
      return {
        ...this.docvortexSettings(),
        ocrSidecarDir: String(settings.ocrSidecarDir || ""),
        ocrSidecarExe: String(settings.ocrSidecarExe || ""),
        ocrPython: String(settings.ocrPython || ""),
        mineruToken: String(settings.mineruToken || ""),
        mineruModel: String(settings.mineruModel || ""),
      };
    }

    // 凭据输入只在公式优先时露出(渐进披露)。
    syncConvertTokenRow() {
      if (!this._convertTokenRow) return;
      this._convertTokenRow.hidden = String(this._convertParse?.value || "local") !== "mineru";
    }

    probeFormulaChain() {
      if (!bridge) return;
      void bridge.start({
        kind: "formula-probe",
        title: "检测公式链路",
        detail: "MinerU + DocVortex",
        payload: { settings: this.formulaSettings() },
      }).catch((error) => new Notice(String(error?.message || error)));
      this.selectTool("tasks");
    }

    startConvertTasks() {
      if (!bridge) return;
      const files = [...this._convertSelection];
      if (!files.length) {
        new Notice("请先选择文件");
        return;
      }
      const format = String(this._convertFormat?.value || "markdown");
      const ext = docvortexFormatExt(format);
      const settings = this.docvortexSettings();
      const formula = this.formulaSettings();
      const parseMode = String(this._convertParse?.value || "local");
      for (const rel of files) {
        const out = convertPath(rel, ext, (candidate) => Boolean(app?.vault?.getAbstractFileByPath?.(candidate)));
        const useFormula = parseMode === "mineru" && /\.pdf$/i.test(rel);
        void bridge.start({
          kind: useFormula ? "formula-convert" : "docvortex-convert",
          title: useFormula ? "公式文档" : "文档互转",
          detail: rel,
          payload: { settings: useFormula ? formula : settings, source: rel, format, out },
        }).catch((error) => new Notice(String(error?.message || error)));
      }
      this.selectTool("tasks");
    }

    // 任务状态由主进程推送:徽标、任务面板与底部任务条一起刷新。
    renderTasks(state) {
      const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
      this._lastState = state;
      const running = tasks.filter((task) => task.status === "running");
      const queued = tasks.filter((task) => task.status === "queued");
      if (this._taskBadge) this._taskBadge.setText(running.length ? `${running.length} 运行中` : "");
      if (this._taskList) {
        this._taskList.empty();
        if (!tasks.length) this._taskList.createDiv({ cls: "qbr-workshop-soon", text: "还没有任务。" });
        for (const task of tasks.slice(0, 20)) this.renderTaskRow(this._taskList, task);
      }
      if (this._ocrRecent) {
        this._ocrRecent.empty();
        const recent = tasks.filter((task) => task.kind === "ocr-cache" || task.kind === "ocr-export").slice(0, 3);
        if (recent.length) {
          this._ocrRecent.createEl("h3", { text: "最近" });
          for (const task of recent) this.renderTaskRow(this._ocrRecent, task);
        }
      }
      if (this._convertRecent) {
        this._convertRecent.empty();
        const recent = tasks
          .filter((task) => task.kind === "docvortex-convert" || task.kind === "docvortex-probe" || task.kind === "formula-convert")
          .slice(0, 3);
        if (recent.length) {
          this._convertRecent.createEl("h3", { text: "最近" });
          for (const task of recent) this.renderTaskRow(this._convertRecent, task);
        }
      }
      if (this._convertStatus) {
        const probe = tasks.find((task) => task.kind === "docvortex-probe");
        if (!probe) this._convertStatus.setText("未检测");
        else if (probe.status === "running" || probe.status === "queued") this._convertStatus.setText("检测中…");
        else if (probe.status === "done") this._convertStatus.setText(`已就绪：${probe.output || "docvortex"}`);
        else this._convertStatus.setText(`未就绪：${probe.error || "未找到"}`);
      }
      if (this._formulaStatus) {
        const probe = tasks.find((task) => task.kind === "formula-probe");
        if (!probe) this._formulaStatus.setText("");
        else if (probe.status === "running" || probe.status === "queued") this._formulaStatus.setText("检测中…");
        else if (probe.status === "done") this._formulaStatus.setText(`公式链路就绪：${probe.output || "MinerU + DocVortex"}`);
        else this._formulaStatus.setText(`公式链路不可用：${probe.error || "未就绪"}`);
      }
      if (this._bookStatus) {
        const probe = tasks.find((task) => task.kind === "calibre-probe");
        if (!probe) this._bookStatus.setText("未检测");
        else if (probe.status === "running" || probe.status === "queued") this._bookStatus.setText("检测中…");
        else if (probe.status === "done") this._bookStatus.setText(`已就绪：${probe.output || "ebook-convert"}`);
        else this._bookStatus.setText(`未就绪：${probe.error || "未找到"}`);
      }
      if (this._bookRecent) {
        this._bookRecent.empty();
        const recent = tasks.filter((task) => task.kind === "ebook-convert" || task.kind === "images-cbz").slice(0, 3);
        if (recent.length) {
          this._bookRecent.createEl("h3", { text: "最近" });
          for (const task of recent) this.renderTaskRow(this._bookRecent, task);
        }
      }
      this.syncTicker(Boolean(running.length || queued.length));
      if (!this._taskBar) return;
      const active = running[0] || queued[0] || null;
      this._taskBar.hidden = !active;
      if (!active) return;
      const total = Number(active.total) || 0;
      const done = Number(active.done) || 0;
      this._taskBarLabel.setText(`${active.title}${active.label ? " · " + active.label : ""}`);
      if (active.status === "running" && !total) {
        // 外部 CLI 不报进度:不确定态滑动条 + 秒表,避免看起来像卡住。
        this._taskBarFill.addClass("is-indeterminate");
        this._taskBarFill.style.width = "";
      } else {
        this._taskBarFill.removeClass("is-indeterminate");
        this._taskBarFill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
      }
      const elapsed = formatElapsed(Date.now() - (Number(active.startedAt) || Number(active.createdAt) || Date.now()));
      this._taskBarMeta.setText(active.status === "running"
        ? `${total ? `${done}/${total}` : `已用 ${elapsed}`} · 共 ${running.length + queued.length} 个任务`
        : `排队中 · 共 ${running.length + queued.length} 个任务`);
    }

    // 运行中的任务每秒刷新一次:秒表与滑动条动起来。
    syncTicker(active) {
      if (active) {
        if (!this._tick) this._tick = window.setInterval(() => this.renderTasks(this._lastState || { tasks: [] }), 1000);
      } else if (this._tick) {
        window.clearInterval(this._tick);
        this._tick = null;
      }
    }

    renderTaskRow(host, task) {
      const row = host.createDiv("qbr-workshop-task");
      row.createSpan({ cls: "qbr-workshop-task-kind", text: WORKSHOP_KIND_LABELS[task.kind] || task.kind });
      const name = row.createDiv("qbr-workshop-task-name");
      name.createEl("b", { text: task.title || task.kind });
      if (task.detail) name.createSpan({ cls: "qbr-workshop-task-detail", text: ` · ${task.detail}` });
      const total = Number(task.total) || 0;
      const done = Number(task.done) || 0;
      const track = row.createDiv("qbr-workshop-task-track");
      const fill = track.createDiv("qbr-workshop-task-fill");
      if (task.status === "running" && !total) fill.addClass("is-indeterminate");
      else fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
      row.createSpan({ cls: `qbr-workshop-task-state is-${task.status}`, text: workshopTaskState(task) });
      const actions = row.createDiv("qbr-workshop-task-actions");
      if (task.status === "running" || task.status === "queued") {
        const cancel = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "取消" });
        cancel.addEventListener("click", () => { void bridge?.cancel?.(task.id).catch(() => {}); });
      }
      if (task.status === "failed" || task.status === "cancelled") {
        const retry = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "重试" });
        retry.addEventListener("click", () => { void bridge?.retry?.(task.id).catch(() => {}); });
      }
      if (task.status === "done" && /[\\/]/.test(String(task.output || ""))) {
        const open = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "打开产物" });
        open.addEventListener("click", () => { void window.qbrDesktop?.openPath?.(task.output); });
        const reveal = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "在文件夹中显示" });
        reveal.addEventListener("click", () => { void window.qbrDesktop?.showItemInFolder?.(task.output); });
      }
      if (task.error) row.createDiv({ cls: "qbr-workshop-task-error", text: task.error });
      else if (task.output) row.createDiv({ cls: "qbr-workshop-task-output", text: task.output });
    }
  }

  return new WorkshopView(leaf);
}
