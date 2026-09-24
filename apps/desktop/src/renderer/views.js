import { ItemView, setIcon } from "obsidian";

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
  const { app, plugin, onOpenBook, onOpenLibrary, onOpenFileDialog } = options;

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
      const books = app.vault.getFiles().filter((file) => BOOK_EXTENSIONS.includes(file.extension)).length;
      return `${progress}:${books}`;
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
      head.createDiv({ cls: "qbr-home-title", text: "UV Reader" });
      const actions = head.createDiv("qbr-home-actions");
      const open = actions.createEl("button", { cls: "mod-cta", text: "打开书籍…" });
      open.addEventListener("click", () => void onOpenFileDialog());
      const library = actions.createEl("button", { text: "书库" });
      library.addEventListener("click", () => void onOpenLibrary());

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
        .filter((file) => BOOK_EXTENSIONS.includes(file.extension))
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
