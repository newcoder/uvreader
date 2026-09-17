import assert from "node:assert/strict";
import test from "node:test";

import {
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  PluginSettingTab,
  Scope,
  SecretComponent,
  SecretStorage,
  Setting,
  requestUrl,
  configureHost,
} from "../src/index.js";
import { setupDom, setupHost } from "./helpers.mjs";

setupDom();

test("Setting builders chain and report values", () => {
  const host = document.createElement("div");
  let toggled = null;
  const setting = new Setting(host)
    .setName("Reader")
    .setDesc("Options")
    .addToggle((toggle) => toggle.setValue(true).onChange((value) => {
      toggled = value;
    }))
    .addDropdown((dropdown) => dropdown.addOptions({ a: "A", b: "B" }).setValue("b"))
    .addButton((button) => button.setButtonText("Go").setCta());
  assert.equal(setting.settingEl, setting.containerEl);
  assert.equal(setting.nameEl.getText(), "Reader");
  assert.equal(setting.descEl.getText(), "Options");
  const input = host.querySelector('input[type="checkbox"]');
  assert.equal(input.checked, true);
  input.checked = false;
  input.dispatchEvent(new globalThis.window.Event("change"));
  assert.equal(toggled, false);
  assert.equal(host.querySelector("select").value, "b");
  assert.equal(host.querySelector("button").textContent, "Go");
});

test("Setting.addComponent receives a container element", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let received = null;
  new Setting(host).addComponent((el) => {
    received = el;
    return new SecretComponent(null, el);
  });
  assert.equal(received?.isConnected, true);
  host.remove();
});

test("Modal keeps its keyboard scope and closes on Escape", () => {
  const keyboardScope = new Scope();
  class DemoModal extends Modal {}
  const modal = new DemoModal(null);
  const originalScope = modal.scope;
  modal.open();
  assert.equal(modal.scope, originalScope);
  assert.equal(document.body.contains(modal.containerEl), true);
  document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.body.contains(modal.containerEl), false);
});

test("Modal exposes a close button and closes from it", () => {
  class DemoModal extends Modal {}
  const modal = new DemoModal(null);
  modal.open();
  const closeButton = modal.modalEl.querySelector(".modal-close-button");
  assert.ok(closeButton, "modal must render a close button");
  closeButton.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }));
  assert.equal(document.body.contains(modal.containerEl), false);
});

test("Modal closes on a backdrop click but not on content clicks", () => {
  class DemoModal extends Modal {}
  const modal = new DemoModal(null);
  modal.open();
  modal.contentEl.dispatchEvent(new globalThis.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(document.body.contains(modal.containerEl), true);
  modal.containerEl.dispatchEvent(new globalThis.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(document.body.contains(modal.containerEl), false);
});

test("Escape only closes the topmost modal", () => {
  class DemoModal extends Modal {}
  const first = new DemoModal(null);
  const second = new DemoModal(null);
  first.open();
  second.open();
  document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.body.contains(second.containerEl), false);
  assert.equal(document.body.contains(first.containerEl), true);
  document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.body.contains(first.containerEl), false);
});

test("Modal ignores Escape while composing text", () => {
  class DemoModal extends Modal {}
  const modal = new DemoModal(null);
  modal.open();
  document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
  assert.equal(document.body.contains(modal.containerEl), true);
  modal.close();
});

test("Menu items fire their callback and hide the menu", () => {
  const menu = new Menu();
  let clicked = 0;
  menu.addItem((item) => item.setTitle("Open").setIcon("book-open").onClick(() => {
    clicked += 1;
  }));
  menu.addSeparator();
  menu.showAtPosition({ x: 1, y: 1 });
  const row = menu.dom.querySelector(".menu-item");
  row.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicked, 1);
  assert.equal(menu.dom, null);
});

test("Menu clamps its position inside the viewport", () => {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle("Open"));
  menu.showAtPosition({ x: 5000, y: 20 });
  const left = Number.parseFloat(menu.dom.style.left);
  assert.ok(left < globalThis.window.innerWidth, `menu left ${left} must stay inside the viewport`);
  menu.hide();
});

test("Notice renders and hides", () => {
  const notice = new Notice("Saved", 0);
  assert.equal(document.body.contains(notice.noticeEl), true);
  notice.setMessage("Updated");
  assert.equal(notice.noticeEl.textContent, "Updated");
  notice.hide();
  assert.equal(document.body.contains(notice.noticeEl), false);
});

test("SecretComponent stores the key and emits a secret id", async () => {
  const app = { secretStorage: new SecretStorage({ getSecretSync: () => null, setSecret: async () => {} }) };
  const host = document.createElement("div");
  const component = new SecretComponent(app, host);
  let received = null;
  component.onChange((id) => {
    received = id;
  });
  component.inputEl.value = "sk-test-123";
  component.inputEl.dispatchEvent(new globalThis.window.Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(received?.startsWith("qiaomu-secret-"), `expected a secret id, got ${received}`);
  assert.equal(app.secretStorage.getSecret(received), "sk-test-123");
  assert.equal(component.inputEl.value, "");
});

test("SecretStorage reads synchronously from the sync backend", async () => {
  const store = new Map([["k1", "v1"]]);
  const storage = new SecretStorage({
    getSecretSync: (id) => store.get(id) ?? null,
    setSecret: async (id, value) => store.set(id, value),
    deleteSecret: async (id) => store.delete(id),
  });
  assert.equal(storage.getSecret("k1"), "v1");
  assert.equal(storage.getSecret("missing"), null);
  await storage.setSecret("k2", "v2");
  assert.equal(storage.getSecret("k2"), "v2");
});

test("PluginSettingTab exposes a container", () => {
  const tab = new PluginSettingTab(null, null);
  assert.equal(tab.containerEl.isConnected, false);
  tab.containerEl.setText("x");
  assert.equal(tab.containerEl.textContent, "x");
});

test("requestUrl uses the injected fetch implementation", async () => {
  const env = setupHost();
  try {
    configureHost({
      fetchImpl: async (url, options) => ({
        status: 200,
        headers: { entries: () => [["content-type", "application/json"]] },
        text: async () => JSON.stringify({ url, method: options.method }),
        clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      }),
    });
    const result = await requestUrl({ url: "https://example.test/v1", method: "POST" });
    assert.equal(result.status, 200);
    assert.equal(result.json.method, "POST");
  } finally {
    configureHost({ fetchImpl: null });
    env.cleanup();
  }
});

test("MarkdownRenderer uses the injected renderer and falls back to text", async () => {
  const env = setupHost();
  try {
    const el = document.createElement("div");
    configureHost({ renderMarkdown: async (markdown, target) => {
      target.innerHTML = `<b>${markdown}</b>`;
    } });
    await MarkdownRenderer.render(null, "hi", el, "", null);
    assert.equal(el.innerHTML, "<b>hi</b>");
    configureHost({ renderMarkdown: null });
    await MarkdownRenderer.render(null, "plain", el, "", null);
    assert.equal(el.textContent, "plain");
  } finally {
    env.cleanup();
  }
});
