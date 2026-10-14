import { ItemView, Notice, setIcon } from "obsidian";

import { iconResolver } from "./icons.js";
import { DOCVORTEX_FORMATS, DOCVORTEX_INPUTS, EBOOK_TARGETS, IMAGE_BOOK_TARGETS, docvortexFormatExt } from "../shared/workshop-formats.js";
import { BOOK_STYLE_DEFAULTS, BOOK_THEMES, COVER_PALETTES, renderBookCss } from "../shared/book-styles.js";
import { FONT_PAIRINGS, findPairing, pairingStacks } from "../shared/book-fonts.js";
import { coverHtml } from "../shared/cover-template.js";
import { chapterStats, mergeChapters, moveChapter, renameChapter, splitChapter } from "../shared/book-chapters.js";
import { markdownToHtml, splitTextChapters } from "../main/text-book.js";
import { EXTRACT_MODES, IMAGE_INPUTS, extractionKind } from "../shared/extract-formats.js";
import { splitMarkdownChapters, unwrapProseFences } from "../shared/markdown-fix.js";
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

// 快速成书的示例文字(选中书稿后用它开头的内容做样张)。
function bookSampleText() {
  return [
    "第一章 起风了",
    "这是一段示例文字，用来看字号、行距、边距和缩进的效果。单栏流式排版交给阅读器分页，宽度自适应设备，不写死版心。",
    "第二段用来观察段间距与两端对齐。中文标点也一起看看：“引号”、（括号）、——破折号。",
  ].join("\n\n");
}

function bookSampleHtml(text) {
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 6);
  const out = [];
  blocks.forEach((block, index) => {
    const first = block.split("\n")[0].trim();
    const rest = block.split("\n").slice(1).map((line) => line.trim()).filter(Boolean).join("");
    if (index === 0 && first.length <= 30) {
      out.push(`<h1>${escapeHtmlText(first)}</h1>`);
      if (rest) out.push(`<p>${escapeHtmlText(rest)}</p>`);
      return;
    }
    out.push(`<p>${escapeHtmlText([first, rest].filter(Boolean).join(""))}</p>`);
  });
  if (!out.length) out.push("<h1>第一章</h1><p>这里显示书稿的排版样张。</p>");
  return out.join("\n");
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

// 本地 MinerU 状态 → 面板/设置里的一行文案(书坊面板与设置页共用)。
export function describeMineruStatus(result) {
  const url = String(result?.url || "");
  const version = result?.version ? ` · 版本 ${result.version}` : "";
  const detail = result?.detail ? ` · ${result.detail}` : "";
  switch (String(result?.status || "")) {
    case "running": return `运行中${version}(${url}${detail})`;
    case "starting": return "启动中…首次加载模型约 10–15 秒";
    case "external": return `外部服务(${url})，不由应用管理`;
    case "missing": return String(result?.detail || "没找到 mineru-kit:在设置 → 书坊里填程序路径");
    case "error": return `启动失败:${String(result?.detail || "未知错误")}`;
    default: return `未运行(${url || "http://127.0.0.1:8123"})；点「启动服务」拉起`;
  }
}

// 授权码在 SecretStorage 里的 id(与主进程约定)。
const KINDLE_SECRET_ID = "kindle-smtp";

// 面板里指向「设置 → 书坊」的入口:全局配置与链路检测都集中在那里。
function addSettingsLink(row, text) {
  const button = row.createEl("button", { text: "打开 设置 → 书坊" });
  button.addEventListener("click", () => {
    // 目标 tab 记在 window 上:设置视图首次 onOpen 时会在 display() 之前应用;
    // 已经打开的情况直接重绘到那一页(不依赖 DOM 时序)。
    window.__qbrSettingsTab = "workshop";
    const settingsTab = window.__qbrPlugin?.settingsTab;
    if (settingsTab) {
      settingsTab._tab = "workshop";
      try {
        if (settingsTab.containerEl?.isConnected) settingsTab.display();
      } catch { /* 还没挂载就算了,onOpen 会用上面的标记 */ }
    }
    document.querySelector('[data-route="settings"]')?.click();
  });
  row.createSpan({ cls: "qbr-workshop-hint", text });
  return button;
}

export function createSettingsView(leaf, options) {
  const { plugin } = options;

  // 「书坊」设置 tab:书坊 / pdf_tool / MinerU / DocVortex / Calibre 的全局配置与链路检测
  // 都集中在这里(与「存储与同步」同级),各工具面板只做每次任务的选项。
  function drawWorkshopSettings(host) {
    const settings = plugin?.settings || {};
    const persist = (key, value) => {
      if (!plugin?.settings) return;
      plugin.settings[key] = value;
      void plugin.saveAll?.();
    };
    const bridge = typeof window !== "undefined" ? window.qbrDesktop : null;
    const notice = (text) => new Notice(text);
    const save = (text) => {
      notice(text);
    };
    // 边打边存:点检测/启动时不需要先让输入框失焦。
    const bind = (input, key, message) => {
      input.addEventListener("input", () => persist(key, input.value.trim()));
      input.addEventListener("change", () => {
        persist(key, input.value.trim());
        save(message);
      });
    };
    // 链路探测:直接在原地显示结果(不再入任务队列)。
    const runProbe = async (status, label, run) => {
      status.setText(`${label}检测中…`);
      try {
        const result = await run();
        const detail = String(result?.detail || "").trim();
        status.setText(result?.ok ? `可用${detail ? ` · ${detail}` : ""}` : `不可用:${detail || "没有返回原因"}`);
      } catch (error) {
        status.setText(`检测失败:${String(error?.message || error)}`);
      }
    };

    const root = host.createDiv("qbr-workshop-settings");

    // 1. 书坊开关
    const toggleCard = root.createDiv("qbr-workshop-card");
    toggleCard.createEl("h3", { text: "书坊" });
    const switchRow = toggleCard.createDiv("qbr-workshop-row");
    const switchLabel = switchRow.createEl("label", { cls: "qbr-workshop-opt" });
    const switchInput = switchLabel.createEl("input", { attr: { type: "checkbox" } });
    switchInput.checked = settings.workshopEnabled !== false;
    switchLabel.createSpan({ text: "在导航里显示「书坊」(关闭后隐藏整页,便于回退)" });
    switchInput.addEventListener("change", () => {
      persist("workshopEnabled", Boolean(switchInput.checked));
      save("书坊开关已保存;导航立即生效。");
    });
    toggleCard.createDiv({ cls: "qbr-workshop-hint", text: "书坊负责:文字层与可搜索 PDF、格式转换、内容提取、电子书制作、发送到 Kindle。下面的配置对全部工具生效。" });

    // 2. 文字层 / 扫描版 PDF(pdf_tool sidecar)
    const ocrCard = root.createDiv("qbr-workshop-card");
    ocrCard.createEl("h3", { text: "扫描版 PDF 文字层" });
    ocrCard.createDiv({ cls: "qbr-workshop-hint", text: "本地 OCR sidecar(pdf_tool/reader/server.py)给扫描页加一层看不见的文字:阅读器里能选中 / 搜索 / 划线,原件不变。" });
    const autoRow = ocrCard.createDiv("qbr-workshop-row");
    const autoLabel = autoRow.createEl("label", { cls: "qbr-workshop-opt" });
    const autoInput = autoLabel.createEl("input", { attr: { type: "checkbox" } });
    autoInput.checked = settings.ocrScannedPdf !== false;
    autoLabel.createSpan({ text: "打开扫描版 PDF 时自动生成文字层" });
    autoInput.addEventListener("change", () => {
      persist("ocrScannedPdf", Boolean(autoInput.checked));
      save("文字层设置已保存;下次打开生效。");
    });
    const sidecarRow = ocrCard.createDiv("qbr-workshop-row");
    sidecarRow.createSpan({ cls: "qbr-workshop-hint", text: "pdf_tool 目录" });
    const sidecarDir = sidecarRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "含 pdf_tool/reader/server.py 的目录,如 D:\\projects\\auto_chat" } });
    sidecarDir.value = String(settings.ocrSidecarDir || "");
    bind(sidecarDir, "ocrSidecarDir", "pdf_tool 目录已保存;新任务生效。");
    const pythonRow = ocrCard.createDiv("qbr-workshop-row");
    pythonRow.createSpan({ cls: "qbr-workshop-hint", text: "Python" });
    const pythonInput = pythonRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空用 python(PATH 上的)" } });
    pythonInput.value = String(settings.ocrPython || "");
    bind(pythonInput, "ocrPython", "Python 路径已保存。");
    const ocrTools = ocrCard.createDiv("qbr-workshop-row");
    const ocrProbe = ocrTools.createEl("button", { text: "检测文字层链路" });
    const ocrStatus = ocrTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    ocrProbe.addEventListener("click", () => void runProbe(ocrStatus, "", () => bridge?.probe?.ocr(settings)));

    // 3. 本地 MinerU(公式优先 / 内容提取共用)
    const mineruCard = root.createDiv("qbr-workshop-card");
    mineruCard.createEl("h3", { text: "MinerU(公式优先 / 内容提取)" });
    mineruCard.createDiv({ cls: "qbr-workshop-hint", text: "公式优先与内容提取的 MinerU 链路都用这里的配置:填了本地服务地址就优先本地(不出网、免凭据),否则用云端凭据。" });
    const tokenRow = mineruCard.createDiv("qbr-workshop-row");
    tokenRow.createSpan({ cls: "qbr-workshop-hint", text: "MinerU 凭据" });
    const tokenInput = tokenRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "云端 token;留空用环境变量 MINERU_API_KEY" } });
    tokenInput.value = String(settings.mineruToken || "");
    bind(tokenInput, "mineruToken", "MinerU 凭据已保存;新任务生效。");
    const localRow = mineruCard.createDiv("qbr-workshop-row");
    localRow.createSpan({ cls: "qbr-workshop-hint", text: "本地 MinerU 服务" });
    const localInput = localRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "如 http://127.0.0.1:8123;留空走云端" } });
    localInput.value = String(settings.mineruLocalUrl || "");
    bind(localInput, "mineruLocalUrl", "本地 MinerU 服务地址已保存;新任务生效。");
    const exeRow = mineruCard.createDiv("qbr-workshop-row");
    exeRow.createSpan({ cls: "qbr-workshop-hint", text: "本地 MinerU 程序" });
    const exeInput = exeRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空自动查找(常见位置 / MINERU_LOCAL_CMD / 同目录 python);也可手填完整路径" } });
    exeInput.value = String(settings.mineruLocalExe || "");
    bind(exeInput, "mineruLocalExe", "本地 MinerU 程序已保存。");
    const autoStartRow = mineruCard.createDiv("qbr-workshop-row");
    const autoStartLabel = autoStartRow.createEl("label", { cls: "qbr-workshop-opt" });
    const autoStartInput = autoStartLabel.createEl("input", { attr: { type: "checkbox" } });
    autoStartInput.checked = settings.mineruLocalAutoStart !== false;
    autoStartLabel.createSpan({ text: "启动应用时自动开启本地 MinerU 服务(退出时只关自己拉起的那个)" });
    autoStartInput.addEventListener("change", () => {
      persist("mineruLocalAutoStart", Boolean(autoStartInput.checked));
      save("自动开启设置已保存。");
    });
    const mineruTools = mineruCard.createDiv("qbr-workshop-row");
    const mineruStatus = mineruTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    // 以输入框当前值为准(用户可能打完路径没失焦就点检测),先落盘再传给主进程。
    const mineruSettings = () => {
      const live = {
        exe: exeInput.value.trim(),
        url: localInput.value.trim(),
        autoStart: Boolean(autoStartInput.checked),
        ocrPython: pythonInput.value.trim(),
        ocrSidecarDir: sidecarDir.value.trim(),
      };
      if (plugin?.settings) {
        plugin.settings.mineruLocalExe = live.exe;
        plugin.settings.mineruLocalUrl = live.url;
        plugin.settings.mineruLocalAutoStart = live.autoStart;
        plugin.settings.ocrPython = live.ocrPython;
        plugin.settings.ocrSidecarDir = live.ocrSidecarDir;
        void plugin.saveAll?.();
      }
      return live;
    };
    const runMineru = async (start) => {
      if (!bridge?.mineru) {
        mineruStatus.setText("这个宿主不支持本地服务检测");
        return;
      }
      mineruStatus.setText(start ? "启动中…" : "检测中…");
      try {
        const result = start ? await bridge.mineru.ensure(mineruSettings()) : await bridge.mineru.status(mineruSettings());
        const tried = Array.isArray(result?.tried) && result.tried.length ? `(已试:${result.tried.slice(0, 4).join("、")})` : "";
        mineruStatus.setText(`${describeMineruStatus(result)}${tried}`);
      } catch (error) {
        mineruStatus.setText(`检测失败:${String(error?.message || error)}`);
      }
    };
    const checkMineru = mineruTools.createEl("button", { text: "检测本地 MinerU" });
    checkMineru.addEventListener("click", () => void runMineru(false));
    const startMineru = mineruTools.createEl("button", { text: "启动服务" });
    startMineru.addEventListener("click", () => void runMineru(true));
    const clearMineru = mineruTools.createEl("button", { text: "清理 MinerU 缓存" });
    clearMineru.addEventListener("click", async () => {
      if (!bridge?.mineru?.clearCaches) {
        notice("这个宿主不支持清理 MinerU 缓存");
        return;
      }
      try {
        const result = await bridge.mineru.clearCaches(mineruSettings());
        const total = Number(result?.totalBytes) || 0;
        const size = total >= 1024 * 1024 ? `${(total / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(total / 1024))} KB`;
        const parts = [result?.cleared?.length ? `已清理 ${size}` : "没有可清理的缓存"];
        if (result?.skippedService) parts.push("服务在运行,上传目录已跳过");
        mineruStatus.setText(parts.join(" · "));
        notice(`MinerU 缓存:${parts.join(";")}`);
      } catch (error) {
        notice(`清理失败:${String(error?.message || error)}`);
      }
    });
    void runMineru(false);
    // 程序路径为空时自动找一次并填入(让「启动服务」开箱可用,不用手抄路径)。
    if (!exeInput.value && bridge?.mineru?.path) {
      void Promise.resolve(bridge.mineru.path(mineruSettings()))
        .then((found) => {
          const value = String(found?.path || "").trim();
          if (!value || exeInput.value) return;
          exeInput.value = value;
          persist("mineruLocalExe", value);
          notice(`已自动找到本地 MinerU:${value}`);
          void runMineru(false);
        })
        .catch(() => {});
    }

    // 4. DocVortex(本地解析 / 公式优先的渲染端)
    const docvortexCard = root.createDiv("qbr-workshop-card");
    docvortexCard.createEl("h3", { text: "DocVortex(格式转换 / 内容提取)" });
    const dvRow = docvortexCard.createDiv("qbr-workshop-row");
    dvRow.createSpan({ cls: "qbr-workshop-hint", text: "DocVortex 路径" });
    const dvPath = dvRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空自动检测(PATH / python -m docvortex)" } });
    dvPath.value = String(settings.docvortexPath || "");
    bind(dvPath, "docvortexPath", "DocVortex 路径已保存。");
    const dvTools = docvortexCard.createDiv("qbr-workshop-row");
    const dvProbe = dvTools.createEl("button", { text: "检测 DocVortex" });
    const dvStatus = dvTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    dvProbe.addEventListener("click", () => void runProbe(dvStatus, "", () => bridge?.probe?.docvortex(settings)));
    const formulaProbe = dvTools.createEl("button", { text: "检测公式链路" });
    const formulaStatus = dvTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "" });
    formulaProbe.addEventListener("click", () => void runProbe(formulaStatus, "", () => bridge?.probe?.formula(settings)));

    // 5. Calibre(电子书互转 / 图片打包)
    const calibreCard = root.createDiv("qbr-workshop-card");
    calibreCard.createEl("h3", { text: "Calibre(电子书制作)" });
    const calibreRow = calibreCard.createDiv("qbr-workshop-row");
    calibreRow.createSpan({ cls: "qbr-workshop-hint", text: "Calibre 路径" });
    const calibrePath = calibreRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空自动检测(常见安装位置 / PATH)" } });
    calibrePath.value = String(settings.calibrePath || "");
    bind(calibrePath, "calibrePath", "Calibre 路径已保存。");
    const calibreTools = calibreCard.createDiv("qbr-workshop-row");
    const calibreProbe = calibreTools.createEl("button", { text: "检测 Calibre" });
    const calibreStatus = calibreTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    calibreProbe.addEventListener("click", () => void runProbe(calibreStatus, "", () => bridge?.probe?.calibre(settings)));

    // 6. 发送到 Kindle:SMTP 与收件地址(授权码只进 SecretStorage)。
    const kindleCard = root.createDiv("qbr-workshop-card");
    kindleCard.createEl("h3", { text: "发送到 Kindle" });
    kindleCard.createDiv({ cls: "qbr-workshop-hint", text: "把 EPUB / PDF / DOCX 发到 Kindle 邮箱(地址在 Amazon「个人文档设置」里);发件地址要先加入已批准列表。" });
    const kindleRows = [
      ["kindleEmail", "Kindle 收件地址", "name_xxxx@kindle.com"],
      ["smtpHost", "SMTP 服务器", "如 smtp.qq.com"],
      ["smtpPort", "SMTP 端口", "465(SSL)或 587(STARTTLS)"],
      ["smtpUser", "SMTP 账号", "你的邮箱地址"],
      ["smtpFrom", "发件地址", "留空用 SMTP 账号"],
    ];
    const kindleInputs = {};
    for (const [key, label, placeholder] of kindleRows) {
      const row = kindleCard.createDiv("qbr-workshop-row");
      row.createSpan({ cls: "qbr-workshop-hint", text: label });
      const input = row.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder } });
      input.value = String(plugin?.settings?.[key] || "");
      bind(input, key, `${label}已保存。`);
      kindleInputs[key] = input;
    }
    const secretRow = kindleCard.createDiv("qbr-workshop-row");
    secretRow.createSpan({ cls: "qbr-workshop-hint", text: "授权码" });
    const secretInput = secretRow.createEl("input", { cls: "qbr-workshop-input", attr: { type: "password", placeholder: "邮箱授权码 / 应用专用密码(不是登录密码)" } });
    const secretState = secretRow.createSpan({ cls: "qbr-workshop-hint", text: "" });
    void Promise.resolve(bridge?.secrets?.getSecret?.(KINDLE_SECRET_ID))
      .then((stored) => secretState.setText(stored ? "已保存;留空不修改" : "未保存"))
      .catch(() => {});
    secretInput.addEventListener("input", () => {
      const value = secretInput.value.trim();
      if (!value) return;
      void bridge?.secrets?.setSecret?.(KINDLE_SECRET_ID, value);
      secretState.setText("已保存(SecretStorage)");
    });
    const kindleTools = kindleCard.createDiv("qbr-workshop-row");
    const kindleProbe = kindleTools.createEl("button", { text: "检测 SMTP" });
    const kindleStatus = kindleTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    const kindleSettings = () => Object.fromEntries(Object.entries(kindleInputs).map(([key, entry]) => [key, entry.value.trim()]));
    kindleProbe.addEventListener("click", () => void runProbe(kindleStatus, "SMTP ", () => bridge?.kindle?.probe(kindleSettings())));

    // 7. 一键自检:四条链路各入队一个检测任务,顺带刷新本地 MinerU 状态。
    const selfCheckRow = root.createDiv("qbr-workshop-row");
    const selfCheck = selfCheckRow.createEl("button", { cls: "mod-cta", text: "书坊链路自检" });
    selfCheck.addEventListener("click", () => {
      for (const [status, label, run] of [
        [ocrStatus, "文字层", () => bridge?.probe?.ocr(settings)],
        [dvStatus, "DocVortex", () => bridge?.probe?.docvortex(settings)],
        [formulaStatus, "公式", () => bridge?.probe?.formula(settings)],
        [calibreStatus, "Calibre", () => bridge?.probe?.calibre(settings)],
      ]) {
        void runProbe(status, label, run);
      }
      void runMineru(false);
      notice("四条链路的探测已开始,结果就在下面各自的状态行里。");
    });
    selfCheckRow.createSpan({ cls: "qbr-workshop-hint", text: "一次把文字层 / DocVortex / 公式 / Calibre 四个检测入队,并刷新本地 MinerU 状态。" });
  }

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
      // 往插件的设置 tab 里挂一个桌面专属的「书坊」页(与「存储与同步」同级);
      // 这样书坊 / pdf_tool / MinerU / DocVortex / Calibre 的配置与检测集中在一处。
      if (typeof tab._settingsTabs === "function" && typeof tab._drawSettingsTab === "function" && !tab._qbrWorkshopTab) {
        const originalTabs = tab._settingsTabs.bind(tab);
        const originalDraw = tab._drawSettingsTab.bind(tab);
        const originalRender = typeof tab._render === "function" ? tab._render.bind(tab) : null;
        tab._settingsTabs = () => [...originalTabs(), { id: "workshop", label: "书坊" }];
        tab._drawSettingsTab = (body) => {
          if (tab._tab === "workshop") {
            drawWorkshopSettings(body);
            return;
          }
          originalDraw(body);
        };
        // 「打开 设置 → 书坊」留下的目标 tab:在**每次渲染之前**应用(首次 open、重绘都覆盖)。
        if (originalRender) {
          tab._render = (root) => {
            if (window.__qbrSettingsTab) {
              tab._tab = window.__qbrSettingsTab;
              window.__qbrSettingsTab = "";
            }
            originalRender(root);
          };
        }
        tab._qbrWorkshopTab = true;
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
  { id: "extract", group: "处理", label: "内容提取", title: "内容提取", en: "Extract", icon: "file-text",
    lead: "只取内容、可丢版式:PDF / DOCX / 图片 → Markdown / HTML / 结构化 JSON(题库等 schema 模板)。" },
  { id: "book", group: "处理", label: "电子书制作", title: "新建电子书", en: "Make a Book", icon: "book-open",
    lead: "从 PDF / Office / txt / Markdown / 图片制作 EPUB:自动提取与分章,配样式、封面、目录,边调边看预览。" },
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
  "book-build": "成书",
  "extract-probe": "检测",
  "extract-pdf": "提取",
  "kindle-send": "发送",
  "extract-docvortex": "提取",
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
        } else if (tool.id === "kindle") {
          this.renderKindlePanel(panel);
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

    // 预设卡片矩阵:ready 的选中(有可见选中态),其余标「后续阶段」并提示归属。
    renderPresetMatrix(host, presets, { selected = "", onSelect = null } = {}) {
      const matrix = host.createDiv("qbr-workshop-matrix");
      const cards = [];
      for (const preset of presets) {
        const card = matrix.createDiv(
          "qbr-workshop-preset"
          + (preset.ready ? " is-ready" : " is-planned")
          + (preset.id === selected ? " is-selected" : ""),
        );
        card.createEl("b", { text: preset.label });
        card.createDiv({ cls: "qbr-workshop-opt-hint", text: preset.hint });
        if (!preset.ready) card.createSpan({ cls: "qbr-workshop-preset-tag", text: "后续阶段" });
        cards.push(card);
        card.addEventListener("click", () => {
          if (!preset.ready) {
            new Notice(`${preset.label} 将在后续阶段接入(见 docs/workshop-implementation.md)`);
            return;
          }
          for (const entry of cards) entry.classList.toggle("is-selected", entry === card);
          if (typeof onSelect === "function") onSelect(preset.id);
        });
      }
      return matrix;
    }

    // 发送到 Kindle(EPUB / PDF / DOCX → 邮箱)─────────────────────
    renderKindlePanel(panel) {
      const root = panel.createDiv("qbr-workshop-tool");
      const inputCard = root.createDiv("qbr-workshop-card");
      inputCard.createEl("h3", { text: "选择要发送的书" });
      inputCard.createDiv({ cls: "qbr-workshop-hint", text: "书库里的 EPUB / PDF / DOCX 直接勾选;本地文件用「打开本地文件…」。多个文件会先打包成 ZIP(Amazon 单封上限 50MB)。" });
      const pickRow = inputCard.createDiv("qbr-workshop-row");
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      const sendButton = pickRow.createEl("button", { cls: "mod-cta", text: "发送到 Kindle" });
      this._kindleList = inputCard.createDiv("qbr-workshop-booklist");
      this._kindleSelection ||= [];
      const wanted = ["epub", "pdf", "docx", "mobi", "azw3"];
      const files = (app?.vault?.getFiles?.() || [])
        .filter((file) => wanted.includes(String(file?.extension || "").toLowerCase()))
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
      if (!files.length) {
        this._kindleList.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有 EPUB / PDF / DOCX。" });
      }
      for (const file of files) {
        const row = this._kindleList.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._kindleSelection.includes(file.path);
        box.addEventListener("change", () => {
          this._kindleSelection = box.checked
            ? [...new Set([...this._kindleSelection, file.path])]
            : this._kindleSelection.filter((item) => item !== file.path);
        });
        row.createSpan({ text: file.basename });
      }
      pickLocal.addEventListener("click", async () => {
        const picked = await bridge?.pickFiles?.();
        if (Array.isArray(picked) && picked.length) {
          this._kindleSelection = [...new Set([...this._kindleSelection, ...picked])];
          new Notice(`已加入 ${picked.length} 个文件`);
        }
      });
      sendButton.addEventListener("click", () => {
        const selection = [...this._kindleSelection];
        if (!selection.length) {
          new Notice("请先选择要发送的文件");
          return;
        }
        void bridge?.start?.({
          kind: "kindle-send",
          title: "发送到 Kindle",
          detail: `${selection.length} 个文件`,
          payload: { files: selection, settings: plugin?.settings || {} },
        }).catch((error) => new Notice(String(error?.message || error)));
        this.selectTool("tasks");
      });
      const optionCard = root.createDiv("qbr-workshop-card");
      optionCard.createEl("h3", { text: "发送设置" });
      addSettingsLink(optionCard.createDiv("qbr-workshop-row"), "SMTP 服务器 / 账号 / 授权码与 Kindle 收件地址都在「设置 → 书坊」;授权码只存进 SecretStorage。");
    }

    // ── 内容提取(PDF / Office / OFD / 图片 → 内容,W1-0)──────────────
    renderExtractPanel(panel) {
      this._extractSelection ||= [];
      const root = panel.createDiv("qbr-workshop-tool");

      // 这里不放预设矩阵:提取产物固定是 <源名>.md / .html / .json,输入决定走哪条链路,
      // 「选中预设」没有实际效果(会误导)——信息放进下面的设置说明里。
      const inputCard = root.createDiv("qbr-workshop-card");
      inputCard.createEl("h3", { text: "选择文件" });
      const pickRow = inputCard.createDiv("qbr-workshop-row");
      const pickVault = pickRow.createEl("button", { text: "选择书库文件…" });
      pickVault.addEventListener("click", () => this.toggleExtractBookList());
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      pickLocal.addEventListener("click", () => void this.pickLocalExtractFiles());
      pickRow.createSpan({ cls: "qbr-workshop-hint", text: "PDF / Office / OFD / HTML / 图片;本地文件就地处理" });
      this._extractBookList = inputCard.createDiv("qbr-workshop-booklist");
      this._extractBookList.hidden = true;
      this._extractChips = inputCard.createDiv("qbr-workshop-chips");

      const optionCard = root.createDiv("qbr-workshop-card");
      optionCard.createEl("h3", { text: "提取设置" });
      const modeRow = optionCard.createDiv("qbr-workshop-row");
      modeRow.createSpan({ cls: "qbr-workshop-hint", text: "PDF 模式" });
      this._extractMode = modeRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const mode of EXTRACT_MODES) {
        this._extractMode.createEl("option", { attr: { value: mode.id }, text: mode.label });
      }
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "MinerU 云端排队时间波动很大(实测 2 页 25 秒、7 页可能到 20 分钟);纯文字、不需要 LaTeX 公式的 PDF 选「文本型 PDF」更快。同一份文件 + 同一模式重跑会复用已有产物,不再等云端。" });
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "在「设置 → 书坊」填了「本地 MinerU 服务」地址后,MinerU 模式优先走本机服务(不出网、免凭据,热请求快很多)。" });
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "输出 <源名>.md / .html / .json(+ 体检报告),落在源文件旁;PDF 走 pdf_tool(模式可切 MinerU),Office / OFD / HTML / 图片走 DocVortex;题库等 schema 模板后续阶段。" });
      const detectRow = optionCard.createDiv("qbr-workshop-row");
      addSettingsLink(detectRow, "提取链路的检测(pdf_tool / DocVortex / MinerU)与全局配置都在「设置 → 书坊」。");

      const startRow = root.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始提取" });
      start.addEventListener("click", () => this.startExtractTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "批量:逐个入队" });

      this._extractPreview = root.createDiv("qbr-workshop-card");
      this._extractPreview.hidden = true;
      this._extractRecent = root.createDiv("qbr-workshop-recent");
      this.renderExtractChips();
    }

    extractFiles() {
      const wanted = [...DOCVORTEX_INPUTS, ...IMAGE_INPUTS];
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => wanted.includes(String(file?.extension || "").toLowerCase()))
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
    }

    toggleExtractBookList() {
      const list = this._extractBookList;
      if (!list) return;
      list.hidden = !list.hidden;
      this.refreshExtractBookList();
    }

    refreshExtractBookList() {
      const list = this._extractBookList;
      if (!list || list.hidden) return;
      list.empty();
      const files = this.extractFiles();
      if (!files.length) {
        list.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有可提取的文档。" });
        return;
      }
      for (const file of files) {
        const row = list.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._extractSelection.includes(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.addExtractFile(file.path);
          else this.removeExtractFile(file.path);
        });
        row.createSpan({ text: `${file.basename} · ${String(file.extension || "").toUpperCase()}` });
      }
    }

    addExtractFile(path) {
      if (!path || this._extractSelection.includes(path)) return;
      this._extractSelection.push(path);
      this.renderExtractChips();
    }

    removeExtractFile(path) {
      this._extractSelection = this._extractSelection.filter((item) => item !== path);
      this.renderExtractChips();
      this.refreshExtractBookList();
    }

    renderExtractChips() {
      const host = this._extractChips;
      if (!host) return;
      host.empty();
      if (!this._extractSelection.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择文件" });
        return;
      }
      for (const path of this._extractSelection) {
        const chip = host.createSpan({ cls: "qbr-workshop-chip" });
        chip.createSpan({ text: path.split("/").pop() || path });
        const remove = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
        remove.addEventListener("click", () => this.removeExtractFile(path));
      }
    }

    async pickLocalExtractFiles() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      for (const picked of paths) this.addExtractFile(String(picked).replace(/\\/g, "/"));
      this.refreshExtractBookList();
    }

    probeExtract() {
      if (!bridge) return;
      void bridge.start({
        kind: "extract-probe",
        title: "检测提取链路",
        detail: "pdf_tool + DocVortex",
        payload: { settings: this.formulaSettings() },
      }).catch((error) => new Notice(String(error?.message || error)));
      this.selectTool("tasks");
    }

    startExtractTasks() {
      if (!bridge) return;
      const files = [...this._extractSelection];
      if (!files.length) {
        new Notice("请先选择文件");
        return;
      }
      const mode = String(this._extractMode?.value || "auto");
      const settings = this.formulaSettings();
      for (const rel of files) {
        const kind = extractionKind(rel);
        void bridge.start({
          kind: kind === "pdf" ? "extract-pdf" : "extract-docvortex",
          title: "内容提取",
          detail: rel,
          payload: { settings, source: rel, mode },
        }).catch((error) => new Notice(String(error?.message || error)));
      }
      this.selectTool("tasks");
    }

    // 提取结果预览:产物路径 + 体检报告 + Markdown 开头(仅书库内产物可读)。
    async renderExtractPreview(task) {
      const host = this._extractPreview;
      if (!host) return;
      host.empty();
      if (!task || task.status !== "done" || !task.output) {
        host.hidden = true;
        return;
      }
      host.hidden = false;
      host.createEl("h3", { text: "提取结果" });
      host.createDiv({ cls: "qbr-workshop-hint", text: task.detail || "" });
      const vaultRoot = String(window.qbrDesktop?.paths?.vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const normalized = String(task.output).replace(/\\/g, "/");
      const relative = vaultRoot && normalized.toLowerCase().startsWith(`${vaultRoot.toLowerCase()}/`)
        ? normalized.slice(vaultRoot.length + 1)
        : "";
      const file = relative ? app?.vault?.getAbstractFileByPath?.(relative) : null;
      if (!file) {
        host.createDiv({ cls: "qbr-workshop-hint", text: `产物在源文件旁：${task.output}` });
        return;
      }
      const text = await app.vault.read(file).catch(() => "");
      if (text) {
        const preview = host.createEl("pre", { cls: "qbr-workshop-extract-text" });
        preview.setText(text.slice(0, 1500));
      }
      const auditRel = relative.replace(/\.md$/i, ".audit.json");
      const auditFile = app?.vault?.getAbstractFileByPath?.(auditRel);
      if (auditFile) {
        const auditText = await app.vault.read(auditFile).catch(() => "");
        try {
          const audit = JSON.parse(auditText);
          const issues = Array.isArray(audit?.issues) ? audit.issues : [];
          host.createDiv({
            cls: "qbr-workshop-hint",
            text: `体检：${audit?.ok === false ? "有问题" : "通过"}${issues.length ? ` · ${issues.length} 条：${issues.slice(0, 3).map((issue) => String(issue?.message || issue?.code || issue)).join("；")}` : ""}`,
          });
        } catch { /* audit is optional */ }
      }
    }

    // ── 电子书制作(W1-2/W1-3 向导;已接:Calibre 互转 + 图片打包)────────
    renderBookPanel(panel) {
      this._bookSelection ||= [];
      this._bookImages ||= [];
      const root = panel.createDiv("qbr-workshop-tool");

      // 主流程只有一条:向导(① 内容 → ② 目录 → ③ 书名与封面 → ④ 排版 → 生成),
      // 右侧全程预览;换格式 / 图片打包等次要动作收进「更多工具」。
      const wizardCard = root.createDiv("qbr-workshop-card");
      wizardCard.createEl("h3", { text: "电子书向导" });
      wizardCard.createDiv({ cls: "qbr-workshop-hint", text: "输入 txt / Markdown 直接分章;PDF / Office / OFD / HTML / EPUB / 图片在生成时自动提取,无需先跑内容提取。" });
      const wizardGrid = wizardCard.createDiv("qbr-workshop-wizard");
      const controls = wizardGrid.createDiv("qbr-workshop-wizard-controls");
      const previewCol = wizardGrid.createDiv("qbr-workshop-wizard-preview");

      // ① 内容
      const sourceStep = this.bookStep(controls, "1", "内容", "书稿来源");
      const sourceRow = sourceStep.createDiv("qbr-workshop-row");
      const pickSource = sourceRow.createEl("button", { text: "选择书稿…" });
      pickSource.addEventListener("click", () => this.toggleBookSourceList());
      const pickSourceLocal = sourceRow.createEl("button", { text: "打开本地文件…" });
      pickSourceLocal.addEventListener("click", () => void this.pickLocalBookSources());
      sourceRow.createSpan({ cls: "qbr-workshop-hint", text: "本地文件就地处理,产物落在源文件旁" });
      this._bookSourceList = sourceStep.createDiv("qbr-workshop-booklist");
      this._bookSourceList.hidden = true;
      this._bookSourceChips = sourceStep.createDiv("qbr-workshop-chips");

      // ② 目录(自动分章,可编辑)
      const chapterStep = this.bookStep(controls, "2", "目录", "自动分章");
      this._bookChaptersHost = chapterStep.createDiv("qbr-workshop-chapters");

      // ③ 书名与封面
      const metaStep = this.bookStep(controls, "3", "书名与封面", "写进扉页、目录与封面");
      const metaRow = metaStep.createDiv("qbr-workshop-row");
      metaRow.createSpan({ cls: "qbr-workshop-hint", text: "书名" });
      this._bookTitle = metaRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空用文件名" } });
      metaRow.createSpan({ cls: "qbr-workshop-hint", text: "作者" });
      this._bookAuthor = metaRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "可选" } });

      const coverRow = metaStep.createDiv("qbr-workshop-row");
      coverRow.createSpan({ cls: "qbr-workshop-hint", text: "封面" });
      this._bookCoverMode = coverRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const [value, label] of [["template", "模板生成"], ["none", "不要封面"], ["auto", "自动(书内首图,否则模板)"], ["image", "指定图片…"]]) {
        this._bookCoverMode.createEl("option", { attr: { value }, text: label });
      }
      this._bookCoverPalette = coverRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const [id, palette] of Object.entries(COVER_PALETTES)) {
        this._bookCoverPalette.createEl("option", { attr: { value: id }, text: palette.label });
      }
      const coverRow2 = metaStep.createDiv("qbr-workshop-row");
      coverRow2.createSpan({ cls: "qbr-workshop-hint", text: "副标题" });
      this._bookSubtitle = coverRow2.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "可选" } });
      this._bookCoverImage = "";
      this._bookCoverPick = coverRow2.createEl("button", { text: "选择图片…" });
      this._bookCoverPick.addEventListener("click", () => void this.pickCoverImage());
      this._bookCoverLabel = coverRow2.createSpan({ cls: "qbr-workshop-hint", text: "" });
      this._bookCoverMode.addEventListener("change", () => { this.syncBookCoverRow(); this.onBookStyleChange(); });
      this.syncBookCoverRow();

      // ④ 排版样式(右侧预览即时更新)
      const styleStep = this.bookStep(controls, "4", "排版样式", "生成时嵌入所选字体子集");
      const layoutRow = styleStep.createDiv("qbr-workshop-row");
      layoutRow.createSpan({ cls: "qbr-workshop-hint", text: "字体搭配" });
      this._bookPairing = layoutRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const pairing of FONT_PAIRINGS) {
        this._bookPairing.createEl("option", { attr: { value: pairing.id }, text: pairing.label });
      }
      this._bookControls = {};
      this.bookSlider(styleStep, "字号", "fontSize", { min: 12, max: 28, step: 1, suffix: "px" });
      this.bookSlider(styleStep, "行距", "lineHeight", { min: 1.2, max: 2.4, step: 0.05, suffix: "" });
      this.bookSlider(styleStep, "边距", "margin", { min: 0, max: 12, step: 1, suffix: "%" });
      const themeRow = styleStep.createDiv("qbr-workshop-row");
      themeRow.createSpan({ cls: "qbr-workshop-hint", text: "主题" });
      this._bookTheme = themeRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const [id, theme] of Object.entries(BOOK_THEMES)) {
        this._bookTheme.createEl("option", { attr: { value: id }, text: theme.label });
      }

      const advanced = styleStep.createEl("details", { cls: "qbr-workshop-advanced" });
      advanced.createEl("summary", { text: "高级排版(缩进 / 段距 / 对齐)" });
      this.bookSlider(advanced, "首行缩进", "indent", { min: 0, max: 4, step: 0.5, suffix: "em" });
      this.bookSlider(advanced, "段间距", "spacing", { min: 0, max: 2, step: 0.25, suffix: "em" });
      const alignRow = advanced.createDiv("qbr-workshop-row");
      alignRow.createSpan({ cls: "qbr-workshop-hint", text: "对齐" });
      this._bookAlign = alignRow.createEl("select", { cls: "qbr-workshop-select" });
      this._bookAlign.createEl("option", { attr: { value: "justify" }, text: "两端对齐" });
      this._bookAlign.createEl("option", { attr: { value: "left" }, text: "左对齐" });
      const headingRow = advanced.createDiv("qbr-workshop-row");
      headingRow.createSpan({ cls: "qbr-workshop-hint", text: "标题" });
      this._bookHeadingAlign = headingRow.createEl("select", { cls: "qbr-workshop-select" });
      this._bookHeadingAlign.createEl("option", { attr: { value: "left" }, text: "左对齐" });
      this._bookHeadingAlign.createEl("option", { attr: { value: "center" }, text: "居中" });

      const buildRow = controls.createDiv("qbr-workshop-row qbr-workshop-build");
      const build = buildRow.createEl("button", { cls: "mod-cta", text: "生成 EPUB" });
      build.addEventListener("click", () => this.startBookBuild());
      buildRow.createSpan({ cls: "qbr-workshop-hint", text: "进度在「任务」里查看" });

      // 预览列:正文样张 + 封面缩略图(随样式即时更新)。
      const previewHead = previewCol.createDiv("qbr-workshop-row");
      previewHead.createEl("b", { text: "预览" });
      const phoneBtn = previewHead.createEl("button", { text: "手机宽度" });
      phoneBtn.addEventListener("click", () => this.setBookPreviewWidth("phone"));
      const wideBtn = previewHead.createEl("button", { text: "桌面宽度" });
      wideBtn.addEventListener("click", () => this.setBookPreviewWidth("wide"));
      this._bookPreviewNote = previewCol.createDiv({ cls: "qbr-workshop-hint", text: "预览:未选择书稿,显示示例文字" });
      this._bookPreview = previewCol.createDiv("qbr-workshop-preview");
      this._bookPreviewFrame = this._bookPreview.createEl("iframe", { cls: "qbr-workshop-preview-frame" });
      this._bookCoverPreview = previewCol.createDiv("qbr-workshop-cover-preview");
      const coverBox = this._bookCoverPreview.createDiv("qbr-workshop-cover-box");
      this._bookCoverFrame = coverBox.createEl("iframe", { cls: "qbr-workshop-cover-frame" });

      // 更多工具:换 Kindle 格式、图片打包;Calibre 路径这类维护项收进折叠。
      const toolsCard = root.createDiv("qbr-workshop-card");
      toolsCard.createEl("h3", { text: "更多工具" });

      const convertBlock = this.bookToolBlock(toolsCard, "EPUB → AZW3 / MOBI", "换成 Kindle 主流格式(Calibre,版式不变)");
      const pickRow = convertBlock.createDiv("qbr-workshop-row");
      const pickVault = pickRow.createEl("button", { text: "选择书库文件…" });
      pickVault.addEventListener("click", () => this.toggleBookList());
      const pickLocal = pickRow.createEl("button", { text: "打开本地文件…" });
      pickLocal.addEventListener("click", () => void this.pickLocalBookFiles());
      pickRow.createSpan({ cls: "qbr-workshop-hint", text: "输入 EPUB/MOBI/AZW3/FB2/CBZ;本地文件就地处理" });
      this._bookList = convertBlock.createDiv("qbr-workshop-booklist");
      this._bookList.hidden = true;
      this._bookChips = convertBlock.createDiv("qbr-workshop-chips");
      const targetRow = convertBlock.createDiv("qbr-workshop-row");
      targetRow.createSpan({ cls: "qbr-workshop-hint", text: "目标格式" });
      this._bookFormat = targetRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const target of EBOOK_TARGETS) {
        this._bookFormat.createEl("option", { attr: { value: target.id }, text: target.label });
      }
      const startRow = convertBlock.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始转换" });
      start.addEventListener("click", () => this.startBookTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "产物落在源文件旁" });

      const imageBlock = this.bookToolBlock(toolsCard, "图片 → CBZ / EPUB", "漫画 / 相册打包成书;EPUB 由 CBZ 经 Calibre 转换");
      const imgRow = imageBlock.createDiv("qbr-workshop-row");
      const pickImages = imgRow.createEl("button", { text: "选择图片…" });
      pickImages.addEventListener("click", () => void this.pickBookImages());
      imgRow.createSpan({ cls: "qbr-workshop-hint", text: "可多选;按文件名自然排序(1 < 2 < 10)" });
      this._bookImageChips = imageBlock.createDiv("qbr-workshop-chips");
      const imgTargetRow = imageBlock.createDiv("qbr-workshop-row");
      imgTargetRow.createSpan({ cls: "qbr-workshop-hint", text: "打包为" });
      this._bookImageFormat = imgTargetRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const target of IMAGE_BOOK_TARGETS) {
        this._bookImageFormat.createEl("option", { attr: { value: target.id }, text: target.label });
      }
      const imgStartRow = imageBlock.createDiv("qbr-workshop-row");
      const imgStart = imgStartRow.createEl("button", { cls: "mod-cta", text: "开始打包" });
      imgStart.addEventListener("click", () => this.startImageTasks());
      imgStartRow.createSpan({ cls: "qbr-workshop-hint", text: "输出:图片目录旁「目录名.cbz」;只有输出 EPUB 时才需要 Calibre" });

      const calibreRow = toolsCard.createDiv("qbr-workshop-row");
      addSettingsLink(calibreRow, "Calibre 路径与检测(换 AZW3 / MOBI、图片转 EPUB 时用)在「设置 → 书坊」。");

      this._bookRecent = root.createDiv("qbr-workshop-recent");
      this.renderBookChips();
      this.renderBookImageChips();
      this.renderBookSourceChips();
      this.applyBookStyleState();
    }

    // 向导里的步骤:编号 + 标题 + 一句说明,返回放控件的主体。
    bookStep(host, index, title, hint) {
      const step = host.createDiv("qbr-workshop-step");
      const head = step.createDiv("qbr-workshop-step-head");
      head.createSpan({ cls: "qbr-workshop-step-no", text: index });
      head.createEl("b", { text: title });
      if (hint) head.createSpan({ cls: "qbr-workshop-hint", text: hint });
      return step.createDiv("qbr-workshop-step-body");
    }

    // 「更多工具」里的一块次要工具。
    bookToolBlock(host, title, hint) {
      const block = host.createDiv("qbr-workshop-subtool");
      block.createEl("b", { text: title });
      if (hint) block.createDiv({ cls: "qbr-workshop-hint", text: hint });
      return block;
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

    // ── 快速成书:书稿选择、样式控件、实时预览、生成 ──────────────────
    bookSlider(host, label, key, { min, max, step, suffix = "" } = {}) {
      const row = host.createDiv("qbr-workshop-row");
      row.createSpan({ cls: "qbr-workshop-hint", text: label });
      const initial = Number.isFinite(Number(BOOK_STYLE_DEFAULTS[key])) ? Number(BOOK_STYLE_DEFAULTS[key]) : Number(min) || 0;
      const input = row.createEl("input", {
        cls: "qbr-workshop-range",
        attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(initial) },
      });
      input.value = String(initial);
      const value = row.createSpan({ cls: "qbr-workshop-range-value", text: `${initial}${suffix}` });
      this._bookControls[key] = { input, value, suffix };
      input.addEventListener("input", () => this.onBookStyleChange());
      return input;
    }

    setBookPreviewWidth(mode) {
      if (this._bookPreview) this._bookPreview.toggleClass("is-wide", mode === "wide");
    }

    bookStyleState() {
      const state = { pairing: String(this._bookPairing?.value || FONT_PAIRINGS[0].id) };
      for (const [key, control] of Object.entries(this._bookControls || {})) {
        state[key] = Number(control.input.value);
      }
      state.theme = String(this._bookTheme?.value || "follow");
      state.align = String(this._bookAlign?.value || "justify");
      state.headingAlign = String(this._bookHeadingAlign?.value || "left");
      state.title = String(this._bookTitle?.value || "");
      state.author = String(this._bookAuthor?.value || "");
      state.coverMode = String(this._bookCoverMode?.value || "template");
      state.coverPalette = String(this._bookCoverPalette?.value || "warm");
      state.coverImage = String(this._bookCoverImage || "");
      state.subtitle = String(this._bookSubtitle?.value || "");
      return state;
    }

    syncBookCoverRow() {
      const mode = String(this._bookCoverMode?.value || "template");
      if (this._bookCoverPalette) this._bookCoverPalette.hidden = mode !== "template" && mode !== "auto";
      if (this._bookCoverPick) this._bookCoverPick.hidden = mode !== "image";
      if (this._bookCoverLabel) {
        this._bookCoverLabel.setText(mode === "image" && this._bookCoverImage ? String(this._bookCoverImage).split("/").pop() : "");
      }
    }

    async pickCoverImage() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      const picked = paths.find((candidate) => /\.(png|jpe?g|webp|gif|bmp|tiff?|jp2)$/i.test(String(candidate)));
      if (!picked) return;
      this._bookCoverImage = String(picked).replace(/\\/g, "/");
      this.syncBookCoverRow();
      this.onBookStyleChange();
    }

    applyBookStyleState() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem("qbr-workshop-book-style") || "{}"); } catch { saved = {}; }
      if (saved.pairing && this._bookPairing) this._bookPairing.value = String(saved.pairing);
      for (const [key, control] of Object.entries(this._bookControls || {})) {
        const fallback = Number.isFinite(Number(BOOK_STYLE_DEFAULTS[key])) ? Number(BOOK_STYLE_DEFAULTS[key]) : control.input.value;
        control.input.value = String(Number.isFinite(Number(saved[key])) ? Number(saved[key]) : fallback);
        control.value.setText(`${control.input.value}${control.suffix}`);
      }
      if (saved.theme) this._bookTheme.value = String(saved.theme);
      if (saved.align) this._bookAlign.value = String(saved.align);
      if (saved.headingAlign) this._bookHeadingAlign.value = String(saved.headingAlign);
      if (typeof saved.title === "string") this._bookTitle.value = saved.title;
      if (typeof saved.author === "string") this._bookAuthor.value = saved.author;
      if (saved.coverMode) this._bookCoverMode.value = String(saved.coverMode);
      if (saved.coverPalette) this._bookCoverPalette.value = String(saved.coverPalette);
      if (typeof saved.coverImage === "string") this._bookCoverImage = saved.coverImage;
      if (typeof saved.subtitle === "string") this._bookSubtitle.value = saved.subtitle;
      this.syncBookCoverRow();
      void this.renderBookPreview();
      this.renderBookCoverPreview();
      void this.renderBookChapters();
    }

    onBookStyleChange() {
      for (const control of Object.values(this._bookControls || {})) {
        control.value.setText(`${control.input.value}${control.suffix}`);
      }
      try { localStorage.setItem("qbr-workshop-book-style", JSON.stringify(this.bookStyleState())); } catch { /* ignore */ }
      clearTimeout(this._bookPreviewTimer);
      this._bookPreviewTimer = setTimeout(() => {
        void this.renderBookPreview();
        this.renderBookCoverPreview();
      }, 150);
    }

    // 模板封面预览:1600×2400 缩放成缩略图(系统近似字体)。
    renderBookCoverPreview() {
      const frame = this._bookCoverFrame;
      if (!frame) return;
      const state = this.bookStyleState();
      if (state.coverMode !== "template" && state.coverMode !== "auto") {
        if (this._bookCoverPreview) this._bookCoverPreview.hidden = true;
        return;
      }
      if (this._bookCoverPreview) this._bookCoverPreview.hidden = false;
      const stacks = pairingStacks(findPairing(state.pairing));
      const fallbackTitle = String(this._bookSources?.[0] || "").split("/").pop()?.replace(/\.[^.]+$/, "") || "未命名";
      const html = coverHtml({
        title: state.title || fallbackTitle,
        author: state.author,
        subtitle: state.subtitle,
        palette: state.coverPalette,
        headingFamily: stacks.heading,
        bodyFamily: stacks.body,
      });
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const previous = this._bookCoverUrl;
      this._bookCoverUrl = url;
      frame.src = url;
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), 5000);
    }

    // 目录编辑:书库书稿可改名/合并/拆分/排序;本地文件在生成时自动识别。
    async renderBookChapters() {
      const host = this._bookChaptersHost;
      if (!host) return;
      host.empty();
      const rel = this._bookSources?.[0];
      const file = rel ? app?.vault?.getAbstractFileByPath?.(rel) : null;
      if (!file) {
        this._bookChapters = [];
        if (rel) host.createDiv({ cls: "qbr-workshop-hint", text: "本地文件的目录在生成时自动识别(此处不可编辑)" });
        return;
      }
      if (!/\.(txt|md|markdown)$/i.test(rel)) {
        this._bookChapters = [];
        host.createDiv({ cls: "qbr-workshop-hint", text: "PDF / Office / OFD / 图片的目录在生成时自动识别(内部先提取,无需先跑内容提取)" });
        return;
      }
      const text = await app.vault.read(file).catch(() => "");
      const isMarkdown = /\.(md|markdown)$/i.test(rel);
      const cleaned = isMarkdown ? unwrapProseFences(text) : text;
      const found = isMarkdown ? splitMarkdownChapters(cleaned) : [];
      this._bookChapters = found.length >= 2
        ? found.map((chapter, index) => ({ title: chapter.title || `第 ${index + 1} 章`, text: chapter.text }))
        : splitTextChapters(cleaned).map((chapter) => ({ title: chapter.title, text: chapter.body }));
      if (!this._bookChapters.length) return;
      const stats = chapterStats(this._bookChapters);
      host.createDiv({ cls: "qbr-workshop-hint", text: `目录:${stats.chapters} 章 · 约 ${Math.max(1, Math.round(stats.chars / 1000))}k 字(可改名 / 合并 / 拆分 / 排序)` });
      this._bookChapters.forEach((chapter, index) => {
        const row = host.createDiv("qbr-workshop-chapter");
        row.createSpan({ cls: "qbr-workshop-chapter-no", text: String(index + 1) });
        const input = row.createEl("input", { cls: "qbr-workshop-input", attr: { value: chapter.title } });
        input.value = chapter.title;
        input.addEventListener("change", () => {
          this._bookChapters = renameChapter(this._bookChapters, index, input.value);
        });
        row.createSpan({ cls: "qbr-workshop-hint", text: `${chapter.text.length} 字` });
        const actions = row.createDiv("qbr-workshop-chapter-actions");
        const up = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "↑" });
        up.disabled = index === 0;
        up.addEventListener("click", () => {
          this._bookChapters = moveChapter(this._bookChapters, index, -1);
          void this.renderBookChapters();
        });
        const down = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "↓" });
        down.disabled = index === this._bookChapters.length - 1;
        down.addEventListener("click", () => {
          this._bookChapters = moveChapter(this._bookChapters, index, 1);
          void this.renderBookChapters();
        });
        const merge = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "合并" });
        merge.disabled = index === this._bookChapters.length - 1;
        merge.addEventListener("click", () => {
          this._bookChapters = mergeChapters(this._bookChapters, index);
          void this.renderBookChapters();
        });
        const split = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "拆分" });
        split.addEventListener("click", () => {
          this._bookChapters = splitChapter(this._bookChapters, index);
          void this.renderBookChapters();
        });
      });
    }

    // 预览:文本源直接读;非文本源优先读同目录的「内容提取」产物 <源名>.md;
    // 都没有时退回示例文字。二进制文件绝不当文本读,避免乱码。
    async renderBookPreview() {
      const frame = this._bookPreviewFrame;
      if (!frame) return;
      const state = this.bookStyleState();
      const stacks = pairingStacks(findPairing(state.pairing));
      const css = renderBookCss({ ...state, bodyFont: stacks.body, headingFont: stacks.heading, latinFont: stacks.latin });
      const rel = String(this._bookSources?.[0] || "");
      const isMarkdown = /\.(md|markdown)$/i.test(rel);
      const isPlain = /\.txt$/i.test(rel);
      const readVault = async (file) => (file ? app.vault.read(file).catch(() => "") : "");
      let note = "预览:未选择书稿,显示示例文字";
      let body = bookSampleHtml(bookSampleText());
      if (isMarkdown || isPlain) {
        const text = await readVault(rel ? app?.vault?.getAbstractFileByPath?.(rel) : null);
        note = isMarkdown ? "预览:书稿开头(Markdown 已渲染)" : "预览:书稿开头";
        body = text.trim()
          ? (isMarkdown ? markdownToHtml(unwrapProseFences(text).slice(0, 6000)) : bookSampleHtml(text))
          : bookSampleHtml("");
      } else if (rel) {
        const sibling = rel.replace(/\.[^./\\]+$/, ".md");
        const extracted = await readVault(app?.vault?.getAbstractFileByPath?.(sibling));
        if (extracted.trim()) {
          note = `预览:同目录已提取的 ${sibling.split("/").pop()}`;
          body = markdownToHtml(unwrapProseFences(extracted).slice(0, 6000));
        } else {
          note = "预览:生成时自动提取内容,这里先显示示例文字";
        }
      }
      if (this._bookPreviewNote) this._bookPreviewNote.setText(note);
      const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const previous = this._bookPreviewUrl;
      this._bookPreviewUrl = url;
      frame.src = url;
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), 5000);
    }

    bookSourceFiles() {
      const wanted = ["txt", "md", "markdown", ...DOCVORTEX_INPUTS, ...IMAGE_INPUTS];
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => wanted.includes(String(file?.extension || "").toLowerCase()))
        .sort((a, b) => String(a.basename).localeCompare(String(b.basename), "ru"));
    }

    toggleBookSourceList() {
      const list = this._bookSourceList;
      if (!list) return;
      list.hidden = !list.hidden;
      this.refreshBookSourceList();
    }

    refreshBookSourceList() {
      const list = this._bookSourceList;
      if (!list || list.hidden) return;
      list.empty();
      const sources = this.bookSourceFiles();
      if (!sources.length) {
        list.createDiv({ cls: "qbr-workshop-hint", text: "书库里还没有可成书的文件(txt / Markdown / PDF / Office / 图片…)。" });
        return;
      }
      this._bookSources ||= [];
      for (const file of sources) {
        const row = list.createEl("label", { cls: "qbr-workshop-book" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this._bookSources.includes(file.path);
        box.addEventListener("change", () => {
          if (box.checked) this.addBookSource(file.path);
          else this.removeBookSource(file.path);
        });
        row.createSpan({ text: `${file.basename} · ${String(file.extension || "").toUpperCase()}` });
      }
    }

    addBookSource(path) {
      this._bookSources ||= [];
      if (path && !this._bookSources.includes(path)) this._bookSources.push(path);
      this.renderBookSourceChips();
      void this.renderBookPreview();
      this.renderBookCoverPreview();
      void this.renderBookChapters();
    }

    removeBookSource(path) {
      this._bookSources = (this._bookSources || []).filter((item) => item !== path);
      this.renderBookSourceChips();
      void this.renderBookPreview();
      this.renderBookCoverPreview();
      void this.renderBookChapters();
      this.refreshBookSourceList();
    }

    renderBookSourceChips() {
      const host = this._bookSourceChips;
      if (!host) return;
      host.empty();
      const sources = this._bookSources || [];
      if (!sources.length) {
        host.createSpan({ cls: "qbr-workshop-hint", text: "未选择书稿" });
        return;
      }
      for (const source of sources) {
        const chip = host.createSpan({ cls: "qbr-workshop-chip" });
        chip.createSpan({ text: source.split("/").pop() || source });
        const remove = chip.createEl("button", { cls: "qbr-workshop-chip-x", text: "✕" });
        remove.addEventListener("click", () => this.removeBookSource(source));
      }
    }

    async pickLocalBookSources() {
      if (!bridge?.pickFiles) return;
      const paths = await bridge.pickFiles().catch(() => []);
      const wanted = ["txt", "md", "markdown", ...DOCVORTEX_INPUTS, ...IMAGE_INPUTS];
      for (const picked of paths) {
        const normalized = String(picked).replace(/\\/g, "/");
        const ext = normalized.split(".").pop()?.toLowerCase() || "";
        if (wanted.includes(ext)) this.addBookSource(normalized);
        else new Notice("这个格式暂不支持制作电子书。");
      }
      this.refreshBookSourceList();
    }

    startBookBuild() {
      if (!bridge) return;
      const rel = this._bookSources?.[0];
      if (!rel) {
        new Notice("请先选择书稿(PDF / Office / txt / Markdown / 图片均可)");
        return;
      }
      const state = this.bookStyleState();
      void bridge.start({
        kind: "book-build",
        title: "生成电子书",
        detail: rel,
        payload: {
          settings: this.formulaSettings(),
          source: rel,
          title: state.title,
          author: state.author,
          styles: {
            fontSize: state.fontSize,
            lineHeight: state.lineHeight,
            margin: state.margin,
            indent: state.indent,
            spacing: state.spacing,
            align: state.align,
            headingAlign: state.headingAlign,
            theme: state.theme,
          },
          fonts: { pairing: state.pairing, embed: true },
          cover: {
            mode: state.coverMode,
            imagePath: state.coverImage,
            subtitle: state.subtitle,
            palette: state.coverPalette,
          },
          chapters: (this._bookChapters || []).length
            ? (this._bookChapters || []).map((chapter) => ({ title: chapter.title, text: chapter.text }))
            : undefined,
        },
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
        { id: "img", label: "图片 → PDF", hint: "打包成 PDF:照片成书、扫描页合成(每张一页)", ready: true },
      ], { selected: this._convertPreset, onSelect: (id) => { this._convertPreset = id; this.syncConvertPreset(); } });

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
      this._convertFormatRow = formatRow;
      formatRow.createSpan({ cls: "qbr-workshop-hint", text: "目标格式" });
      this._convertFormat = formatRow.createEl("select", { cls: "qbr-workshop-select" });
      for (const format of DOCVORTEX_FORMATS) {
        this._convertFormat.createEl("option", { attr: { value: format.id }, text: format.label });
      }
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "输出与源文件同目录,用目标扩展名;同名自动加序号。" });
      const parseRow = optionCard.createDiv("qbr-workshop-row");
      this._convertParseRow = parseRow;
      parseRow.createSpan({ cls: "qbr-workshop-hint", text: "解析方式" });
      this._convertParse = parseRow.createEl("select", { cls: "qbr-workshop-select" });
      this._convertParse.createEl("option", { attr: { value: "local" }, text: "本地解析(DocVortex,通用)" });
      this._convertParse.createEl("option", { attr: { value: "text" }, text: "文本型(本地 fitz,PDF:试卷 / 公文 / 讲义)" });
      this._convertParse.createEl("option", { attr: { value: "mineru" }, text: "公式优先(MinerU 云端,PDF)" });
      this._convertParse.createEl("option", { attr: { value: "mineru-local" }, text: "公式优先(本地 MinerU 服务,PDF)" });
      const savedParse = localStorage.getItem("qbr-workshop-parse");
      this._convertParse.value = ["text", "mineru", "mineru-local"].includes(String(savedParse)) ? String(savedParse) : "local";
      this._convertParse.addEventListener("change", () => {
        localStorage.setItem("qbr-workshop-parse", String(this._convertParse.value));
        this.syncConvertTokenRow();
      });
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "怎么选:有数学公式的论文 / 教材 → 公式优先;试卷 / 公文 / 讲义(文字为主、符号少)→ 文本型(本地,不会把「A. C++」这类文字裁成图片);Office / HTML / EPUB 等文档 → 本地解析。" });
      // 全局配置与链路检测集中在「设置 → 书坊」(MinerU / pdf_tool / DocVortex / Calibre);
      // 这个面板只留每次任务要选的:预设、文件、目标格式、解析方式。
      const settingsRow = optionCard.createDiv("qbr-workshop-row");
      addSettingsLink(settingsRow, "MinerU 凭据 / 本地服务、DocVortex 路径、Calibre 路径与各链路检测都在那里(对所有工具生效)。");

      // 预设决定后续操作:图片 → PDF 只用「选图片 + 打包」,目标格式 / 解析方式 / MinerU
      // 那些控件与它无关 —— 收集起来按预设显隐(渐进披露)。
      this._convertHints = [...optionCard.querySelectorAll("div.qbr-workshop-hint")];
      this._convertImgHint = optionCard.createDiv({ cls: "qbr-workshop-hint", text: "图片 → PDF:选中的每张图片合成一页(PNG / JPG / WebP / GIF / BMP / TIFF / JP2;页面按 150dpi 换算),产物是 PDF,落在首图旁边(同名加序号)。不经过 DocVortex、不需要凭据、秒级。" });
      this._convertImgHint.hidden = true;

      const startRow = root.createDiv("qbr-workshop-row");
      const start = startRow.createEl("button", { cls: "mod-cta", text: "开始转换" });
      this._convertStart = start;
      start.addEventListener("click", () => this.startConvertTasks());
      startRow.createSpan({ cls: "qbr-workshop-hint", text: "批量:可一次选多本,逐个入队。" });
      this.syncConvertPreset();

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
        mineruLocalUrl: String(settings.mineruLocalUrl || ""),
        mineruLocalExe: String(settings.mineruLocalExe || ""),
        mineruLocalAutoStart: settings.mineruLocalAutoStart !== false,
      };
    }

    // 凭据 / 本地服务地址只在 MinerU 相关模式露出(渐进披露)。
    syncConvertTokenRow() {
      const mode = String(this._convertParse?.value || "local");
      const mineru = this._convertPreset !== "img" && (mode === "mineru" || mode === "mineru-local");
      if (this._convertTokenRow) this._convertTokenRow.hidden = !mineru;
      if (this._convertLocalRow) this._convertLocalRow.hidden = !mineru;
      if (this._convertLocalExeRow) this._convertLocalExeRow.hidden = !mineru;
      if (this._convertLocalTools) this._convertLocalTools.hidden = !mineru;
    }

    // 预设不同,后续操作不同:图片 → PDF 只需选图片;文档互转才用目标格式 / 解析方式 / MinerU。
    syncConvertPreset() {
      const img = this._convertPreset === "img";
      if (this._convertFormatRow) this._convertFormatRow.hidden = img;
      if (this._convertParseRow) this._convertParseRow.hidden = img;
      for (const hint of this._convertHints || []) hint.hidden = img;
      if (this._convertImgHint) this._convertImgHint.hidden = !img;
      if (this._convertDetectRow) this._convertDetectRow.hidden = img;
      if (this._convertPathRow) this._convertPathRow.hidden = img;
      if (this._convertStart) this._convertStart.setText(img ? "打包为 PDF" : "开始转换");
      this.syncConvertTokenRow();
    }

    // 本地 MinerU:检测 = 如实探测 /v1/health(不会偷偷拉起服务);「启动服务」才启动。
    // 注意:这个视图里的 bridge 是 qbrDesktop.workshop(只有任务接口),服务接口在 qbrDesktop.mineru。
    async checkMineruLocal({ start = false } = {}) {
      const status = this._convertLocalStatus;
      if (!status) return;
      const mineru = typeof window !== "undefined" ? window.qbrDesktop?.mineru || null : null;
      if (!mineru) {
        status.setText("这个宿主不支持本地服务检测");
        return;
      }
      status.setText(start ? "启动中…" : "检测中…");
      try {
        const settings = this.formulaSettings();
        const result = start ? await mineru.ensure(settings) : await mineru.status(settings);
        status.setText(this.describeMineruStatus(result));
      } catch (error) {
        status.setText(`检测失败:${String(error?.message || error)}`);
      }
    }

    // 清理 MinerU 缓存:公式优先的解析复用缓存 + (服务没在跑时)本地上传目录;如实报告释放量。
    async clearMineruCaches() {
      const mineru = typeof window !== "undefined" ? window.qbrDesktop?.mineru || null : null;
      if (!mineru?.clearCaches) {
        new Notice("这个宿主不支持清理 MinerU 缓存");
        return;
      }
      try {
        const result = await mineru.clearCaches(this.formulaSettings());
        const total = Number(result?.totalBytes) || 0;
        const size = total >= 1024 * 1024 ? `${(total / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(total / 1024))} KB`;
        const parts = [];
        if (result?.cleared?.length) parts.push(`已清理 ${size}`);
        else parts.push("没有可清理的缓存");
        if (result?.skippedService) parts.push("服务在运行,上传目录已跳过(停掉服务后可再清)");
        if (Array.isArray(result?.skipped) && result.skipped.length) parts.push(`${result.skipped.length} 个目录被占用,跳过`);
        new Notice(`MinerU 缓存:${parts.join(";")}`);
        this._convertLocalStatus?.setText(parts.join(" · "));
      } catch (error) {
        new Notice(`清理失败:${String(error?.message || error)}`);
      }
    }

    describeMineruStatus(result) {      const url = String(result?.url || "");
      const version = result?.version ? ` · 版本 ${result.version}` : "";
      const detail = result?.detail ? ` · ${result.detail}` : "";
      switch (String(result?.status || "")) {
        case "running": return `运行中${version}(${url}${detail})`;
        case "starting": return "启动中…首次加载模型约 10–15 秒";
        case "external": return `外部服务(${url})，不由应用管理`;
        case "missing": return String(result?.detail || "没找到 mineru-kit:在下面填程序路径");
        case "error": return `启动失败:${String(result?.detail || "未知错误")}`;
        default: return `未运行(${url})；点「启动服务」拉起`;
      }
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
      // 「图片 → PDF」预设:选中的图片合成一个 PDF(W1-5),不经过 DocVortex。
      if (this._convertPreset === "img") {
        const images = files.filter((rel) => /\.(png|jpe?g|webp|gif|bmp|tiff?|jp2)$/i.test(rel));
        if (!images.length) {
          new Notice("图片 → PDF 需要图片文件(PNG / JPG / WebP / BMP / TIFF)");
          return;
        }
        void bridge.start({
          kind: "images-pdf",
          title: "图片 → PDF",
          detail: `${images.length} 张`,
          payload: { images, settings: this.docvortexSettings() },
        }).catch((error) => new Notice(String(error?.message || error)));
        this.selectTool("tasks");
        return;
      }
      const format = String(this._convertFormat?.value || "markdown");
      const ext = docvortexFormatExt(format);
      const settings = this.docvortexSettings();
      const formula = this.formulaSettings();
      const parseMode = String(this._convertParse?.value || "local");
      for (const rel of files) {
        const out = convertPath(rel, ext, (candidate) => Boolean(app?.vault?.getAbstractFileByPath?.(candidate)));
        const isPdf = /\.pdf$/i.test(rel);
        const useFormula = (parseMode === "mineru" || parseMode === "mineru-local") && isPdf;
        const useText = parseMode === "text" && isPdf;
        const formulaPayload = useFormula ? { ...formula, mineruSource: parseMode === "mineru-local" ? "local" : "" } : formula;
        void bridge.start({
          kind: useFormula ? "formula-convert" : useText ? "text-convert" : "docvortex-convert",
          title: useFormula ? "公式文档" : useText ? "文本型文档" : "文档互转",
          detail: rel,
          payload: { settings: useFormula || useText ? formulaPayload : settings, source: rel, format, out },
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
      if (this._extractStatus) {
        const probe = tasks.find((task) => task.kind === "extract-probe");
        if (!probe) this._extractStatus.setText("未检测");
        else if (probe.status === "running" || probe.status === "queued") this._extractStatus.setText("检测中…");
        else if (probe.status === "done") this._extractStatus.setText(`已就绪：${probe.output || "pdf_tool + DocVortex"}`);
        else this._extractStatus.setText(`未就绪：${probe.error || "未找到"}`);
      }
      if (this._extractRecent) {
        this._extractRecent.empty();
        const recent = tasks
          .filter((task) => task.kind === "extract-pdf" || task.kind === "extract-docvortex")
          .slice(0, 3);
        if (recent.length) {
          this._extractRecent.createEl("h3", { text: "最近" });
          for (const task of recent) this.renderTaskRow(this._extractRecent, task);
        }
      }
      if (this._extractPreview) {
        const finished = tasks.find((task) => (task.kind === "extract-pdf" || task.kind === "extract-docvortex") && task.status === "done");
        void this.renderExtractPreview(finished || null);
      }
      if (this._bookRecent) {
        this._bookRecent.empty();
        const recent = tasks
          .filter((task) => task.kind === "ebook-convert" || task.kind === "images-cbz" || task.kind === "book-build")
          .slice(0, 3);
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
