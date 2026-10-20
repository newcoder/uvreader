import { ItemView, Notice, setIcon } from "obsidian";

import { iconResolver } from "./icons.js";
import { DOCVORTEX_FORMATS, DOCVORTEX_INPUTS, EBOOK_TARGETS, IMAGE_BOOK_TARGETS, TEXT_SOURCE_EXTENSIONS, docvortexFormatExt } from "../shared/workshop-formats.js";
import { BOOK_STYLE_DEFAULTS, COVER_PALETTES } from "../shared/book-styles.js";
import { chapterStats, mergeChapters, moveChapter, removeChapter, renameChapter, splitChapter } from "../shared/book-chapters.js";
import { splitTextChapters } from "../main/text-book.js";
import { EXTRACT_MODES, IMAGE_INPUTS, extractionKind } from "../shared/extract-formats.js";
import { splitMarkdownChapters, unwrapProseFences } from "../shared/markdown-fix.js";
import { convertPath, uvtextPath } from "../shared/workshop-names.js";
import { createAiContext } from "../../../../packages/reader/src/ai-context.js";
import { engineCapabilityRows, engineComponentSummary } from "../main/engine-client.js";
import { decodeText } from "../shared/text-encoding.js";
import { applyChapterRule, describeChapterRule } from "../shared/chapter-rules.js";
import { describeIssues, scanChapterIssues, splitCleanupBlocks } from "../shared/text-issues.js";

// 书坊的 AI 辅助复用伴读的配置读取(供应商 / 模型 / 密钥都从同一份设置与密钥库来,
// 不新增设置项);这里只用 aiConfig,翻译与高亮定位给最小实现。
const aiContext = createAiContext({
  translate: (key) => String(key || ""),
  platform: {},
  win: typeof window === "undefined" ? undefined : window,
  locateHl: () => null,
});

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
    switchLabel.createSpan({ text: "导航里显示「书坊」;关闭只隐藏导航入口和书坊页面,阅读不受影响,「设置 → 书坊」这个标签页始终在,随时能打开" });
    switchInput.addEventListener("change", () => {
      persist("workshopEnabled", Boolean(switchInput.checked));
      // 勾选框只存设置不会重绘导航:显式触发一次布局刷新(否则关掉能生效、再打开导航却不回来)。
      plugin?.app?.workspace?.trigger?.("layout-change");
      save("书坊开关已保存;导航立即生效。");
    });
    toggleCard.createDiv({ cls: "qbr-workshop-hint", text: "书坊负责:文字层与可搜索 PDF、格式转换、内容提取、电子书制作。后台能力的路径由「书坊引擎」管;下面的「本机工具」只在引擎不可用时回退。" });

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
    mineruCard.createDiv({ cls: "qbr-workshop-hint", text: "有引擎时:本地服务地址会自动同步给引擎;凭据只在回退本机时用(引擎的凭据在「引擎配置」里)。" });
    mineruCard.createDiv({ cls: "qbr-workshop-hint", text: "首次用某个模型时 MinerU 会先下载(几百 MB~GB),期间任务会停在「解析中」;同一模型之后不再下载。" });
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

    // 4. 书坊引擎(可独立部署的本地 HTTP 服务:应用只探测与调用,能力由引擎上报)
    //    E1 只做探测/状态;搬能力(E2)与一键安装(E3)见 docs/workshop-engine-plan.md。
    const engineCard = root.createDiv("qbr-workshop-card");
    engineCard.createEl("h3", { text: "书坊引擎(后台能力)" });
    engineCard.createDiv({ cls: "qbr-workshop-hint", text: "把 Python / pdf_tool / DocVortex / 文字层这些后台能力做成一个可独立部署的本地服务;装上引擎后,下面那些路径都不用自己配。" });
    // 引擎进程:状态 + 启动/停止 + 启动应用时自动开启。
    // 引擎是独立服务,应用重启不会自动带起它 —— 这里给显式入口;停只停应用自己起的(pid 记录)。
    const engineServiceRow = engineCard.createDiv("qbr-workshop-row");
    const engineServiceStatus = engineServiceRow.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "检查中…" });
    const engineStartBtn = engineServiceRow.createEl("button", { cls: "mod-cta", text: "启动引擎" });
    const engineStopBtn = engineServiceRow.createEl("button", { text: "停止引擎" });
    const engineAutoLabel = engineCard.createEl("label", { cls: "qbr-workshop-hint" });
    const engineAuto = engineAutoLabel.createEl("input", { attr: { type: "checkbox" } });
    engineAuto.checked = settings.engineAutoStart !== false;
    engineAutoLabel.createSpan({ text: "启动应用时自动开启书坊引擎(引擎没装就什么都不做)" });
    engineAuto.addEventListener("change", () => persist("engineAutoStart", engineAuto.checked));
    const renderEngineService = (state) => {
      if (!state) return;
      engineServiceStatus.setText(String(state.detail || (state.installed ? (state.running ? "运行中" : "未运行") : "未安装")));
      engineStartBtn.disabled = state.installed !== true || state.running === true;
      engineStopBtn.disabled = state.running !== true;
    };
    const refreshEngineService = async () => {
      if (!bridge?.engine?.service) return;
      const state = await bridge.engine.service().catch(() => null);
      renderEngineService(state);
    };
    engineStartBtn.addEventListener("click", async () => {
      engineServiceStatus.setText("启动中…");
      const result = await bridge?.engine?.start?.({ engineUrl: settings.engineUrl })
        .catch((error) => ({ ok: false, detail: String(error?.message || error) }));
      if (!result?.ok) {
        engineServiceStatus.setText(`启动失败:${result?.detail || result?.error || "没有返回原因"}`);
        void refreshEngineService();
        return;
      }
      if (result.engineUrl) {
        persist("engineUrl", result.engineUrl);
        engineUrl.value = result.engineUrl;
      }
      if (result.token) {
        persist("engineToken", result.token);
        engineToken.value = result.token;
      }
      renderEngineService(result);
      void checkEngine(true);
    });
    engineStopBtn.addEventListener("click", async () => {
      engineServiceStatus.setText("停止中…");
      const result = await bridge?.engine?.stop?.().catch((error) => ({ ok: false, detail: String(error?.message || error) }));
      if (result?.ok) engineCaps.empty();
      engineServiceStatus.setText(result?.ok ? "已停止" : String(result?.detail || "停止失败"));
      void refreshEngineService();
    });
    void refreshEngineService();
    const engineUrlRow = engineCard.createDiv("qbr-workshop-row");
    engineUrlRow.createSpan({ cls: "qbr-workshop-hint", text: "服务地址" });
    const engineUrl = engineUrlRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空用 http://127.0.0.1:8760" } });
    engineUrl.value = String(settings.engineUrl || "");
    bind(engineUrl, "engineUrl", "引擎地址已保存。");
    const engineTokenRow = engineCard.createDiv("qbr-workshop-row");
    engineTokenRow.createSpan({ cls: "qbr-workshop-hint", text: "令牌" });
    const engineToken = engineTokenRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "引擎没设令牌就留空(仅本机)" } });
    engineToken.value = String(settings.engineToken || "");
    bind(engineToken, "engineToken", "引擎令牌已保存。");
    // E3b 一键安装/更新:下载 + sha256 校验 + 解压 + 拉起都在主进程做,进度走任务队列;
    // 装完把地址与令牌回填到上面两行(用户不用自己抄)。
    const engineInstallRow = engineCard.createDiv("qbr-workshop-row");
    const engineInstallBtn = engineInstallRow.createEl("button", { cls: "mod-cta", text: "下载并安装引擎" });
    const engineInstallLocalBtn = engineInstallRow.createEl("button", { text: "从本地包安装" });
    const engineInstallStatus = engineInstallRow.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "" });
    const applyEngineInstall = (result) => {
      if (!result?.engineUrl) return;
      persist("engineUrl", result.engineUrl);
      engineUrl.value = result.engineUrl;
      if (result.engineToken) {
        persist("engineToken", result.engineToken);
        engineToken.value = result.engineToken;
      }
      engineInstallStatus.setText(`引擎 ${result.version || ""} 已装好并启动 ✓`);
      void checkEngine(true);
    };
    const watchEngineInstall = (taskId) => {
      if (!bridge?.workshop?.onState) return;
      const stop = bridge.workshop.onState((state) => {
        const task = (state?.tasks || []).find((row) => row.id === taskId);
        if (!task) return;
        if (task.status === "queued" || task.status === "running") {
          if (task.label) engineInstallStatus.setText(String(task.label));
          return;
        }
        stop?.();
        if (task.status === "done") applyEngineInstall(task.result);
        else if (task.status === "cancelled") engineInstallStatus.setText("安装已取消。");
        else engineInstallStatus.setText(`安装失败:${task.error || "看任务详情"}`);
      });
    };
    const startEngineInstall = (payload, detail) => {
      if (!bridge?.workshop?.start) return;
      engineInstallStatus.setText("排队中…");
      void bridge.workshop.start({ kind: "engine-install", title: "安装书坊引擎", detail, payload })
        .then((taskId) => watchEngineInstall(String(taskId || "")))
        .catch((error) => engineInstallStatus.setText(`启动失败:${String(error?.message || error)}`));
    };
    engineInstallBtn.addEventListener("click", () => startEngineInstall({ port: 8760 }, "最新版"));
    engineInstallLocalBtn.addEventListener("click", async () => {
      const file = await bridge?.engine?.pickBundle?.().catch(() => "");
      if (!file) return;
      startEngineInstall({ archivePath: String(file) }, "本地包");
    });
    // 可选组件(E4):把 DocVortex 这类「还要另外装」的东西装进引擎自己的 Python;action=remove 卸载。
    const startEngineComponent = (name, label, action = "install") => {
      const removing = action === "remove";
      if (!bridge?.workshop?.start) return;
      engineInstallStatus.setText(removing ? `准备卸载 ${label}…` : `准备装 ${label}…`);
      void bridge.workshop.start({
        kind: "engine-component",
        title: removing ? `从引擎卸载 ${label}` : `装 ${label} 到引擎`,
        detail: label,
        payload: { name, action, settings: { ...settings } },
      }).then((taskId) => {
        if (!bridge?.workshop?.onState) return;
        const stop = bridge.workshop.onState((state) => {
          const task = (state?.tasks || []).find((row) => row.id === String(taskId || ""));
          if (!task) return;
          if (task.status === "queued" || task.status === "running") {
            if (task.label) engineInstallStatus.setText(String(task.label));
            return;
          }
          stop?.();
          if (task.status === "done") {
            engineInstallStatus.setText(removing ? `${label} 已从引擎卸载 ✓` : `${label} 已装进引擎 ✓`);
            void checkEngine(true);
          } else if (task.status === "cancelled") {
            engineInstallStatus.setText(`${removing ? "卸载" : "装"} ${label} 已取消。`);
          } else {
            engineInstallStatus.setText(`${removing ? "卸载" : "装"} ${label} 失败:${task.error || "看任务详情"}`);
          }
        });
      }).catch((error) => engineInstallStatus.setText(`启动失败:${String(error?.message || error)}`));
    };
    const engineTools = engineCard.createDiv("qbr-workshop-row");
    const engineProbe = engineTools.createEl("button", { text: "检测引擎" });
    const engineRefreshBtn = engineTools.createEl("button", { text: "重探能力" });
    const engineStatus = engineTools.createSpan({ cls: "qbr-workshop-hint qbr-mineru-status", text: "未检测" });
    const engineCaps = engineCard.createDiv("qbr-workshop-engine-caps");
    const engineConfig = engineCard.createEl("details");
    engineConfig.createEl("summary", { text: "引擎配置(路径 / 凭据 / 并发;配置存在引擎侧)" });
    const engineFields = {};
    const engineField = (label, key, placeholder = "") => {
      const row = engineConfig.createDiv("qbr-workshop-row");
      row.createSpan({ cls: "qbr-workshop-hint", text: label });
      const input = row.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder } });
      engineFields[key] = input;
    };
    engineField("pdf_tool 目录", "pdfToolDir", "内含 pdf_tool/pdf_to_doc.py;留空用引擎自带的");
    engineField("Python", "python", "跑 pdf_tool / DocVortex 的解释器;留空用引擎自带");
    engineField("DocVortex", "docvortexPath", "留空按引擎 Python / PATH 找");
    engineField("MinerU 服务地址", "mineruLocalUrl", "如 http://127.0.0.1:8000");
    engineField("MinerU token", "mineruToken", "已保存就留空(不回显)");
    engineField("MinerU 本机程序", "mineruLocalExe", "mineru-kit 可执行文件(helper 靠它找 venv)");
    engineField("MinerU 模型", "mineruModel", "默认 vlm");
    engineField("Calibre", "calibrePath", "ebook-convert;留空按 PATH / 常见位置找");
    engineField("boko", "bokoPath", "boko 二进制(单文件);留空按 PATH 找");
    engineField("并发作业数", "workers", "默认 2");
    const engineActions = engineConfig.createDiv("qbr-workshop-row");
    const engineSave = engineActions.createEl("button", { cls: "mod-cta", text: "保存到引擎" });
    const engineSaveHint = engineActions.createSpan({ cls: "qbr-workshop-hint", text: "" });

    const renderEngineHealth = (health) => {
      engineCaps.empty();
      const rows = engineCapabilityRows(health);
      if (!rows.length) return;
      // 如实说明:包里自带什么、什么还要另外装(别让用户以为装上引擎就什么都有了)。
      const summary = engineComponentSummary(health);
      if (summary.bundled.length || summary.external.length) {
        engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `引擎包里自带:${summary.bundled.join(" / ") || "—"}` });
        engineCaps.createDiv({
          cls: "qbr-workshop-hint",
          text: `还要另外装:${summary.external.join(" / ") || "—"}${summary.optional.length ? `(可选:${summary.optional.join(" / ")})` : ""}`,
        });
      }
      for (const row of rows) {
        // pdf_tool 走的是配置目录时,别标「自带」(它本来可以是自带的,但现在用的是配置的那份)。
        const tag = row.kind === "bundled"
          ? (row.detail.includes("配置 ·") ? "用配置的路径" : "自带")
          : row.optional ? "另外装 · 可选" : "另外装";
        engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `${row.ok ? "✓" : "✗"} ${row.label}${row.detail ? ` · ${row.detail}` : ""}${row.kind ? ` · ${tag}` : ""}` });
      }
      // 不可用时给「具体怎么补」,不只报错;引擎能自己装的直接给按钮(装进引擎的 Python,不碰系统)。
      for (const item of summary.missing) {
        if (item.installable && item.component) {
          const row = engineCaps.createDiv("qbr-workshop-row");
          row.createSpan({ cls: "qbr-workshop-hint", text: `→ ${item.label}:` });
          const button = row.createEl("button", { cls: "mod-cta", text: "装到引擎" });
          button.addEventListener("click", () => startEngineComponent(item.component, item.label));
          if (item.fix) engineCaps.createDiv({ cls: "qbr-workshop-hint", text: item.fix });
          continue;
        }
        if (!item.fix) continue;
        engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `→ ${item.label}:${item.fix}` });
      }
    };
    const loadEngineConfig = async () => {
      if (!bridge?.engine?.config) return;
      const result = await bridge.engine.config(settings).catch(() => null);
      if (!result?.ok) return;
      const config = result.data?.config || {};
      const detected = result.data?.detected || {};
      const defaults = result.data?.defaults || {};
      // 配置项 → 引擎探测到的对应值:界面拿它当**占位**(填了用填的,没填就是实际生效的值)。
      const autoKeys = { pdfToolDir: "pdfTool", python: "python", docvortexPath: "docvortex", calibrePath: "calibre", bokoPath: "boko" };
      const sourceLabel = { bundled: "自带", configured: "配置", path: "PATH", engine: "引擎 Python", "": "自动" };
      for (const [key, input] of Object.entries(engineFields)) {
        input.value = key === "mineruToken" ? "" : String(config[key] ?? "");
        if (key === "mineruToken") {
          if (config.hasMineruToken) input.setAttribute("placeholder", "已保存;留空不修改");
          continue;
        }
        if (input.value) continue;
        const auto = autoKeys[key];
        if (auto && detected[auto]) {
          input.setAttribute("placeholder", `自动:${detected[auto]}(${sourceLabel[detected[`${auto}Source`]] || "自动"})`);
        } else if (defaults[key] !== undefined && defaults[key] !== "") {
          input.setAttribute("placeholder", `默认:${defaults[key]}`);
        }
      }
      // DocVortex 是装在引擎自己的 components/ 里时,给一条卸载入口 ——
      // 只在「引擎里那份」出现(来源 engine);PATH / 配置找到的绝不显示,免得删错东西。
      if (detected.docvortexSource === "engine") {
        const row = engineCaps.createDiv("qbr-workshop-row");
        row.createSpan({ cls: "qbr-workshop-hint", text: "DocVortex 装在引擎的 components/ 里:" });
        const uninstall = row.createEl("button", { text: "卸载" });
        uninstall.addEventListener("click", () => startEngineComponent("docvortex", "DocVortex", "remove"));
      }
    };
    const checkEngine = async (refresh = false) => {
      if (!bridge?.probe?.engine) return;
      engineStatus.setText(refresh ? "重探中…" : "检测中…");
      const result = await bridge.probe.engine({ ...settings, refresh }).catch((error) => ({ ok: false, detail: String(error?.message || error) }));
      const detail = String(result?.detail || "").trim();
      engineStatus.setText(result?.ok ? `可用 · ${detail}` : `不可用:${detail || "没有返回原因"}`);
      if (result?.ok) {
        renderEngineHealth(result.health);
        void loadEngineConfig();
        // 自动接线:本机有活着的本地 MinerU 时,地址/程序/凭据已经顺手写进引擎配置(要如实说出来)。
        const syncedKeys = Object.keys(result.synced?.patch || {});
        if (syncedKeys.length) {
          engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `已把本机 MinerU 设置同步给引擎:${syncedKeys.join(" / ")}` });
        }
      } else {
        engineCaps.empty();
      }
    };
    engineProbe.addEventListener("click", () => void checkEngine(false));
    engineRefreshBtn.addEventListener("click", () => void checkEngine(true));
    // 手工验证「这次是引擎干的」:看引擎自己的作业清单(新在前,带参数摘要与状态)。
    const engineJobsBtn = engineTools.createEl("button", { text: "查看引擎作业" });
    engineJobsBtn.addEventListener("click", async () => {
      engineCaps.empty();
      const result = await bridge?.engine?.jobs?.({ ...settings }, 8).catch(() => null);
      if (!result?.ok) {
        engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `读不到作业清单:${result?.error || "没有返回原因"}` });
        return;
      }
      const jobs = result.data?.jobs || [];
      engineCaps.createDiv({ cls: "qbr-workshop-hint", text: jobs.length ? `最近 ${jobs.length} 个作业(新在前):` : "引擎还没跑过作业。" });
      for (const job of jobs) {
        const when = Number(job.finishedAt || job.startedAt || job.createdAt || 0);
        const time = when ? new Date(when * 1000).toLocaleTimeString() : "";
        const progress = Number(job.total) ? ` ${job.done}/${job.total}` : "";
        engineCaps.createDiv({ cls: "qbr-workshop-hint", text: `${time} · ${job.kind} · ${job.status}${progress} · ${job.summary}` });
      }
    });
    engineSave.addEventListener("click", async () => {
      if (!bridge?.engine?.saveConfig) return;
      const patch = {};
      for (const [key, input] of Object.entries(engineFields)) patch[key] = String(input.value || "");
      engineSaveHint.setText("保存中…");
      const result = await bridge.engine.saveConfig(settings, patch).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      if (!result?.ok) {
        engineSaveHint.setText(`保存失败:${result?.error || "没有返回原因"}`);
        return;
      }
      engineSaveHint.setText("已保存到引擎 ✓");
      if (result.data?.capabilities) renderEngineHealth({ capabilities: result.data.capabilities });
    });

    // 5. DocVortex(本地解析 / 公式优先的渲染端)
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
    docvortexCard.createDiv({ cls: "qbr-workshop-hint", text: "装了书坊引擎后这里可以留空:DocVortex 的路径改在引擎配置里(引擎会自己探)。" });
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
    calibreCard.createDiv({ cls: "qbr-workshop-hint", text: "装了书坊引擎后这里可以留空:Calibre / boko 的路径改在引擎配置里(引擎会自己探;boko 更轻)。下载:https://calibre-ebook.com/download · boko:https://github.com/zacharydenton/boko/releases" });

    // 8. 本机回退:与引擎配置重复的「本机路径」收进一块折叠区(字段不删 —— 引擎不可用时靠它们回退本机)。
    // 引擎是主路径:把它的卡片在 DOM 里提到最前(书坊开关之后),不用搬那一大段代码。
    root.insertBefore(engineCard, toggleCard.nextSibling);
    const fallbackCard = root.createEl("details", { cls: "qbr-workshop-card qbr-workshop-fallback" });
    fallbackCard.createEl("summary", { text: "本机工具(仅引擎不可用时回退;引擎可用时这些设置不生效)" });
    fallbackCard.createDiv({ cls: "qbr-workshop-hint", text: "引擎的路径改在「书坊引擎 → 引擎配置」里;这里是引擎没装 / 连不上时的回退路径(填了才用,留空按自动检测)。" });
    // MinerU 模型:本机回退链路要用,但之前只在引擎配置里露出来 → 这里补上(值本来就是共用的同一个设置)。
    const fallbackModelRow = fallbackCard.createDiv("qbr-workshop-row");
    fallbackModelRow.createSpan({ cls: "qbr-workshop-hint", text: "MinerU 模型" });
    const fallbackModel = fallbackModelRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "默认 vlm(只影响回退本机;引擎用引擎配置里的)" } });
    fallbackModel.value = String(settings.mineruModel || "");
    bind(fallbackModel, "mineruModel", "MinerU 模型已保存;新任务生效。");
    fallbackCard.appendChild(ocrCard);
    fallbackCard.appendChild(docvortexCard);
    fallbackCard.appendChild(calibreCard);

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
  "extract-docvortex": "提取",
  "questions-extract": "题库",
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
  if (task.status === "cancelled") return "已取消(上游释放资源约需 10–20 秒,稍候再试)";
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
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "输出 <源名>.md / .html / .json(+ 体检报告),落在源文件旁;PDF 走 pdf_tool(模式可切 MinerU),Office / OFD / HTML / 图片 / Markdown / 纯文本走 DocVortex。" });
      optionCard.createDiv({ cls: "qbr-workshop-hint", text: "水印 / 页眉页脚:pdf_tool 目前总是自动清理(已向 pdf_tool 提需求,支持后才能在这里关)。" });
      // 题库:提取同一份正文,再按规则解析成 uvreader.question-bank/v1(另存 JSON + 可读 Markdown)。
      const bankRow = optionCard.createEl("label", { cls: "qbr-workshop-book" });
      this._extractBank = bankRow.createEl("input", { attr: { type: "checkbox" } });
      this._extractBank.checked = false;
      bankRow.createSpan({ text: "同时生成题库(题目 → _questions.json + _questions.md;试卷 / 练习册用)" });
      const detectRow = optionCard.createDiv("qbr-workshop-row");
      addSettingsLink(detectRow, "提取链路的检测(pdf_tool / DocVortex / MinerU)与全局配置都在「设置 → 书坊」。");

      // 上游修好提取行为(脚注、表格等)后老缓存不会自动更新,这里显式重跑一次。
      const refreshRow = optionCard.createEl("label", { cls: "qbr-workshop-book" });
      this._extractRefresh = refreshRow.createEl("input", { attr: { type: "checkbox" } });
      this._extractRefresh.checked = false;
      refreshRow.createSpan({ text: "忽略缓存重新提取(PDF 会重跑一次 MinerU,较慢且计费)" });

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
      const wanted = [...DOCVORTEX_INPUTS, ...IMAGE_INPUTS, ...TEXT_SOURCE_EXTENSIONS];
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
      const withBank = this._extractBank?.checked === true;
      for (const rel of files) {
        if (withBank) {
          // 题库:一次任务里「提取 + 解析 + 落盘」,产物是 _questions.json / _questions.md / _audit.json。
          void bridge.start({
            kind: "questions-extract",
            title: "题库提取",
            detail: rel,
            payload: { settings, source: rel, mode, refresh: this._extractRefresh?.checked === true },
          }).catch((error) => new Notice(String(error?.message || error)));
          continue;
        }
        const kind = extractionKind(rel);
        void bridge.start({
          kind: kind === "pdf" ? "extract-pdf" : "extract-docvortex",
          title: "内容提取",
          detail: rel,
          payload: { settings, source: rel, mode, refresh: this._extractRefresh?.checked === true },
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

      // 主流程只有一条:向导(① 内容 → ② 目录 → ③ 书名与封面 → ④ 排版 → 生成);
      // 换格式 / 图片打包等次要动作收进「更多工具」。
      const wizardCard = root.createDiv("qbr-workshop-card");
      wizardCard.createEl("h3", { text: "电子书向导" });
      wizardCard.createDiv({ cls: "qbr-workshop-hint", text: "输入 txt / Markdown 直接分章;PDF / Office / OFD / HTML / EPUB / 图片在生成时自动提取,无需先跑内容提取。" });
      const wizardGrid = wizardCard.createDiv("qbr-workshop-wizard");
      const controls = wizardGrid.createDiv("qbr-workshop-wizard-controls");

      // ① 内容
      const sourceStep = this.bookStep(controls, "1", "内容", "书稿来源");
      const sourceRow = sourceStep.createDiv("qbr-workshop-row");      const pickSource = sourceRow.createEl("button", { text: "选择书稿…" });
      pickSource.addEventListener("click", () => this.toggleBookSourceList());
      const pickSourceLocal = sourceRow.createEl("button", { text: "打开本地文件…" });
      pickSourceLocal.addEventListener("click", () => void this.pickLocalBookSources());
      sourceRow.createSpan({ cls: "qbr-workshop-hint", text: "本地文件就地处理,产物落在源文件旁" });
      this._bookSourceList = sourceStep.createDiv("qbr-workshop-booklist");
      this._bookSourceList.hidden = true;
      this._bookSourceChips = sourceStep.createDiv("qbr-workshop-chips");
      // 上游(pdf_tool / DocVortex)修好提取行为后,老缓存不会自动更新:需要时重跑一次。
      const refreshRow = sourceStep.createEl("label", { cls: "qbr-workshop-book" });
      this._bookRefresh = refreshRow.createEl("input", { attr: { type: "checkbox" } });
      this._bookRefresh.checked = false;
      refreshRow.createSpan({ text: "忽略缓存重新提取(PDF / Office 会重跑上游,较慢;上游更新过提取行为时才需要)" });

      // ② 目录(自动分章,可编辑)
      const chapterStep = this.bookStep(controls, "2", "目录", "自动分章");
      this._bookChaptersHost = chapterStep.createDiv("qbr-workshop-chapters");
      // 书里那几页印刷目录(「目录 …… 12」)与电子书导航重复且格式乱,默认去掉。
      const tocRow = chapterStep.createEl("label", { cls: "qbr-workshop-book" });
      this._bookDropToc = tocRow.createEl("input", { attr: { type: "checkbox" } });
      this._bookDropToc.checked = true;
      tocRow.createSpan({ text: "去掉书里的印刷目录(与电子书导航重复的那几页)" });

      // AI 分章建议:章名不是常见形态时,让模型归纳规则,套用前先给预览(可撤销)。
      const aiChapterRow = chapterStep.createDiv("qbr-workshop-row");
      aiChapterRow.createSpan({ cls: "qbr-workshop-hint", text: "认不出章名?" });
      const aiChapters = aiChapterRow.createEl("button", { text: "AI 建议分章" });
      aiChapters.addEventListener("click", () => void this.startAiChapters());
      aiChapterRow.createSpan({ cls: "qbr-workshop-hint", text: "判断章名形态,套用前先看预览" });
      this._bookAiChapters = chapterStep.createDiv("qbr-workshop-ai-suggest qbr-workshop-ai-chapters");

      // AI 清理(两步):先本地体检发现问题 → 用户勾选确认 → 再清理并给出前后对比。
      const aiCleanRow = chapterStep.createDiv("qbr-workshop-row");
      aiCleanRow.createSpan({ cls: "qbr-workshop-hint", text: "有 OCR 错字 / 断行 / 吞标题?" });
      const aiCleanCheck = aiCleanRow.createEl("button", { text: "检查可疑内容" });
      aiCleanCheck.addEventListener("click", () => this.checkBookIssues());
      aiCleanRow.createSpan({ cls: "qbr-workshop-hint", text: "本地体检,不调用 AI" });
      this._bookAiClean = chapterStep.createDiv("qbr-workshop-ai-suggest qbr-workshop-ai-clean");

      // ③ 书名与封面
      const metaStep = this.bookStep(controls, "3", "书名与封面", "写进扉页、目录与封面");
      const metaRow = metaStep.createDiv("qbr-workshop-row");
      metaRow.createSpan({ cls: "qbr-workshop-hint", text: "书名" });
      this._bookTitle = metaRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "留空用文件名" } });
      metaRow.createSpan({ cls: "qbr-workshop-hint", text: "作者" });
      this._bookAuthor = metaRow.createEl("input", { cls: "qbr-workshop-input", attr: { placeholder: "可选" } });

      // AI 辅助(W2-1):结果只作建议,「应用」前不改任何字段(可选、可撤销)。
      this._aiSuggestion = null;
      this._aiDismissed ||= new Set();
      const aiRow = metaStep.createDiv("qbr-workshop-row");
      aiRow.createSpan({ cls: "qbr-workshop-hint", text: "AI 辅助" });
      const aiMeta = aiRow.createEl("button", { text: "AI 推断书名 / 作者" });
      aiMeta.addEventListener("click", () => void this.startAiSuggestion("ai-metadata"));
      const aiCover = aiRow.createEl("button", { text: "AI 封面文案" });
      aiCover.addEventListener("click", () => void this.startAiSuggestion("ai-cover-copy"));
      aiRow.createSpan({ cls: "qbr-workshop-hint", text: "用书稿开头推断;只填空着的字段" });
      this._bookAiSuggestion = metaStep.createDiv("qbr-workshop-ai-suggest qbr-workshop-ai-meta");

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

      // ④ 排版样式:只留书里一定看得见的三项。字号 / 行距 / 边距 / 对齐 / 主题都由
      // 阅读器自己的阅读设置决定(UV Reader 用 !important 覆盖,见 reader-appearance.js),
      // 摆在这里只会是「按了没反应」的控件;书里仍会写入一份默认基线供其他阅读器使用。
      const styleStep = this.bookStep(controls, "4", "排版样式", "首行缩进 / 段间距 / 标题对齐");
      this._bookControls = {};
      this.bookSlider(styleStep, "首行缩进", "indent", { min: 0, max: 4, step: 0.5, suffix: "em" });
      this.bookSlider(styleStep, "段间距", "spacing", { min: 0, max: 2, step: 0.25, suffix: "em" });
      const headingRow = styleStep.createDiv("qbr-workshop-row");
      headingRow.createSpan({ cls: "qbr-workshop-hint", text: "标题" });
      this._bookHeadingAlign = headingRow.createEl("select", { cls: "qbr-workshop-select" });
      this._bookHeadingAlign.createEl("option", { attr: { value: "left" }, text: "左对齐" });
      this._bookHeadingAlign.createEl("option", { attr: { value: "center" }, text: "居中" });
      this._bookHeadingAlign.addEventListener("change", () => this.onBookStyleChange());

      const buildRow = controls.createDiv("qbr-workshop-row qbr-workshop-build");
      const build = buildRow.createEl("button", { cls: "mod-cta", text: "生成 EPUB" });
      build.addEventListener("click", () => this.startBookBuild());
      buildRow.createSpan({ cls: "qbr-workshop-hint", text: "进度在「任务」里查看" });

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

    bookStyleState() {
      const state = {};
      for (const [key, control] of Object.entries(this._bookControls || {})) {
        state[key] = Number(control.input.value);
      }
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
      for (const [key, control] of Object.entries(this._bookControls || {})) {
        const fallback = Number.isFinite(Number(BOOK_STYLE_DEFAULTS[key])) ? Number(BOOK_STYLE_DEFAULTS[key]) : control.input.value;
        control.input.value = String(Number.isFinite(Number(saved[key])) ? Number(saved[key]) : fallback);
        control.value.setText(`${control.input.value}${control.suffix}`);
      }
      if (saved.headingAlign) this._bookHeadingAlign.value = String(saved.headingAlign);
      if (typeof saved.title === "string") this._bookTitle.value = saved.title;
      if (typeof saved.author === "string") this._bookAuthor.value = saved.author;
      if (saved.coverMode) this._bookCoverMode.value = String(saved.coverMode);
      if (saved.coverPalette) this._bookCoverPalette.value = String(saved.coverPalette);
      if (typeof saved.coverImage === "string") this._bookCoverImage = saved.coverImage;
      if (typeof saved.subtitle === "string") this._bookSubtitle.value = saved.subtitle;
      this.syncBookCoverRow();
      void this.renderBookChapters();
    }

    onBookStyleChange() {
      for (const control of Object.values(this._bookControls || {})) {
        control.value.setText(`${control.input.value}${control.suffix}`);
      }
      try { localStorage.setItem("qbr-workshop-book-style", JSON.stringify(this.bookStyleState())); } catch { /* ignore */ }
    }

    // ── LLM 辅助(W2-1):AI 元数据推断 / AI 封面文案 ──────────────────────
    // 伴读那份配置(供应商 / 模型 / 密钥);没配好返回 null,由调用方给可操作提示。
    aiReadyConfig() {
      const cfg = aiContext.aiConfig(plugin);
      if (!cfg?.provider || !cfg.base || !cfg.model || (cfg.needsKey && !cfg.key)) return null;
      return {
        id: cfg.id,
        name: cfg.provider?.label || cfg.id,
        base: cfg.base,
        model: cfg.model,
        thinking: cfg.thinking === true,
        supportsThinking: cfg.provider?.supportsThinking === true,
        compat: cfg.provider?.compat || null,
        key: cfg.key || "",
        needsKey: cfg.needsKey === true,
      };
    }

    // 读书稿正文:按编码解码(GB18030 的中文 TXT 很常见,一律 UTF-8 读会整本乱码)。
    // 书库文件走 vault;本地文件(书库外)按绝对路径读。两条路都经过同一份解码。
    async readSourceText(rel) {
      const normalized = String(rel || "").replace(/\\/g, "/");
      if (!normalized) return "";
      const vaultRoot = String(window.qbrDesktop?.paths?.vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const absolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
        ? normalized
        : (vaultRoot ? `${vaultRoot}/${normalized}` : "");
      const fsImpl = typeof window !== "undefined" && typeof window.require === "function" ? window.require("fs") : null;
      if (fsImpl && absolute) {
        try {
          return decodeText(fsImpl.readFileSync(absolute));
        } catch { /* 读不到就退回 vault */ }
      }
      const file = app?.vault?.getAbstractFileByPath?.(normalized);
      return file ? String(await app.vault.read(file).catch(() => "") || "") : "";
    }

    // 书稿全文 / 开头:txt / md 直接读;PDF / Office 读同目录「内容提取」的 md 产物。
    // 与主进程 runner 的读法一致(同一份编码解码),套用 AI 规则时切出来的章节才对得上。
    async bookSourceFullText() {
      const rel = String(this._bookSources?.[0] || "");
      if (!rel) return "";
      if (/\.(txt|md|markdown)$/i.test(rel)) return this.readSourceText(rel);
      return this.readSourceText(rel.replace(/\.[^./\\]+$/, ".md"));
    }

    async bookSourceText(limit = 8000) {
      return (await this.bookSourceFullText()).slice(0, limit);
    }

    async startAiSuggestion(kind) {
      if (!bridge) return;
      const rel = String(this._bookSources?.[0] || "");
      if (!rel) {
        new Notice("请先选择书稿");
        return;
      }
      const config = this.aiReadyConfig();
      if (!config) {
        new Notice("AI 还没配置好:先在「设置 → AI 助读」里选好供应商、模型与密钥");
        return;
      }
      const text = await this.bookSourceText();
      if (text.trim().length < 20) {
        new Notice("没有可用的正文:PDF / Office 书稿请先跑一次「内容提取」,或直接选 txt / Markdown");
        return;
      }
      const fileName = rel.split("/").pop() || rel;
      void bridge.start({
        kind,
        title: kind === "ai-metadata" ? "AI 推断元数据" : "AI 封面文案",
        detail: rel,
        payload: { config, text, fileName },
      }).catch((error) => new Notice(String(error?.message || error)));
      new Notice("AI 在后台处理,结果会出现在「书名与封面」这一步(只作建议)");
    }

    // 任务完成 → 记下建议;面板里显式「应用」才写进字段 / 替换目录(可选、可撤销)。
    captureAiSuggestions(tasks) {
      const pending = (tasks || []).find((task) => (task.kind === "ai-metadata" || task.kind === "ai-cover-copy" || task.kind === "ai-chapters")
        && task.status === "done" && task.result);
      if (!pending) return;
      if (this._aiSuggestion?.taskId === pending.id || this._aiDismissed?.has?.(pending.id)) return;
      this._aiSuggestion = { kind: pending.kind, taskId: pending.id, data: pending.result };
      this.renderAiSuggestion();
    }

    renderAiSuggestion() {
      const suggestion = this._aiSuggestion;
      const kind = suggestion?.kind || "";
      const host = kind === "ai-chapters" ? this._bookAiChapters
        : kind === "ai-clean" ? this._bookAiClean
          : this._bookAiSuggestion;
      if (!host) return;
      host.empty();
      if (!suggestion?.data) return;
      if (kind === "ai-chapters") this.renderAiChapterSuggestion(host, suggestion);
      else if (kind === "ai-clean") this.renderAiCleanSuggestion(host, suggestion);
      else this.renderAiFieldSuggestion(host, suggestion);
    }

    aiSuggestionActions(host, suggestion, applyLabel, onApply) {
      const actions = host.createDiv("qbr-workshop-row");
      const apply = actions.createEl("button", { cls: "mod-cta", text: applyLabel });
      apply.addEventListener("click", () => void onApply());
      const skip = actions.createEl("button", { text: "忽略" });
      skip.addEventListener("click", () => {
        this._aiDismissed?.add?.(suggestion.taskId);
        this._aiSuggestion = null;
        host.empty();
      });
    }

    renderAiFieldSuggestion(host, suggestion) {
      if (!host) return;
      const rows = suggestion.kind === "ai-metadata"
        ? [["书名", suggestion.data.title], ["作者", suggestion.data.author], ["语言", suggestion.data.language], ["丛书", suggestion.data.series], ["标签", (suggestion.data.tags || []).join(" / ")]]
        : [["书名", suggestion.data.title], ["副标题", suggestion.data.subtitle], ["系列", suggestion.data.series]];
      const filled = rows.filter(([, value]) => String(value || "").trim());
      if (!filled.length) {
        host.createDiv({ cls: "qbr-workshop-hint", text: "AI 没有给出可用的建议(可以重试一次)" });
        return;
      }
      host.createDiv({ cls: "qbr-workshop-hint", text: suggestion.kind === "ai-metadata" ? "AI 建议(应用时只填空着的字段):" : "AI 封面文案(应用时只填空着的字段):" });
      for (const [label, value] of filled) host.createDiv({ cls: "qbr-workshop-hint", text: `${label}:${value}` });
      this.aiSuggestionActions(host, suggestion, "应用", () => this.applyAiSuggestion());
    }

    // AI 分章建议:只显示「规则 + 预览」,套用是本地按规则重切(与主进程同一份实现)。
    renderAiChapterSuggestion(host, suggestion) {
      if (!host) return;
      const data = suggestion.data;
      host.createDiv({ cls: "qbr-workshop-hint", text: `AI 判断的章名形态:${describeChapterRule(data.rule)}` });
      host.createDiv({ cls: "qbr-workshop-hint", text: `预计 ${data.count} 章(从 ${data.candidates} 条候选里${data.truncated ? "采样" : "逐条"}判断)` });
      if (data.first?.length) host.createDiv({ cls: "qbr-workshop-hint", text: `开头:${data.first.join(" / ")}` });
      if (data.last?.length) host.createDiv({ cls: "qbr-workshop-hint", text: `结尾:${data.last.join(" / ")}` });
      this.aiSuggestionActions(host, suggestion, "套用这份目录", () => this.applyAiChapters());
    }

    async applyAiChapters() {
      const suggestion = this._aiSuggestion;
      const rule = suggestion?.data?.rule;
      if (!rule) return;
      const text = await this.bookSourceFullText();
      const applied = applyChapterRule(text, rule);
      if (applied.error) {
        new Notice(`套用失败:${applied.error}`);
        return;
      }
      this._bookChapters = applied.chapters.map((chapter) => ({ title: chapter.title, text: chapter.body }));
      this.renderChapterRows();
      this._aiSuggestion = null;
      this.renderAiSuggestion();
      new Notice(`已套用 AI 目录:${applied.count} 章(可继续改名 / 合并 / 排序)`);
    }

    async startAiChapters() {
      if (!bridge) return;
      const rel = String(this._bookSources?.[0] || "");
      if (!rel) {
        new Notice("请先选择书稿");
        return;
      }
      const config = this.aiReadyConfig();
      if (!config) {
        new Notice("AI 还没配置好:先在「设置 → AI 助读」里选好供应商、模型与密钥");
        return;
      }
      const fileName = rel.split("/").pop() || rel;
      void bridge.start({
        kind: "ai-chapters",
        title: "AI 建议分章",
        detail: rel,
        payload: { config, source: rel, fileName },
      }).catch((error) => new Notice(String(error?.message || error)));
      new Notice("AI 在后台判断章名形态,结果会出现在「目录」这一步(套用前先看预览)");
    }

    // ── AI 清理:第一步「发现问题」(纯本地)────────────────────────────────
    checkBookIssues() {
      const host = this._bookAiClean;
      if (!host) return;
      host.empty();
      const chapters = this._bookChapters || [];
      if (!chapters.length) {
        host.createDiv({ cls: "qbr-workshop-hint", text: "还没有目录:先选书稿,或先跑一次「AI 建议分章」。" });
        return;
      }
      const scan = scanChapterIssues(chapters);
      if (!scan.rows.length) {
        this._bookIssues = null;
        host.createDiv({ cls: "qbr-workshop-hint", text: "没有发现可疑内容(怪字符 / 乱码片段 / 疑似吞标题 / 疑似断行 都没有)。" });
        return;
      }
      this._bookIssues = { rows: scan.rows, selected: new Set(scan.rows.map((row) => row.index)) };
      host.createDiv({ cls: "qbr-workshop-hint", text: `发现 ${scan.suspects} 章可疑(${describeIssues({ issues: scan.totals })});勾选后才会清理:` });
      for (const row of scan.rows.slice(0, 40)) {
        const line = host.createEl("label", { cls: "qbr-workshop-book" });
        const box = line.createEl("input", { attr: { type: "checkbox" } });
        box.checked = true;
        box.addEventListener("change", () => {
          if (box.checked) this._bookIssues?.selected.add(row.index);
          else this._bookIssues?.selected.delete(row.index);
          this.updateCleanSummary();
        });
        line.createSpan({ text: `第 ${row.index + 1} 章 ${row.title} · ${describeIssues(row.scan)}` });
        const sample = Object.values(row.scan.issues).flat().find(Boolean);
        if (sample) line.createSpan({ cls: "qbr-workshop-hint", text: `例:${sample}` });
      }
      if (scan.rows.length > 40) {
        host.createDiv({ cls: "qbr-workshop-hint", text: `…… 还有 ${scan.rows.length - 40} 章可疑(可先清理这些,再重新检查)` });
      }
      this._cleanSummary = host.createDiv({ cls: "qbr-workshop-hint" });
      const actions = host.createDiv("qbr-workshop-row");
      const start = actions.createEl("button", { cls: "mod-cta", text: "清理选中的章节" });
      start.addEventListener("click", () => void this.startAiClean());
      const cancel = actions.createEl("button", { text: "先不清理" });
      cancel.addEventListener("click", () => {
        this._bookIssues = null;
        this._cleanSummary = null;
        host.empty();
      });
      this.updateCleanSummary();
    }

    updateCleanSummary() {
      const host = this._cleanSummary;
      const issues = this._bookIssues;
      if (!host || !issues) return;
      const picked = issues.rows.filter((row) => issues.selected.has(row.index));
      const blocks = picked.reduce((sum, row) => sum + splitCleanupBlocks(String(this._bookChapters?.[row.index]?.text || "")).length, 0);
      host.setText(picked.length ? `选中 ${picked.length} 章 · 预计 ${blocks} 块 · 约 ${blocks} 次调用` : "没有选中任何章节");
    }

    // ── AI 清理:第二步「实际清理」(只发勾选的章节,结果先看对比)──────────
    async startAiClean() {
      if (!bridge) return;
      const issues = this._bookIssues;
      const picked = (issues?.rows || []).filter((row) => issues.selected.has(row.index));
      if (!picked.length) {
        new Notice("先勾选要清理的章节");
        return;
      }
      const config = this.aiReadyConfig();
      if (!config) {
        new Notice("AI 还没配置好:先在「设置 → AI 助读」里选好供应商、模型与密钥");
        return;
      }
      const chapters = picked
        .map((row) => ({
          index: row.index,
          title: this._bookChapters?.[row.index]?.title || row.title,
          text: String(this._bookChapters?.[row.index]?.text || ""),
        }))
        .filter((chapter) => chapter.text.trim());
      if (!chapters.length) {
        new Notice("选中的章节没有正文");
        return;
      }
      const blocks = chapters.reduce((sum, chapter) => sum + splitCleanupBlocks(chapter.text).length, 0);
      if (blocks > 200) {
        new Notice(`要清理 ${blocks} 块,一次跑不完:先少选几章(建议 ≤ 200 块)`);
        return;
      }
      const rel = String(this._bookSources?.[0] || "");
      void bridge.start({
        kind: "ai-clean",
        title: "AI 清理",
        detail: `${chapters.length} 章 · ${blocks} 块`,
        payload: { config, chapters, source: rel },
      }).catch((error) => new Notice(String(error?.message || error)));
      new Notice("AI 在后台清理,完成后这里给出清理前后的对比(应用前不会改动目录)");
    }

    renderAiCleanSuggestion(host, suggestion) {
      const data = suggestion.data;
      host.createDiv({ cls: "qbr-workshop-hint", text: `AI 清理完成:${data.chapters.length} 章 · 改动 ${data.changed} 处${data.rejected ? ` · 丢弃 ${data.rejected} 块(疑似改写,已保留原文)` : ""}` });
      for (const chapter of data.chapters.filter((row) => row.changed).slice(0, 8)) {
        host.createDiv({ cls: "qbr-workshop-hint", text: `第 ${chapter.index + 1} 章 ${chapter.title} · ${chapter.changed} 处` });
      }
      for (const sample of (data.samples || []).slice(0, 8)) {
        host.createDiv({ cls: "qbr-workshop-hint", text: `第 ${sample.index + 1} 章:${sample.prefix || ""}【${sample.before}】→【${sample.after}】${sample.suffix || ""}` });
      }
      if (!data.changed) host.createDiv({ cls: "qbr-workshop-hint", text: "模型没有提出改动(或者改动都被护栏丢弃了)。" });
      this.aiSuggestionActions(host, suggestion, "应用清理结果", () => this.applyAiClean());
    }

    async applyAiClean() {
      const suggestion = this._aiSuggestion;
      const file = String(suggestion?.data?.file || "");
      const host = this._bookAiClean;
      if (!file) {
        new Notice("清理结果不可用(没有落盘)");
        return;
      }
      const fsImpl = typeof window !== "undefined" && typeof window.require === "function" ? window.require("fs") : null;
      let payload = null;
      try {
        payload = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      } catch { /* 读不到 */ }
      const rows = Array.isArray(payload?.chapters) ? payload.chapters : [];
      if (!rows.length) {
        new Notice("读不到清理结果文件");
        return;
      }
      let applied = 0;
      let skipped = 0;
      for (const row of rows) {
        const chapter = this._bookChapters?.[row.index];
        // 目录在这期间改过(标题对不上)就跳过,别把清理结果贴到错的章节上。
        if (!chapter || (row.title && chapter.title && row.title !== chapter.title)) {
          skipped += 1;
          continue;
        }
        chapter.text = String(row.text || chapter.text);
        applied += 1;
      }
      this.renderChapterRows();
      this._aiSuggestion = null;
      this._bookIssues = null;
      this._cleanSummary = null;
      host?.empty();
      new Notice(`已应用清理结果:${applied} 章${skipped ? `,跳过 ${skipped} 章(目录已变化)` : ""}。想还原就重新选一次书稿。`);
    }

    applyAiSuggestion() {
      const suggestion = this._aiSuggestion;
      if (!suggestion?.data) return;
      const fill = (input, value) => {
        // 已有内容不覆盖(用户写的东西优先);只填空着的字段。
        if (!input || !String(value || "").trim() || String(input.value || "").trim()) return false;
        input.value = String(value);
        return true;
      };
      const data = suggestion.data;
      const touched = suggestion.kind === "ai-metadata"
        ? [fill(this._bookTitle, data.title), fill(this._bookAuthor, data.author)]
        : [fill(this._bookSubtitle, data.subtitle), fill(this._bookTitle, data.title)];
      this.onBookStyleChange();
      this._aiSuggestion = null;
      this.renderAiSuggestion();
      new Notice(touched.some(Boolean) ? "已填入空的字段(其余保持不变)" : "字段里已经有内容,没有覆盖");
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
      const text = await this.readSourceText(rel);
      const isMarkdown = /\.(md|markdown)$/i.test(rel);
      const cleaned = isMarkdown ? unwrapProseFences(text) : text;
      const found = isMarkdown ? splitMarkdownChapters(cleaned, { bookTitle: this._bookTitle?.value || "" }) : [];
      this._bookChapters = found.length >= 2
        ? found.map((chapter, index) => ({ title: chapter.title || `第 ${index + 1} 章`, text: chapter.text }))
        : splitTextChapters(cleaned).map((chapter) => ({ title: chapter.title, text: chapter.body }));
      this.renderChapterRows();
    }

    // 只渲染当前章节列表(编辑动作不再重读源文件 —— 否则改名/排序会被重新分章覆盖掉)。
    renderChapterRows() {
      const host = this._bookChaptersHost;
      if (!host) return;
      host.empty();
      if (!this._bookChapters?.length) return;
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
          this.renderChapterRows();
        });
        const down = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "↓" });
        down.disabled = index === this._bookChapters.length - 1;
        down.addEventListener("click", () => {
          this._bookChapters = moveChapter(this._bookChapters, index, 1);
          this.renderChapterRows();
        });
        const merge = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "合并" });
        merge.disabled = index === this._bookChapters.length - 1;
        merge.addEventListener("click", () => {
          this._bookChapters = mergeChapters(this._bookChapters, index);
          this.renderChapterRows();
        });
        const split = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "拆分" });
        split.addEventListener("click", () => {
          this._bookChapters = splitChapter(this._bookChapters, index);
          this.renderChapterRows();
        });
        // 页眉/扉页这类不该成章的直接删(生成时也会自动清一遍)。
        const remove = actions.createEl("button", { cls: "qbr-workshop-task-btn", text: "删除" });
        remove.disabled = this._bookChapters.length <= 1;
        remove.addEventListener("click", () => {
          this._bookChapters = removeChapter(this._bookChapters, index);
          this.renderChapterRows();
        });
      });
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
      void this.renderBookChapters();
    }

    removeBookSource(path) {
      this._bookSources = (this._bookSources || []).filter((item) => item !== path);
      this.renderBookSourceChips();
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
            indent: state.indent,
            spacing: state.spacing,
            headingAlign: state.headingAlign,
          },
          cover: {
            mode: state.coverMode,
            imagePath: state.coverImage,
            subtitle: state.subtitle,
            palette: state.coverPalette,
          },
          chapters: (this._bookChapters || []).length
            ? (this._bookChapters || []).map((chapter) => ({ title: chapter.title, text: chapter.text }))
            : undefined,
          // 书里那几页印刷目录(与电子书导航重复):默认去掉,面板里可关。
          dropPrintedToc: this._bookDropToc ? Boolean(this._bookDropToc.checked) : true,
          // 忽略缓存重新提取(上游更新过提取行为时用)。
          refresh: this._bookRefresh ? Boolean(this._bookRefresh.checked) : false,
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
        { id: "convert", label: "文档互转(DocVortex)", hint: "保持内容与版式:Office/ODF/HTML/EPUB/OFD/Markdown/纯文本 → md / html / docx / pdf / latex", ready: true },
        { id: "epub-md", label: "EPUB → Markdown", hint: "把 EPUB 拆成 Markdown:标题 / 列表 / 图片保留,公式进 LaTeX(目标格式已预选 md)", ready: true },
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
      inputCard.createDiv({ cls: "qbr-workshop-hint", text: "Markdown / 纯文本也能转:DocVortex 不收 .md / .txt,书坊先渲染成 HTML(公式仍是公式)再交给它。" });
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
      const wanted = [...DOCVORTEX_INPUTS, ...TEXT_SOURCE_EXTENSIONS];
      return (app?.vault?.getFiles?.() || [])
        .filter((file) => wanted.includes(String(file?.extension || "").toLowerCase()))
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
        // 书坊引擎(可独立部署的本地 HTTP 服务):配了地址就优先走引擎,失败回退本机。
        engineUrl: String(settings.engineUrl || ""),
        engineToken: String(settings.engineToken || ""),
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
    // 「EPUB → Markdown」是文档互转的快捷方式:目标格式预选 md(仍可改,改了就是普通互转)。
    syncConvertPreset() {
      const img = this._convertPreset === "img";
      if (this._convertPreset === "epub-md" && this._convertFormat) this._convertFormat.value = "markdown";
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
      // 「EPUB → Markdown」预设:输入应当是 EPUB(目标格式在预设里已预选,选错会在这里拦住)。
      if (this._convertPreset === "epub-md" && !files.some((rel) => /\.epub$/i.test(rel))) {
        new Notice("EPUB → Markdown 需要 EPUB 文件");
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
      this.captureAiSuggestions(tasks);
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
