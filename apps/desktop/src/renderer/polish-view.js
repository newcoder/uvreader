// 精修工作区：整本书 Markdown + CodeMirror 6 + 修正点列表 + 预览。
//
// 工作区是持久面板，不是任务队列项：关闭/重开、切书、重启后都从
// polish-session.json 恢复。只有“生成精修版本”会启动 book-polish 重建任务。

import { ItemView, Menu, Modal, Notice } from "obsidian";
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { COVER_PALETTES } from "../shared/book-styles.js";
import { renderMathIn } from "./math.js";
import {
  buildPolishOutline,
  chapterAtOffset,
  collectNoteTexts,
  collectPolishNumbers,
  decoratePreviewNoterefs,
  deletePolishMarker,
  deletePolishNote,
  insertPolishMarker,
  isNoteHeading,
  mergePolishNoteIntoNext,
  mergePolishNoteIntoPrevious,
  nextPolishNoteNumber,
  parsePolishMarkdown,
  refreshPolishBodyMarkers,
  renumberPolishMarkers,
  renumberPolishNotes,
} from "../shared/polish-markdown.js";

const POINT_STATUS_EFFECT = StateEffect.define();
const POINT_IDS_EFFECT = StateEffect.define();
const HIDE_COMMENTS_EFFECT = StateEffect.define();

const hideCommentsField = StateField.define({
  create: () => true,
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(HIDE_COMMENTS_EFFECT)) next = Boolean(effect.value);
    }
    return next;
  },
});

const pointStatusField = StateField.define({
  create: () => ({}),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(POINT_STATUS_EFFECT)) next = effect.value || {};
    }
    return next;
  },
});

// 当前报告里仍存在的 point id；修好后报告不再包含它，编辑器里的旧
// point 注释就淡化显示，避免“列表已经没了，正文还在标红”的错觉。
const pointIdsField = StateField.define({
  create: () => new Set(),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(POINT_IDS_EFFECT)) next = effect.value || new Set();
    }
    return next;
  },
});

function commentDecorations(view) {
  const builder = new RangeSetBuilder();
  const statuses = view.state.field(pointStatusField, false) || {};
  const livePointIds = view.state.field(pointIdsField, false) || new Set();
  const hideComments = view.state.field(hideCommentsField, false) !== false;
  const commentRe = /<!--\s*polish:(point|note|marker)\b[^>]*-->/g;
  for (let index = 1; index <= view.state.doc.lines; index += 1) {
    const line = view.state.doc.line(index);
    if (!line.text.includes("polish:")) continue;
    commentRe.lastIndex = 0;
    const matches = [];
    let match;
    while ((match = commentRe.exec(line.text))) matches.push(match);
    const point = matches.find((item) => item[1] === "point");
    const note = matches.find((item) => item[1] === "note");
    if (point || note) {
      let lineClass = "qbr-polish-comment-line qbr-polish-note-line";
      if (point) {
        const id = (point[0].match(/polish:point\s+([^\s]+)/) || [])[1] || "";
        if (!livePointIds.has(id)) {
          lineClass = "qbr-polish-comment-line qbr-polish-point-line is-stale";
        } else {
          const status = statuses[id]?.status || "open";
          lineClass = `qbr-polish-comment-line qbr-polish-point-line is-${status}`;
        }
      }
      if (hideComments) lineClass += " is-hidden";
      builder.add(line.from, line.from, Decoration.line({ class: lineClass }));
    }
    for (const marker of matches) {
      if (marker[1] !== "marker") continue;
      const from = line.from + marker.index;
      if (hideComments) builder.add(from, from + marker[0].length, Decoration.replace({}));
      else builder.add(from, from + marker[0].length, Decoration.mark({ class: "qbr-polish-marker-comment" }));
    }
  }
  return builder.finish();
}

const commentPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = commentDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.transactions.some((transaction) => (
      transaction.effects.some((effect) => effect.is(POINT_STATUS_EFFECT) || effect.is(POINT_IDS_EFFECT) || effect.is(HIDE_COMMENTS_EFFECT))
    ))) {
      this.decorations = commentDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text-normal)",
    backgroundColor: "var(--background-primary)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-monospace, 'Cascadia Mono', Consolas, monospace)",
    fontSize: "13px",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "18px 24px 120px",
    maxWidth: "920px",
    margin: "0 auto",
    caretColor: "var(--text-normal)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text-normal)",
    borderLeftWidth: "1.5px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-faint)",
  },
  ".cm-activeLine": { backgroundColor: "var(--background-modifier-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-normal)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--text-selection, rgba(127, 109, 242, 0.28))",
  },
  ".qbr-polish-comment-line": {
    fontSize: "11px",
    color: "var(--text-faint)",
    backgroundColor: "var(--background-secondary)",
  },
  ".qbr-polish-point-line": {
    borderLeft: "3px solid var(--interactive-accent)",
    backgroundColor: "color-mix(in srgb, var(--interactive-accent) 8%, transparent)",
  },
  ".qbr-polish-note-line": {
    borderLeft: "3px solid var(--text-faint)",
  },
  ".qbr-polish-point-line.is-resolved": {
    borderLeftColor: "var(--color-green, #3fb950)",
    backgroundColor: "color-mix(in srgb, var(--color-green, #3fb950) 8%, transparent)",
  },
  ".qbr-polish-point-line.is-ignored": {
    borderLeftColor: "var(--text-faint)",
    opacity: "0.55",
  },
  ".qbr-polish-point-line.is-stale": {
    borderLeftColor: "var(--text-faint)",
    backgroundColor: "transparent",
    opacity: "0.5",
  },
  ".qbr-polish-marker-comment": {
    color: "var(--text-faint)",
    fontSize: "10px",
    opacity: "0.65",
  },
});

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
}

export function createPolishView(leaf, options = {}) {
  const { renderMarkdown, plugin } = options;
  const bridge = typeof window === "undefined" ? null : window.qbrDesktop;

  class PolishView extends ItemView {
    constructor(viewLeaf) {
      super(viewLeaf);
      this._manifestPath = "";
      this._bundle = null;
      this._editor = null;
      this._hideComments = true;
      this._assetUrlCache = new Map();
      this._numbering = null;
      this._autoNumberTimer = null;
      this._autoNumbering = false;
      this._selectionFixTimer = null;
      this._suppressSelectionSync = false;
      this._points = [];
      this._noteById = new Map();
      this._markerById = new Map();
      this._markerCountByNote = new Map();
      this._chapterById = new Map();
      this._issueByChapter = new Map();
      this._statusMap = {};
      this._filter = "review";
      this._search = "";
      this._selectedId = "";
      this._selectedNoteId = "";
      this._stage = "notes";
      this._lastRenumberMessage = "";
      this._open = false;
      this._saveTimer = null;
      this._sessionTimer = null;
      this._previewTimer = null;
      this._saveRunning = null;
      this._finishedUnsubscribe = null;
      this._lastRebuildOutput = "";
      this._lastPolishSnapshot = "";
      this._lastRebuildTag = String(plugin?.settings?.polishTag || "精修");
      this._scrollHandler = null;
      this._schedulePreview = debounce(() => this.renderPreview(), 300);
    }

    getViewType() {
      return "qbr-polish";
    }

    getDisplayText() {
      return this._bundle?.manifest?.book?.title ? `精修 · ${this._bundle.manifest.book.title}` : "精修";
    }

    getIcon() {
      return "pencil";
    }

    async setState(state = {}) {
      this.state = state;
      const nextPath = String(state?.manifestPath || "");
      if (!nextPath) return;
      this._manifestPath = nextPath;
      if (this._open) await this.loadBundle(nextPath);
    }

    getState() {
      return { manifestPath: this._manifestPath };
    }

    async onOpen() {
      this._open = true;
      this.contentEl.addClass("qbr-polish-view");
      this._finishedUnsubscribe = bridge?.workshop?.onFinished?.((task) => {
        if (task?.kind !== "book-polish") return;
        if (task.status === "done" && task.output) {
          this._lastRebuildOutput = String(task.output || "");
          new Notice("精修电子书已重新生成");
          if (this._bundle) void this.loadBundle(this._manifestPath);
        } else if (task.status === "failed") {
          new Notice(`精修复建失败：${task.error || "未知错误"}`);
        }
      }) || null;
      if (this._manifestPath) await this.loadBundle(this._manifestPath);
      else this.renderEmpty();
    }

    async onClose() {
      this._open = false;
      if (this._finishedUnsubscribe) {
        this._finishedUnsubscribe();
        this._finishedUnsubscribe = null;
      }
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        void this.saveMarkdown();
      }
      if (this._sessionTimer) {
        clearTimeout(this._sessionTimer);
        this._sessionTimer = null;
        void this.saveSession();
      }
      if (this._autoNumberTimer) {
        clearTimeout(this._autoNumberTimer);
        this._autoNumberTimer = null;
      }
      if (this._selectionFixTimer) {
        clearTimeout(this._selectionFixTimer);
        this._selectionFixTimer = null;
      }
      this._editor?.destroy();
      this._editor = null;
    }

    async loadBundle(manifestPath) {
      if (!bridge?.polish?.load) {
        this.renderMessage("精修工作区需要在桌面版中使用。", "打开书坊", () => window.qbrOpenWorkshop?.("tasks"));
        return;
      }
      try {
        const bundle = await bridge.polish.load(manifestPath);
        if (this._autoNumberTimer) {
          clearTimeout(this._autoNumberTimer);
          this._autoNumberTimer = null;
        }
        this._manifestPath = String(manifestPath || "");
        this._bundle = bundle;
        this._assetUrlCache = new Map();
        this._statusMap = bundle.session?.pointStatus || {};
        this._stage = ["notes", "body", "done"].includes(bundle.session?.stage) ? bundle.session.stage : "notes";
        this._filter = ["review", "all", "done", "notes"].includes(bundle.session?.ui?.filter) ? bundle.session.ui.filter : "review";
        this._sideTab = ["preview", "inspect"].includes(bundle.session?.ui?.sideTab) ? bundle.session.ui.sideTab : "preview";
        this._tocOpen = bundle.session?.ui?.tocOpen !== false;
        this._tocDepth = [1, 2, 3].includes(Number(bundle.session?.ui?.tocDepth)) ? Number(bundle.session.ui.tocDepth) : 2;
        this._hideComments = bundle.session?.ui?.hideComments !== false;
        this._selectedId = bundle.session?.ui?.selectedPointId || "";
        this._lastRebuildOutput = String(bundle.session?.lastOutput || "");
        this._lastPolishSnapshot = String(bundle.session?.lastPolishSnapshot || "");
        this._lastRebuildTag = String(bundle.session?.lastTag || plugin?.settings?.polishTag || "精修");
        this._points = Array.isArray(bundle.report?.points) ? bundle.report.points : [];
        this._noteById = new Map((bundle.manifest?.notes || []).map((note) => [note.id, note]));
        this._selectedNoteId = "";
        this.syncNotesFromMarkdown(bundle.markdown || "");
        this._numbering = collectPolishNumbers(bundle.markdown || "");
        this._markerById = new Map((bundle.manifest?.markers || []).map((marker) => [marker.id, marker]));
        this._chapterById = new Map((bundle.manifest?.chapters || []).map((chapter) => [chapter.id, chapter]));
        this._issueByChapter = new Map((bundle.report?.sequenceIssues || []).map((issue) => [issue.chapterId, issue]));
        this._markerCountByNote = new Map();
        for (const marker of bundle.manifest?.markers || []) {
          if (!marker.noteId) continue;
          this._markerCountByNote.set(marker.noteId, (this._markerCountByNote.get(marker.noteId) || 0) + 1);
        }
        if (this._selectedId && !this._points.some((point) => point.id === this._selectedId)) {
          this._selectedId = "";
        }
        this.renderShell();
        this.mountEditor(bundle.markdown || "");
        this.renderToc();
        this.renderList();
        this.renderDetail();
        this.renderPreview();
        if (!this._selectedId) this.scrollToFirstChapter();
        if (bundle.markdownChanged) {
          new Notice("polish.md 已在外部修改；工作区已载入最新文本");
        }
      } catch (error) {
        this._bundle = null;
        this.renderMessage(`打开精修工作区失败：${String(error?.message || error)}`, "返回书坊", () => window.qbrOpenWorkshop?.("tasks"));
      }
    }

    async closeToWorkshop() {
      // 精修是独立工作区；关闭后回到书坊任务页，避免用户落在空白标签上。
      const leaf = this.leaf;
      try {
        leaf?.detach?.();
      } finally {
        await window.qbrOpenWorkshop?.("tasks");
        // onClose 里的异步保存可能晚于书坊打开，最后再确认一次活动标签。
        const workshop = this.app?.workspace?.getLeavesOfType?.("qbr-workshop")?.[0];
        if (workshop) {
          this.app.workspace.setActiveLeaf?.(workshop);
          await this.app.workspace.revealLeaf?.(workshop);
        }
      }
    }

    renderEmpty() {
      this.contentEl.empty();
      this.contentEl.addClass("qbr-polish-view");
      const card = this.contentEl.createDiv("qbr-polish-empty");
      card.createEl("h2", { text: "精修工作区" });
      card.createDiv({ text: "先生成电子书，然后在书坊任务列表里点“精修”。精修会打开整本书的 Markdown，修正点会自动保存，关闭后可以随时回来继续。" });
      const actions = card.createDiv("qbr-polish-empty-actions");
      const workshop = actions.createEl("button", { cls: "mod-cta", text: "打开书坊" });
      workshop.addEventListener("click", () => window.qbrOpenWorkshop?.("tasks"));
      const close = actions.createEl("button", { text: "关闭" });
      close.addEventListener("click", () => this.closeToWorkshop());
    }

    renderMessage(message, actionLabel = "", action = null) {
      this.contentEl.empty();
      this.contentEl.addClass("qbr-polish-view");
      const card = this.contentEl.createDiv("qbr-polish-empty");
      card.createEl("h2", { text: "精修工作区" });
      card.createDiv({ text: message });
      if (actionLabel && action) {
        const actions = card.createDiv("qbr-polish-empty-actions");
        const button = actions.createEl("button", { cls: "mod-cta", text: actionLabel });
        button.addEventListener("click", action);
      }
    }

    renderShell() {
      this.contentEl.empty();
      this.contentEl.addClass("qbr-polish-view");
      const head = this.contentEl.createDiv("qbr-polish-head");
      const tocToggle = head.createEl("button", {
        cls: "qbr-polish-toc-toggle",
        attr: { type: "button", "aria-label": "收起或展开目录" },
      });
      tocToggle.setText("☰");
      tocToggle.addEventListener("click", () => this.setTocOpen(!this._tocOpen));

      const titleBox = head.createDiv("qbr-polish-title");
      titleBox.createEl("b", { text: this._bundle?.manifest?.book?.title || "精修" });
      titleBox.createSpan({ text: "整本书 Markdown" });
      this._countLabel = null;
      this._saveStatus = head.createSpan({ cls: "qbr-polish-save-status", text: "已保存" });

      const actions = head.createDiv("qbr-polish-head-actions");
      this._checkButton = actions.createEl("button", { cls: "qbr-polish-check-button", attr: { type: "button" } });
      this._checkButton.createSpan({ text: "检查" });
      this._checkBadge = this._checkButton.createSpan({ cls: "qbr-polish-check-badge", text: "" });
      this._checkButton.addEventListener("click", () => this.showSide("inspect"));

      const more = actions.createEl("button", { text: "更多" });
      more.addEventListener("click", (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("书籍信息…").onClick(() => this.openBookInfo()));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle("手动补号…").onClick(() => this.openCurrentRenumber()));
        menu.addItem((item) => item.setTitle("重新检查修正点").onClick(() => this.recheckPoints()));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle("导入精修 Markdown…").onClick(() => this.importMarkdownFile()));
        menu.addItem((item) => item.setTitle("修复目录结构…").onClick(() => this.repairToc()));
        menu.addItem((item) => item.setTitle("另存精修 Markdown…").onClick(() => this.saveCopy()));
        menu.addItem((item) => item.setTitle("从旧备份导入注文…").onClick(() => this.importOldNotes()));
        menu.addItem((item) => item.setTitle("待确认全部标为已处理…").onClick(() => this.resolveAllOpen()));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle("检查结构").onClick(() => this.startAudit()));
        menu.addItem((item) => item.setTitle("还原自动结果…").onClick(() => this.revertChanges()));
        if (this._lastPolishSnapshot) {
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("打开精修副本").onClick(() => bridge?.openPath?.(this._lastPolishSnapshot)));
        }
        menu.showAtMouseEvent(event);
      });
      this._rebuildButton = actions.createEl("button", { cls: "mod-cta", text: "生成精修版本" });
      this._rebuildButton.addEventListener("click", () => this.openRebuildDialog());
      this.syncRebuildButton();
      if (this._lastRebuildOutput) {
        const output = actions.createEl("button", { text: "加入书库并打开" });
        output.addEventListener("click", () => bridge?.openBookPath?.(this._lastRebuildOutput));
      }
      const close = actions.createEl("button", { text: "关闭" });
      close.addEventListener("click", () => this.closeToWorkshop());

      const workspace = this.contentEl.createDiv("qbr-polish-workspace");
      this._toc = workspace.createDiv("qbr-polish-toc");
      if (!this._tocOpen) this._toc.addClass("is-collapsed");
      const tocExpanded = this._toc.createDiv("qbr-polish-toc-expanded");
      const tocHead = tocExpanded.createDiv("qbr-polish-toc-head");
      const tocTitleBox = tocHead.createDiv("qbr-polish-toc-title-box");
      tocTitleBox.createDiv({ cls: "qbr-polish-toc-kicker", text: "全书概览" });
      this._tocTitle = tocTitleBox.createDiv({ cls: "qbr-polish-toc-title", text: "" });
      const tocActions = tocHead.createDiv("qbr-polish-toc-head-actions");
      const info = tocActions.createEl("button", {
        cls: "qbr-polish-toc-info",
        text: "⚙",
        attr: { type: "button", "aria-label": "书籍信息" },
      });
      info.addEventListener("click", () => this.openBookInfo());
      const collapse = tocActions.createEl("button", {
        cls: "qbr-polish-toc-collapse",
        text: "«",
        attr: { type: "button", "aria-label": "收起目录" },
      });
      collapse.addEventListener("click", () => this.setTocOpen(false));
      const overview = tocExpanded.createDiv("qbr-polish-toc-overview");
      const stat = overview.createDiv("qbr-polish-toc-stat");
      this._tocLinked = stat.createEl("b", { text: "" });
      this._tocTotal = stat.createSpan({ text: "" });
      const progress = overview.createDiv("qbr-polish-toc-progress");
      this._tocProgressFill = progress.createDiv("qbr-polish-toc-progress-fill");
      this._tocMeta = overview.createDiv({ cls: "qbr-polish-toc-meta", text: "" });
      const sectionHead = tocExpanded.createDiv("qbr-polish-toc-section-head");
      const sectionTitle = sectionHead.createDiv("qbr-polish-toc-section-title");
      sectionTitle.createSpan({ text: "目录" });
      sectionTitle.createSpan({ cls: "qbr-polish-toc-live", text: "实时" });
      this._tocDepth = sectionHead.createEl("select", {
        cls: "qbr-polish-toc-depth",
        attr: { "aria-label": "目录显示层级" },
      });
      for (const [value, label] of [[1, "只看章"], [2, "章 + 节"], [3, "全部"]]) {
        this._tocDepth.createEl("option", { attr: { value: String(value) }, text: label });
      }
      this._tocDepth.value = String(this._tocDepth || 2);
      this._tocDepth.addEventListener("change", () => {
        this._tocDepth = Number(this._tocDepth.value) || 2;
        this.renderToc();
        this.scheduleSessionSave();
      });
      this._tocList = tocExpanded.createDiv("qbr-polish-toc-list");
      const rail = this._toc.createDiv("qbr-polish-toc-rail");
      const expand = rail.createEl("button", {
        cls: "qbr-polish-toc-expand",
        text: "»",
        attr: { type: "button", "aria-label": "展开目录" },
      });
      expand.addEventListener("click", () => this.setTocOpen(true));
      rail.createDiv({ cls: "qbr-polish-toc-rail-book", text: "书" });
      this._tocRail = rail.createDiv("qbr-polish-toc-rail-items");

      const main = workspace.createDiv("qbr-polish-main");
      const toolbar = main.createDiv("qbr-polish-toolbar");
      const addTool = (text, cls, onClick) => {
        const button = toolbar.createEl("button", { cls: cls || "", text, attr: { type: "button" } });
        button.addEventListener("click", onClick);
      };
      addTool("补号", "", () => this.addNoteNumberAtCursor());
      addTool("合并下一条", "", () => this.mergeNextNoteIntoCurrent());
      addTool("加标注", "", () => this.addMarkerAtCursor());
      addTool("删标注", "", () => this.deleteMarkerAtCursor());
      toolbar.createSpan({ cls: "qbr-polish-toolbar-divider" });
      addTool("重新生成正文标记", "is-secondary", () => this.regenerateBodyMarkers(false));
      this._commentsButton = toolbar.createEl("button", { cls: "is-secondary", text: "" });
      this._commentsButton.addEventListener("click", () => this.toggleComments());
      this.syncCommentsButton();
      toolbar.createDiv({ cls: "qbr-polish-toolbar-spacer" });
      this._toolbarChapter = toolbar.createSpan({ cls: "qbr-polish-toolbar-chapter", text: "" });

      const body = main.createDiv("qbr-polish-body");
      this._editorHost = body.createDiv("qbr-polish-editor-pane");
      const side = body.createDiv("qbr-polish-side");
      this._side = side;
      const sideTabs = side.createDiv("qbr-polish-side-tabs");
      const sideBack = sideTabs.createEl("button", { cls: "qbr-polish-side-back", text: "← 编辑" });
      sideBack.addEventListener("click", () => this.showSide("editor"));
      this._sideButtons = new Map();
      for (const [value, label] of [["preview", "预览"], ["inspect", "检查"]]) {
        const button = sideTabs.createEl("button", { cls: "qbr-polish-side-tab", attr: { type: "button", "data-side": value } });
        button.createSpan({ text: label });
        if (value === "inspect") this._sideBadge = button.createSpan({ cls: "qbr-polish-side-badge", text: "" });
        button.addEventListener("click", () => this.showSide(value));
        this._sideButtons.set(value, button);
      }
      const sideBody = side.createDiv("qbr-polish-side-body");
      this._previewPane = sideBody.createDiv("qbr-polish-preview");
      const previewHead = this._previewPane.createDiv("qbr-polish-preview-head");
      this._previewTitle = previewHead.createSpan({ text: "预览" });
      this._previewBody = this._previewPane.createDiv("qbr-polish-preview-body");
    this._previewBody.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const noteButton = target?.closest?.("button.qbr-preview-noteref[data-note-id]");
      if (noteButton) {
        event.preventDefault();
        this.selectNote(noteButton.getAttribute("data-note-id") || "");
        return;
      }
      const markerButton = target?.closest?.("button.qbr-preview-noteback[data-marker-id]");
      if (markerButton) {
        event.preventDefault();
        this._selectedNoteId = "";
        this.syncNoteSelection();
        const range = this.findCommentRange("marker", markerButton.getAttribute("data-marker-id") || "");
        if (range && this._editor) this.moveToVisibleAnchor(range.from, { focus: true, y: "center" });
      }
    });
      this._inspectPane = sideBody.createDiv("qbr-polish-inspect");
      const inspectHead = this._inspectPane.createDiv("qbr-polish-inspect-head");
      const inspectTitle = inspectHead.createDiv("qbr-polish-inspect-title");
      inspectTitle.createEl("b", { text: "检查" });
      const recheck = inspectTitle.createEl("button", { text: "重新检查" });
      recheck.addEventListener("click", () => this.recheckPoints());
      this._searchInput = inspectHead.createEl("input", {
        attr: { type: "search", placeholder: "搜索注号、页码或注文…", "aria-label": "搜索修正点" },
      });
      this._searchInput.addEventListener("input", () => {
        this._search = String(this._searchInput.value || "").trim();
        this.renderList();
      });
      this._listHint = inspectHead.createDiv("qbr-polish-list-hint");
      const filters = inspectHead.createDiv("qbr-polish-filters");
      this._filterButtons = new Map();
      for (const [value, label] of [["review", "待确认"], ["all", "全部"], ["done", "已处理"], ["notes", "全部注文"]]) {
        const button = filters.createEl("button", { attr: { type: "button", "data-filter": value }, text: label });
        button.addEventListener("click", () => {
          this._filter = value;
          if (value === "notes") this._selectedId = "";
          else this._selectedNoteId = "";
          this.syncFilterButtons();
          this.renderList();
          this.renderDetail();
          this.scheduleSessionSave();
        });
        this._filterButtons.set(value, button);
      }
      this._list = this._inspectPane.createDiv("qbr-polish-list");
      this._detail = this._inspectPane.createDiv("qbr-polish-detail");

      const status = this.contentEl.createDiv("qbr-polish-statusbar");
      this._statusCounts = status.createSpan({ cls: "qbr-polish-status-counts", text: "" });
      this._statusChapter = status.createSpan({ cls: "qbr-polish-status-chapter", text: "" });
      this._statusSave = status.createSpan({ cls: "qbr-polish-status-save", text: "已保存" });

      this.syncFilterButtons();
      this.showSide(this._sideTab || "preview", { save: false });
      this.renderToc();
      this.syncCounts();
    }

    showSide(tab, { save = true } = {}) {
      if (!this._side) return;
      const next = tab === "inspect" ? "inspect" : tab === "preview" ? "preview" : "editor";
      this._sideTab = next;
      this.contentEl.toggleClass("qbr-polish-show-side", next !== "editor");
      for (const [value, button] of this._sideButtons || []) {
        button.toggleClass("is-active", value === next);
      }
      this._previewPane?.toggleClass("is-hidden", next !== "preview");
      this._inspectPane?.toggleClass("is-hidden", next !== "inspect");
      this._side.toggleClass("is-hidden", next === "editor");
      if (next === "inspect") this.renderList();
      if (save) this.scheduleSessionSave();
    }

    toggleComments() {
      this._hideComments = !this._hideComments;
      if (!this._editor) {
        this.syncCommentsButton();
        return;
      }
      const pos = this._editor.state.selection.main.head;
      const anchor = this._hideComments ? this.visibleAnchorFor(pos) : pos;
      const effects = [HIDE_COMMENTS_EFFECT.of(this._hideComments)];
      if (anchor !== pos) effects.push(EditorView.scrollIntoView(anchor, { y: "nearest" }));
      this._suppressSelectionSync = anchor !== pos;
      try {
        this._editor.dispatch({
          effects,
          ...(anchor !== pos ? { selection: { anchor } } : {}),
        });
      } finally {
        this._suppressSelectionSync = false;
      }
      this.syncCommentsButton();
      this.scheduleSessionSave();
    }

    syncCommentsButton() {
      this._commentsButton?.setText(this._hideComments ? "显示定位注释" : "隐藏定位注释");
    }

    setTocOpen(open) {
      this._tocOpen = Boolean(open);
      const narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < 980;
      if (narrow) {
        this._toc?.toggleClass("is-open", this._tocOpen);
        this._toc?.removeClass("is-collapsed");
      } else {
        this._toc?.toggleClass("is-collapsed", !this._tocOpen);
        this._toc?.removeClass("is-open");
      }
      this.scheduleSessionSave();
    }

    noteGroupKey(value) {
      return String(value || "")
        .replace(/^#{1,6}\s*/, "")
        .replace(/^第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]?\s*/, "")
        .replace(/^(?:chapter|part)\s+[0-9ivxlc]+[.、:]?\s*/i, "")
        .replace(/[^\p{L}\p{N}]/gu, "")
        .toLowerCase();
    }

    chapterNoteCounts(text) {
      const chapters = this._bundle?.manifest?.chapters || [];
      const notesChapter = chapters.find((chapter) => isNoteHeading(String(chapter?.title || "").trim()));
      const byKey = new Map();
      for (const chapter of chapters) {
        const title = String(chapter?.title || "").trim();
        const key = this.noteGroupKey(title);
        if (title && key) byKey.set(key, title);
      }
      const counts = new Map();
      const parsed = parsePolishMarkdown(text);
      for (const note of parsed.notes) {
        const group = String(note.group || "").trim();
        if (!group) continue;
        const title = byKey.get(this.noteGroupKey(group));
        if (!title) continue;
        counts.set(title, (counts.get(title) || 0) + 1);
      }
      if (notesChapter && parsed.notes.length) counts.set(String(notesChapter.title).trim(), parsed.notes.length);
      return counts;
    }

    pendingPointsByChapter() {
      const chapters = this._bundle?.manifest?.chapters || [];
      const indexById = new Map(chapters.map((chapter, index) => [String(chapter?.id || ""), index]));
      const counts = new Map();
      for (const point of this._points || []) {
        if ((this._statusMap?.[point.id]?.status || "open") !== "open") continue;
        const id = String(point.context?.markerChapterId || point.chapterId || "");
        const index = indexById.get(id);
        if (index != null) counts.set(index, (counts.get(index) || 0) + 1);
      }
      return counts;
    }

    renderToc() {
      if (!this._tocList) return;
      const text = this._editor?.state.doc.toString() ?? String(this._bundle?.markdown || "");
      const chapters = this._bundle?.manifest?.chapters || [];
      const indexByTitle = new Map(chapters.map((chapter, index) => [String(chapter?.title || "").trim(), index]));
      const items = buildPolishOutline(text, { chapterTitles: this.chapterTitles() });
      const noteCounts = this.chapterNoteCounts(text);
      const pending = this.pendingPointsByChapter();
      this._tocList.empty();
      this._tocRail?.empty();
      this._tocRows = [];
      let chapterTitle = "";
      for (const item of items) {
        if (item.level === 1) chapterTitle = item.title;
        const isChapter = item.level === 1;
        const index = isChapter ? indexByTitle.get(item.title) : -1;
        const row = this._tocList.createEl("button", {
          cls: `qbr-polish-toc-row${isChapter ? "" : " is-child"}${item.level === 3 ? " is-child-2" : ""}`,
          attr: { type: "button", "data-line": String(item.line), "data-level": String(item.level) },
        });
        row.createSpan({ cls: "qbr-polish-toc-name", text: item.title });
        if (isChapter) {
          const count = noteCounts.get(item.title) || 0;
          if (count) row.createSpan({ cls: "qbr-polish-toc-count", text: String(count) });
          const open = pending.get(index) || 0;
          if (open && !isNoteHeading(item.title)) {
            const dot = row.createSpan({ cls: "qbr-polish-toc-dot" });
            dot.setAttribute("aria-label", `${open} 条待确认`);
          }
        }
        row.addEventListener("click", () => this.jumpToOutlineLine(item.line));
        this._tocRows.push({ ...item, element: row, chapterTitle });
        if (isChapter && index >= 0) {
          const railItem = this._tocRail.createEl("button", {
            cls: "qbr-polish-toc-rail-item",
            text: String(index + 1).padStart(2, "0"),
            attr: { type: "button", "aria-label": item.title },
          });
          railItem.addEventListener("click", () => {
            this.setTocOpen(true);
            this.jumpToOutlineLine(item.line);
          });
        }
      }
      if (!items.length) {
        this._tocList.createDiv({ cls: "qbr-polish-toc-empty", text: "还没有章节标题。" });
      }
      this._tocActiveLine = null;
      this.updateTocSelection();
    }

    scheduleTocUpdate() {
      if (this._tocTimer) clearTimeout(this._tocTimer);
      this._tocTimer = setTimeout(() => {
        this._tocTimer = null;
        this.renderToc();
      }, 350);
    }

    updateTocSelection() {
      if (!this._editor || !this._tocRows?.length) return;
      const line = this._editor.state.doc.lineAt(this._editor.state.selection.main.head).number - 1;
      let chapterRow = null;
      let sectionRow = null;
      for (const row of this._tocRows) {
        if (row.line > line) break;
        if (row.level === 1) {
          chapterRow = row;
          sectionRow = null;
        } else {
          sectionRow = row;
        }
      }
      for (const row of this._tocRows) {
        row.element.toggleClass("is-active", row === chapterRow);
        row.element.toggleClass("is-section-active", row === sectionRow);
      }
      const title = chapterRow?.title || "";
      this._toolbarChapter?.setText(title ? `当前章节：${title}` : "");
      this._statusChapter?.setText(title ? `当前章节 ${title}` : "");
      const activeLine = sectionRow?.line ?? chapterRow?.line ?? -1;
      if (activeLine !== this._tocActiveLine) {
        this._tocActiveLine = activeLine;
        const active = sectionRow?.element || chapterRow?.element;
        if (active && this._tocOpen) {
          try {
            active.scrollIntoView({ block: "nearest" });
          } catch { /* ignore */ }
        }
      }
    }

    scrollToFirstChapter() {
      const first = this._tocRows?.find((row) => row.level === 1);
      if (!first || !this._editor) return;
      const doc = this._editor.state.doc;
      const target = doc.line(Math.max(1, Math.min(doc.lines, first.line + 1)));
      this._editor.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "start" }),
      });
    }

    jumpToOutlineLine(line) {
      if (!this._editor) return;
      this._selectedId = "";
      this._selectedNoteId = "";
      this.renderList();
      this.renderDetail();
      const doc = this._editor.state.doc;
      const target = doc.line(Math.max(1, Math.min(doc.lines, Number(line) + 1)));
      this._editor.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
      this._editor.focus();
      this.updateTocSelection();
      if (this.contentEl.clientWidth < 980) this._toc?.removeClass("is-open");
    }


    syncRebuildButton() {
      if (!this._rebuildButton) return;
      const translationMode = String(this._bundle?.manifest?.build?.translationMode || "none");
      const hasOutput = Boolean(this._bundle?.manifest?.build?.out);
      if (translationMode !== "none" || !hasOutput) {
        this._rebuildButton.disabled = true;
        this._rebuildButton.setText("暂不支持重建");
        this._rebuildButton.setAttribute("aria-label", translationMode !== "none"
          ? "翻译/简繁转换的电子书暂不支持精修复建"
          : "缺少原始构建输出路径，暂不能重建");
        return;
      }
      this._rebuildButton.disabled = false;
      this._rebuildButton.setText("生成精修版本");
      this._rebuildButton.removeAttribute("aria-label");
    }

    renderStageBar() {
      if (!this._stageLabel || !this._stageActions) return;
      this._stageActions.empty();
      // 这两步只是建议顺序，不再做硬门槛：注文编号和正文标注都可以随时改。
      this._stageLabel.setText("建议顺序：先核对注文编号，再检查正文标注；可随时修改");
      const add = (text, cls, onClick) => {
        const button = this._stageActions.createEl("button", { cls: cls || "", text });
        button.addEventListener("click", onClick);
      };
      add("加编号", "", () => this.addNoteNumberAtCursor());
      add("与下一条合并", "", () => this.mergeNextNoteIntoCurrent());
      add("重新生成正文标记", "", () => this.regenerateBodyMarkers(false));
      add("加标注", "", () => this.addMarkerAtCursor());
      add("删标注", "", () => this.deleteMarkerAtCursor());
      this.syncRebuildButton();
    }

    setStage(stage, { save = true } = {}) {
      this._stage = ["notes", "body", "done"].includes(stage) ? stage : "notes";
      this.renderStageBar();
      if (save) this.scheduleSessionSave();
    }

    applyMarkdownUpdate(next) {
      if (!this._editor) return;
      const view = this._editor;
      const current = view.state.doc.toString();
      if (current === next) return;
      const scrollTop = view.scrollDOM.scrollTop;
      let start = 0;
      while (start < current.length && start < next.length && current[start] === next[start]) start += 1;
      let oldEnd = current.length;
      let newEnd = next.length;
      while (oldEnd > start && newEnd > start && current[oldEnd - 1] === next[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
      }
      this._autoNumbering = true;
      try {
        view.dispatch({ changes: { from: start, to: oldEnd, insert: next.slice(start, newEnd) } });
      } finally {
        this._autoNumbering = false;
      }
      view.scrollDOM.scrollTop = scrollTop;
      this.syncNotesFromMarkdown(next);
      this._numbering = collectPolishNumbers(next);
      this.renderList();
      this.renderDetail();
      this.renderPreview();
    }

    confirmNotes() {
      const missing = [...this._noteById.values()].filter((note) => !note.label);
      if (missing.length) {
        new Notice(`还有 ${missing.length} 条注文没有编号，请先补号再进入第二步`);
        return;
      }
      this.regenerateBodyMarkers(true);
    }

    regenerateBodyMarkers(advance) {
      if (!this._editor) return;
      const current = this._editor.state.doc.toString();
      const result = refreshPolishBodyMarkers(current, { chapterTitles: this.chapterTitles() });
      if (result.changed) this.applyMarkdownUpdate(result.markdown);
      this._stage = "body";
      this.renderStageBar();
      this.scheduleSessionSave();
      new Notice(advance
        ? `已按注释编号自动生成正文标记（更新 ${result.count} 个），请检查后确认`
        : `已刷新 ${result.count} 个正文标记`);
    }

    addMarkerAtCursor() {
      if (!this._editor) return;
      const markdown = this._editor.state.doc.toString();
      const offset = this._editor.state.selection.main.head;
      const id = `marker-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = insertPolishMarker(markdown, offset, { id, chapterTitles: this.chapterTitles() });
      if (!result.ok) {
        new Notice(result.error || "加标注失败");
        return;
      }
      this.applyMarkdownUpdate(result.markdown);
      if (this._stage === "done") this.setStage("body", { save: false });
      this.scheduleSessionSave();
      new Notice(`已加入标注 ${result.label}；后续标注已自动对齐`);
    }

    deleteMarkerAtCursor() {
      if (!this._editor) return;
      const markdown = this._editor.state.doc.toString();
      const offset = this._editor.state.selection.main.head;
      const result = deletePolishMarker(markdown, offset, { chapterTitles: this.chapterTitles() });
      if (!result.ok) {
        new Notice(result.error || "删标注失败");
        return;
      }
      this.applyMarkdownUpdate(result.markdown);
      if (this._stage === "done") this.setStage("body", { save: false });
      this.scheduleSessionSave();
      new Notice(`已删除标注 ${result.label}；后续标注已自动对齐`);
    }

    async importMarkdownFile() {
      if (!bridge?.polish?.pickImport || !bridge?.polish?.importMarkdown) {
        new Notice("导入精修 Markdown 需要在桌面版中使用");
        return;
      }
      let inspection;
      try {
        inspection = await bridge.polish.pickImport(this._manifestPath);
      } catch (error) {
        new Notice(`读取文件失败：${String(error?.message || error)}`);
        return;
      }
      if (!inspection) return;
      if (!inspection.ok) {
        new Notice(inspection.errors?.[0] || "这个文件不能作为精修 Markdown 导入");
        return;
      }
      const stats = inspection.stats || {};
      const title = inspection.info?.title || inspection.current?.title || "未命名书稿";
      const source = inspection.info?.source || "";
      const reasons = Array.isArray(inspection.reasons) ? inspection.reasons : [];
      const lines = [
        "导入精修 Markdown？",
        "",
        `文件：${inspection.filePath}`,
        `书名：${title}`,
        source ? `原书：${source}` : "",
        `章节 ${stats.chapters || 0} · 注文 ${stats.notes || 0} · 标注 ${stats.markers || 0}`,
        "",
        inspection.sameBook
          ? inspection.confidence === "same" ? "检查结果：同一本书。" : "检查结果：看起来是同一本书。"
          : "⚠ 检查结果：可能不是同一本书。",
        ...reasons.map((reason) => `· ${reason}`),
        "",
        "当前精修内容会先自动备份，然后被这个文件替换。",
        "",
        "继续导入？",
      ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm(lines.join("\n"))
        : false;
      if (!confirmed) return;
      let result;
      try {
        result = await bridge.polish.importMarkdown(this._manifestPath, inspection.filePath, {
          force: !inspection.sameBook,
          markdown: this._editor?.state.doc.toString() || "",
        });
      } catch (error) {
        new Notice(`导入失败：${String(error?.message || error)}`);
        return;
      }
      if (!result?.ok) {
        new Notice(result?.error || "导入失败");
        return;
      }
      if (result.unchanged) {
        new Notice("文件内容与当前精修相同，没有改动");
        return;
      }
      await this.loadBundle(this._manifestPath);
      new Notice(`已导入精修 Markdown：${stats.chapters || 0} 章 · ${stats.notes || 0} 条注文${result.backupPath ? "；旧内容已备份" : ""}`);
    }

    async repairToc() {
      if (!bridge?.polish?.repairHeadings) {
        new Notice("修复目录需要在桌面版中使用");
        return;
      }
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm("按原书基线恢复章节层级并重建目录？\n\n当前 Markdown 会先自动备份。")
        : false;
      if (!confirmed) return;
      let result;
      try {
        result = await bridge.polish.repairHeadings(
          this._manifestPath,
          this._editor?.state.doc.toString() || "",
        );
      } catch (error) {
        new Notice(`修复目录失败：${String(error?.message || error)}`);
        return;
      }
      if (!result?.ok) {
        new Notice(result?.error || "修复目录失败");
        return;
      }
      await this.loadBundle(this._manifestPath);
      new Notice(result.changed
        ? `目录已修复：${result.chapters} 章 · ${result.nav} 个目录项；请再点“生成精修版本”更新电子书`
        : `目录结构已经正确：${result.chapters} 章`);
    }

    async importOldNotes() {
      if (!this._editor || !bridge?.polish?.importNotes) return;
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm("从最近一次备份的精修文件导入已校对的注文正文？\n\n新精修的章节、注文编号和正文链接会保留，只替换注文文字。")
        : false;
      if (!confirmed) return;
      const result = await bridge.polish.importNotes(this._manifestPath, this._editor.state.doc.toString());
      if (!result?.ok) {
        new Notice(result?.error || "没有可导入的旧精修注释");
        return;
      }
      this.applyMarkdownUpdate(result.markdown);
      await this.saveMarkdown();
      this.scheduleSessionSave();
      const warning = result.warnings?.length ? `；${result.warnings.length} 条需要手工确认` : "";
      new Notice(`已导入 ${result.updates} 条注文正文${warning}`);
    }

    openBookInfo() {
      if (!this._bundle) return;
      const build = this._bundle.manifest?.build || {};
      const book = this._bundle.manifest?.book || {};
      const cover = build.cover || {};
      const savedCoverMode = String(cover.mode || "template");
      let coverImage = String(cover.imagePath || "").trim();
      // The old picker left the mode on “template” after choosing an image, so
      // the image was silently ignored on rebuild. Show the image mode instead;
      // saving then repairs the stored manifest.
      const legacyImageCover = Boolean(coverImage) && savedCoverMode === "template";
      let coverModeTouched = false;
      const modal = new Modal(this.app);
      modal.titleEl.setText("书籍信息");
      const root = modal.contentEl.createDiv("qbr-polish-info");
      const tabs = root.createDiv("qbr-polish-info-tabs");
      const coverTab = tabs.createEl("button", { cls: "is-active", text: "封面" });
      const metaTab = tabs.createEl("button", { text: "元数据" });
      const body = root.createDiv("qbr-polish-info-body");
      const coverPane = body.createDiv("qbr-polish-info-pane");
      const metaPane = body.createDiv("qbr-polish-info-pane is-hidden");
      const field = (host, label, input) => {
        const row = host.createDiv("qbr-polish-info-field");
        row.createEl("label", { text: label });
        row.appendChild(input);
        return input;
      };
      const select = (host, label, options, value) => {
        const el = host.createEl("select");
        for (const [optionValue, optionLabel] of options) {
          el.createEl("option", { attr: { value: optionValue }, text: optionLabel });
        }
        el.value = value;
        return field(host, label, el);
      };
      const input = (host, label, value, placeholder = "") => {
        const el = host.createEl("input", { attr: { type: "text", placeholder } });
        el.value = value || "";
        return field(host, label, el);
      };
      const fileUrl = (value) => {
        const normalized = String(value || "").replace(/\\/g, "/");
        return normalized.startsWith("/") ? `file://${encodeURI(normalized)}` : `file:///${encodeURI(normalized)}`;
      };

      // 封面
      const coverLayout = coverPane.createDiv("qbr-polish-info-cover-layout");
      const preview = coverLayout.createDiv("qbr-polish-info-preview");
      const art = preview.createDiv("qbr-polish-info-cover");
      const form = coverLayout.createDiv("qbr-polish-info-form");
      const coverMode = select(form, "封面模式", [
        ["template", "模板生成"],
        ["auto", "自动（书内首图）"],
        ["image", "指定图片"],
        ["none", "不要封面"],
      ], legacyImageCover ? "image" : savedCoverMode);
      const palette = select(form, "模板配色", Object.entries(COVER_PALETTES).map(([id, value]) => [id, value.label]), cover.palette || "warm");
      const fit = select(form, "图片显示", [
        ["contain", "完整显示（留白）"],
        ["cover", "铺满页面（可能裁切）"],
      ], cover.fit || "contain");
      const subtitle = input(form, "副标题", cover.subtitle || "", "可选");
      const imageRow = form.createDiv("qbr-polish-info-field");
      imageRow.createEl("label", { text: "封面图片" });
      const imageActions = imageRow.createDiv("qbr-polish-info-image-actions");
      const imageLabel = imageActions.createSpan({ text: coverImage ? coverImage.split(/[\\/]/).pop() : "未选择" });
      const clearImage = imageActions.createEl("button", { text: "清除" });
      const pick = imageActions.createEl("button", { text: "选择图片…" });
      const imageHint = form.createDiv({ cls: "qbr-polish-info-note" });
      const legacyHint = legacyImageCover
        ? form.createDiv({ cls: "qbr-polish-info-note", text: "检测到已选封面图片，已切换到“指定图片”；保存后生成精修版本即可生效。" })
        : null;
      const syncImageUi = () => {
        imageLabel.setText(coverImage ? coverImage.split(/[\\/]/).pop() : "未选择");
        clearImage.hidden = !coverImage;
        if (!coverImage) {
          imageHint.setText(coverMode.value === "image" ? "未选择图片时会回退到模板封面。" : "");
        } else if (coverMode.value === "image") {
          imageHint.setText("这张图片会在下一次生成精修版本时写入封面。");
        } else if (coverMode.value === "none") {
          imageHint.setText("当前不生成封面；已选图片不会写入。");
        } else {
          imageHint.setText("已选图片，但当前模式不会使用它；切到“指定图片”才会写入。");
        }
      };
      clearImage.addEventListener("click", () => {
        coverImage = "";
        if (coverMode.value === "image") {
          coverMode.value = "template";
          coverModeTouched = true;
        }
        if (legacyHint) legacyHint.hidden = true;
        syncImageUi();
        paintCover();
      });
      pick.addEventListener("click", async () => {
        const paths = await bridge?.workshop?.pickFiles?.().catch(() => []) || [];
        const picked = paths.find((candidate) => /\.(png|jpe?g|webp|gif|bmp|tiff?|jp2)$/i.test(String(candidate)));
        if (!picked) return;
        coverImage = String(picked);
        // Picking an image means “use this image”; leaving the mode on
        // template was the bug that made regenerated covers disappear.
        coverMode.value = "image";
        if (legacyHint) legacyHint.hidden = true;
        syncImageUi();
        paintCover();
      });
      form.createDiv({ cls: "qbr-polish-info-note", text: "封面会在下一次“生成精修版本”时写入 EPUB，不会自动重建。" });

      const paintCover = () => {
        art.empty();
        art.removeAttribute("style");
        if (coverMode.value === "none") {
          art.createDiv({ cls: "qbr-polish-info-cover-empty", text: "不使用封面" });
          return;
        }
        if (coverMode.value === "image" && coverImage) {
          const picked = art.createEl("img", { attr: { src: fileUrl(coverImage), alt: "封面预览" } });
          picked.addEventListener("error", () => {
            art.empty();
            art.createDiv({ cls: "qbr-polish-info-cover-empty", text: "图片无法读取，请重新选择" });
          });
          return;
        }
        const paletteValue = COVER_PALETTES[palette.value] || COVER_PALETTES.warm;
        art.style.background = `linear-gradient(155deg, ${paletteValue.bg}, ${paletteValue.accent})`;
        art.style.color = paletteValue.fg;
        art.createDiv({ cls: "qbr-polish-info-cover-kicker", text: "UV READER" });
        const middle = art.createDiv({ cls: "qbr-polish-info-cover-middle" });
        middle.createDiv({ cls: "qbr-polish-info-cover-title", text: titleInput.value.trim() || book.title || "书名" });
        if (subtitle.value.trim()) middle.createDiv({ cls: "qbr-polish-info-cover-sub", text: subtitle.value.trim() });
        art.createDiv({ cls: "qbr-polish-info-cover-author", text: authorInput.value.trim() || "" });
      };

      // 元数据
      const metaForm = metaPane.createDiv("qbr-polish-info-form");
      const titleInput = input(metaForm, "书名", build.title || book.title || "");
      const authorInput = input(metaForm, "作者", build.author || book.author || "");
      const languageInput = input(metaForm, "语言", build.language || book.language || "zh", "zh / en / ja…");
      const languageList = metaForm.createEl("datalist", { attr: { id: "qbr-polish-language-list" } });
      for (const [value, label] of [["zh", "中文"], ["en", "English"], ["de", "Deutsch"], ["ja", "日本語"], ["fr", "Français"], ["es", "Español"], ["pt", "Português"], ["ru", "Русский"], ["ko", "한국어"]]) {
        languageList.createEl("option", { attr: { value }, text: label });
      }
      languageInput.setAttribute("list", "qbr-polish-language-list");
      const identifier = input(metaForm, "标识符 / ISBN", build.identifier || "", "可选，例如 urn:isbn:978…");
      metaForm.createDiv({ cls: "qbr-polish-info-note", text: "这些字段写入 EPUB 元数据，不改 Markdown 正文。出版社、出版日期、简介暂不存。" });

      const showTab = (name) => {
        coverTab.toggleClass("is-active", name === "cover");
        metaTab.toggleClass("is-active", name === "meta");
        coverPane.toggleClass("is-hidden", name !== "cover");
        metaPane.toggleClass("is-hidden", name !== "meta");
      };
      coverTab.addEventListener("click", () => showTab("cover"));
      metaTab.addEventListener("click", () => showTab("meta"));
      coverMode.addEventListener("change", () => {
        coverModeTouched = true;
        if (legacyHint) legacyHint.hidden = true;
        syncImageUi();
        paintCover();
      });
      palette.addEventListener("change", paintCover);
      titleInput.addEventListener("input", paintCover);
      authorInput.addEventListener("input", paintCover);
      subtitle.addEventListener("input", paintCover);

      const footer = root.createDiv("qbr-polish-info-footer");
      footer.createSpan({ cls: "qbr-polish-info-note", text: "保存后下次“生成精修版本”生效" });
      const cancel = footer.createEl("button", { text: "取消" });
      const save = footer.createEl("button", { cls: "mod-cta", text: "保存" });
      cancel.addEventListener("click", () => modal.close());
      save.addEventListener("click", async () => {
        const info = {
          title: titleInput.value.trim(),
          author: authorInput.value.trim(),
          language: languageInput.value.trim() || "zh",
          identifier: identifier.value.trim(),
          cover: {
            ...cover,
            mode: coverMode.value,
            palette: palette.value,
            fit: fit.value,
            subtitle: subtitle.value.trim(),
            imagePath: coverImage,
          },
          // Lets the main process distinguish “old picker left template on”
          // from a deliberate switch back to the template cover.
          coverModeExplicit: coverModeTouched,
        };
        if (!info.title) {
          new Notice("书名不能为空");
          return;
        }
        save.disabled = true;
        try {
          const bundle = await bridge.polish.saveInfo(this._manifestPath, info);
          this._bundle = bundle;
          this.contentEl.querySelector(".qbr-polish-title b")?.setText(bundle.manifest?.book?.title || info.title);
          modal.close();
          new Notice("书籍信息已保存；下次生成精修版本生效");
        } catch (error) {
          new Notice(`保存失败：${String(error?.message || error)}`);
        } finally {
          save.disabled = false;
        }
      });

      paintCover();
      syncImageUi();
      modal.open();
    }

    confirmBody() {
      this._stage = "done";
      this.renderStageBar();
      this.scheduleSessionSave();
      new Notice("正文标记已确认，可以生成精修版本");
    }

    mountEditor(markdownText) {
      this._editor?.destroy();
      if (!this._editorHost) return;
      this._editorHost.empty();
      const state = EditorState.create({
        doc: String(markdownText || ""),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
          search({ top: true }),
          EditorState.tabSize.of(2),
          pointStatusField,
          pointIdsField,
          hideCommentsField,
          commentPlugin,
          editorTheme,
          EditorView.lineWrapping,
          keymap.of([
            { key: "Mod-s", run: () => { void this.saveMarkdown(); return true; } },
            { key: "Alt-ArrowUp", run: () => this.stepPoint(-1) },
            { key: "Alt-ArrowDown", run: () => this.stepPoint(1) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.onDocChanged(update);
            if (update.selectionSet) this.onSelectionChanged(update);
          }),
        ],
      });
      this._editor = new EditorView({ state, parent: this._editorHost });
      this._editor.dispatch({
        effects: [
          POINT_STATUS_EFFECT.of(this._statusMap),
          POINT_IDS_EFFECT.of(new Set(this._points.map((point) => point.id))),
          HIDE_COMMENTS_EFFECT.of(this._hideComments !== false),
        ],
      });
      if (this._selectedId) this.selectPoint(this._selectedId, { focus: false });
      this._scrollHandler = debounce(() => this.scheduleSessionSave(), 700);
      this._editor.scrollDOM.addEventListener("scroll", this._scrollHandler, { passive: true });
    }

    onDocChanged(update) {
      this.setSaveStatus("编辑中…");
      if (this._stage === "done") {
        this._stage = "body";
        this.renderStageBar();
        this.syncRebuildButton();
        this.scheduleSessionSave();
      }
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        void this.saveMarkdown();
      }, 500);
      if (!this._autoNumbering && update) this.scheduleAutoNumberCheck(update);
      this._schedulePreview();
      this.scheduleTocUpdate();
      this.scheduleVisibleSelectionFix();
    }

    scheduleAutoNumberCheck(update) {
      if (!this.numberingEditRelevant(update)) return;
      if (this._autoNumberTimer) clearTimeout(this._autoNumberTimer);
      this._autoNumberTimer = setTimeout(() => {
        this._autoNumberTimer = null;
        this.autoNumberIfNeeded();
      }, 700);
    }

    numberingEditRelevant(update) {
      let relevant = false;
      for (const transaction of update.transactions || []) {
        transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          if (relevant) return;
          const text = typeof inserted?.toString === "function" ? inserted.toString() : "";
          const line = transaction.newDoc.lineAt(Math.max(0, Math.min(transaction.newDoc.length, fromB)));
          const lineText = line.text;
          if (/polish:(?:note|marker)\b/.test(lineText)) relevant = true;
          else if (/^\s*(?:\d{1,3}|[０-９]{1,3})[、.．)）]/.test(lineText)) relevant = true;
          else if (/^\s*(?:\d{1,3}|[０-９]{1,3})[、.．)）]/.test(text)) relevant = true;
          if (!relevant && toB - fromB > 0) {
            const changed = transaction.newDoc.sliceString(fromB, toB);
            if (/polish:(?:note|marker)\b/.test(changed)) relevant = true;
          }
        });
      }
      return relevant;
    }

    autoNumberIfNeeded() {
      if (!this._editor || !this._open || this._autoNumbering) return;
      const markdown = this._editor.state.doc.toString();
      const next = collectPolishNumbers(markdown);
      const previous = this._numbering;
      if (!previous) {
        this._numbering = next;
        return;
      }
      const changedNotes = [];
      for (const [id, item] of next.notes) {
        const before = previous.notes.get(id);
        if (!before) continue;
        if (before.label !== item.label) changedNotes.push({ ...item, target: item.label });
        else if (before.commentNumber !== item.commentNumber && Number.isFinite(item.commentNumber)) {
          changedNotes.push({ ...item, target: item.commentNumber });
        }
      }
      const changedMarkers = [];
      for (const [id, item] of next.markers) {
        const before = previous.markers.get(id);
        if (!before) continue;
        if (before.label !== item.label) changedMarkers.push({ ...item, target: item.label });
        else if (before.commentNumber !== item.commentNumber && Number.isFinite(item.commentNumber)) {
          changedMarkers.push({ ...item, target: item.commentNumber });
        }
      }
      const validNumber = (value) => Number.isFinite(value) && value >= 1 && value === Math.floor(value);
      if (changedNotes.length === 1 && validNumber(changedNotes[0].target)) {
        this._numbering = next;
        this.renumberFromNote(changedNotes[0].id, changedNotes[0].target, { auto: true });
        return;
      }
      if (!changedNotes.length && changedMarkers.length === 1 && validNumber(changedMarkers[0].target)) {
        this._numbering = next;
        const marker = changedMarkers[0];
        if (marker.note && this._noteById.has(marker.note)) {
          this.renumberFromNote(marker.note, marker.target, { auto: true });
        } else {
          this.renumberFromMarker(marker.id, marker.target, { auto: true });
        }
        return;
      }
      this._numbering = next;
    }

    onSelectionChanged(update) {
      if (!this._editor) return;
      const pos = update.state.selection.main.head;
      const line = update.state.doc.lineAt(pos);
      if (!this._suppressSelectionSync) {
        const match = line.text.match(/<!--\s*polish:point\s+([^\s]+)/);
        if (match) {
          this._selectedNoteId = "";
          if (match[1] !== this._selectedId && this._points.some((point) => point.id === match[1])) {
            this._selectedId = match[1];
            this.renderList();
            this.renderDetail();
            this.scheduleSessionSave();
          }
        } else {
          const noteId = this.noteIdAtLine(line.number);
          if (noteId && noteId !== this._selectedNoteId) {
            this._selectedNoteId = noteId;
            this._selectedId = "";
            this.syncNoteSelection();
            this.renderDetail();
            this.scheduleSessionSave();
          }
        }
      }
      this.updateTocSelection();
      this._schedulePreview();
      this.scheduleVisibleSelectionFix();
    }

    unanchoredNoteAtLine(lineNumber) {
      if (!this._editor) return null;
      const doc = this._editor.state.doc;
      const current = doc.line(lineNumber).text.trim();
      if (!current || /^<!--/.test(current) || /^#{1,6}\s/.test(current)) return null;
      let heading = 0;
      for (let number = lineNumber - 1; number >= 1; number -= 1) {
        if (/^##\s+/.test(doc.line(number).text)) {
          heading = number;
          break;
        }
      }
      let notesHeading = -1;
      for (let number = lineNumber - 1; number > heading; number -= 1) {
        if (isNoteHeading(doc.line(number).text.trim())) {
          notesHeading = number;
          break;
        }
      }
      let anchorLine = -1;
      let chapter = "";
      for (let number = lineNumber - 1; number > Math.max(heading, lineNumber - 8); number -= 1) {
        const match = doc.line(number).text.match(/<!--\s*polish:note\s+[^\s]+([^>]*)-->/);
        if (!match) continue;
        anchorLine = number;
        chapter = (match[1].match(/chapter=([^\s]+)/) || [])[1] || "";
        break;
      }
      if (notesHeading < 0 && anchorLine < 0) return null;
      return { line: lineNumber, chapter, text: current };
    }

    addNoteNumberAtCursor() {
      if (!this._editor) return;
      const lineNumber = this._editor.state.doc.lineAt(this._editor.state.selection.main.from).number;
      let noteId = this.noteIdAtLine(lineNumber);
      if (noteId) {
        const note = this._noteById.get(noteId);
        if (!note) {
          new Notice("找不到这条注文，请重新打开精修");
          return;
        }
        if (String(note.label || "").trim()) {
          new Notice(`这条注文已经有编号 ${note.label}；要改号请用“手动补号”`);
          return;
        }
      } else {
        const context = this.unanchoredNoteAtLine(lineNumber);
        if (!context) {
          new Notice("请把光标放到注释块里需要加编号的那一段");
          return;
        }
        noteId = `note-manual-${Date.now().toString(36)}`;
        const line = this._editor.state.doc.line(context.line);
        const anchor = `<!-- polish:note ${noteId} chapter=${context.chapter || ""} page=0 label="" linked=false alignment=none -->\n`;
        this._editor.dispatch({
          changes: { from: line.from, insert: anchor },
          selection: { anchor: line.from + anchor.length },
        });
        this._noteById.set(noteId, {
          id: noteId,
          chapterId: context.chapter || "",
          page: 0,
          label: "",
          text: context.text,
        });
        this._selectedNoteId = noteId;
        this._selectedId = "";
        this.syncNotesFromMarkdown(this._editor.state.doc.toString());
        this.renderList();
        this.renderDetail();
      }
      const next = nextPolishNoteNumber(this._editor.state.doc.toString(), noteId);
      if (!next.ok) {
        new Notice(next.error || "无法计算下一个编号");
        return;
      }
      this.renumberFromNote(noteId, next.start);
    }

    forgetNoteInBundle(noteId) {
      this._points = this._points.filter((point) => point.noteId !== noteId);
      if (Array.isArray(this._bundle?.report?.points)) {
        this._bundle.report.points = this._bundle.report.points.filter((point) => point.noteId !== noteId);
      }
      if (Array.isArray(this._bundle?.manifest?.notes)) {
        this._bundle.manifest.notes = this._bundle.manifest.notes.filter((note) => note.id !== noteId);
      }
      if (Array.isArray(this._bundle?.manifest?.markers)) {
        this._bundle.manifest.markers = this._bundle.manifest.markers.filter((marker) => marker.noteId !== noteId && marker.note !== noteId);
      }
      const pending = bridge?.polish?.forgetNote?.(this._manifestPath, noteId);
      if (pending?.catch) pending.catch(() => {});
    }

    mergeNextNoteIntoCurrent() {
      let noteId = this._selectedNoteId;
      if (!noteId && this._editor) {
        const lineNumber = this._editor.state.doc.lineAt(this._editor.state.selection.main.from).number;
        noteId = this.noteIdAtLine(lineNumber);
      }
      if (!noteId) {
        new Notice("请把光标放到要合并的前一条注文上，或在左侧“全部注文”里选中它");
        return;
      }
      if (!this._editor) return;
      const result = mergePolishNoteIntoNext(this._editor.state.doc.toString(), noteId, {
        chapterTitles: this.chapterTitles(),
      });
      if (!result.ok) {
        new Notice(result.error || "合并失败");
        return;
      }
      this._selectedNoteId = result.currentId || "";
      this._selectedId = "";
      this.forgetNoteInBundle(result.removedId);
      this.applyMarkdownUpdate(result.markdown);
      if (this._stage === "done") this.setStage("body", { save: false });
      this.syncNoteSelection();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
      new Notice(`已把注文 ${result.removedLabel || ""} 合并到 ${result.currentLabel || ""}，正文标注已重新对齐`);
    }

    mergeNoteIntoPrevious(noteId) {
      if (!this._editor) return;
      const notes = [...this._noteById.values()];
      const index = notes.findIndex((note) => note.id === noteId);
      const note = notes[index];
      const previous = notes.slice(0, Math.max(0, index)).reverse()
        .find((item) => item.chapterId === note?.chapterId);
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm(`把注文 ${note?.label || ""} 并入上一条 ${previous?.label || "?"}？合并后这条注文和它的正文标注会删除。`)
        : false;
      if (!confirmed) return;
      const result = mergePolishNoteIntoPrevious(this._editor.state.doc.toString(), noteId, {
        chapterTitles: this.chapterTitles(),
      });
      if (!result.ok) {
        new Notice(result.error || "合并失败");
        return;
      }
      this._selectedNoteId = result.previousId || "";
      this._selectedId = "";
      this.forgetNoteInBundle(noteId);
      this.applyMarkdownUpdate(result.markdown);
      if (this._stage === "done") this.setStage("body", { save: false });
      this.syncNoteSelection();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
      new Notice(`已合并到注文 ${result.previousLabel || ""}，原正文标注已删除并重新对齐`);
    }

    deleteNote(noteId) {
      if (!this._editor) return;
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm("删除这条注文？它的正文标注也会一起删除；如果只是上一条的续写，请用“合并到上一条”。")
        : false;
      if (!confirmed) return;
      const result = deletePolishNote(this._editor.state.doc.toString(), noteId, {
        chapterTitles: this.chapterTitles(),
      });
      if (!result.ok) {
        new Notice(result.error || "删除失败");
        return;
      }
      this._selectedNoteId = result.nextId || result.previousId || "";
      this._selectedId = "";
      this.forgetNoteInBundle(noteId);
      this.applyMarkdownUpdate(result.markdown);
      if (this._stage === "done") this.setStage("body", { save: false });
      this.syncNoteSelection();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
      new Notice("已删除注文，正文标注已重新对齐");
    }

    openCurrentRenumber() {
      if (!this._editor) return;
      const lineNumber = this._editor.state.doc.lineAt(this._editor.state.selection.main.head).number;
      const noteId = this.noteIdAtLine(lineNumber);
      if (noteId) {
        this.openRenumberDialog(noteId);
        return;
      }
      const context = this.unanchoredNoteAtLine(lineNumber);
      if (!context) {
        new Notice("请把光标放到注释块的某一条注文上");
        return;
      }
      const id = `note-manual-${Date.now().toString(36)}`;
      const line = this._editor.state.doc.line(context.line);
      const anchor = `<!-- polish:note ${id} chapter=${context.chapter || ""} page=0 label="" linked=false alignment=none -->\n`;
      this._editor.dispatch({
        changes: { from: line.from, insert: anchor },
        selection: { anchor: line.from + anchor.length },
      });
      this._noteById.set(id, {
        id,
        chapterId: context.chapter || "",
        page: 0,
        label: "",
        text: context.text,
      });
      this._selectedNoteId = id;
      this._selectedId = "";
      this.syncNotesFromMarkdown(this._editor.state.doc.toString());
      this.renderList();
      this.renderDetail();
      this.openRenumberDialog(id);
    }

    noteIdAtLine(lineNumber) {
      if (!this._editor) return "";
      const doc = this._editor.state.doc;
      const current = doc.line(lineNumber).text;
      const direct = current.match(/<!--\s*polish:note\s+([^\s]+)/);
      if (direct) return direct[1];
      const trimmed = current.trim();
      // 空白行、注释行不能作为“注文正文”选中。
      if (!trimmed || /^<!--/.test(trimmed)) return "";
      for (let number = lineNumber - 1; number >= Math.max(1, lineNumber - 2); number -= 1) {
        const text = doc.line(number).text.trim();
        if (!text) continue;
        if (/^<!--\s*polish:point\b/.test(text)) continue;
        const match = text.match(/<!--\s*polish:note\s+([^\s]+)/);
        if (match) return match[1];
        break;
      }
      return "";
    }

    syncNotesFromMarkdown(markdown) {
      const parsed = parsePolishMarkdown(markdown);
      const texts = collectNoteTexts(markdown);
      const previous = this._noteById;
      const next = new Map();
      for (const note of parsed.notes) {
        const base = previous.get(note.id) || {};
        const text = texts.get(note.id) || base.text || "";
        const label = note.label
          || (text.match(/^(\d+)、/) || [])[1]
          || base.label
          || "";
        next.set(note.id, {
          ...base,
          id: note.id,
          chapterId: note.chapter || base.chapterId || "",
          page: Number(note.page) || Number(base.page) || 0,
          label,
          text,
        });
      }
      // 正文 marker 注释里带 note=note-xxx；用它刷新 note→marker 的映射，
      // 这样即使 manifest 还是旧的，也能直接对当前 polish.md 手动补号。
      for (const marker of parsed.markers) {
        if (!marker.note || !next.has(marker.note)) continue;
        next.get(marker.note).markerId = marker.id;
      }
      this._noteById = next;
    }

    applyReport(report) {
      if (!this._bundle || !report || !Array.isArray(report.points)) return;
      const signature = (value) => [
        (value?.points || []).map((point) => `${point.id}:${point.title || ""}:${point.noteId || ""}:${point.context?.noteText || ""}`).join("|"),
        (value?.sequenceIssues || []).map((issue) => `${issue.chapterId}:${issue.message || ""}`).join("|"),
      ].join("//");
      const previous = signature(this._bundle.report);
      this._bundle.report = report;
      this._points = report.points;
      this._issueByChapter = new Map((report.sequenceIssues || []).map((issue) => [issue.chapterId, issue]));
      this._editor?.dispatch({ effects: POINT_IDS_EFFECT.of(new Set(this._points.map((point) => point.id))) });
      if (this._selectedId && !this._points.some((point) => point.id === this._selectedId)) {
        this._selectedId = "";
      }
      this.syncCounts();
      if (signature(report) === previous) return;
      this.renderList();
      this.renderDetail();
      this.renderPreview();
    }

    async saveMarkdown() {
      if (!this._editor || !bridge?.polish?.saveMarkdown) return;
      // 先抓一份快照:等待上一次保存时编辑器可能已经被关闭。
      const markdownText = this._editor.state.doc.toString();
      // 串行保存:自动保存、重建前保存、手动重检可能同时触发,不能并发写同一个文件。
      if (this._saveRunning) await this._saveRunning.catch(() => {});
      const run = this.saveMarkdownNow(markdownText);
      this._saveRunning = run;
      try {
        return await run;
      } finally {
        if (this._saveRunning === run) this._saveRunning = null;
      }
    }

    async saveMarkdownNow(markdownText) {
      if (!bridge?.polish?.saveMarkdown) return;
      this.setSaveStatus("保存中…");
      try {
        const result = await bridge.polish.saveMarkdown(this._manifestPath, markdownText);
        if (this._bundle) this._bundle.session = result.session;
        const latest = this._editor?.state?.doc?.toString() ?? markdownText;
        if (!this._open) return;
        if (latest !== markdownText) {
          // 保存期间又改了:别用旧文本的检查结果覆盖当前列表,等下一次自动保存。
          this.setSaveStatus("已保存;继续编辑中…");
          return;
        }
        // 修正点按刚保存的文本重算；已经修好的点会立即从列表里消失。
        this.syncNotesFromMarkdown(latest);
        this.applyReport(result.report);
        this.setSaveStatus(`已保存 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      } catch (error) {
        this.setSaveStatus(`保存失败：${String(error?.message || error)}`, true);
      }
    }

    async recheckPoints() {
      if (!this._editor) return;
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      const before = this._points.length;
      await this.saveMarkdown();
      const open = this._points.filter((point) => (this._statusMap?.[point.id]?.status || "open") === "open").length;
      const delta = before - this._points.length;
      new Notice(`重新检查完成：待确认 ${open} 个${delta > 0 ? `；已自动消除 ${delta} 个已修正的修正点` : ""}`);
    }

    resolveAllOpen() {
      const open = this._points.filter((point) => (this._statusMap?.[point.id]?.status || "open") === "open");
      if (!open.length) {
        new Notice("没有待确认的修正点");
        return;
      }
      if (!window.confirm(`把当前 ${open.length} 个待确认修正点全部标为已处理？之后仍可在“已处理”里重新打开。`)) return;
      const updatedAt = new Date().toISOString();
      const next = { ...this._statusMap };
      for (const point of open) next[point.id] = { status: "resolved", updatedAt };
      this._statusMap = next;
      this._editor?.dispatch({ effects: POINT_STATUS_EFFECT.of(this._statusMap) });
      this.renderList();
      this.syncCounts();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
      new Notice(`已把 ${open.length} 个修正点标为已处理`);
    }

    setSaveStatus(text, error = false) {
      this._saveStatus?.setText(text);
      this._saveStatus?.toggleClass("is-error", Boolean(error));
      this._statusSave?.setText(text);
      this._statusSave?.toggleClass("is-error", Boolean(error));
    }

    scheduleSessionSave() {
      if (this._sessionTimer) clearTimeout(this._sessionTimer);
      this._sessionTimer = setTimeout(() => {
        this._sessionTimer = null;
        void this.saveSession();
      }, 500);
    }

    async saveSession() {
      if (!bridge?.polish?.saveSession) return;
      const patch = {
        ui: {
          filter: this._filter,
          selectedPointId: this._selectedId,
          scrollTop: Number(this._editor?.scrollDOM?.scrollTop) || 0,
          sideTab: this._sideTab || "preview",
          tocOpen: this._tocOpen !== false,
          tocDepth: Number(this._tocDepth) || 2,
          hideComments: this._hideComments !== false,
        },
        stage: this._stage,
        pointStatus: this._statusMap,
      };
      try {
        const session = await bridge.polish.saveSession(this._manifestPath, patch);
        if (this._bundle) this._bundle.session = session;
      } catch {
        // 会话保存失败不打断编辑；Markdown 本身仍会自动保存。
      }
    }

    visibleNotes() {
      const search = this._search.toLowerCase();
      const notes = [...this._noteById.values()];
      if (!search) return notes;
      return notes.filter((note) => [
        note.label,
        note.text,
        note.page,
      ].some((value) => String(value || "").toLowerCase().includes(search)));
    }

    visiblePoints() {
      const statusOf = (point) => this._statusMap?.[point.id]?.status || "open";
      let points = this._points;
      if (this._filter === "review") points = points.filter((point) => statusOf(point) === "open");
      else if (this._filter === "done") points = points.filter((point) => statusOf(point) === "resolved");
      const search = this._search.toLowerCase();
      if (search) {
        points = points.filter((point) => {
          const note = this._noteById.get(point.noteId);
          return [
            point.title,
            this.pointTitle(point),
            point.reason,
            point.page,
            note?.label,
            note?.text,
          ].some((value) => String(value || "").toLowerCase().includes(search));
        });
      }
      return points;
    }

    syncFilterButtons() {
      for (const [value, button] of this._filterButtons || []) {
        button.toggleClass("is-active", value === this._filter);
      }
    }

    syncCounts() {
      const open = this._points.filter((point) => (this._statusMap?.[point.id]?.status || "open") === "open").length;
      const summary = this._bundle?.report?.summary || {};
      const notes = Number(summary.notes) || this._noteById?.size || 0;
      const linked = Math.max(0, notes - (Number(summary.unlinkedNotes) || 0));
      const markers = (this._bundle?.manifest?.markers || []).length;
      const tocIssues = Number(summary.tocIssues) || 0;
      this._checkBadge?.setText(open ? String(open) : "");
      this._sideBadge?.setText(open ? String(open) : "");
      this._tocTitle?.setText(`${this._bundle?.manifest?.chapters?.length || 0} 章 · ${notes} 注文`);
      this._tocLinked?.setText(String(linked));
      this._tocTotal?.setText(`/ ${notes} 注文已链接`);
      if (this._tocProgressFill) {
        this._tocProgressFill.style.width = `${notes ? Math.round((linked / notes) * 100) : 0}%`;
      }
      this._tocMeta?.setText(`待确认 ${open} · 标记 ${markers} · 目录 ${tocIssues}`);
      this._statusCounts?.setText(`待确认 ${open} · 注文 ${notes} · 标记 ${markers}`);
      this.renderToc();
    }

    renderList() {
      if (!this._list) return;
      const scrollTop = this._list.scrollTop;
      this._list.empty();
      const noteMode = this._filter === "notes";
      const points = noteMode ? [] : this.visiblePoints();
      const notes = noteMode ? this.visibleNotes() : [];
      const issueCount = (this._bundle?.report?.sequenceIssues || []).length;
      const countText = noteMode ? `${notes.length} 条注文` : `${points.length} 个修正点`;
      this._listHint?.setText(`${countText}${issueCount ? ` · ${issueCount} 个章节编号问题` : ""}`);
      if (!points.length && !notes.length && !issueCount) {
        this._list.createDiv({
          cls: "qbr-polish-list-empty",
          text: noteMode ? "没有匹配的注文。" : this._filter === "review" ? "这个筛选下没有待确认的修正点。" : "没有匹配的修正点。",
        });
        this._list.scrollTop = 0;
        return;
      }
      const groups = [];
      const byChapter = new Map();
      const entries = noteMode ? notes.slice(0, 1000) : points.slice(0, 1000);
      for (const item of entries) {
        const chapterId = item.chapterId || "";
        if (!byChapter.has(chapterId)) {
          const group = { chapterId, title: this._chapterById.get(chapterId)?.title || "正文", entries: [] };
          byChapter.set(chapterId, group);
          groups.push(group);
        }
        byChapter.get(chapterId).entries.push(item);
      }
      for (const group of groups) {
        const section = this._list.createDiv("qbr-polish-group");
        const heading = section.createDiv("qbr-polish-group-head");
        heading.createSpan({ text: group.title });
        if (this._issueByChapter.get(group.chapterId)) {
          heading.createSpan({ cls: "qbr-polish-group-issue", text: "编号不一致" });
        }
        heading.createSpan({ cls: "qbr-polish-group-count", text: String(group.entries.length) });
        if (noteMode) {
          for (const note of group.entries) {
            const row = section.createEl("button", {
              cls: `qbr-polish-point-row qbr-polish-note-row${note.id === this._selectedNoteId ? " is-selected" : ""}`,
              attr: { type: "button", "data-note-id": note.id },
            });
            const top = row.createDiv("qbr-polish-point-top");
            top.createSpan({ cls: "qbr-polish-point-label", text: note.label || "?" });
            top.createSpan({ cls: "qbr-polish-point-title", text: `注文 ${note.label || ""}` });
            top.createSpan({ cls: "qbr-polish-point-page", text: note.page ? `第 ${note.page} 页` : "" });
            const snippet = String(note.text || "").replace(/\s+/g, " ").slice(0, 100);
            if (snippet) row.createDiv({ cls: "qbr-polish-point-snippet", text: snippet });
            row.addEventListener("click", () => this.selectNote(note.id));
          }
          continue;
        }
        for (const point of group.entries) {
          const note = this._noteById.get(point.noteId);
          const status = this._statusMap?.[point.id]?.status || "open";
          const row = section.createEl("button", {
            cls: `qbr-polish-point-row is-${status}`,
            attr: { type: "button", "data-point-id": point.id },
          });
          if (point.id === this._selectedId) row.addClass("is-selected");
          const top = row.createDiv("qbr-polish-point-top");
          top.createSpan({ cls: "qbr-polish-point-label", text: note?.label || point.label || "?" });
          top.createSpan({ cls: "qbr-polish-point-title", text: this.pointTitle(point) });
          top.createSpan({ cls: "qbr-polish-point-page", text: point.page ? `第 ${point.page} 页` : "" });
          const snippet = note?.text ? note.text.replace(/\s+/g, " ").slice(0, 90) : point.context?.noteText || "";
          if (snippet) row.createDiv({ cls: "qbr-polish-point-snippet", text: snippet });
          row.addEventListener("click", () => this.selectPoint(point.id));
        }
      }
      if ((noteMode ? notes.length : points.length) > 1000) {
        this._list.createDiv({ cls: "qbr-polish-list-empty", text: "列表只显示前 1000 条；请用搜索或筛选缩小范围。" });
      }
      const issues = this._bundle?.report?.sequenceIssues || [];
      if (issues.length) {
        const section = this._list.createDiv("qbr-polish-group qbr-polish-issues");
        const heading = section.createDiv("qbr-polish-group-head");
        heading.createSpan({ text: "章节编号问题" });
        heading.createSpan({ cls: "qbr-polish-group-count", text: String(issues.length) });
        for (const issue of issues) {
          const row = section.createEl("button", { cls: "qbr-polish-issue-row", attr: { type: "button" } });
          row.createDiv({ cls: "qbr-polish-issue-title", text: issue.chapterTitle || "正文" });
          row.createDiv({ cls: "qbr-polish-issue-message", text: issue.message });
          row.addEventListener("click", () => this.jumpToChapter(issue.chapterTitle || ""));
        }
      }
      this._list.scrollTop = scrollTop;
    }

    chapterTitles() {
      return (this._bundle?.manifest?.chapters || [])
        .map((chapter) => String(chapter?.title || "").trim())
        .filter(Boolean);
    }

    jumpToChapter(title, { keepSelection = false } = {}) {
      if (!this._editor || !title) return;
      const text = this._editor.state.doc.toString();
      const index = text.indexOf(`## ${title}`);
      if (index < 0) return;
      if (!keepSelection) this._selectedId = "";
      this._editor.dispatch({
        selection: { anchor: index },
        effects: EditorView.scrollIntoView(index, { y: "center" }),
      });
      this._editor.focus();
      if (!keepSelection) {
        this.renderList();
        this.renderDetail();
      }
      this._schedulePreview();
    }

    selectPoint(id, { focus = true } = {}) {
      this._selectedId = String(id || "");
      this._selectedNoteId = "";
      // 窄窗口下详情是抽屉，选中修正点时自动打开，避免只能看到编辑器。
      this.contentEl.addClass("qbr-polish-show-detail");
      const point = this._points.find((item) => item.id === this._selectedId);
      if (point && this._editor) {
        const range = this.findCommentRange("point", point.id) || this.findCommentRange("note", point.noteId);
        if (range) {
          this.moveToVisibleAnchor(range.from, { focus });
        }
      }
      for (const row of this._list?.querySelectorAll?.(".qbr-polish-point-row") || []) {
        row.classList.toggle("is-selected", row.dataset.pointId === this._selectedId);
      }
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
    }

    selectNote(noteId) {
      if (!noteId) return;
      this._selectedNoteId = noteId;
      this._selectedId = "";
      this.contentEl.addClass("qbr-polish-show-detail");
      this.jumpToNote(noteId);
      this.syncNoteSelection();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
    }

    syncNoteSelection() {
      for (const row of this._list?.querySelectorAll?.(".qbr-polish-note-row") || []) {
        row.classList.toggle("is-selected", row.dataset.noteId === this._selectedNoteId);
      }
    }

    stepPoint(delta) {
      const points = this.visiblePoints();
      if (!points.length) return false;
      const current = points.findIndex((point) => point.id === this._selectedId);
      const next = current < 0
        ? (delta > 0 ? 0 : points.length - 1)
        : Math.min(points.length - 1, Math.max(0, current + delta));
      this.selectPoint(points[next].id);
      return true;
    }

    findCommentRange(kind, id) {
      if (!this._editor || !id) return null;
      const text = this._editor.state.doc.toString();
      const match = new RegExp(`<!--\\s*polish:${kind}\\s+${escapeRegExp(id)}\\b[^>]*-->`).exec(text);
      return match ? { from: match.index, to: match.index + match[0].length } : null;
    }

    // 隐藏定位注释后，注释行是 display:none；如果选区落在这些行里，
    // CodeMirror 画不出光标，表现就是“能输入但看不到光标”。所有程序化
    // 定位都改成落到下一条可见正文；用户用方向键误入时也会被兜底移出。
    visibleAnchorFor(position) {
      if (!this._editor) return position;
      const doc = this._editor.state.doc;
      const offset = Math.max(0, Math.min(doc.length, Number(position) || 0));
      const line = doc.lineAt(offset);
      const isPolishCommentLine = (text) => /^<!--\s*polish:(?:point|note|marker)\b/.test(String(text || "").trim());
      if (isPolishCommentLine(line.text)) {
        for (let number = line.number + 1; number <= doc.lines; number += 1) {
          const candidate = doc.line(number);
          const text = candidate.text.trim();
          if (!text || isPolishCommentLine(text)) continue;
          return candidate.from;
        }
        for (let number = line.number - 1; number >= 1; number -= 1) {
          const candidate = doc.line(number);
          const text = candidate.text.trim();
          if (!text || isPolishCommentLine(text)) continue;
          return candidate.to;
        }
        return offset;
      }
      for (const match of line.text.matchAll(/<!--\s*polish:marker\b[^>]*-->/g)) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        if (offset >= from && offset <= to) return line.from;
      }
      return offset;
    }

    moveToVisibleAnchor(position, { focus = true, y = "center" } = {}) {
      if (!this._editor) return position;
      const anchor = this.visibleAnchorFor(position);
      this._suppressSelectionSync = true;
      try {
        this._editor.dispatch({
          selection: { anchor },
          effects: EditorView.scrollIntoView(anchor, { y }),
        });
      } finally {
        this._suppressSelectionSync = false;
      }
      if (focus) this._editor.focus();
      return anchor;
    }

    scheduleVisibleSelectionFix() {
      if (!this._hideComments || this._selectionFixTimer) return;
      this._selectionFixTimer = setTimeout(() => {
        this._selectionFixTimer = null;
        if (!this._open || !this._editor || !this._hideComments) return;
        const pos = this._editor.state.selection.main.head;
        const anchor = this.visibleAnchorFor(pos);
        if (anchor === pos) return;
        this._suppressSelectionSync = true;
        try {
          this._editor.dispatch({
            selection: { anchor },
            effects: EditorView.scrollIntoView(anchor, { y: "nearest" }),
          });
        } finally {
          this._suppressSelectionSync = false;
        }
      }, 0);
    }

    renderSequenceIssues(chapterId = "") {
      const issues = this._bundle?.report?.sequenceIssues || [];
      const visible = chapterId ? issues.filter((issue) => issue.chapterId === chapterId) : issues;
      if (!visible.length) return;
      const section = this._detail.createDiv("qbr-polish-detail-section");
      section.createEl("h4", { text: "章节编号问题" });
      section.createDiv({
        cls: "qbr-polish-hint",
        text: "数量不一致时，先看多出的正文标注是不是重复引用；如果注文更多，通常是漏了正文标注。",
      });
      for (const issue of visible) {
        const row = section.createDiv("qbr-polish-sequence-issue");
        row.createEl("b", { text: issue.chapterTitle || "正文" });
        row.createSpan({ text: issue.message });
      }
    }

    pointTitle(point) {
      const note = this._noteById.get(point.noteId);
      if (point.kind === "note-unlinked") {
        const group = String(point.context?.markerChapterTitle || "").trim();
        return `${group ? `${group}：` : ""}注号 ${note?.label || "?"} 没有对应的正文标记`;
      }
      if (point.title && note?.label) {
        return point.title.replace(/注号\s+[^\s]+\s+/, `注号 ${note.label} `);
      }
      return point.title || point.reason || note?.label || "修正点";
    }

    renderDetail() {
      if (!this._detail) return;
      this._detail.empty();
      const point = this._points.find((item) => item.id === this._selectedId);
      if (!point) {
        const selectedNote = this._noteById.get(this._selectedNoteId);
        if (selectedNote) {
          this.renderNoteDetail(selectedNote);
          return;
        }
        this._detail.createDiv({ cls: "qbr-polish-detail-empty", text: "从上方列表选择一个修正点，或把光标放到一条注文上。" });
        this.renderSequenceIssues();
        const tocIssues = Number(this._bundle?.report?.summary?.tocIssues) || 0;
        if (tocIssues) {
          this._detail.createDiv({ cls: "qbr-polish-detail-empty", text: `另有 ${tocIssues} 项目录问题；P0 只列出，暂不在这里编辑。` });
        }
        return;
      }
      const note = this._noteById.get(point.noteId);
      const status = this._statusMap?.[point.id]?.status || "open";
      const head = this._detail.createDiv("qbr-polish-detail-head");
      head.createSpan({ cls: "qbr-polish-detail-label", text: note?.label || "?" });
      const title = head.createDiv("qbr-polish-detail-title");
      title.createEl("b", { text: this.pointTitle(point) });
      const context = point.context || {};
      const markerChapter = context.markerChapterId && context.markerChapterId !== point.chapterId
        ? context.markerChapterTitle || this._chapterById.get(context.markerChapterId)?.title || context.markerChapterId
        : "";
      const meta = [
        point.page ? `第 ${point.page} 页` : "",
        status === "resolved" ? "已处理" : status === "ignored" ? "已忽略" : "待确认",
        this._chapterById.get(point.chapterId)?.title || "",
        markerChapter ? `${point.kind === "note-unlinked" ? "正文在" : "候选在"} ${markerChapter}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      title.createSpan({ text: meta });
      if (point.reason) this._detail.createDiv({ cls: "qbr-polish-detail-reason", text: point.reason });
      this.renderSequenceIssues(point.chapterId);
      if (note?.text) {
        const section = this._detail.createDiv("qbr-polish-detail-section");
        section.createEl("h4", { text: "注文全文" });
        section.createDiv({ cls: "qbr-polish-detail-note", text: note.text.replace(/\s+/g, " ") });
      }
      if (context.before || context.after) {
        const section = this._detail.createDiv("qbr-polish-detail-section");
        const sourceLabel = context.source === "marker"
          ? "正文标记附近"
          : context.source === "semantic"
            ? "同章语义片段（未绑定标记）"
            : "同章末尾（未绑定标记）";
        section.createEl("h4", { text: sourceLabel });
        if (context.before) section.createDiv({ cls: "qbr-polish-detail-context", text: `…${context.before}` });
        if (context.after) section.createDiv({ cls: "qbr-polish-detail-context", text: `${context.after}…` });
      }
      if (context.sharedTerms?.length || point.suggestions?.length) {
        const section = this._detail.createDiv("qbr-polish-detail-section");
        section.createEl("h4", { text: "线索" });
        const chips = section.createDiv("qbr-polish-chips");
        for (const suggestion of point.suggestions || []) chips.createSpan({ cls: "qbr-polish-chip is-suggestion", text: `建议 ${suggestion}` });
        for (const term of context.sharedTerms || []) chips.createSpan({ cls: "qbr-polish-chip", text: term });
      }
      const actions = this._detail.createDiv("qbr-polish-detail-actions");
      const chapterTitle = point.context?.chapterTitle || this._chapterById.get(point.chapterId)?.title || "";
      if (!note && chapterTitle) {
        const chapterButton = actions.createEl("button", { text: "定位章节" });
        chapterButton.addEventListener("click", () => this.jumpToChapter(chapterTitle, { keepSelection: true }));
      } else {
        const locate = actions.createEl("button", { text: "在编辑器中定位" });
        locate.addEventListener("click", () => this.selectPoint(point.id));
      }
      if (note) {
        const viewNote = actions.createEl("button", { text: "查看注文" });
        viewNote.addEventListener("click", () => {
          this._filter = "notes";
          this.syncFilterButtons();
          this.selectNote(note.id);
        });
        if (point.kind === "note-unlinked" && markerChapter) {
          const jump = actions.createEl("button", { cls: "mod-cta", text: "去正文补标注" });
          jump.addEventListener("click", () => this.jumpToChapter(markerChapter, { keepSelection: true }));
        }
        const renumber = actions.createEl("button", { text: "手动补号" });
        renumber.addEventListener("click", () => this.openRenumberDialog(point.noteId));
      }
      if (point.markerId) {
        const marker = actions.createEl("button", { text: "定位正文标记" });
        marker.addEventListener("click", () => {
          const range = this.findCommentRange("marker", point.markerId);
          if (!range || !this._editor) return;
          this.moveToVisibleAnchor(range.from, { focus: true, y: "center" });
        });
      }
      if (status !== "resolved") {
        const resolve = actions.createEl("button", { cls: "mod-cta", text: "标记已处理" });
        resolve.addEventListener("click", () => this.setPointStatus(point.id, "resolved"));
      }
      if (status !== "ignored") {
        const ignore = actions.createEl("button", { text: "忽略" });
        ignore.addEventListener("click", () => this.setPointStatus(point.id, "ignored"));
      }
      if (status !== "open") {
        const reopen = actions.createEl("button", { text: "重新打开" });
        reopen.addEventListener("click", () => this.setPointStatus(point.id, "open"));
      }
    }

    renderNoteDetail(note) {
      const head = this._detail.createDiv("qbr-polish-detail-head");
      head.createSpan({ cls: "qbr-polish-detail-label", text: note.label || "?" });
      const title = head.createDiv("qbr-polish-detail-title");
      title.createEl("b", { text: `注文 ${note.label || ""}` });
      const meta = [
        note.page ? `第 ${note.page} 页` : "",
        this._chapterById.get(note.chapterId)?.title || "",
        note.alignment === "ordinal" ? "自动顺序对应" : "",
      ].filter(Boolean).join(" · ");
      if (meta) title.createSpan({ text: meta });
      this.renderSequenceIssues(note.chapterId);
      const section = this._detail.createDiv("qbr-polish-detail-section");
      section.createEl("h4", { text: "注文全文" });
      section.createDiv({ cls: "qbr-polish-detail-note", text: note.text || "（这条注文没有文本）" });
      const actions = this._detail.createDiv("qbr-polish-detail-actions");
      const locate = actions.createEl("button", { text: "在编辑器中定位" });
      locate.addEventListener("click", () => this.jumpToNote(note.id));
      const notes = [...this._noteById.values()];
      const index = notes.findIndex((item) => item.id === note.id);
      const previous = notes.slice(0, Math.max(0, index)).reverse()
        .find((item) => item.chapterId === note.chapterId);
      if (previous) {
        const merge = actions.createEl("button", { cls: "mod-cta", text: "并入上一条" });
        merge.addEventListener("click", () => this.mergeNoteIntoPrevious(note.id));
      }
      const mergeNext = actions.createEl("button", { text: "与下一条合并" });
      mergeNext.addEventListener("click", () => this.mergeNextNoteIntoCurrent());
      const remove = actions.createEl("button", { text: "删除注文" });
      remove.addEventListener("click", () => this.deleteNote(note.id));
      const renumber = actions.createEl("button", { text: "手动补号" });
      renumber.addEventListener("click", () => this.openRenumberDialog(note.id));
    }

    jumpToNote(noteId) {
      const range = this.findCommentRange("note", noteId);
      if (!range || !this._editor) return;
      this.moveToVisibleAnchor(range.from, { focus: true, y: "center" });
    }

    openRenumberDialog(noteId) {
      const note = this._noteById.get(noteId);
      if (!note) return;
      const current = Math.max(1, Number(note.label) || 1);
      const onSubmit = (value) => this.renumberFromNote(noteId, value);
      const modal = new (class extends Modal {
        onOpen() {
          this.titleEl?.setText(`手动补号 · 注文 ${note.label || ""}`);
          this.contentEl.createDiv({
            cls: "qbr-polish-modal-hint",
            text: `从这条注文开始，后面的注文和对应正文标记会按顺序自动递增。当前编号：${current}。`,
          });
          const preview = String(note.text || "").replace(/\s+/g, " ").slice(0, 120);
          if (preview) this.contentEl.createDiv({ cls: "qbr-polish-modal-preview", text: preview });
          const input = this.contentEl.createEl("input", {
            cls: "qbr-polish-modal-input",
            attr: { type: "number", min: "1", step: "1", value: String(current) },
          });
          const status = this.contentEl.createDiv({ cls: "qbr-polish-modal-status" });
          const actions = this.contentEl.createDiv("qbr-polish-modal-actions");
          const cancel = actions.createEl("button", { text: "取消" });
          cancel.addEventListener("click", () => this.close());
          const apply = actions.createEl("button", { cls: "mod-cta", text: "应用" });
          apply.addEventListener("click", async () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || value < 1) {
              status.setText("请输入大于 0 的整数");
              return;
            }
            apply.disabled = true;
            apply.setText("应用中…");
            status.setText("");
            try {
              const changed = await onSubmit(Math.floor(value));
              if (changed) this.close();
              else {
                apply.disabled = false;
                apply.setText("应用");
                status.setText(this._lastRenumberMessage || "没有变化，请确认选中的注文和输入编号");
              }
            } catch (error) {
              apply.disabled = false;
              apply.setText("应用");
              status.setText(`补号失败：${String(error?.message || error)}`);
            }
          });
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            apply.click();
          });
          setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
        }
      })(this.app);
      modal.open();
    }

    renumberFromNote(noteId, startNumber, { auto = false } = {}) {
      this._lastRenumberMessage = "";
      try {
        if (!this._editor) {
          this._lastRenumberMessage = "编辑器还没有准备好，请稍后再试";
          return false;
        }
        const note = this._noteById.get(noteId);
        if (!note) {
          this._lastRenumberMessage = "找不到这条注文，可能已重新生成；请关闭后重新打开精修";
          if (!auto) new Notice(this._lastRenumberMessage);
          return false;
        }
        const markdown = this._editor.state.doc.toString();
        const markerByNote = new Map();
        for (const [id, item] of this._noteById) {
          if (item.markerId) markerByNote.set(id, item.markerId);
        }
        const result = renumberPolishNotes(markdown, noteId, startNumber, markerByNote);
        if (!result.count) {
          this._lastRenumberMessage = "没有在 polish.md 里找到这条注文；请重新打开精修后再试";
          if (!auto) new Notice(this._lastRenumberMessage);
          return false;
        }
        if (!result.changed) {
          this._lastRenumberMessage = `编号没有变化：从 ${startNumber} 开始已经是连续编号`;
          if (!auto) new Notice(this._lastRenumberMessage);
          return false;
        }
        // 只替换真正变化的区间，避免整篇文档重建；补号后把视图定位到当前注文，
        // 不让光标/滚动条跳回文首。自动顺延保持当前光标位置。
        let start = 0;
        while (start < markdown.length && start < result.markdown.length
          && markdown[start] === result.markdown[start]) {
          start += 1;
        }
        let oldEnd = markdown.length;
        let newEnd = result.markdown.length;
        while (oldEnd > start && newEnd > start
          && markdown[oldEnd - 1] === result.markdown[newEnd - 1]) {
          oldEnd -= 1;
          newEnd -= 1;
        }
        this._autoNumbering = true;
        try {
          this._editor.dispatch({
            changes: { from: start, to: oldEnd, insert: result.markdown.slice(start, newEnd) },
          });
        } finally {
          this._autoNumbering = false;
        }
        this.syncNotesFromMarkdown(result.markdown);
        this._numbering = collectPolishNumbers(result.markdown);
        this._selectedNoteId = noteId;
        this._selectedId = "";
        this.syncNoteSelection();
        if (!auto) this.jumpToNote(noteId);
        this.renderList();
        this.renderDetail();
        this.renderPreview();
        this._lastRenumberMessage = `已从这条注文开始重排 ${result.count} 条编号`;
        if (!auto) new Notice(`${this._lastRenumberMessage}；重建会以当前 polish.md 为准`);
        else if (result.count > 1) new Notice(`已自动顺延后面 ${result.count - 1} 条注文编号`);
        return true;
      } catch (error) {
        console.error("polish renumber failed", error);
        this._lastRenumberMessage = `补号失败：${String(error?.message || error)}`;
        if (!auto) new Notice(this._lastRenumberMessage);
        return false;
      }
    }

    renumberFromMarker(markerId, startNumber, { auto = false } = {}) {
      if (!this._editor) return false;
      const markdown = this._editor.state.doc.toString();
      const result = renumberPolishMarkers(markdown, markerId, startNumber);
      if (!result.changed) return false;
      let start = 0;
      while (start < markdown.length && start < result.markdown.length
        && markdown[start] === result.markdown[start]) {
        start += 1;
      }
      let oldEnd = markdown.length;
      let newEnd = result.markdown.length;
      while (oldEnd > start && newEnd > start
        && markdown[oldEnd - 1] === result.markdown[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
      }
      this._autoNumbering = true;
      try {
        this._editor.dispatch({
          changes: { from: start, to: oldEnd, insert: result.markdown.slice(start, newEnd) },
        });
      } finally {
        this._autoNumbering = false;
      }
      this.syncNotesFromMarkdown(result.markdown);
      this._numbering = collectPolishNumbers(result.markdown);
      this.renderList();
      this.renderDetail();
      this.renderPreview();
      if (!auto) new Notice(`已从这条标注开始重排 ${result.count} 个正文标记`);
      else if (result.count > 1) new Notice(`已自动顺延后面 ${result.count - 1} 个正文标记`);
      return true;
    }

    setPointStatus(id, status) {
      if (!id) return;
      this._statusMap = {
        ...this._statusMap,
        [id]: { status, updatedAt: new Date().toISOString() },
      };
      this._editor?.dispatch({ effects: POINT_STATUS_EFFECT.of(this._statusMap) });
      if (status !== "open" && this._filter === "review") {
        const next = this.visiblePoints()[0];
        this._selectedId = next?.id || "";
      }
      this.renderList();
      this.syncCounts();
      this.renderDetail();
      this.renderPreview();
      this.scheduleSessionSave();
    }

    renderPreview() {
      if (!this._previewBody || !this._editor) return;
      const point = this._points.find((item) => item.id === this._selectedId);
      const range = point ? (this.findCommentRange("point", point.id) || this.findCommentRange("note", point.noteId)) : null;
      const markdown = this._editor.state.doc.toString();
      const offset = range ? range.from : this._editor.state.selection.main.head;
      const chapter = chapterAtOffset(markdown, offset, {
        chapterTitles: this.chapterTitles(),
      });
      this._previewTitle?.setText(chapter.title ? `预览 · ${chapter.title}` : "预览");
      this._previewBody.empty();
      if (!chapter.text) {
        this._previewBody.createDiv({ cls: "qbr-polish-preview-empty", text: "把光标放进正文或选择一个修正点，这里会显示所在章节。" });
        return;
      }
      const limited = chapter.text.length > 120000 ? `${chapter.text.slice(0, 120000)}\n\n…` : chapter.text;
      // Keep the marker → note mapping for this chapter. The preview strips the
      // hidden comments, so the blue [N] markers would otherwise be decorative.
      const outline = buildPolishOutline(markdown, { chapterTitles: this.chapterTitles() });
      const chapterItems = outline.filter((item) => item.kind === "chapter");
      const lineAt = markdown.slice(0, offset).split("\n").length - 1;
      const chapterItem = [...chapterItems].reverse().find((item) => item.line <= lineAt) || chapterItems[0];
      const lines = markdown.split("\n");
      const chapterEnd = chapterItems[chapterItems.indexOf(chapterItem) + 1]?.line ?? lines.length;
      const rawChapter = chapterItem ? lines.slice(chapterItem.line, chapterEnd).join("\n") : "";
      const parsed = parsePolishMarkdown(rawChapter);
      const noteIds = parsed.markers.map((marker) => marker.note || "");
      if (typeof renderMarkdown === "function") {
        this._previewBody.innerHTML = decoratePreviewNoterefs(renderMarkdown(limited), noteIds);
        renderMathIn(this._previewBody);
      } else {
        this._previewBody.innerHTML = `<pre>${escapeHtml(limited)}</pre>`;
      }
      this.decoratePreviewNoteBacklinks(parsed, chapter);
      if (this._selectedNoteId) {
        const target = [...this._previewBody.querySelectorAll(".qbr-preview-note-body")]
          .find((el) => el.dataset.noteId === this._selectedNoteId);
        target?.scrollIntoView({ block: "center" });
      }
      void this.resolvePreviewImages();
    }

    decoratePreviewNoteBacklinks(parsed, chapter) {
      if (!this._previewBody) return;
      const markerByNote = new Map();
      for (const marker of parsed.markers || []) {
        if (marker.note && !markerByNote.has(marker.note)) markerByNote.set(marker.note, marker.id);
      }
      let inNotes = isNoteHeading(chapter.title);
      let noteIndex = 0;
      for (const el of [...this._previewBody.children]) {
        if (/^H[1-6]$/.test(el.tagName)) {
          inNotes = isNoteHeading(el.textContent || "");
          continue;
        }
        if (!inNotes || el.tagName !== "P") continue;
        const match = /^\s*(\d{1,3})、/.exec(el.textContent || "");
        if (!match) continue;
        const note = parsed.notes?.[noteIndex++];
        if (!note) continue;
        el.dataset.noteId = note.id;
        el.classList.add("qbr-preview-note-body");
        const markerId = markerByNote.get(note.id) || "";
        if (!markerId) continue;
        const prefix = /^\s*\d{1,3}、/.exec(el.innerHTML);
        if (!prefix) continue;
        el.innerHTML = `<button type="button" class="qbr-preview-noteback" data-marker-id="${markerId.replace(/"/g, "&quot;")}" aria-label="回到正文标注 ${match[1]}">[${match[1]}]</button>${el.innerHTML.slice(prefix[0].length)}`;
      }
    }

    async resolvePreviewImages() {
      if (!this._previewBody || !bridge?.polish?.resolveAsset) return;
      const images = [...this._previewBody.querySelectorAll("img[src]")];
      await Promise.all(images.map(async (img) => {
        const source = img.getAttribute("src") || "";
        if (!source || /^(?:data:|file:|https?:|blob:)/i.test(source)) return;
        if (this._assetUrlCache.has(source)) {
          const cached = this._assetUrlCache.get(source);
          if (!img.isConnected) return;
          if (cached) img.src = cached;
          else img.hidden = true;
          return;
        }
        let resolved = "";
        try {
          resolved = await bridge.polish.resolveAsset(this._manifestPath, source);
        } catch {
          resolved = "";
        }
        this._assetUrlCache.set(source, resolved);
        if (!img.isConnected) return;
        if (resolved) img.src = resolved;
        else img.hidden = true;
      }));
    }

    async saveCopy() {
      if (!bridge?.polish?.saveAs) return;
      try {
        await this.saveMarkdown();
        const saved = await bridge.polish.saveAs(this._manifestPath);
        if (saved) new Notice(`精修 Markdown 已另存：${saved}`);
      } catch (error) {
        new Notice(`另存失败：${String(error?.message || error)}`);
      }
    }

    async revertChanges() {
      const confirmed = typeof window !== "undefined" && window.confirm
        ? window.confirm("还原到生成时的自动结果？本次对 polish.md 的修改和修正点状态会被清除。")
        : false;
      if (!confirmed) return;
      if (!bridge?.polish?.revert) return;
      try {
        const bundle = await bridge.polish.revert(this._manifestPath);
        this._bundle = bundle;
        this._statusMap = {};
        this._filter = "review";
        this._stage = bundle.session?.stage || "notes";
        this._selectedId = bundle.report?.points?.[0]?.id || "";
        this.renderShell();
        this.mountEditor(bundle.markdown || "");
        this.renderList();
        this.renderDetail();
        this.renderPreview();
        new Notice("已还原自动结果");
      } catch (error) {
        new Notice(`还原失败：${String(error?.message || error)}`);
      }
    }

    async startAudit() {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        await this.saveMarkdown();
      }
      try {
        await bridge?.workshop?.start?.({
          kind: "book-polish",
          title: "精修结构检查",
          detail: this._bundle?.manifest?.book?.title || "",
          notify: false,
          payload: { phase: "audit", manifestPath: this._manifestPath },
        });
        new Notice("已加入结构检查任务");
      } catch (error) {
        new Notice(`无法开始检查：${String(error?.message || error)}`);
      }
    }

    openRebuildDialog() {
      if (!this._bundle) return;
      const owner = this;
      const defaultTag = this._lastRebuildTag || String(plugin?.settings?.polishTag || "精修");
      const modal = new (class extends Modal {
        onOpen() {
          this.titleEl?.setText("生成精修版本");
          this.contentEl.createDiv({
            cls: "qbr-polish-modal-hint",
            text: "原文件不会被覆盖。新文件会用 tag 做后缀，同时把当前 polish.md 保存一份同名副本，方便以后对照。同名会自动加序号。",
          });
          const field = this.contentEl.createDiv("qbr-polish-modal-field");
          field.createEl("label", { text: "版本 tag" });
          const input = field.createEl("input", {
            cls: "qbr-polish-modal-input",
            attr: { type: "text", maxlength: "40", value: defaultTag, "aria-label": "版本 tag" },
          });
          const status = this.contentEl.createDiv({ cls: "qbr-polish-modal-status" });
          const target = String(owner._bundle?.manifest?.build?.out || "");
          const ext = (target.match(/\.[^./\\]+$/) || [""])[0] || ".epub";
          const base = target.slice(0, target.length - ext.length).split(/[\\/]/).pop() || "书名";
          const fallbackTag = defaultTag || "精修";
          const preview = () => {
            const tag = String(input.value || "").trim() || fallbackTag;
            status.setText(`新文件：${base}-${tag}${ext}；polish 副本：polish-${tag}.md`);
          };
          input.addEventListener("input", preview);
          preview();
          const actions = this.contentEl.createDiv("qbr-polish-modal-actions");
          const cancel = actions.createEl("button", { text: "取消" });
          cancel.addEventListener("click", () => this.close());
          const apply = actions.createEl("button", { cls: "mod-cta", text: "生成" });
          apply.addEventListener("click", async () => {
            const tag = String(input.value || "").trim() || fallbackTag;
            this.close();
            await owner.startRebuild(tag);
          });
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            apply.click();
          });
          setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
        }
      })(this.app);
      modal.open();
    }

    async startRebuild(tag = "精修") {
      if (!this._bundle) return;
      const versionTag = String(tag || "").trim() || String(plugin?.settings?.polishTag || "精修");
      this._lastRebuildTag = versionTag;
      // Remember the last tag as the next book's default; each book still keeps
      // its own lastTag in polish-session.json.
      if (plugin?.settings && plugin.settings.polishTag !== versionTag) {
        plugin.settings.polishTag = versionTag;
        const save = typeof plugin.saveSettings === "function" ? plugin.saveSettings.bind(plugin) : plugin.saveAll?.bind(plugin);
        void save?.();
      }
      if (String(this._bundle.manifest?.build?.translationMode || "none") !== "none") {
        new Notice("翻译/简繁转换的电子书暂不支持精修复建");
        return;
      }
      if (!this._bundle.manifest?.build?.out) {
        new Notice("这份精修清单缺少原始构建输出路径，请重新生成电子书");
        return;
      }
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        await this.saveMarkdown();
      }
      try {
        await this.saveSession();
      } catch {
        // 会话失败不阻止重建；Markdown 已经落盘。
      }
      try {
        await bridge?.workshop?.start?.({
          kind: "book-polish",
          title: "重建精修电子书",
          detail: `${this._bundle?.manifest?.book?.title || ""} · ${versionTag}`,
          payload: { phase: "rebuild", manifestPath: this._manifestPath, tag: versionTag },
        });
        this._rebuildButton.disabled = true;
        this._rebuildButton.setText("已加入重建任务");
        new Notice("已加入重建任务；完成后会在这里提示");
        setTimeout(() => {
          if (this._rebuildButton) {
            this._rebuildButton.disabled = false;
            this._rebuildButton.setText("生成精修版本");
          }
        }, 4000);
      } catch (error) {
        new Notice(`无法开始重建：${String(error?.message || error)}`);
      }
    }
  }

  return new PolishView(leaf);
}
