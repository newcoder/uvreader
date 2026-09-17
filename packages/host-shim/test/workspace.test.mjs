import assert from "node:assert/strict";
import test from "node:test";

import { ItemView, createApp } from "../src/index.js";
import { setupDom, setupHost } from "./helpers.mjs";

setupDom();

class DemoView extends ItemView {
  getViewType() {
    return "demo-view";
  }

  getDisplayText() {
    return "Demo";
  }

  async onOpen() {
    this.opened = true;
    this.contentEl.setText("ready");
  }
}

test("setViewState creates the registered view, mounts it and opens it", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "demo-view", state: { file: "a.epub" } });
    assert.ok(leaf.view instanceof DemoView);
    assert.equal(leaf.view.opened, true);
    assert.equal(app.workspace.activeLeaf, leaf);
    assert.equal(app.workspace.getActiveViewOfType(DemoView), leaf.view);
    assert.equal(document.body.contains(leaf.view.containerEl), true);
  } finally {
    env.cleanup();
  }
});

test("setViewState reuses the same view for the same type", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "demo-view", state: { file: "a" } });
    const first = leaf.view;
    await leaf.setViewState({ type: "demo-view", state: { file: "b" } });
    assert.equal(leaf.view, first);
    assert.deepEqual(first.getState(), { file: "b" });
  } finally {
    env.cleanup();
  }
});

test("detaching a leaf removes the view and clears the active leaf", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "demo-view" });
    const view = leaf.view;
    app.workspace.detachLeavesOfType("demo-view");
    assert.equal(app.workspace.getLeavesOfType("demo-view").length, 0);
    assert.equal(app.workspace.activeLeaf, null);
    assert.equal(document.body.contains(view.containerEl), false);
  } finally {
    env.cleanup();
  }
});

test("MarkdownView renders the file content", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    const note = await app.vault.create("notes/book.md", "# Note\n\nbody");
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(note);
    assert.equal(leaf.view.getViewType(), "markdown");
    assert.match(leaf.view.contentEl.textContent, /# Note/);
    assert.match(leaf.view.contentEl.textContent, /body/);
  } finally {
    env.cleanup();
  }
});

test("getRightLeaf reuses the existing sidebar leaf", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    const first = app.workspace.getRightLeaf(false);
    const second = app.workspace.getRightLeaf(false);
    assert.equal(first, second);
    assert.equal(app.workspace.getLeavesOfType("").length >= 0, true);
  } finally {
    env.cleanup();
  }
});

test("a newly mounted main view is visible before activation", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const first = app.workspace.getLeaf("tab");
    await first.setViewState({ type: "demo-view" });
    const second = app.workspace.getLeaf("tab");
    const view = new DemoView(second);
    second.view = view;
    app.workspace._mount(second, view);
    assert.equal(view.containerEl.hidden, false, "the mounted view must be visible while it loads");
    assert.equal(first.view.containerEl.hidden, true);
    app.workspace._activate(second);
    assert.equal(app.workspace.activeLeaf, second);
    assert.equal(view.containerEl.hidden, false);
  } finally {
    env.cleanup();
  }
});

test("only the active main leaf is visible", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const first = app.workspace.getLeaf("tab");
    await first.setViewState({ type: "demo-view" });
    const second = app.workspace.getLeaf("tab");
    await second.setViewState({ type: "demo-view" });
    assert.equal(first.view.containerEl.hidden, true);
    assert.equal(second.view.containerEl.hidden, false);
    app.workspace.setActiveLeaf(first);
    assert.equal(first.view.containerEl.hidden, false);
    assert.equal(second.view.containerEl.hidden, true);
  } finally {
    env.cleanup();
  }
});

test("activating a sidebar leaf keeps the main view visible", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const main = app.workspace.getLeaf("tab");
    await main.setViewState({ type: "demo-view" });
    const right = app.workspace.getRightLeaf(false);
    await right.setViewState({ type: "demo-view" });
    assert.equal(main.view.containerEl.hidden, false);
    assert.equal(right.view.containerEl.hidden, false);
    assert.equal(app.workspace.activeLeaf, main);
    assert.equal(app.workspace.activeRightLeaf, right);
    assert.equal(app.workspace.getActiveViewOfType(DemoView), main.view);
  } finally {
    env.cleanup();
  }
});

test("the left split hosts sidebar leaves without hiding the main view", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const main = app.workspace.getLeaf("tab");
    await main.setViewState({ type: "demo-view" });
    const left = app.workspace.getLeftLeaf();
    await left.setViewState({ type: "demo-view" });
    assert.equal(app.workspace.leftSplit.collapsed, false);
    assert.equal(left.getRoot(), app.workspace.leftSplit);
    assert.equal(main.view.containerEl.hidden, false, "the main view stays visible next to a left sidebar");
    assert.equal(left.view.containerEl.hidden, false);
    assert.equal(app.workspace.activeLeaf, main);
    left.detach();
    assert.equal(app.workspace.leftSplit.collapsed, true);
  } finally {
    env.cleanup();
  }
});

test("the right split expands for a sidebar and collapses when its leaf detaches", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    app.viewFactories.set("demo-view", (leaf) => new DemoView(leaf));
    const leaf = app.workspace.getRightLeaf(false);
    assert.equal(app.workspace.rightSplit.collapsed, false);
    await leaf.setViewState({ type: "demo-view" });
    assert.equal(leaf.view.containerEl.hidden, false);
    leaf.detach();
    assert.equal(app.workspace.rightSplit.collapsed, true);
    assert.equal(app.workspace.rightSplit.el.hidden, true);
  } finally {
    env.cleanup();
  }
});

test("getRightLeaf lives under the right split", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    const leaf = app.workspace.getRightLeaf(false);
    assert.equal(leaf.getRoot(), app.workspace.rightSplit);
    assert.equal(app.workspace.rightSplit.collapsed, false);
  } finally {
    env.cleanup();
  }
});

test("onLayoutReady runs immediately after the layout is marked ready", async () => {
  const env = setupHost();
  try {
    const app = createApp({ workspaceEl: document.body });
    let called = 0;
    app.workspace.onLayoutReady(() => {
      called += 1;
    });
    assert.equal(called, 0);
    app.workspace.markLayoutReady();
    assert.equal(called, 1);
    app.workspace.onLayoutReady(() => {
      called += 1;
    });
    assert.equal(called, 2);
  } finally {
    env.cleanup();
  }
});
