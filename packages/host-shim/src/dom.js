const PROPERTY_KEYS = ["type", "value", "placeholder", "href", "src", "alt", "id", "name", "for", "title"];

function applyOptions(el, options) {
  if (options == null) return;
  if (typeof options === "string") {
    el.className = options;
    return;
  }
  if (typeof options !== "object") return;
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(" ") : String(options.cls);
  if (options.text != null) el.textContent = String(options.text);
  if (options.html != null) el.innerHTML = String(options.html);
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) {
      if (value == null) el.removeAttribute(key);
      else el.setAttribute(key, String(value));
    }
  }
  for (const key of PROPERTY_KEYS) {
    if (options[key] != null && key in el) el[key] = options[key];
  }
  if (options.checked != null && "checked" in el) el.checked = Boolean(options.checked);
  if (options.disabled != null && "disabled" in el) el.disabled = Boolean(options.disabled);
  if (options.parent) options.parent.appendChild(el);
}

function classList(value) {
  return String(value || "").split(/\s+/).filter(Boolean);
}

// Obsidian installs a small DOM helper layer on Element.prototype. The reader
// uses it in hundreds of places, so the shim must provide the same surface.
export function installDomExtensions(win = globalThis.window) {
  const proto = win?.Element?.prototype;
  if (!proto || proto.createEl) return win;
  const define = (name, value) => Object.defineProperty(proto, name, { value, writable: true, configurable: true });

  define("createEl", function createEl(tag, options, callback) {
    const el = this.ownerDocument.createElement(tag);
    applyOptions(el, options);
    this.appendChild(el);
    if (typeof callback === "function") callback(el);
    return el;
  });
  define("createDiv", function createDiv(options, callback) {
    return this.createEl("div", options, callback);
  });
  define("createSpan", function createSpan(options, callback) {
    return this.createEl("span", options, callback);
  });
  define("setText", function setText(value) {
    this.textContent = value == null ? "" : String(value);
  });
  define("getText", function getText() {
    return this.textContent || "";
  });
  define("appendText", function appendText(value) {
    this.appendChild(this.ownerDocument.createTextNode(String(value)));
  });
  define("empty", function empty() {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define("detach", function detach() {
    this.remove();
  });
  define("addClass", function addClass(...values) {
    for (const value of values) this.classList.add(...classList(value));
  });
  define("removeClass", function removeClass(...values) {
    for (const value of values) this.classList.remove(...classList(value));
  });
  define("toggleClass", function toggleClass(value, on) {
    const names = classList(value);
    for (const name of names) {
      if (on === undefined) this.classList.toggle(name);
      else this.classList.toggle(name, Boolean(on));
    }
  });
  define("hasClass", function hasClass(value) {
    return this.classList.contains(value);
  });
  define("setAttr", function setAttr(name, value) {
    if (value == null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  });
  define("setAttrs", function setAttrs(values) {
    for (const [key, value] of Object.entries(values || {})) this.setAttr(key, value);
  });
  define("setCssProps", function setCssProps(values) {
    for (const [key, value] of Object.entries(values || {})) this.style.setProperty(key, String(value));
  });
  define("setCssStyles", function setCssStyles(values) {
    Object.assign(this.style, values || {});
  });
  define("find", function find(selector) {
    return this.querySelector(selector);
  });
  define("findAll", function findAll(selector) {
    return [...this.querySelectorAll(selector)];
  });
  define("show", function show() {
    this.style.display = "";
  });
  define("hide", function hide() {
    this.style.display = "none";
  });
  define("isShown", function isShown() {
    return Boolean(this.offsetWidth || this.offsetHeight || this.getClientRects?.().length);
  });
  return win;
}
