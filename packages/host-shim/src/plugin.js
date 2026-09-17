import { Component } from "./component.js";
import { Events } from "./events.js";
import { FileSystemAdapter, Vault } from "./files.js";
import { host } from "./host.js";
import { normalizePath } from "./paths.js";
import { SecretStorage } from "./services.js";
import { Workspace } from "./workspace.js";

function dataDir() {
  return host().dataRoot || host().vaultRoot || "";
}

function join(dir, name) {
  return normalizePath(dir ? `${dir}/${name}` : name);
}

function safeId(value) {
  return String(value || "chat").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
}

async function readText(file) {
  const fs = host().fs;
  if (!fs) return null;
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeText(file, text) {
  const fs = host().fs;
  const path = host().path;
  if (!fs || !path) throw new Error("host-shim: configureHost({ fs, path }) is required");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.promises.writeFile(temporary, text, "utf8");
  await fs.promises.rename(temporary, file);
}

async function readJson(file) {
  const raw = await readText(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFrontmatter(data) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(data);
  if (!match) return { frontmatter: {}, body: data, hasFrontmatter: false };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === "true";
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else value = value.replace(/^["']|["']$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body: data.slice(match[0].length), hasFrontmatter: true };
}

function serializeFrontmatter(frontmatter, body, hasFrontmatter) {
  const keys = Object.keys(frontmatter);
  if (!keys.length && !hasFrontmatter) return body;
  const lines = keys.map((key) => {
    const value = frontmatter[key];
    if (Array.isArray(value)) return `${key}:\n${value.map((item) => `  - ${item}`).join("\n")}`;
    if (typeof value === "string") return `${key}: ${/[:#]/.test(value) ? JSON.stringify(value) : value}`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest || { id: "qiaomu-reader", name: "UV Reader", version: "0.0.0", dir: "" };
    this._commands = [];
    if (app?.plugins?.plugins) app.plugins.plugins[this.manifest.id] = this;
  }

  async loadData() {
    return this.app._loadPluginData();
  }

  async saveData(data) {
    return this.app._savePluginData(data);
  }

  registerView(type, factory) {
    this.app.viewFactories.set(type, factory);
  }

  registerExtensions(extensions, viewType) {
    for (const extension of extensions) this.app.extensionViews.set(String(extension).toLowerCase(), viewType);
  }

  addRibbonIcon(icon, title, callback) {
    const ribbon = this.app.ribbonEl
      || (typeof document !== "undefined" ? document.createElement("div") : null);
    if (!ribbon) return null;
    const el = ribbon.createDiv?.("side-dock-ribbon-action") || null;
    if (el) {
      el.setAttribute("aria-label", title || "");
      el.setAttribute("data-icon", icon || "");
      if (typeof callback === "function") el.addEventListener("click", callback);
    }
    return el;
  }

  addCommand(command) {
    this.app.commands.push(command);
    return command;
  }

  addSettingTab(tab) {
    this.app.settingTabs.push(tab);
  }

  registerObsidianProtocolHandler(name, callback) {
    this.app.protocolHandlers.set(name, callback);
  }
}

export class App {
  constructor(runtime = {}) {
    this.isMobile = Boolean(runtime.isMobile ?? host().isMobile);
    this.ribbonEl = runtime.ribbonEl || null;
    this.workspaceEl = runtime.workspaceEl || null;
    this.vault = runtime.vault || new Vault(new FileSystemAdapter({ root: runtime.vaultRoot ?? host().vaultRoot }));
    this.workspace = new Workspace(this);
    this.secretStorage = new SecretStorage(runtime.secrets);
    this.commands = [];
    this.settingTabs = [];
    this.viewFactories = new Map();
    this.extensionViews = new Map();
    this.protocolHandlers = new Map();
    this.plugins = { plugins: {} };
    this._dataDefaults = runtime.dataDefaults || {};
    this._data = null;
    this.keymap = {
      scopes: [],
      pushScope(scope) {
        this.scopes.push(scope);
        return scope;
      },
      popScope(scope) {
        this.scopes = this.scopes.filter((item) => item !== scope);
      },
    };
    this.metadataCache = new Events();
    this.metadataCache.getFileCache = (file) => this._fileCache(file);
    this.metadataCache.getFirstLinkpathDest = (name) => this._linkDest(name);
    this.metadataCache.getTags = () => ({});
    this.fileManager = {
      processFrontMatter: async (file, fn) => {
        const data = await this.vault.read(file);
        const parsed = parseFrontmatter(data);
        const result = fn(parsed.frontmatter) ?? parsed.frontmatter;
        await this.vault.modify(file, serializeFrontmatter(result, parsed.body, parsed.hasFrontmatter));
      },
      generateMarkdownLink: (file, sourcePath, subpath, alias) => {
        const path = file?.path || String(file || "");
        const label = alias || file?.basename || path;
        return `[[${path}${label === path ? "" : `|${label}`}]]`;
      },
      trashFile: async (file) => {
        await this.vault.delete(file);
      },
    };
    this.setting = {
      open() {},
      openTabById() {},
    };
  }

  _fileCache(file) {
    const cached = this._cache || (this._cache = new Map());
    return cached.get(file?.path) || null;
  }

  _linkDest(name) {
    const target = normalizePath(name);
    const direct = this.vault.getAbstractFileByPath(target);
    if (direct) return direct;
    const basename = target.split("/").pop() || target;
    return this.vault.getFiles().find((file) => file.basename === basename || file.name === basename) || null;
  }

  async _loadPluginData() {
    const dir = dataDir();
    let value = await readJson(join(dir, "data.json"));
    if (!value || typeof value !== "object") value = {};
    if (!value.settings || typeof value.settings !== "object") value = { ...value, settings: {} };
    const settings = value.settings;
    for (const [key, fallback] of Object.entries(this._dataDefaults)) {
      if (settings[key] === undefined) settings[key] = fallback;
    }
    if (!Array.isArray(settings.aiChatHistory)) {
      const index = await readJson(join(dir, "chat/index.json"));
      if (Array.isArray(index)) {
        const items = [];
        for (const entry of index) {
          if (!entry?.id) continue;
          const item = await readJson(join(dir, `chat/${safeId(entry.id)}.json`));
          if (item) items.push(item);
        }
        settings.aiChatHistory = items;
      }
    }
    this._data = value;
    return value;
  }

  async _savePluginData(data) {
    const dir = dataDir();
    const value = data && typeof data === "object" ? { ...data } : {};
    const flat = !value.settings || typeof value.settings !== "object";
    const settings = flat ? { ...value } : { ...value.settings };
    const history = Array.isArray(settings.aiChatHistory) ? settings.aiChatHistory : [];
    delete settings.aiChatHistory;
    const settingsPayload = flat ? settings : { ...value, settings };
    await writeText(join(dir, "data.json"), JSON.stringify(settingsPayload, null, 2));
    const index = history.map((item) => ({
      id: item?.id || "",
      title: item?.title || "",
      book: item?.book || "",
      createdAt: item?.createdAt || 0,
      updatedAt: item?.updatedAt || 0,
    }));
    await writeText(join(dir, "chat/index.json"), JSON.stringify(index, null, 2));
    for (const item of history) {
      if (!item?.id) continue;
      await writeText(join(dir, `chat/${safeId(item.id)}.json`), JSON.stringify(item, null, 2));
    }
    this._data = data;
  }
}

export function createApp(runtime = {}) {
  return new App(runtime);
}
