import { Events } from "./events.js";
import { host } from "./host.js";
import { basenameOf, extensionOf, isAbsolutePath, normalizePath } from "./paths.js";

export class TAbstractFile {
  constructor(path) {
    const normalized = normalizePath(path);
    this.path = normalized;
    this.name = normalized.split("/").pop() || "";
    this.parent = null;
    this.vault = null;
  }
}

export class TFile extends TAbstractFile {
  constructor(path) {
    super(path);
    this.basename = basenameOf(path);
    this.extension = extensionOf(path);
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}

export class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
  }

  isRoot() {
    return this.path === "" || this.path === "/";
  }
}

function requireFs() {
  const fs = host().fs;
  if (!fs) throw new Error("host-shim: configureHost({ fs, path }) is required");
  return fs;
}

function requirePath() {
  const path = host().path;
  if (!path) throw new Error("host-shim: configureHost({ fs, path }) is required");
  return path;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export class FileSystemAdapter {
  constructor(options = {}) {
    this.root = normalizePath(options.root ?? host().vaultRoot ?? "");
  }

  getBasePath() {
    return this.root;
  }

  resolve(file) {
    const path = normalizePath(file);
    if (!path || isAbsolutePath(path)) return path;
    if (!this.root) return path;
    return normalizePath(`${this.root}/${path}`);
  }

  getFullPath(file) {
    return this.resolve(file);
  }

  async read(file) {
    return requireFs().promises.readFile(this.resolve(file), "utf8");
  }

  async readBinary(file) {
    return toArrayBuffer(await requireFs().promises.readFile(this.resolve(file)));
  }

  async write(file, data) {
    const target = this.resolve(file);
    await requireFs().promises.mkdir(requirePath().dirname(target), { recursive: true });
    await requireFs().promises.writeFile(target, data, "utf8");
  }

  async writeBinary(file, data) {
    const target = this.resolve(file);
    await requireFs().promises.mkdir(requirePath().dirname(target), { recursive: true });
    await requireFs().promises.writeFile(target, Buffer.from(data));
  }

  async exists(file) {
    try {
      await requireFs().promises.access(this.resolve(file));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dir) {
    await requireFs().promises.mkdir(this.resolve(dir), { recursive: true });
  }

  async remove(file) {
    await requireFs().promises.rm(this.resolve(file), { recursive: true, force: true });
  }

  async rename(file, next) {
    const target = this.resolve(next);
    await requireFs().promises.mkdir(requirePath().dirname(target), { recursive: true });
    await requireFs().promises.rename(this.resolve(file), target);
  }

  async stat(file) {
    return requireFs().promises.stat(this.resolve(file));
  }

  async list(dir = "") {
    const entries = await requireFs().promises.readdir(this.resolve(dir), { withFileTypes: true });
    return entries.map((entry) => entry.name);
  }

  async process(file, fn, options = {}) {
    const target = this.resolve(file);
    let current = options.initial ?? "";
    try {
      current = await requireFs().promises.readFile(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = await fn(current);
    if (next === undefined) return current;
    await this.write(file, next);
    return next;
  }
}

export class Vault extends Events {
  constructor(adapter) {
    super();
    this.adapter = adapter;
    this._files = new Map();
  }

  getName() {
    return host().vaultName || "Qiaomu Library";
  }

  getRoot() {
    return this._folder("/");
  }

  _file(path) {
    const key = normalizePath(path);
    let file = this._files.get(key);
    if (!file) {
      file = new TFile(key);
      file.vault = this;
      this._files.set(key, file);
    }
    return file;
  }

  _folder(path) {
    const folder = new TFolder(path);
    folder.vault = this;
    return folder;
  }

  getAbstractFileByPath(path) {
    const key = normalizePath(path);
    if (!key) return null;
    try {
      const stat = requireFs().statSync(this.adapter.resolve(key));
      return stat.isDirectory() ? this._folder(key) : this._file(key);
    } catch {
      return null;
    }
  }

  getFileByPath(path) {
    const file = this.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  getFolderByPath(path) {
    const folder = this.getAbstractFileByPath(path);
    return folder instanceof TFolder ? folder : null;
  }

  async read(file) {
    return this.adapter.read(file.path ?? file);
  }

  async cachedRead(file) {
    return this.read(file);
  }

  async readBinary(file) {
    return this.adapter.readBinary(file.path ?? file);
  }

  async modify(file, data) {
    await this.adapter.write(file.path ?? file, data);
  }

  async create(path, data) {
    const key = normalizePath(path);
    await this.adapter.write(key, data);
    return this._file(key);
  }

  async createBinary(path, data) {
    const key = normalizePath(path);
    await this.adapter.writeBinary(key, data);
    return this._file(key);
  }

  async createFolder(path) {
    const key = normalizePath(path);
    await this.adapter.mkdir(key);
    return this._folder(key);
  }

  async process(file, fn) {
    return this.adapter.process(file.path ?? file, fn);
  }

  async delete(file) {
    const key = file.path ?? file;
    await this.adapter.remove(key);
    this._files.delete(normalizePath(key));
  }

  async rename(file, nextPath) {
    const oldPath = file.path ?? file;
    const key = normalizePath(nextPath);
    await this.adapter.rename(oldPath, key);
    this._files.delete(normalizePath(oldPath));
    if (file && typeof file === "object") file.path = key;
    this.trigger("rename", file, oldPath);
    return file;
  }

  getFiles() {
    const root = this.adapter.root;
    if (!root) return [];
    const fs = requireFs();
    const path = requirePath();
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = normalizePath(`${dir}/${entry.name}`);
        if (entry.isDirectory()) walk(full, depth + 1);
        else {
          const relative = normalizePath(path.relative(root, full));
          if (relative.startsWith("..")) continue;
          const file = this._file(relative);
          try {
            const stat = fs.statSync(full);
            file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
          } catch {}
          out.push(file);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  getMarkdownFiles() {
    return this.getFiles().filter((file) => file.extension === "md");
  }

  getAllLoadedFiles() {
    return [...this._files.values()];
  }

  getResourcePath(file) {
    const absolute = this.adapter.resolve(file.path ?? file);
    const encoded = encodeURI(absolute).replace(/#/g, "%23");
    return /^[a-zA-Z]:\//.test(absolute) ? `file:///${encoded}` : `file://${encoded}`;
  }
}
