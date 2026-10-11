import { ItemView, Notice, setIcon } from "obsidian";

import { iconResolver } from "./icons.js";

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
  { id: "extract", group: "处理", label: "内容提取", title: "内容提取(PDF → Doc)", en: "Extract", icon: "file-text",
    lead: "完整提取文字、图片、表格、代码、公式,输出 Markdown / HTML / JSON,供转换或重新排版。" },
  { id: "convert", group: "处理", label: "格式转换", title: "格式转换", en: "Convert", icon: "arrow-right",
    lead: "文档互转:Office / ODF / HTML / EPUB / OFD → Markdown / HTML / DOCX / PDF / EPUB。" },
  { id: "book", group: "处理", label: "电子书制作", title: "新建电子书", en: "Make a Book", icon: "book-open",
    lead: "从提取结果、Markdown 或图片制作 EPUB:元数据、章节、封面、样式,可实时预览。" },
  { id: "kindle", group: "发送", label: "发送到 Kindle", title: "发送到 Kindle", en: "Send to Kindle", icon: "external-link",
    lead: "把 EPUB / PDF / DOCX 直接发到你的 Kindle 邮箱;EPUB 原生支持,不需要转 AZW3。" },
  { id: "tasks", group: "队列", label: "任务", title: "任务", en: "Tasks", icon: "history",
    lead: "运行中与最近的任务;取消、重试、打开产物。历史不自动续跑。" },
];

// 任务类型标签与状态文案(队列数据来自主进程)。
const WORKSHOP_KIND_LABELS = { probe: "自检" };

function workshopTaskState(task) {
  if (task.status === "running") return task.total ? `运行中 ${task.done}/${task.total}` : "运行中…";
  if (task.status === "queued") return "排队中";
  if (task.status === "done") return "已完成";
  if (task.status === "cancelled") return "已取消";
  return "失败";
}

export function createWorkshopView(leaf, options) {
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

    // 任务状态由主进程推送:徽标、任务面板与底部任务条一起刷新。
    renderTasks(state) {
      const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
      const running = tasks.filter((task) => task.status === "running");
      const queued = tasks.filter((task) => task.status === "queued");
      if (this._taskBadge) this._taskBadge.setText(running.length ? `${running.length} 运行中` : "");
      if (this._taskList) {
        this._taskList.empty();
        if (!tasks.length) this._taskList.createDiv({ cls: "qbr-workshop-soon", text: "还没有任务。" });
        for (const task of tasks.slice(0, 20)) this.renderTaskRow(this._taskList, task);
      }
      if (!this._taskBar) return;
      const active = running[0] || queued[0] || null;
      this._taskBar.hidden = !active;
      if (!active) return;
      const total = Number(active.total) || 0;
      const done = Number(active.done) || 0;
      this._taskBarLabel.setText(`${active.title}${active.label ? " · " + active.label : ""}`);
      this._taskBarFill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
      this._taskBarMeta.setText(`${active.status === "running" ? `${done}/${total || "?"}` : "排队中"} · 共 ${running.length + queued.length} 个任务`);
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
      track.createDiv("qbr-workshop-task-fill").style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
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
      }
      if (task.error) row.createDiv({ cls: "qbr-workshop-task-error", text: task.error });
      else if (task.output) row.createDiv({ cls: "qbr-workshop-task-output", text: task.output });
    }
  }

  return new WorkshopView(leaf);
}
