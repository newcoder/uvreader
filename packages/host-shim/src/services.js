import { host } from "./host.js";

export const Platform = Object.freeze({
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
});

function fetchImpl() {
  const impl = host().fetchImpl || globalThis.fetch;
  if (!impl) throw new Error("host-shim: no fetch implementation available");
  return impl;
}

export async function requestUrl(request = {}) {
  const { url, method = "GET", headers = {}, body, throw: throwOnError = false, signal } = request;
  if (!url) throw new Error("host-shim: requestUrl requires a url");
  const response = await fetchImpl()(url, { method, headers, body, signal });
  const text = await response.text();
  let arrayBuffer = null;
  try {
    arrayBuffer = await response.clone().arrayBuffer();
  } catch {
    arrayBuffer = null;
  }
  const result = {
    status: response.status,
    headers: Object.fromEntries(response.headers?.entries?.() || []),
    text,
    arrayBuffer,
    json: null,
  };
  try {
    result.json = text ? JSON.parse(text) : null;
  } catch {
    result.json = null;
  }
  if (throwOnError && (response.status < 200 || response.status >= 300)) {
    const error = new Error(`Request failed, status ${response.status}`);
    error.status = response.status;
    error.response = result;
    throw error;
  }
  return result;
}

export function setIcon(el, name) {
  if (!el) return el;
  const resolver = host().iconResolver;
  el.innerHTML = "";
  if (typeof resolver === "function") {
    const svg = resolver(name);
    if (svg) el.innerHTML = svg;
  }
  el.setAttribute?.("data-icon", name || "");
  return el;
}

export const MarkdownRenderer = {
  async render(app, markdown, el, sourcePath, component) {
    if (!el) return;
    const render = host().renderMarkdown;
    if (typeof render === "function") {
      await render(String(markdown || ""), el, { app, sourcePath, component });
      return;
    }
    el.textContent = String(markdown || "");
  },
  async renderMarkdown(markdown, el, sourcePath, component) {
    return this.render(null, markdown, el, sourcePath, component);
  },
};

export class SecretStorage {
  constructor(backend = null) {
    this._backend = backend || host().secrets || null;
    this._memory = new Map();
  }

  // Obsidian's SecretStorage API is synchronous; the plugin reads keys during
  // request building, so an async backend must be bridged with sendSync and a
  // local cache.
  getSecret(id) {
    if (!id) return null;
    if (this._backend?.getSecretSync) {
      try {
        const value = this._backend.getSecretSync(id);
        if (value != null) {
          this._memory.set(id, value);
          return value;
        }
      } catch {
        /* fall through to the cache */
      }
    }
    return this._memory.get(id) ?? null;
  }

  async setSecret(id, value) {
    this._memory.set(id, value);
    return this._backend?.setSecret?.(id, value);
  }

  async deleteSecret(id) {
    this._memory.delete(id);
    return this._backend?.deleteSecret?.(id);
  }

  async listSecrets() {
    if (this._backend?.listSecrets) return this._backend.listSecrets();
    return [...this._memory.keys()];
  }
}
