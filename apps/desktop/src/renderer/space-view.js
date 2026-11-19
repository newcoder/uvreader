// 悦空间首页：左侧空间树，右侧当前空间内容。
// 空间数据/文件复制在主进程 spaces.js；这里只负责选择和展示。
import { ItemView, Modal, Notice, Setting, setIcon } from "obsidian";
import { BOOK_EXTENSIONS } from "../shared/books.js";
import { workshopCapabilitiesFor } from "../shared/workshop-capabilities.js";
import { isQuizOutput, spaceVaultRelative } from "../../../../packages/reader/src/space-paths.js";
import { iconResolver } from "./icons.js";
import { shellText } from "./i18n-shell.js";

const SPACE_TYPES = {
  reading: { label: "阅读", color: "#3f7be8" },
  research: { label: "研究", color: "#7c5cff" },
  learning: { label: "学习", color: "#229b6c" },
  work: { label: "工作", color: "#dd8a2f" },
  other: { label: "其他", color: "#8a8175" },
};

const TREE_KEY = "qbr-space-tree-collapsed";
const SELECTED_KEY = "qbr-space-selected";
const SECTION_MIN_FILES = 8;

const SPACE_OUTPUT_TYPES = {
  exports: { label: "成品", color: "#7c5cff" },
  translations: { label: "译文", color: "#3f7be8" },
  quizzes: { label: "答题页", color: "#dd8a2f" },
  polish: { label: "精修", color: "#229b6c" },
  extracts: { label: "提取", color: "#0f9b8e" },
  notes: { label: "笔记", color: "#b06ab3" },
  other: { label: "其他", color: "#8a8175" },
};

// The space view groups files by what the reader does next, not by every
// output directory. Translations, extracts and exports are results in the
// same "other" bucket; notes and conversations are reading traces.
const SPACE_SECTION_GROUPS = [
  { key: "books", label: "源文件" },
  { key: "polish", label: "精修" },
  { key: "quizzes", label: "答题页" },
  { key: "notes", label: "笔记与对话" },
  { key: "other", label: "其它" },
];

const CAPABILITY_LABELS = {
  "make-searchable": "可搜索",
  "searchable-copy": "可搜索副本",
  "exam-answer-page": "答题页",
  "questions-and-answers": "整理题目",
  "extract-text": "提取正文",
  "convert-word": "转 Word",
  "convert-markdown": "转 Markdown",
  "convert-pdf": "转 PDF",
  "make-ebook": "制作电子书",
  "translate-ebook": "翻译",
  "bilingual-ebook": "双语",
  "bilingual-ebook-side": "左右双语",
  "classical-modern": "文白对照",
  "script-simplified": "转简体",
  "script-traditional": "转繁体",
  "convert-kindle": "转 Kindle",
  "navigation-toc": "导航目录",
  "export-navigation-epub": "导出导航版",
};

const CAPABILITY_TOOLS = new Set(["ocr", "extract", "convert", "book"]);

const SPACE_FILE_TYPES = {
  pdf: { label: "PDF", color: "#d9534f", icon: "file-text" },
  doc: { label: "DOC", color: "#3b6fd8", icon: "file-text" },
  docx: { label: "DOCX", color: "#3b6fd8", icon: "file-text" },
  epub: { label: "EPUB", color: "#7c5cff", icon: "book-open" },
  mobi: { label: "MOBI", color: "#b7791f", icon: "book-open" },
  azw: { label: "AZW", color: "#b7791f", icon: "book-open" },
  azw3: { label: "AZW3", color: "#b7791f", icon: "book-open" },
  fb2: { label: "FB2", color: "#0f9b8e", icon: "book-open" },
  fbz: { label: "FBZ", color: "#0f9b8e", icon: "book-open" },
  cbz: { label: "CBZ", color: "#dd8a2f", icon: "image" },
  md: { label: "MD", color: "#6f6a60", icon: "file-text" },
  markdown: { label: "MD", color: "#6f6a60", icon: "file-text" },
  txt: { label: "TXT", color: "#6f6a60", icon: "file-text" },
  html: { label: "HTML", color: "#dd8a2f", icon: "code" },
  htm: { label: "HTML", color: "#dd8a2f", icon: "code" },
  json: { label: "JSON", color: "#0f9b8e", icon: "braces" },
  png: { label: "PNG", color: "#229b6c", icon: "image" },
  jpg: { label: "JPG", color: "#229b6c", icon: "image" },
  jpeg: { label: "JPG", color: "#229b6c", icon: "image" },
  webp: { label: "WEBP", color: "#229b6c", icon: "image" },
  gif: { label: "GIF", color: "#229b6c", icon: "image" },
  bmp: { label: "BMP", color: "#229b6c", icon: "image" },
  tiff: { label: "TIFF", color: "#229b6c", icon: "image" },
  jp2: { label: "JP2", color: "#229b6c", icon: "image" },
};

function fileTypeOf(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return SPACE_FILE_TYPES[ext] || { label: formatOf(name), color: "#8a8175", icon: "file-text" };
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatOf(name) {
  return String(name || "").split(".").pop()?.toUpperCase() || "FILE";
}

function typeOf(space) {
  return SPACE_TYPES[space?.type] || SPACE_TYPES.other;
}

function outputGroupKey(category) {
  if (category === "polish" || category === "quizzes" || category === "notes") return category;
  return "other";
}

class CreateSpaceModal extends Modal {
  constructor(app, { onCreate, t }) {
    super(app);
    this.onCreate = onCreate;
    this.t = t || ((text) => text);
  }

  onOpen() {
    this.titleEl.setText(this.t("新建空间"));
    const root = this.contentEl.createDiv("qbr-space-create");
    let name = "";
    let type = "reading";
    new Setting(root)
      .setName(this.t("空间名称"))
      .addText((text) => text.setPlaceholder(this.t("例如：论文研究")).onChange((value) => { name = value.trim(); }));
    new Setting(root)
      .setName(this.t("项目类型"))
      .setDesc(this.t("类型只影响导航颜色和图标，不会创建类型目录。"))
      .addDropdown((dropdown) => {
        for (const [id, meta] of Object.entries(SPACE_TYPES)) dropdown.addOption(id, this.t(meta.label));
        dropdown.setValue(type).onChange((value) => { type = value; });
      });
    root.createDiv({
      cls: "qbr-space-create-note",
      text: this.t("空间目录会建在书库的 Spaces 下。导入的文件会复制到空间里，原文件保留。"),
    });
    const actions = root.createDiv("qbr-space-create-actions");
    const cancel = actions.createEl("button", { text: this.t("取消") });
    const create = actions.createEl("button", { cls: "mod-cta", text: this.t("创建空间") });
    cancel.addEventListener("click", () => this.close());
    create.addEventListener("click", async () => {
      if (!name) {
        new Notice(this.t("请输入空间名称"));
        return;
      }
      create.disabled = true;
      try {
        const space = await this.onCreate({ name, type });
        if (space) this.close();
      } finally {
        create.disabled = false;
      }
    });
    setTimeout(() => root.querySelector("input")?.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LibraryImportModal extends Modal {
  constructor(app, { space, files, onImport, t }) {
    super(app);
    this.space = space;
    this.files = files;
    this.onImport = onImport;
    this.t = t || ((text) => text);
    this.selected = new Set();
  }

  onOpen() {
    this.titleEl.setText(this.t("从书库导入到「{0}」", this.space.name));
    const root = this.contentEl.createDiv("qbr-space-pick");
    const search = root.createEl("input", {
      cls: "qbr-space-pick-search",
      attr: { type: "search", placeholder: this.t("搜索书库中的书…") },
    });
    const list = root.createDiv("qbr-space-pick-list");
    const draw = (query = "") => {
      list.empty();
      const needle = String(query || "").trim().toLowerCase();
      const files = this.files.filter((file) => !needle || file.basename.toLowerCase().includes(needle));
      if (!files.length) {
        list.createDiv({ cls: "qbr-space-pick-empty", text: this.t("没有匹配的书籍") });
        return;
      }
      for (const file of files) {
        const row = list.createEl("label", { cls: "qbr-space-pick-row" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this.selected.has(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.selected.add(file.path);
          else this.selected.delete(file.path);
          update();
        });
        const copy = row.createDiv("qbr-space-pick-copy");
        copy.createDiv({ cls: "qbr-space-pick-title", text: file.basename });
        copy.createDiv({ cls: "qbr-space-pick-meta", text: `${formatOf(file.name)} · ${formatBytes(file.stat?.size)}` });
      }
    };
    const actions = root.createDiv("qbr-space-pick-actions");
    const cancel = actions.createEl("button", { text: this.t("取消") });
    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.t("导入所选") });
    const update = () => {
      confirm.setText(this.selected.size
        ? this.t("导入所选（{0}）", this.selected.size)
        : this.t("导入所选"));
      confirm.disabled = !this.selected.size;
    };
    search.addEventListener("input", () => draw(search.value));
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", () => {
      const paths = [...this.selected]
        .map((path) => this.app.vault.adapter.getFullPath(path))
        .filter(Boolean);
      this.close();
      void this.onImport?.(paths);
    });
    draw();
    update();
    search.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

export function createSpacesView(leaf, options) {
  const { app, plugin, onOpenBook, onOpenFileDialog } = options;
  const bridge = () => window.qbrDesktop?.spaces || null;
  const t = (text, ...args) => shellText(plugin, text, ...args);

  class SpacesView extends ItemView {
    constructor(hostLeaf) {
      super(hostLeaf);
      this.spaces = [];
      this.selectedId = "";
      this.treeCollapsed = false;
      this.importing = false;
      this._selectedSourcePaths = new Set();
      this._selectedSources = [];
      this._selectedHomePath = "";
      this._toolsBar = null;
    }

    getViewType() {
      return "qbr-home";
    }

    getDisplayText() {
      return plugin.translate?.("space-nav") || "悦空间";
    }

    getIcon() {
      return "book-open";
    }

    async onOpen() {
      this.contentEl.addClass("qiaomu-reader-lib", "qbr-space-home", "qbr-home-view");
      this.selectedId = localStorage.getItem(SELECTED_KEY) || "";
      this.treeCollapsed = localStorage.getItem(TREE_KEY) === "1";
      this._onContentClick = (event) => {
        const target = event.target;
        if (target?.closest?.(".qbr-space-book[data-source-path], .qbr-home-book-card, .qbr-space-tools")) return;
        this.clearSourceSelection();
        this.clearHomeSelection();
      };
      this.contentEl.addEventListener("click", this._onContentClick);
      try {
        void plugin.ensureStarterBooks?.(false);
      } catch (error) {
        console.warn("host-shim: starter library install failed", error);
      }
      await this.refresh();
      this._lastSignature = this.signature();
      this._refreshTimer = setInterval(() => {
        if (!this.contentEl?.isConnected) return;
        const next = this.signature();
        if (next === this._lastSignature) return;
        this._lastSignature = next;
        void this.refresh();
      }, 1500);
    }

    async onClose() {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
      if (this._onContentClick) this.contentEl.removeEventListener("click", this._onContentClick);
      this._onContentClick = null;
      this.contentEl.empty();
    }

    signature() {
      return `${Object.keys(plugin.progress || {}).length}:${app.vault.getFiles().length}:${this.spaces.length}:${this.selectedId}`;
    }

    async refresh() {
      const api = bridge();
      if (!api?.list) {
        this.spaces = [];
        this.render();
        return;
      }
      try {
        // The books directory is the source of truth. Reconcile renamed,
        // deleted and newly copied files before rendering the space cards.
        await api.sync?.();
      } catch (error) {
        console.warn("UV Reader: could not sync spaces", error);
      }
      try {
        this.spaces = await api.list() || [];
      } catch (error) {
        console.warn("UV Reader: could not list spaces", error);
        this.spaces = [];
        new Notice(t("读取空间失败：{0}", String(error?.message || error)));
      }
      for (const space of this.spaces) {
        if (space.exists) await plugin.loadSpaceReading?.(space.root).catch(() => 0);
      }
      if (this.selectedId && !this.spaces.some((space) => space.id === this.selectedId)) {
        this.selectedId = "";
        localStorage.removeItem(SELECTED_KEY);
      }
      this.render();
    }

    select(id) {
      const next = String(id || "");
      if (next !== this.selectedId) {
        this._selectedSourcePaths = new Set();
        this._selectedSources = [];
        this._selectedHomePath = "";
      }
      this.selectedId = next;
      if (this.selectedId) localStorage.setItem(SELECTED_KEY, this.selectedId);
      else localStorage.removeItem(SELECTED_KEY);
      this.render();
      if (next) void this.syncSelected(next);
    }

    async syncSelected(id) {
      const api = bridge();
      if (!api?.sync) return;
      try {
        await api.sync(id);
        const spaces = await api.list?.();
        if (spaces) {
          this.spaces = spaces;
          this.render();
        }
      } catch (error) {
        console.warn("UV Reader: could not sync the selected space", error);
      }
    }

    toggleTree() {
      this.treeCollapsed = !this.treeCollapsed;
      localStorage.setItem(TREE_KEY, this.treeCollapsed ? "1" : "0");
      this.render();
    }

    render() {
      const root = this.contentEl;
      root.empty();
      this._toolsBar = null;
      root.toggleClass("qiaomu-reader-lib-nav-collapsed", this.treeCollapsed);
      root.toggleClass("is-tree-collapsed", this.treeCollapsed);
      const shell = root.createDiv("qiaomu-reader-lib-main qbr-space-shell");
      this.renderTree(shell);
      const content = shell.createDiv("qiaomu-reader-lib-content qbr-space-content");
      this.renderToolbar(content);
      const main = content.createDiv("qiaomu-reader-lib-body qbr-space-main");
      const selected = this.spaces.find((space) => space.id === this.selectedId);
      if (selected) this.renderSpace(main, selected);
      else this.renderDefault(main);
      if (!selected) this._restoreHomeSelection();
      this._filterContent(this._query);
    }

    renderToolbar(host) {
      const toolbar = host.createDiv("qiaomu-reader-lib-toolbar");
      const nav = toolbar.createEl("button", {
        cls: "qiaomu-reader-lib-navbtn",
        attr: { type: "button", "aria-label": t("展开空间导航") },
      });
      setIcon(nav, "chevron-right");
      nav.addEventListener("click", () => this.toggleTree());
      const search = toolbar.createDiv("qiaomu-reader-lib-search");
      const searchIcon = search.createDiv("qiaomu-reader-lib-search-ic");
      setIcon(searchIcon, "search");
      const placeholder = t("搜索空间内文件…");
      const input = search.createEl("input", {
        cls: "qiaomu-reader-lib-search-input",
        attr: { type: "text", placeholder, "aria-label": placeholder, spellcheck: "false" },
      });
      input.value = this._query || "";
      input.addEventListener("input", () => {
        this._query = input.value;
        this._filterContent(input.value);
      });
      const selected = this.spaces.find((space) => space.id === this.selectedId);
      const label = toolbar.createDiv("qiaomu-reader-lib-viewlabel");
      label.setText(selected ? `${selected.name} · ${t(typeOf(selected).label)}` : t("默认阅读空间"));
      this._viewLabel = label;
    }

    _filterContent(query) {
      const needle = String(query || "").trim().toLowerCase();
      const main = this.contentEl.querySelector(".qbr-space-main");
      if (!main) return;
      const selectedIds = new Set((this._selectedSources || []).map((book) => book.id).filter(Boolean));
      const filtering = Boolean(needle || selectedIds.size);
      let visible = 0;
      for (const card of main.querySelectorAll(".qbr-space-book, .qbr-space-continue, .qbr-home-card")) {
        const name = card.getAttribute("data-file-name") || card.textContent || "";
        let matches = !needle || name.toLowerCase().includes(needle);
        if (matches && selectedIds.size && (card.classList.contains("qbr-space-output-card") || card.classList.contains("qbr-space-chat-card"))) {
          matches = selectedIds.has(card.getAttribute("data-source-id"));
        }
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      for (const group of main.querySelectorAll(".qbr-space-books:not(.qbr-space-section-body), .qbr-home-section")) {
        group.hidden = filtering && !group.querySelector(".qbr-space-book:not([hidden]), .qbr-home-card:not([hidden])");
      }
      for (const section of main.querySelectorAll(".qbr-space-file-section")) {
        const body = section.querySelector(".qbr-space-section-body");
        if (!body) continue;
        const head = section.querySelector(".qbr-space-section-head");
        const chevron = head?.querySelector(".qbr-space-section-chev");
        if (filtering) {
          const matched = section.querySelector(".qbr-space-book:not([hidden])");
          section.hidden = !matched;
          if (matched) {
            body.hidden = false;
            head?.setAttribute("aria-expanded", "true");
            if (chevron) setIcon(chevron, "chevron-down");
          }
        } else {
          const collapsed = section.dataset.collapsed === "1";
          section.hidden = false;
          body.hidden = collapsed;
          head?.setAttribute("aria-expanded", String(!collapsed));
          if (chevron) setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
        }
        const count = section.querySelector(".qbr-space-section-count");
        if (count) count.textContent = String(section.querySelectorAll(".qbr-space-book:not([hidden])").length);
      }
      let selectionNote = main.querySelector(".qbr-space-selection-empty");
      const derivedVisible = main.querySelector(".qbr-space-output-card:not([hidden]), .qbr-space-chat-card:not([hidden])");
      if (selectedIds.size && !needle && !derivedVisible) {
        if (!selectionNote) {
          selectionNote = main.createDiv({
            cls: "qbr-space-search-empty qbr-space-selection-empty",
            text: selectedIds.size === 1
              ? t("这个源文件还没有衍生文件。")
              : t("所选源文件还没有衍生文件。"),
          });
        }
      } else if (selectionNote) {
        selectionNote.remove();
      }
      let note = main.querySelector(".qbr-space-search-empty:not(.qbr-space-selection-empty)");
      if (needle && !visible) {
        if (!note) note = main.createDiv({ cls: "qbr-space-search-empty", text: t("没有匹配的文件") });
      } else if (note) {
        note.remove();
      }
    }

    renderTree(host) {
      const tree = host.createDiv("qiaomu-reader-lib-side qbr-space-side");
      const head = tree.createDiv("qiaomu-reader-lib-side-head");
      head.createSpan({ cls: "qiaomu-reader-lib-side-title", text: plugin.translate?.("space-nav") || t("悦空间") });
      const actions = head.createDiv("qbr-space-tree-actions");
      const collapse = actions.createEl("button", {
        cls: "qiaomu-reader-lib-collapse qbr-space-collapse",
        attr: { type: "button", "aria-label": t("收起空间导航") },
      });
      setIcon(collapse, "chevron-left");
      collapse.addEventListener("click", () => this.toggleTree());
      const add = actions.createEl("button", {
        cls: "qiaomu-reader-lib-collapse qbr-space-add",
        attr: { type: "button", "aria-label": t("新建空间") },
      });
      setIcon(add, "plus");
      add.addEventListener("click", () => this.openCreate());

      const list = tree.createDiv("qiaomu-reader-lib-tree");
      const makeNode = (className = "") => list.createDiv(`qiaomu-reader-lib-node ${className}`.trim());
      const addDot = (node, color) => {
        const icon = node.createSpan("qiaomu-reader-lib-node-icon");
        const dot = icon.createSpan("qbr-space-type-dot");
        dot.style.background = color;
      };

      const defaultNode = makeNode(this.selectedId ? "" : "qiaomu-reader-lib-node-on");
      defaultNode.createSpan("qiaomu-reader-lib-node-chev");
      addDot(defaultNode, "#b8afa2");
      defaultNode.createSpan({ cls: "qiaomu-reader-lib-node-label qbr-space-project-name", text: t("默认阅读空间") });
      defaultNode.addEventListener("click", () => this.select(""));

      list.createDiv({ cls: "qiaomu-reader-lib-node qiaomu-reader-lib-node-group" })
        .createSpan({ cls: "qiaomu-reader-lib-node-label", text: t("空间") });

      for (const space of this.spaces) {
        const row = makeNode(space.id === this.selectedId ? "qiaomu-reader-lib-node-on" : "");
        row.createSpan("qiaomu-reader-lib-node-chev");
        addDot(row, space.color || typeOf(space).color);
        row.createSpan({ cls: "qiaomu-reader-lib-node-label qbr-space-project-name", text: space.name });
        row.createSpan({ cls: "qiaomu-reader-lib-node-count", text: space.exists ? String(space.bookCount) : "!" });
        row.addEventListener("click", () => this.select(space.id));
      }

      const newNode = makeNode("qiaomu-reader-lib-node-action");
      const icon = newNode.createSpan("qiaomu-reader-lib-node-icon");
      setIcon(icon, "plus");
      newNode.createSpan({ cls: "qiaomu-reader-lib-node-label", text: t("新建空间") });
      newNode.addEventListener("click", () => this.openCreate());
    }

    openCreate() {
      new CreateSpaceModal(app, {
        t,
        onCreate: async ({ name, type }) => {
          const api = bridge();
          if (!api?.create) {
            new Notice(t("当前环境不能创建空间"));
            return null;
          }
          try {
            const space = await api.create({ name, type });
            await this.refresh();
            this.select(space.id);
            new Notice(t("已创建空间「{0}」", space.name));
            return space;
          } catch (error) {
            new Notice(t("创建失败：{0}", String(error?.message || error)));
            return null;
          }
        },
      }).open();
    }

    renderDefault(host) {
      this.renderHeader(host, null);
      const spaced = new Set(this.spaces.flatMap((space) => (space.books || []).map((book) => book.path)));
      const isSpaced = (file) => spaced.has(app.vault.adapter.getFullPath(file.path));
      const recent = Object.entries(plugin.progress || {})
        .filter(([, entry]) => entry && (entry.lastRead || entry.percent))
        .sort((a, b) => (b[1].lastRead || 0) - (a[1].lastRead || 0))
        .slice(0, 16);
      const recentGrid = this.homeSection(host, t("继续阅读"));
      let count = 0;
      for (const [path, entry] of recent) {
        const file = app.vault.getAbstractFileByPath(path);
        if (!file || isSpaced(file)) continue;
        count += 1;
        this.renderHomeCard(recentGrid, file, Number(entry.percent) || 0);
        if (count >= 8) break;
      }
      if (!count) {
        recentGrid.createDiv({ cls: "qbr-home-section-note", text: t("还没有阅读记录，先打开一本书吧。") });
      }

      const vaultBooks = app.vault.getFiles()
        .filter((file) => BOOK_EXTENSIONS.includes(file.extension) && plugin.isLibraryBook?.(file) !== false)
        .filter((file) => !isSpaced(file))
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0))
        .slice(0, 8);
      const added = this.homeSection(host, t("书库新书"));
      if (!vaultBooks.length) {
        added.createDiv({ cls: "qbr-home-section-note", text: t("书库还是空的，点“打开书籍…”添加本地文件。") });
      }
      for (const file of vaultBooks) this.renderHomeCard(added, file, this.percentOf(file.path));

      const projectGrid = this.homeSection(host, t("阅读项目"), t("把相关图书的进度、划线和会话归到一处，可整组迁移。"));
      void this.renderReadingProjects(projectGrid).then(
        () => this._filterContent(this._query),
        () => {},
      );
    }

    homeSection(host, title, note = "") {
      const section = host.createDiv("qbr-home-section");
      section.createDiv({ cls: "qbr-home-section-title", text: title });
      if (note) section.createDiv({ cls: "qbr-home-section-note", text: note });
      return section.createDiv("qbr-home-grid");
    }

    percentOf(path) {
      const percent = Number(plugin.progress?.[path]?.percent);
      return Number.isFinite(percent) ? percent : 0;
    }

    renderHomeCard(grid, file, percent = 0) {
      const card = grid.createDiv("qbr-home-card qbr-home-book-card");
      card.setAttribute("data-file-name", file.name || file.basename || "");
      card.setAttribute("data-home-path", file.path || "");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", "false");
      const type = fileTypeOf(file.name);
      const format = card.createDiv("qbr-home-card-format");
      format.style.color = type.color;
      const icon = format.createSpan("qbr-home-card-format-icon");
      icon.innerHTML = iconResolver(type.icon);
      format.createSpan({ text: type.label });
      card.createDiv({ cls: "qbr-home-card-title", text: file.basename });
      const bar = card.createDiv("qbr-home-card-bar");
      bar.createDiv("qbr-home-card-fill").style.width = `${Math.min(100, Math.max(0, percent))}%`;
      card.createDiv({ cls: "qbr-home-card-meta", text: percent ? `${percent}%` : t("未开始") });
      card.addEventListener("click", () => this.selectHomeCard(file));
      card.addEventListener("dblclick", (event) => {
        event.preventDefault();
        this.clearHomeSelection();
        void onOpenBook?.(file.path);
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.clearHomeSelection();
          void onOpenBook?.(file.path);
        } else if (event.key === " ") {
          event.preventDefault();
          this.selectHomeCard(file);
        }
      });
    }

    async renderReadingProjects(grid) {
      if (typeof plugin.listReadingProjects !== "function") return;
      const projects = await plugin.listReadingProjects() || [];
      if (!grid.isConnected) return;
      if (!projects.length) {
        grid.createDiv({ cls: "qbr-home-section-note", text: t("还没有阅读项目。打开“书库”，在书的菜单里选择“加入阅读项目…”。") });
        return;
      }
      for (const project of projects) {
        const card = grid.createDiv("qbr-home-card");
        card.setAttribute("data-file-name", project.name || "");
        card.createDiv({ cls: "qbr-home-card-format", text: t("项目") });
        card.createDiv({ cls: "qbr-home-card-title", text: project.name });
        card.createDiv({ cls: "qbr-home-card-meta", text: plugin.translate?.("books-count", project.books.length) || `${project.books.length} 本` });
        card.addEventListener("click", () => plugin.openReadingProjects?.({ mode: "manage", project: project.name }));
      }
    }

    renderSpace(host, space) {
      this.renderHeader(host, space);
      if (!space.exists) {
        this.renderMissing(host, space);
        return;
      }
      const outputs = Array.isArray(space.outputs) ? space.outputs : [];
      this._toolsBar = this.renderDocumentTools(host, space);
      const grouped = this.shouldGroupSpace(space, outputs);
      if (!space.books?.length) {
        this._selectedSources = [];
        this._selectedSourcePaths = new Set();
        this.renderEmpty(host, space);
        if (grouped) this.renderSpaceSections(host, space, outputs);
        else this.renderDerivedDocs(host, space, outputs);
        this._updateToolsBar(space);
        return;
      }
      if (grouped) {
        this.renderSpaceSections(host, space, outputs);
        this._restoreSourceSelection(space);
        return;
      }
      const grid = host.createDiv("qbr-space-books");
      for (const book of space.books) {
        this.renderBookCard(grid, {
          id: book.id,
          title: book.title || book.name,
          name: book.name,
          size: book.size,
          path: book.path,
          percent: this.bookPercent(book),
        }, space);
      }
      this.renderDerivedDocs(host, space, outputs);
      this._restoreSourceSelection(space);
    }

    renderDocumentTools(host, space) {
      const bar = host.createDiv("qbr-space-tools");
      const head = bar.createDiv("qbr-space-tools-head");
      head.createDiv({ cls: "qbr-space-tools-title", text: t("文档工具") });
      const summary = head.createDiv("qbr-space-tools-summary");
      const actions = bar.createDiv("qbr-space-tools-actions");
      const tools = { bar, summary, actions, space };
      this._toolsBar = tools;
      this._updateToolsBar(space);
      return tools;
    }

    _updateToolsBar(space) {
      const tools = this._toolsBar;
      if (!tools) return;
      tools.actions.empty();
      const selected = this._selectedSources || [];
      if (!selected.length) {
        tools.summary.setText(t("选择源文件以使用文档工具"));
        if (space.books?.length) this.toolButton(tools.actions, t("全选"), () => this.selectAllSources(space));
        this.toolButton(tools.actions, t("书坊"), () => void window.qbrOpenWorkshop?.("tasks"));
        return;
      }
      if (selected.length === 1) {
        const book = selected[0];
        tools.summary.setText(book.title || book.name || "");
        this.toolButton(
          tools.actions,
          this.isReadableBook(book) ? t("打开") : t("系统打开"),
          () => {
            this.clearSourceSelection();
            this.openSpaceBook(space, book);
          },
        );
      } else {
        tools.summary.setText(t("已选择 {0} 个文件", selected.length));
      }
      const capabilities = this.spaceCapabilities(selected, { multi: selected.length > 1 });
      for (const capability of capabilities.slice(0, 4)) {
        const label = CAPABILITY_LABELS[capability.id] || capability.title;
        this.toolButton(
          tools.actions,
          t(label),
          () => this.openWorkshopForSelection(space, capability),
          { primary: capability.primary === true },
        );
      }
      this.toolButton(tools.actions, t("书坊"), () => void window.qbrOpenWorkshop?.("tasks"));
      if (space.books?.length && selected.length < space.books.length) {
        this.toolButton(tools.actions, t("全选"), () => this.selectAllSources(space));
      }
      this.toolButton(tools.actions, t("清除"), () => this.clearSourceSelection());
    }

    toolButton(host, label, handler, { primary = false } = {}) {
      const button = host.createEl("button", {
        cls: `qbr-space-tool-btn${primary ? " mod-cta" : ""}`,
        text: label,
        attr: { type: "button" },
      });
      button.addEventListener("click", handler);
      return button;
    }

    isReadableBook(book) {
      const extension = String(book?.name || book?.title || "").split(".").pop()?.toLowerCase() || "";
      return BOOK_EXTENSIONS.includes(extension);
    }

    spaceCapabilities(books, { multi = false } = {}) {
      const lists = books.map((book) => {
        const extension = String(book?.name || book?.title || "").split(".").pop()?.toLowerCase() || "";
        return workshopCapabilitiesFor({ extension })
          .filter((capability) => CAPABILITY_TOOLS.has(String(capability.tool || "")) && capability.action !== "ai-prompt" && !capability.hidden);
      }).filter((list) => list.length);
      if (!lists.length) return [];
      const common = lists[0].filter((capability) => (
        lists.every((list) => list.some((item) => item.id === capability.id))
      ));
      return multi ? common.filter((capability) => capability.tool !== "book") : common;
    }

    openWorkshopForSelection(space, capability) {
      const vaultRoot = String(window.qbrDesktop?.paths?.vaultRoot || "");
      const sources = (this._selectedSources || [])
        .map((book) => spaceVaultRelative(book.path, vaultRoot))
        .filter(Boolean);
      if (!sources.length) return;
      const opened = window.qbrOpenWorkshop?.(capability, {
        sources,
        spaceId: space.id,
        spaceRoot: space.root,
      });
      if (!opened) new Notice(t("当前环境不能打开书坊"));
    }

    shouldGroupSpace(space, outputs = []) {
      const groups = new Set(outputs.map((output) => outputGroupKey(output.category)));
      const chats = this.spaceChats(space);
      if (space.books?.length) groups.add("books");
      if (chats.length) groups.add("notes");
      if (chats.length) return true;
      return (space.books?.length || 0) + outputs.length + chats.length >= SECTION_MIN_FILES || groups.size >= 3;
    }

    _spaceChatBook(space, chat) {
      const target = String(chat?.bookPath || "").replace(/\\/g, "/").toLowerCase();
      if (!target) return null;
      const base = String(app.vault.adapter?.getBasePath?.() || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const absoluteTarget = base && !target.startsWith("/") && !/^[a-z]:\//.test(target)
        ? `${base}/${target}`
        : target;
      const root = String(space?.root || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const folder = root.split("/").pop() || "";
      for (const book of space?.books || []) {
        const absolute = String(book.path || "").replace(/\\/g, "/").toLowerCase();
        const relative = String(book.relativePath || "").replace(/\\/g, "/").toLowerCase();
        if (absoluteTarget === absolute || target === absolute) return book;
        if (relative && (target === relative || target === `${root}/${relative}`)) return book;
        if (relative && folder && target.endsWith(`/${folder}/${relative}`)) return book;
      }
      return null;
    }

    spaceChats(space) {
      const history = Array.isArray(plugin.settings?.aiChatHistory) ? plugin.settings.aiChatHistory : [];
      const chats = [];
      const seen = new Set();
      for (const chat of history) {
        if (!chat?.id || seen.has(chat.id)) continue;
        const book = this._spaceChatBook(space, chat);
        if (!book) continue;
        seen.add(chat.id);
        chats.push({ chat, book });
      }
      return chats.sort((a, b) => (Number(b.chat.updatedAt) || 0) - (Number(a.chat.updatedAt) || 0));
    }

    _applySourceSelection(space, books) {
      this._selectedSources = (books || []).filter(Boolean);
      this._selectedSourcePaths = new Set(this._selectedSources.map((book) => book.path));
      for (const card of this.contentEl.querySelectorAll(".qbr-space-book[data-source-path]")) {
        const selected = this._selectedSourcePaths.has(card.getAttribute("data-source-path"));
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));
        const check = card.querySelector(".qbr-space-source-check");
        if (check) check.checked = selected;
      }
      this._filterContent(this._query);
      this._updateToolsBar(space);
    }

    _restoreSourceSelection(space) {
      if (!this._selectedSourcePaths.size) {
        this._updateToolsBar(space);
        return;
      }
      const byPath = new Map((space.books || []).map((book) => [book.path, book]));
      const books = [...this._selectedSourcePaths].map((path) => byPath.get(path)).filter(Boolean);
      this._selectedSources = books;
      this._selectedSourcePaths = new Set(books.map((book) => book.path));
      this._applySourceSelection(space, books);
    }

    selectSource(space, book, { additive = false } = {}) {
      if (!book) return;
      if (!additive) {
        this._applySourceSelection(space, [book]);
        return;
      }
      const selected = new Map(this._selectedSources.map((item) => [item.path, item]));
      if (selected.has(book.path)) selected.delete(book.path);
      else selected.set(book.path, book);
      this._applySourceSelection(space, [...selected.values()]);
    }

    toggleSourceSelection(space, book) {
      this.selectSource(space, book, { additive: true });
    }

    selectAllSources(space) {
      this._applySourceSelection(space, (space.books || []).slice());
    }

    clearSourceSelection() {
      if (!this._selectedSources.length && !this._selectedSourcePaths.size) return;
      this._selectedSources = [];
      this._selectedSourcePaths = new Set();
      for (const card of this.contentEl.querySelectorAll(".qbr-space-book.is-selected")) {
        card.classList.remove("is-selected");
        card.setAttribute("aria-pressed", "false");
      }
      for (const check of this.contentEl.querySelectorAll(".qbr-space-source-check")) check.checked = false;
      this._filterContent(this._query);
      const space = this.spaces.find((item) => item.id === this.selectedId) || null;
      this._updateToolsBar(space);
    }

    _restoreHomeSelection() {
      if (!this._selectedHomePath) return;
      let found = false;
      for (const card of this.contentEl.querySelectorAll(".qbr-home-book-card")) {
        const selected = card.getAttribute("data-home-path") === this._selectedHomePath;
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));
        if (selected) found = true;
      }
      if (!found) this._selectedHomePath = "";
    }

    selectHomeCard(file) {
      this._selectedHomePath = file.path || "";
      for (const node of this.contentEl.querySelectorAll(".qbr-home-book-card")) {
        const selected = node.getAttribute("data-home-path") === this._selectedHomePath;
        node.classList.toggle("is-selected", selected);
        node.setAttribute("aria-pressed", String(selected));
      }
    }

    clearHomeSelection() {
      if (!this._selectedHomePath) return;
      this._selectedHomePath = "";
      for (const card of this.contentEl.querySelectorAll(".qbr-home-book-card.is-selected")) {
        card.classList.remove("is-selected");
        card.setAttribute("aria-pressed", "false");
      }
    }

    renderSpaceSections(host, space, outputs = []) {
      const groups = new Map();
      for (const output of outputs) {
        const key = outputGroupKey(output.category);
        const list = groups.get(key) || [];
        list.push(output);
        groups.set(key, list);
      }
      const chats = this.spaceChats(space);
      for (const group of SPACE_SECTION_GROUPS) {
        if (group.key === "books") {
          if (!space.books?.length) continue;
          const section = this.createFileSection(host, space, "books", t(group.label), space.books.length);
          for (const book of space.books) {
            this.renderBookCard(section.body, {
              id: book.id,
              title: book.title || book.name,
              name: book.name,
              size: book.size,
              path: book.path,
              percent: this.bookPercent(book),
            }, space);
          }
          continue;
        }
        const list = group.key === "notes" ? (groups.get("notes") || []) : groups.get(group.key);
        const count = (list?.length || 0) + (group.key === "notes" ? chats.length : 0);
        if (!count) continue;
        const section = this.createFileSection(host, space, `outputs-${group.key}`, t(group.label), count);
        for (const output of list || []) {
          const source = (space.books || []).find((book) => book.id === output.sourceId);
          this.renderOutputCard(section.body, space, output, source);
        }
        if (group.key === "notes") {
          for (const item of chats) this.renderChatCard(section.body, item.chat, item.book);
        }
      }
    }

    _sectionStateKey(space) {
      return `qbr-space-sections-${space?.id || ""}`;
    }

    _readSectionState(space) {
      try {
        const parsed = JSON.parse(localStorage.getItem(this._sectionStateKey(space)) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    _isSectionCollapsed(space, key) {
      return Boolean(this._readSectionState(space)[key]);
    }

    _setSectionCollapsed(space, key, collapsed) {
      try {
        const state = this._readSectionState(space);
        if (collapsed) state[key] = true;
        else delete state[key];
        localStorage.setItem(this._sectionStateKey(space), JSON.stringify(state));
      } catch {
        // localStorage is optional; the section still toggles for this render.
      }
    }

    createFileSection(host, space, key, label, count) {
      const section = host.createDiv("qbr-space-file-section");
      const collapsed = this._isSectionCollapsed(space, key);
      section.dataset.sectionKey = key;
      section.dataset.collapsed = collapsed ? "1" : "0";
      const head = section.createEl("button", {
        cls: "qbr-space-section-head",
        attr: { type: "button", "aria-expanded": String(!collapsed) },
      });
      const chevron = head.createSpan("qbr-space-section-chev");
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
      head.createSpan({ cls: "qbr-space-section-title", text: label });
      head.createSpan({ cls: "qbr-space-section-count", text: String(count) });
      const body = section.createDiv("qbr-space-books qbr-space-section-body");
      body.hidden = collapsed;
      head.addEventListener("click", () => {
        const next = !body.hidden;
        body.hidden = next;
        section.dataset.collapsed = next ? "1" : "0";
        head.setAttribute("aria-expanded", String(!next));
        setIcon(chevron, next ? "chevron-right" : "chevron-down");
        this._setSectionCollapsed(space, key, next);
      });
      return { section, head, body };
    }

    lastKey(space) {
      return `qbr-space-last-${space.id}`;
    }

    lastBook(space) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(this.lastKey(space)) || "null"); } catch { stored = null; }
      const path = String(stored?.path || "");
      return (space.books || []).find((book) => book.path === path) || space.books?.[0] || null;
    }

    bookPercent(book) {
      const base = String(app.vault.adapter?.getBasePath?.() || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const absolute = String(book.path || "").replace(/\\/g, "/");
      const relative = base && absolute.toLowerCase().startsWith(`${base.toLowerCase()}/`)
        ? absolute.slice(base.length + 1)
        : absolute;
      const percent = Number(plugin.progress?.[relative]?.percent);
      return Number.isFinite(percent) ? percent : 0;
    }

    async openSpaceBook(space, book) {
      const api = bridge();
      let target = book;
      // A file can be renamed outside the app while this card is still on
      // screen. Sync first and resolve the source by id, not by the stale path.
      try {
        await api?.sync?.(space.id);
        const spaces = await api?.list?.();
        if (spaces) {
          this.spaces = spaces;
          const updatedSpace = spaces.find((item) => item.id === space.id);
          const updated = updatedSpace?.books?.find((item) => item.id === book.id)
            || updatedSpace?.books?.find((item) => item.relativePath === book.relativePath)
            || updatedSpace?.books?.find((item) => item.name === book.name);
          if (!updated) {
            void this.refresh();
            return;
          }
          target = updated;
        }
      } catch (error) {
        console.warn("UV Reader: could not sync the space before opening", error);
      }
      try {
        localStorage.setItem(this.lastKey(space), JSON.stringify({ path: target.path, at: Date.now() }));
      } catch { /* localStorage is optional */ }
      void onOpenBook?.(target.path);
    }

    renderContinue(host, space, book) {
      const percent = this.bookPercent(book);
      const card = host.createDiv("qbr-space-continue");
      card.setAttribute("data-file-name", book.name || book.title || "");
      const copy = card.createDiv("qbr-space-continue-copy");
      copy.createDiv({ cls: "qbr-space-continue-kicker", text: t("继续上次") });
      copy.createDiv({ cls: "qbr-space-continue-title", text: book.title || book.name });
      copy.createDiv({ cls: "qbr-space-continue-meta", text: `${fileTypeOf(book.name || book.title).label} · ${formatBytes(book.size)}${percent ? ` · ${percent}%` : ""}` });
      const actions = card.createDiv("qbr-space-continue-actions");
      const progress = actions.createDiv("qbr-space-continue-progress");
      const track = progress.createEl("i");
      track.createEl("b").style.width = `${Math.max(0, Math.min(100, percent))}%`;
      const open = actions.createEl("button", { cls: "qbr-space-btn mod-cta", text: t("继续阅读"), attr: { type: "button" } });
      open.addEventListener("click", () => this.openSpaceBook(space, book));
    }

    renderHeader(host, space) {
      const row = host.createDiv("qiaomu-reader-lib-actions qbr-space-action-row");
      const path = row.createDiv("qbr-space-path");
      path.setText(space?.root || t("书库中的书籍；创建空间来组织一本书或一批文档。"));
      const actions = row.createDiv("qbr-space-head-actions");
      if (space) {
        const open = actions.createEl("button", { cls: "qbr-space-btn", text: t("打开目录"), attr: { type: "button" } });
        open.addEventListener("click", () => void bridge()?.openFolder?.(space.id));
        const importBtn = actions.createEl("button", { cls: "qbr-space-btn mod-cta", text: this.importing ? t("正在导入…") : t("导入文件..."), attr: { type: "button" } });
        importBtn.disabled = this.importing;
        importBtn.addEventListener("click", () => void this.importInto(space));
        const library = actions.createEl("button", { cls: "qbr-space-btn", text: t("从书库导入..."), attr: { type: "button" } });
        library.addEventListener("click", () => this.openLibraryImport(space));
      } else {
        actions.addClass("qbr-home-actions");
        const open = actions.createEl("button", { cls: "qbr-space-btn mod-cta", text: t("打开书籍…"), attr: { type: "button" } });
        open.addEventListener("click", () => void onOpenFileDialog?.());
        const projects = actions.createEl("button", { cls: "qbr-space-btn", text: t("阅读项目"), attr: { type: "button" } });
        projects.addEventListener("click", () => plugin.openReadingProjects?.({ mode: "manage" }));
        const quiz = actions.createEl("button", { cls: "qbr-space-btn", text: t("答题页"), attr: { type: "button" } });
        quiz.addEventListener("click", () => void window.qbrOpenQuizList?.());
      }
    }

    renderMissing(host, space) {
      const empty = host.createDiv("qbr-space-empty");
      empty.createDiv({ cls: "qbr-space-empty-title", text: t("空间目录不可用") });
      empty.createDiv({
        cls: "qbr-space-empty-sub",
        text: `${t("找不到：{0}", space.root)}\n${t("请把目录恢复，或在空间设置里重新绑定。")}`,
      });
    }

    renderEmpty(host, space) {
      const empty = host.createDiv("qbr-space-empty");
      empty.createDiv({ cls: "qbr-space-empty-icon", text: "↧" });
      empty.createDiv({ cls: "qbr-space-empty-title", text: t("这个空间还没有内容") });
      empty.createDiv({
        cls: "qbr-space-empty-sub",
        text: t("导入的书籍和文档会复制到空间目录。之后的笔记、译文、提取结果、答题页和精修电子书，也会保存在这个空间里。"),
      });
      const actions = empty.createDiv("qbr-space-empty-actions");
      const importBtn = actions.createEl("button", { cls: "mod-cta", text: t("导入文件..."), attr: { type: "button" } });
      importBtn.addEventListener("click", () => void this.importInto(space));
      const library = actions.createEl("button", { text: t("从书库导入..."), attr: { type: "button" } });
      library.addEventListener("click", () => this.openLibraryImport(space));
      const drop = empty.createDiv({ cls: "qbr-space-empty-hint", text: t("也可以把文件直接拖到这里") });
      const formats = empty.createDiv("qbr-space-formats");
      for (const label of ["EPUB", "PDF", "MOBI", "AZW3", "DOCX", "Markdown", t("图片")]) formats.createSpan({ text: label });
      empty.createDiv({ cls: "qbr-space-empty-foot", text: t("源文件会复制到 {0}\\books", space.root) });
      this.bindDrop(drop, space);
    }

    bindDrop(host, space) {
      host.addEventListener("dragover", (event) => {
        event.preventDefault();
        host.addClass("is-dragging");
      });
      host.addEventListener("dragleave", () => host.removeClass("is-dragging"));
      host.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        host.removeClass("is-dragging");
        const files = Array.from(event.dataTransfer?.files || []);
        const paths = files.map((file) => window.qbrDesktop?.pathForFile?.(file) || file.path || "").filter(Boolean);
        void this.importInto(space, paths);
      });
    }

    renderFileType(card, name) {
      const meta = fileTypeOf(name);
      const badge = card.createDiv("qbr-space-book-type");
      badge.style.setProperty("--qbr-file-color", meta.color);
      const icon = badge.createDiv("qbr-space-book-type-icon");
      icon.innerHTML = iconResolver(meta.icon);
      badge.createSpan({ cls: "qbr-space-book-type-label", text: meta.label });
    }

    renderBookCard(grid, book, space = null) {
      const card = grid.createDiv("qbr-space-book");
      card.setAttribute("data-file-name", book.name || book.title || "");
      if (space) {
        const check = card.createEl("input", {
          cls: "qbr-space-source-check",
          attr: { type: "checkbox", "aria-label": t("选择文件") },
        });
        check.checked = this._selectedSourcePaths.has(book.path);
        check.addEventListener("click", (event) => event.stopPropagation());
        check.addEventListener("change", (event) => {
          event.stopPropagation();
          this.toggleSourceSelection(space, book);
        });
      }
      this.renderFileType(card, book.name || book.title);
      const copy = card.createDiv("qbr-space-book-copy");
      copy.createDiv({ cls: "qbr-space-book-title", text: book.title });
      copy.createDiv({ cls: "qbr-space-book-meta", text: `${fileTypeOf(book.name || book.title).label} · ${formatBytes(book.size)}` });
      const bar = copy.createDiv("qbr-space-book-progress");
      const track = bar.createEl("i");
      const fill = track.createEl("b");
      fill.style.width = `${Math.max(0, Math.min(100, Number(book.percent) || 0))}%`;
      bar.createSpan({ text: book.percent ? `${book.percent}%` : t("未开始") });
      if (space) {
        card.setAttribute("data-source-path", book.path || "");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-pressed", String(this._selectedSourcePaths.has(book.path)));
        card.addEventListener("click", (event) => {
          if (event.target?.closest?.(".qbr-space-source-check")) return;
          this.selectSource(space, book, {
            additive: event.ctrlKey || event.metaKey || event.shiftKey,
          });
        });
        card.addEventListener("dblclick", (event) => {
          event.preventDefault();
          this.clearSourceSelection();
          this.openSpaceBook(space, book);
        });
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.clearSourceSelection();
            this.openSpaceBook(space, book);
          } else if (event.key === " ") {
            event.preventDefault();
            this.selectSource(space, book);
          }
        });
      } else {
        card.addEventListener("click", () => void onOpenBook?.(book.path));
      }
    }

    renderDerivedDocs(host, space, outputs = []) {
      if (!outputs.length) return;
      const grid = host.createDiv("qbr-space-books qbr-space-derived-books");
      grid.createDiv({ cls: "qbr-space-grid-section", text: t("衍生文档") });
      for (const output of outputs) {
        const source = (space.books || []).find((book) => book.id === output.sourceId);
        this.renderOutputCard(grid, space, output, source);
      }
    }

    renderOutputCard(grid, space, output, source) {
      const category = SPACE_OUTPUT_TYPES[output.category] || SPACE_OUTPUT_TYPES.other;
      const card = grid.createDiv("qbr-space-book qbr-space-output-card");
      card.setAttribute("data-file-name", output.name || "");
      card.setAttribute("data-source-id", output.sourceId || "");
      this.renderFileType(card, output.name);
      const copy = card.createDiv("qbr-space-book-copy");
      copy.createDiv({ cls: "qbr-space-book-title", text: output.name });
      const meta = copy.createDiv("qbr-space-book-meta");
      const kind = meta.createSpan({ cls: "qbr-space-derived-kind", text: t(category.label) });
      kind.style.color = category.color;
      meta.createSpan({ text: ` · ${formatBytes(output.size)}` });
      if (source) {
        copy.createDiv({ cls: "qbr-space-derived-source", text: t("来自《{0}》", source.title || source.name) });
      }
      const actions = card.createDiv("qbr-space-card-actions");
      const remove = actions.createEl("button", {
        cls: "qbr-space-card-delete",
        attr: { type: "button", "aria-label": t("删除衍生文档") },
      });
      setIcon(remove, "trash");
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.deleteOutput(space, output);
      });
      card.addEventListener("click", () => this.openOutput(output, space));
    }

    renderChatCard(grid, chat, book) {
      const title = String(chat.title || chat.id || "");
      const card = grid.createDiv("qbr-space-book qbr-space-chat-card");
      card.setAttribute("data-file-name", title);
      card.setAttribute("data-source-id", book?.id || "");
      const badge = card.createDiv("qbr-space-book-type");
      badge.style.setProperty("--qbr-file-color", "#b06ab3");
      const icon = badge.createDiv("qbr-space-book-type-icon");
      icon.innerHTML = iconResolver("message-square");
      badge.createSpan({ cls: "qbr-space-book-type-label", text: "AI" });
      const copy = card.createDiv("qbr-space-book-copy");
      copy.createDiv({ cls: "qbr-space-book-title", text: title });
      const meta = copy.createDiv({ cls: "qbr-space-book-meta" });
      meta.createSpan({ cls: "qbr-space-derived-kind", text: t("对话") });
      const when = Number(chat.updatedAt) || Number(chat.createdAt) || 0;
      if (when) meta.createSpan({ text: ` · ${new Date(when).toLocaleDateString()}` });
      if (book) {
        copy.createDiv({ cls: "qbr-space-derived-source", text: t("来自《{0}》", book.title || book.name) });
      }
      card.addEventListener("click", () => {
        if (typeof window.qbrOpenChat === "function") window.qbrOpenChat(chat.id);
      });
    }

    async deleteOutput(space, output) {
      const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(t("删除「{0}」？\n\n文件会移到回收站。", output.name))
        : false;
      if (!confirmed) return;
      const api = bridge();
      if (typeof api?.deleteOutput !== "function") {
        new Notice(t("当前环境不能删除衍生文档"));
        return;
      }
      try {
        await api.deleteOutput(space.id, output.relativePath);
        new Notice(t("已删除「{0}」", output.name));
        await this.refresh();
      } catch (error) {
        new Notice(t("删除失败：{0}", String(error?.message || error)), 8000);
      }
    }

    openOutput(output, space = null) {
      const extension = String(output?.name || "").split(".").pop()?.toLowerCase() || "";
      if (["epub", "pdf", "cbz", "fb2", "fbz", "mobi", "azw", "azw3"].includes(extension)) {
        void onOpenBook?.(output.path);
        return;
      }
      const isQuizPage = isQuizOutput(output);
      if (isQuizPage && typeof window.qbrOpenQuiz === "function") {
        window.qbrOpenQuiz(output.path, { origin: "space", spaceId: space?.id || "" });
        return;
      }
      void window.qbrDesktop?.openPath?.(output.path);
    }

    async importInto(space, suppliedPaths = null) {
      const api = bridge();
      if (!api?.importFiles) {
        new Notice(t("当前环境不能导入文件"));
        return;
      }
      let paths = suppliedPaths;
      if (!paths) {
        try { paths = await api.pickFiles(); } catch { paths = []; }
      }
      if (!paths?.length) return;
      this.importing = true;
      this.render();
      try {
        const result = await api.importFiles(space.id, paths);
        const imported = result?.imported?.length || 0;
        const duplicates = result?.duplicates?.length || 0;
        const failed = result?.failed || [];
        if (imported) new Notice(t("已导入 {0} 个文件到「{1}」", imported, space.name), 5000);
        if (duplicates) new Notice(t("{0} 个文件已在空间中，已复用现有副本", duplicates), 5000);
        if (failed.length) new Notice(t("{0} 个文件导入失败：{1}", failed.length, failed[0].error), 8000);
        await this.refresh();
      } catch (error) {
        new Notice(t("导入失败：{0}", String(error?.message || error)), 8000);
      } finally {
        this.importing = false;
        this.render();
      }
    }

    openLibraryImport(space) {
      const existing = new Set((space.books || []).map((book) => book.path));
      const files = app.vault.getFiles()
        .filter((file) => BOOK_EXTENSIONS.includes(file.extension) && plugin.isLibraryBook?.(file) !== false)
        .filter((file) => !existing.has(app.vault.adapter.getFullPath(file.path)))
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0));
      if (!files.length) {
        new Notice(t("书库里还没有可导入的书籍"));
        return;
      }
      new LibraryImportModal(app, {
        t,
        space,
        files,
        onImport: (paths) => this.importInto(space, paths),
      }).open();
    }
  }

  return new SpacesView(leaf);
}
