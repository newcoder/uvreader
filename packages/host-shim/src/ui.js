import { Component } from "./component.js";
import { Scope } from "./scope.js";
import { setIcon } from "./services.js";

function doc() {
  const document = globalThis.document;
  if (!document) throw new Error("host-shim: a DOM is required for UI components");
  return document;
}

function inputEvent(component, el, handler) {
  el.addEventListener("input", () => handler(el.value));
  return component;
}

export class Notice {
  constructor(message, timeout = 5000) {
    this.message = String(message ?? "");
    this.noticeEl = doc().createElement("div");
    this.noticeEl.classList.add("notice");
    this.noticeEl.textContent = this.message;
    doc().body.appendChild(this.noticeEl);
    this._timeout = timeout ? setTimeout(() => this.hide(), timeout) : null;
  }

  setMessage(message) {
    this.message = String(message ?? "");
    this.noticeEl.textContent = this.message;
  }

  hide() {
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = null;
    this.noticeEl.remove();
  }
}

export class MenuItem {
  constructor(menu, section = "") {
    this.menu = menu;
    this.title = "";
    this.icon = "";
    this.checked = false;
    this.disabled = false;
    this.isLabel = false;
    this.section = section;
    this.callback = null;
  }

  setTitle(title) {
    this.title = String(title ?? "");
    return this;
  }

  setIcon(icon) {
    this.icon = icon || "";
    return this;
  }

  setChecked(checked) {
    this.checked = Boolean(checked);
    return this;
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    return this;
  }

  setIsLabel(isLabel) {
    this.isLabel = Boolean(isLabel);
    return this;
  }

  setSection(section) {
    this.section = section || "";
    return this;
  }

  onClick(callback) {
    this.callback = callback;
    return this;
  }
}

export class Menu {
  constructor() {
    this.items = [];
    this.dom = null;
    this._hideCallbacks = [];
  }

  addItem(callback) {
    const item = new MenuItem(this);
    this.items.push(item);
    if (typeof callback === "function") callback(item);
    return item;
  }

  addSeparator() {
    this.items.push({ separator: true });
    return this;
  }

  onHide(callback) {
    this._hideCallbacks.push(callback);
    return this;
  }

  showAtMouseEvent(event) {
    return this.showAtPosition({ x: event?.clientX || 0, y: event?.clientY || 0 });
  }

  showAtPosition(position = {}) {
    this.hide();
    const el = doc().createElement("div");
    el.classList.add("menu");
    el.style.position = "fixed";
    el.style.left = `${position.x || 0}px`;
    el.style.top = `${position.y || 0}px`;
    el.style.zIndex = "1000";
    for (const item of this.items) {
      if (item.separator) {
        const separator = el.createDiv?.("menu-separator") || el.appendChild(doc().createElement("div"));
        separator.classList.add("menu-separator");
        continue;
      }
      const row = doc().createElement("div");
      row.classList.add("menu-item");
      if (item.disabled) row.classList.add("is-disabled");
      if (item.icon) {
        const iconEl = doc().createElement("div");
        iconEl.classList.add("menu-item-icon");
        setIcon(iconEl, item.icon);
        row.appendChild(iconEl);
      }
      const titleEl = doc().createElement("div");
      titleEl.classList.add("menu-item-title");
      titleEl.textContent = item.title;
      row.appendChild(titleEl);
      if (!item.disabled && item.callback) {
        row.addEventListener("click", () => {
          this.hide();
          item.callback();
        });
      }
      el.appendChild(row);
    }
    doc().body.appendChild(el);
    const win = doc().defaultView || globalThis;
    const margin = 8;
    const width = el.offsetWidth || 180;
    const height = el.offsetHeight || 0;
    let x = Number(position.x) || 0;
    let y = Number(position.y) || 0;
    if (x + width + margin > win.innerWidth) x = Math.max(margin, win.innerWidth - width - margin);
    if (y + height + margin > win.innerHeight) y = Math.max(margin, y - height - 6);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.dom = el;
    const close = (event) => {
      if (el.contains(event.target)) return;
      this.hide();
    };
    this._close = close;
    setTimeout(() => doc().addEventListener("mousedown", close), 0);
    return this;
  }

  hide() {
    if (this._close) doc().removeEventListener("mousedown", this._close);
    this._close = null;
    this.dom?.remove();
    this.dom = null;
    for (const callback of this._hideCallbacks.splice(0)) {
      try {
        callback();
      } catch (error) {
        console.error("host-shim: menu hide callback failed", error);
      }
    }
  }
}

const modalStack = [];

export class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.scope = new Scope();
    this.containerEl = doc().createElement("div");
    this.containerEl.classList.add("modal-container");
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-modal", "true");
    this.modalEl = doc().createElement("div");
    this.modalEl.classList.add("modal");
    this.modalEl.tabIndex = -1;
    this.titleEl = doc().createElement("div");
    this.titleEl.classList.add("modal-title");
    this.contentEl = doc().createElement("div");
    this.contentEl.classList.add("modal-content");
    this.closeButtonEl = doc().createElement("div");
    this.closeButtonEl.classList.add("modal-close-button");
    this.closeButtonEl.setAttribute("role", "button");
    this.closeButtonEl.setAttribute("tabindex", "0");
    this.closeButtonEl.setAttribute("aria-label", "关闭");
    this.closeButtonEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    this.closeButtonEl.addEventListener("click", () => this.close());
    this.closeButtonEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.close();
      }
    });
    this.modalEl.append(this.closeButtonEl, this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this._closeCallback = null;
    this._backdropHandler = (event) => {
      if (event.target === this.containerEl) this.close();
    };
  }

  setTitle(title) {
    this.titleEl.textContent = String(title ?? "");
    return this;
  }

  setContent(content) {
    this.contentEl.textContent = String(content ?? "");
    return this;
  }

  setCloseCallback(callback) {
    this._closeCallback = callback;
    return this;
  }

  onOpen() {}

  onClose() {}

  open() {
    if (this._open) return this;
    this._open = true;
    this._previousFocus = doc().activeElement;
    modalStack.push(this);
    doc().body.appendChild(this.containerEl);
    this.containerEl.classList.add("mod-open");
    this.containerEl.addEventListener("mousedown", this._backdropHandler);
    this.load();
    this.onOpen();
    this._escHandler = (event) => {
      if (modalStack[modalStack.length - 1] !== this) return;
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      this.close();
    };
    doc().addEventListener("keydown", this._escHandler);
    if (!this.contentEl.querySelector("input, textarea, select, button")) this.modalEl.focus({ preventScroll: true });
    return this;
  }

  close() {
    if (!this._open) return;
    this._open = false;
    if (this._escHandler) doc().removeEventListener("keydown", this._escHandler);
    this._escHandler = null;
    this.containerEl.removeEventListener("mousedown", this._backdropHandler);
    const index = modalStack.indexOf(this);
    if (index >= 0) modalStack.splice(index, 1);
    try {
      this.onClose();
    } finally {
      this.unload();
      this.containerEl.remove();
      const callback = this._closeCallback;
      this._closeCallback = null;
      if (typeof callback === "function") callback();
      const previous = this._previousFocus;
      this._previousFocus = null;
      if (previous && previous.isConnected && typeof previous.focus === "function") {
        try {
          previous.focus({ preventScroll: true });
        } catch {}
      }
    }
  }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = doc().createElement("div");
    this.containerEl.classList.add("vertical-tab-content");
  }

  display() {}

  hide() {}
}

class ValueComponent {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.disabled = false;
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    if (this.inputEl) this.inputEl.disabled = this.disabled;
    return this;
  }
}

export class TextComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl = containerEl.createEl("input", { type: "text" });
  }

  setValue(value) {
    this.inputEl.value = value == null ? "" : String(value);
    return this;
  }

  getValue() {
    return this.inputEl.value;
  }

  setPlaceholder(placeholder) {
    this.inputEl.placeholder = String(placeholder ?? "");
    return this;
  }

  onChange(callback) {
    return inputEvent(this, this.inputEl, callback);
  }
}

export class TextAreaComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl = containerEl.createEl("textarea");
  }

  setValue(value) {
    this.inputEl.value = value == null ? "" : String(value);
    return this;
  }

  getValue() {
    return this.inputEl.value;
  }

  setPlaceholder(placeholder) {
    this.inputEl.placeholder = String(placeholder ?? "");
    return this;
  }

  onChange(callback) {
    return inputEvent(this, this.inputEl, callback);
  }
}

export class ToggleComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl = containerEl.createEl("input", { type: "checkbox" });
    this.toggleEl = this.inputEl;
  }

  setValue(value) {
    this.inputEl.checked = Boolean(value);
    return this;
  }

  getValue() {
    return this.inputEl.checked;
  }

  onChange(callback) {
    this.inputEl.addEventListener("change", () => callback(this.inputEl.checked));
    return this;
  }
}

export class DropdownComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl = containerEl.createEl("select");
    this.selectEl = this.inputEl;
  }

  addOption(value, label) {
    const el = doc().createElement("option");
    el.value = String(value);
    el.textContent = String(label ?? value);
    this.inputEl.appendChild(el);
    return this;
  }

  addOptions(entries) {
    for (const [value, label] of Object.entries(entries || {})) this.addOption(value, label);
    return this;
  }

  setValue(value) {
    this.inputEl.value = String(value ?? "");
    return this;
  }

  getValue() {
    return this.inputEl.value;
  }

  onChange(callback) {
    this.inputEl.addEventListener("change", () => callback(this.inputEl.value));
    return this;
  }
}

export class SliderComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl = containerEl.createEl("input", { type: "range" });
    this.sliderEl = this.inputEl;
  }

  setLimits(min, max, step) {
    this.inputEl.min = String(min);
    this.inputEl.max = String(max);
    this.inputEl.step = String(step ?? 1);
    return this;
  }

  setValue(value) {
    this.inputEl.value = String(value);
    return this;
  }

  getValue() {
    return Number(this.inputEl.value);
  }

  setDynamicTooltip() {
    return this;
  }

  showTooltip() {
    return this;
  }

  onChange(callback) {
    this.inputEl.addEventListener("input", () => callback(Number(this.inputEl.value)));
    return this;
  }
}

export class ButtonComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.buttonEl = containerEl.createEl("button");
  }

  setButtonText(text) {
    this.buttonEl.textContent = String(text ?? "");
    return this;
  }

  setCta() {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }

  setWarning() {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }

  setIcon(icon) {
    setIcon(this.buttonEl, icon);
    return this;
  }

  setTooltip(tooltip) {
    this.buttonEl.setAttribute("aria-label", String(tooltip ?? ""));
    return this;
  }

  setDisabled(disabled) {
    this.buttonEl.disabled = Boolean(disabled);
    return this;
  }

  onClick(callback) {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

export class ExtraButtonComponent extends ValueComponent {
  constructor(containerEl) {
    super(containerEl);
    this.extraSettingsEl = containerEl.createEl("button", { cls: "extra-setting-button" });
  }

  setIcon(icon) {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }

  setTooltip(tooltip) {
    this.extraSettingsEl.setAttribute("aria-label", String(tooltip ?? ""));
    return this;
  }

  setDisabled(disabled) {
    this.extraSettingsEl.disabled = Boolean(disabled);
    return this;
  }

  onClick(callback) {
    this.extraSettingsEl.addEventListener("click", callback);
    return this;
  }
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl.createDiv("setting-item");
    this.settingEl = this.containerEl;
    this.infoEl = this.containerEl.createDiv("setting-item-info");
    this.nameEl = this.infoEl.createDiv("setting-item-name");
    this.descEl = this.infoEl.createDiv("setting-item-description");
    this.controlEl = this.containerEl.createDiv("setting-item-control");
    this.components = [];
  }

  setName(name) {
    this.nameEl.textContent = String(name ?? "");
    return this;
  }

  setDesc(description) {
    this.descEl.textContent = String(description ?? "");
    return this;
  }

  setHeading() {
    this.containerEl.classList.add("setting-item-heading");
    this.controlEl.remove();
    return this;
  }

  setClass(cls) {
    this.containerEl.addClass?.(cls);
    return this;
  }

  setTooltip(tooltip) {
    this.containerEl.setAttribute("aria-label", String(tooltip ?? ""));
    return this;
  }

  setDisabled(disabled) {
    for (const component of this.components) component.setDisabled?.(disabled);
    return this;
  }

  addComponent(callback) {
    const wrapper = this.controlEl.createDiv("setting-item-control-extra");
    const component = callback(wrapper);
    if (component) this.components.push(component);
    return this;
  }

  addText(callback) {
    const component = new TextComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addTextArea(callback) {
    const component = new TextAreaComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addToggle(callback) {
    const component = new ToggleComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addDropdown(callback) {
    const component = new DropdownComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addSlider(callback) {
    const component = new SliderComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addButton(callback) {
    const component = new ButtonComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  addExtraButton(callback) {
    const component = new ExtraButtonComponent(this.controlEl);
    this.components.push(component);
    callback?.(component);
    return this;
  }

  then(callback) {
    callback?.(this);
    return this;
  }
}

export class SecretComponent extends ValueComponent {
  constructor(app, containerEl) {
    super(containerEl);
    this.app = app;
    this.inputEl = containerEl.createEl("input", {
      type: "password",
      attr: { autocomplete: "off", placeholder: "粘贴 API 密钥" },
    });
    this._secretId = "";
    this._change = null;
    this._dirty = false;
    this.inputEl.addEventListener("input", () => {
      this._dirty = true;
    });
    this.inputEl.addEventListener("change", () => void this._commit());
    this.inputEl.addEventListener("blur", () => void this._commit());
  }

  async _commit() {
    const value = this.inputEl.value;
    if (!value) {
      // An empty field means "keep the stored secret" unless the user cleared
      // it themselves; blurring after a save must not delete the key.
      if (this._dirty && this._secretId) {
        await this.app?.secretStorage?.deleteSecret?.(this._secretId);
        this._secretId = "";
        this.inputEl.placeholder = "粘贴 API 密钥";
        this._change?.("");
      }
      this._dirty = false;
      return;
    }
    if (!this._secretId) {
      this._secretId = `qiaomu-secret-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    await this.app?.secretStorage?.setSecret?.(this._secretId, value);
    this.inputEl.value = "";
    this.inputEl.placeholder = "已保存密钥，输入可替换";
    this._dirty = false;
    this._change?.(this._secretId);
  }

  setValue(value) {
    this._secretId = value == null ? "" : String(value);
    if (this._secretId) this.inputEl.placeholder = "已保存密钥，输入可替换";
    return this;
  }

  getValue() {
    return this._secretId;
  }

  onChange(callback) {
    this._change = callback;
    return this;
  }
}

export class FuzzySuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.limit = 50;
    this.emptyStateText = "No results";
    this.inputEl = this.contentEl.createEl("input", { type: "text", cls: "prompt-input" });
    this.resultContainerEl = this.contentEl.createDiv("prompt-results");
    this.inputEl.addEventListener("input", () => this._render(this.inputEl.value));
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        const first = this.resultContainerEl.querySelector(".suggestion-item");
        if (first) this.selectSuggestion(first._value, event);
      }
    });
  }

  getItems() {
    return [];
  }

  getItemText(item) {
    return String(item ?? "");
  }

  onChooseItem() {}

  selectSuggestion(item, event) {
    this.onChooseItem(item, event);
    this.close();
  }

  _render(query) {
    if (!this.resultContainerEl) return;
    this.resultContainerEl.empty?.();
    const needle = String(query || "").toLowerCase();
    const matches = this.getItems()
      .filter((item) => this.getItemText(item).toLowerCase().includes(needle))
      .slice(0, this.limit);
    if (!matches.length) {
      const empty = this.resultContainerEl.createDiv("suggestion-empty");
      empty.textContent = this.emptyStateText;
      return;
    }
    for (const item of matches) {
      const el = this.resultContainerEl.createDiv("suggestion-item");
      el._value = item;
      this.renderSuggestion(item, el);
      el.addEventListener("click", (event) => this.selectSuggestion(item, event));
    }
  }

  renderSuggestion(item, el) {
    el.textContent = this.getItemText(item);
  }

  open() {
    super.open();
    this._render("");
    this.inputEl.focus();
    return this;
  }
}

export class AbstractInputSuggest {
  constructor(app, inputEl) {
    this.app = app;
    this.inputEl = inputEl;
    this.limit = 20;
    this._selectCallback = null;
    this._inputHandler = () => this._update();
    inputEl.addEventListener("input", this._inputHandler);
    inputEl.addEventListener("blur", () => setTimeout(() => this.close(), 150));
    this.containerEl = inputEl.parentElement?.createDiv("suggestion-container") || null;
  }

  getSuggestions() {
    return [];
  }

  renderSuggestion(value, el) {
    el.textContent = String(value ?? "");
  }

  selectSuggestion(value, event) {
    this.setValue(String(value ?? ""));
    this._selectCallback?.(value, event);
    this.close();
  }

  setValue(value) {
    this.inputEl.value = value;
    return this;
  }

  getValue() {
    return this.inputEl.value;
  }

  onSelect(callback) {
    this._selectCallback = callback;
    return this;
  }

  _update() {
    if (!this.containerEl) return;
    this.containerEl.empty?.();
    const values = this.getSuggestions(this.inputEl.value) || [];
    for (const value of values.slice(0, this.limit)) {
      const el = this.containerEl.createDiv("suggestion-item");
      this.renderSuggestion(value, el);
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.selectSuggestion(value, event);
      });
    }
    if (this.containerEl.classList) this.containerEl.classList.toggle("is-visible", values.length > 0);
  }

  close() {
    this.containerEl?.empty?.();
  }
}
