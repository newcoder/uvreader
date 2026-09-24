import { Component } from "./component.js";
import { Events } from "./events.js";
import { Scope } from "./scope.js";
import { setIcon } from "./services.js";

function ownerDocument() {
  return globalThis.document || null;
}

export class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf?.app || null;
    this.scope = new Scope();
    const doc = leaf?.containerEl?.ownerDocument || ownerDocument();
    this.containerEl = doc ? doc.createElement("div") : null;
    this.containerEl?.classList?.add("view-content");
  }

  getViewType() {
    return "empty";
  }

  getDisplayText() {
    return "";
  }

  getIcon() {
    return "file";
  }

  async onOpen() {}

  async onClose() {}

  async setState(state) {
    this.state = state;
  }

  getState() {
    return this.state || {};
  }

  onPaneMenu() {}

  addAction(icon, title, callback) {
    const el = this.containerEl?.createEl?.("div", { cls: "view-action" });
    if (!el) return null;
    setIcon(el, icon);
    if (title) el.setAttribute("aria-label", title);
    if (typeof callback === "function") el.addEventListener("click", callback);
    return el;
  }
}

export class ItemView extends View {
  constructor(leaf) {
    super(leaf);
    const doc = this.containerEl?.ownerDocument || ownerDocument();
    this.contentEl = doc ? doc.createElement("div") : null;
    this.contentEl?.classList?.add("view-content");
    if (this.containerEl && this.contentEl) this.containerEl.appendChild(this.contentEl);
  }
}

export class MarkdownView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
  }

  getViewType() {
    return "markdown";
  }

  getDisplayText() {
    return this.file?.basename || "Note";
  }

  getIcon() {
    return "file-text";
  }

  async setState(state) {
    this.state = state;
    if (state?.file && this.app?.vault) {
      const file = this.app.vault.getAbstractFileByPath(state.file);
      if (file) this.file = file;
    }
  }

  async onOpen() {
    if (!this.file || !this.contentEl) return;
    try {
      const data = await this.app.vault.read(this.file);
      this.contentEl.setText(data);
    } catch (error) {
      this.contentEl.setText(String(error?.message || error));
    }
  }
}

export class WorkspaceLeaf {
  constructor(workspace, options = {}) {
    this.app = workspace.app;
    this.workspace = workspace;
    this.view = null;
    this._right = options.right === true;
    this._left = options.left === true;
  }

  getViewType() {
    return this.view?.getViewType?.() || "";
  }

  getRoot() {
    if (this._left) return this.workspace.leftSplit;
    return this._right ? this.workspace.rightSplit : this.workspace.rootSplit;
  }

  async setViewState(state, eState) {
    const type = state?.type;
    const factory = this.app?.viewFactories?.get(type);
    if (!factory) throw new Error(`host-shim: no view registered for "${type}"`);
    if (this.view && this.view.getViewType?.() === type) {
      // Make the view visible before it swaps its content: foliate cannot
      // resolve a reading location while the container has zero dimensions.
      this.workspace._activate(this);
      await this.view.setState?.(state?.state || {}, eState);
      return this;
    }
    if (this.view) {
      await this.view.onClose?.();
      this.view.unload?.();
      this.view.containerEl?.remove?.();
    }
    const view = factory(this);
    view.app = this.app;
    this.view = view;
    this.workspace._mount(this, view);
    view.load?.();
    await view.onOpen?.();
    if (state?.state && Object.keys(state.state).length) await view.setState?.(state.state, eState);
    this.workspace._activate(this);
    this.workspace.trigger("layout-change");
    return this;
  }

  async openFile(file, options = {}) {
    if (!file) return false;
    if (file.extension === "md") {
      const view = new MarkdownView(this);
      view.app = this.app;
      view.file = file;
      this.view = view;
      this.workspace._mount(this, view);
      view.load?.();
      await view.onOpen?.();
      this.workspace._activate(this);
      return true;
    }
    const type = this.app?.extensionViews?.get(file.extension);
    if (!type) return false;
    await this.setViewState({ type, state: { path: file.path }, active: options.active !== false });
    return true;
  }

  async setEphemeralState() {}

  getEphemeralState() {
    return {};
  }

  detach() {
    this.workspace._detach(this);
  }
}

// Sidebar widths can be dragged; the reader re-lays out from its own width
// observer. Values live in localStorage so the layout survives a restart.
const SPLIT_WIDTHS = {
  left: { min: 200, max: 640, fallback: 300 },
  right: { min: 240, max: 720, fallback: 380 },
};
const SPLIT_WIDTH_KEY = "qbr.workspace.splitWidths";
const MAIN_MIN_WIDTH = 360;

export class Workspace extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.layoutReady = false;
    this._layoutReadyCallbacks = [];
    this.leaves = [];
    this.activeLeaf = null;
    this.activeRightLeaf = null;
    const doc = app.workspaceEl?.ownerDocument || globalThis.document;
    this.rootSplit = this._makeSplit("main", false, doc);
    this.leftSplit = this._makeSplit("left", true, doc);
    this.rightSplit = this._makeSplit("right", true, doc);
    if (app.workspaceEl && this.rootSplit.el) {
      app.workspaceEl.classList.add("qbr-workspace");
      this.leftSplitter = this._makeSplitter("left", doc);
      this.rightSplitter = this._makeSplitter("right", doc);
      app.workspaceEl.append(
        this.leftSplit.el, this.leftSplitter,
        this.rootSplit.el,
        this.rightSplitter, this.rightSplit.el,
      );
      this._applyStoredWidths();
    }
  }

  _splitFor(side) {
    return side === "left" ? this.leftSplit : this.rightSplit;
  }

  _makeSplitter(side, doc) {
    if (!doc) return null;
    const el = doc.createElement("div");
    el.className = `qbr-splitter qbr-splitter-${side}`;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "vertical");
    el.tabIndex = 0;
    el.addEventListener("pointerdown", (event) => this._startSplitDrag(side, event));
    el.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const split = this._splitFor(side);
      if (split.collapsed) return;
      event.preventDefault();
      const grow = side === "left" ? event.key === "ArrowRight" : event.key === "ArrowLeft";
      this._setSplitWidth(side, (split.width || SPLIT_WIDTHS[side].fallback) + (grow ? 24 : -24));
      this._storeWidths();
    });
    return el;
  }

  _startSplitDrag(side, event) {
    if (event.button !== 0 || !this._splitFor(side)?.el) return;
    event.preventDefault();
    const doc = this.app.workspaceEl?.ownerDocument || globalThis.document;
    const startX = event.clientX;
    const startWidth = this._splitFor(side).el.getBoundingClientRect().width;
    const move = (moveEvent) => {
      const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      this._setSplitWidth(side, startWidth + delta);
    };
    // Pointer capture keeps the drag alive when the pointer crosses the reader
    // (its book iframes would otherwise swallow the move events).
    const handle = event.currentTarget;
    try { handle?.setPointerCapture?.(event.pointerId); } catch { /* document listeners still work */ }
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      doc?.removeEventListener?.("pointermove", move);
      doc?.removeEventListener?.("pointerup", up);
      doc?.removeEventListener?.("pointercancel", up);
      try { handle?.releasePointerCapture?.(event.pointerId); } catch { /* already gone */ }
      this._storeWidths();
    };
    doc?.addEventListener?.("pointermove", move);
    doc?.addEventListener?.("pointerup", up);
    doc?.addEventListener?.("pointercancel", up);
  }

  _splitMax(side) {
    const limits = SPLIT_WIDTHS[side];
    const workspace = this.app.workspaceEl;
    const other = side === "left" ? this.rightSplit : this.leftSplit;
    const otherWidth = other?.collapsed ? 0 : (other?.width || 0);
    const total = workspace?.clientWidth || 0;
    const room = total ? total - otherWidth - MAIN_MIN_WIDTH - 12 : limits.max;
    return Math.max(limits.min, Math.min(limits.max, room));
  }

  _setSplitWidth(side, width) {
    const split = this._splitFor(side);
    if (!split?.el) return;
    const limits = SPLIT_WIDTHS[side];
    const value = Math.round(Math.max(limits.min, Math.min(this._splitMax(side), width)));
    split.width = value;
    split.el.style.flexBasis = `${value}px`;
  }

  _applyStoredWidths() {
    let stored = {};
    try {
      const raw = this.app.workspaceEl.ownerDocument.defaultView?.localStorage?.getItem(SPLIT_WIDTH_KEY);
      stored = raw ? JSON.parse(raw) : {};
    } catch { stored = {}; }
    for (const side of ["left", "right"]) {
      const limits = SPLIT_WIDTHS[side];
      const value = Number.isFinite(stored[side]) ? stored[side] : limits.fallback;
      this._setSplitWidth(side, value);
    }
  }

  _storeWidths() {
    try {
      const data = { left: this.leftSplit.width, right: this.rightSplit.width };
      this.app.workspaceEl.ownerDocument.defaultView?.localStorage?.setItem(SPLIT_WIDTH_KEY, JSON.stringify(data));
    } catch { /* the layout still works without storage */ }
  }

  _makeSplit(kind, collapsed, doc) {
    const split = { app: this.app, kind, collapsed: Boolean(collapsed), children: [], el: null };
    if (doc) {
      const el = doc.createElement("div");
      el.className = `qbr-split qbr-split-${kind}`;
      el.hidden = split.collapsed;
      split.el = el;
    }
    split.collapse = () => {
      split.collapsed = true;
      this._syncLayout();
    };
    split.expand = () => {
      split.collapsed = false;
      this._syncLayout();
    };
    return split;
  }

  _mount(leaf, view) {
    const split = leaf._left ? this.leftSplit : leaf._right ? this.rightSplit : this.rootSplit;
    const container = split.el || this.app.workspaceEl;
    container?.appendChild?.(view.containerEl);
    view.containerEl?.classList?.add("qbr-view");
    // Mounting a main view means it is about to be shown: give it layout
    // immediately so engines can measure while they open. Activation later
    // hides the previously active view.
    if (!leaf._right && !leaf._left) this._pendingActive = leaf;
    this._syncLayout();
  }

  _syncLayout() {
    if (this.leftSplit.el) this.leftSplit.el.hidden = this.leftSplit.collapsed;
    if (this.rightSplit.el) this.rightSplit.el.hidden = this.rightSplit.collapsed;
    if (this.leftSplitter) this.leftSplitter.hidden = this.leftSplit.collapsed;
    if (this.rightSplitter) this.rightSplitter.hidden = this.rightSplit.collapsed;
    // A view that was just mounted is about to become active: show it during
    // load even while another view still owns activeLeaf.
    const active = this._pendingActive || this.activeLeaf || null;
    for (const leaf of this.leaves) {
      const el = leaf.view?.containerEl;
      if (!el) continue;
      el.hidden = leaf._left ? this.leftSplit.collapsed
        : leaf._right ? this.rightSplit.collapsed
          : leaf !== active;
    }
  }

  onLayoutReady(callback) {
    if (this.layoutReady) {
      callback();
      return;
    }
    this._layoutReadyCallbacks.push(callback);
  }

  markLayoutReady() {
    if (this.layoutReady) return;
    this.layoutReady = true;
    for (const callback of this._layoutReadyCallbacks.splice(0)) {
      try {
        callback();
      } catch (error) {
        console.error("host-shim: layout-ready callback failed", error);
      }
    }
  }

  getLeavesOfType(type) {
    return this.leaves.filter((leaf) => leaf.view?.getViewType?.() === type);
  }

  getLeaf(type = "tab") {
    const leaf = new WorkspaceLeaf(this, { right: false });
    this.leaves.push(leaf);
    return leaf;
  }

  getRightLeaf() {
    const existing = this.leaves.find((leaf) => leaf._right);
    if (existing) {
      this.rightSplit.expand();
      return existing;
    }
    const leaf = new WorkspaceLeaf(this, { right: true });
    this.leaves.push(leaf);
    this.rightSplit.children.push(leaf);
    this.rightSplit.expand();
    return leaf;
  }

  getLeftLeaf() {
    const existing = this.leaves.find((leaf) => leaf._left);
    if (existing) {
      this.leftSplit.expand();
      return existing;
    }
    const leaf = new WorkspaceLeaf(this, { left: true });
    this.leaves.push(leaf);
    this.leftSplit.children.push(leaf);
    this.leftSplit.expand();
    return leaf;
  }

  async revealLeaf(leaf) {
    this._activate(leaf);
    return leaf;
  }

  setActiveLeaf(leaf) {
    this._activate(leaf);
  }

  getMostRecentLeaf() {
    return this.activeLeaf || this.leaves[this.leaves.length - 1] || null;
  }

  _activate(leaf) {
    if (leaf?._left === true) {
      // A left sidebar leaf never becomes the main active view.
      this.leftSplit.expand();
      return;
    }
    const isRight = leaf?._right === true;
    const changed = isRight ? this.activeRightLeaf !== leaf : this.activeLeaf !== leaf;
    if (isRight) this.activeRightLeaf = leaf;
    else this.activeLeaf = leaf;
    if (!isRight) this._pendingActive = null;
    this._syncLayout();
    if (changed) this.trigger("active-leaf-change", leaf);
  }

  detachLeavesOfType(type) {
    for (const leaf of this.getLeavesOfType(type)) leaf.detach();
  }

  getActiveViewOfType(ViewClass) {
    const view = this.activeLeaf?.view;
    return ViewClass && view instanceof ViewClass ? view : null;
  }

  getActiveFile() {
    return this.activeLeaf?.view?.file || null;
  }

  iterateAllLeaves(callback) {
    for (const leaf of [...this.leaves]) callback(leaf);
  }

  _detach(leaf) {
    const view = leaf.view;
    if (view) {
      void view.onClose?.();
      view.unload?.();
      view.containerEl?.remove?.();
    }
    leaf.view = null;
    this.leaves = this.leaves.filter((item) => item !== leaf);
    this.rightSplit.children = this.rightSplit.children.filter((item) => item !== leaf);
    this.leftSplit.children = this.leftSplit.children.filter((item) => item !== leaf);
    if (leaf._right && !this.leaves.some((item) => item._right)) this.rightSplit.collapse();
    if (leaf._left && !this.leaves.some((item) => item._left)) this.leftSplit.collapse();
    if (this.activeRightLeaf === leaf) this.activeRightLeaf = null;
    if (this.activeLeaf === leaf) {
      this.activeLeaf = this.leaves.find((item) => !item._right && !item._left) || this.leaves[0] || null;
      this.trigger("active-leaf-change", this.activeLeaf);
    }
    this._syncLayout();
    this.trigger("layout-change");
  }
}
