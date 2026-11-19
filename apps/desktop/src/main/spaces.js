// 悦空间：自包含的阅读/研究/学习/工作空间。
//
// 每个自定义空间绑定一个目录，源文件复制到 <root>/books，元数据和索引放在
// <root>/.uvreader。这里的服务只做文件与元数据，不依赖 Electron，方便测试。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BOOK_EXTENSIONS, EXTERNAL_DOC_EXTENSIONS } from "../shared/books.js";

export const SPACE_SCHEMA = 1;

export const SPACE_TYPES = Object.freeze({
  reading: { label: "阅读", color: "#3f7be8" },
  research: { label: "研究", color: "#7c5cff" },
  learning: { label: "学习", color: "#229b6c" },
  work: { label: "工作", color: "#dd8a2f" },
  other: { label: "其他", color: "#8a8175" },
});

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

function cleanText(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

function safeFolderName(value) {
  let name = String(value || "").replace(/[\\/:*?"<>|]/g, " ");
  name = Array.from(name, (char) => (char.codePointAt(0) <= 31 ? " " : char)).join("");
  name = name.replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!name || WINDOWS_RESERVED.test(name)) name = name ? `${name} (space)` : "未命名空间";
  return name.slice(0, 60).trim() || "未命名空间";
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function normalizeSpaces(value) {
  const list = Array.isArray(value?.spaces) ? value.spaces : [];
  return {
    schemaVersion: SPACE_SCHEMA,
    spaces: list.filter((item) => item && typeof item === "object" && item.id && item.root).map((item) => ({
      id: String(item.id),
      name: cleanText(item.name, "未命名空间"),
      type: SPACE_TYPES[item.type] ? item.type : "other",
      color: COLOR.test(String(item.color || "")) ? item.color : SPACE_TYPES[item.type]?.color || SPACE_TYPES.other.color,
      root: path.resolve(String(item.root)),
      createdAt: String(item.createdAt || ""),
      updatedAt: String(item.updatedAt || ""),
    })),
  };
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sourceId() {
  return `src-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

const OUTPUT_ORDER = { exports: 0, translations: 1, quizzes: 2, polish: 3, extracts: 4, notes: 5, other: 6 };
const OUTPUT_DOC_EXTENSIONS = new Set(["epub", "pdf", "docx", "html", "htm", "md", "markdown", "txt", "azw3", "mobi", "cbz", "json"]);
const OUTPUT_SKIP_NAMES = /^(?:polish\.(?:json|session\.json|report\.json|baseline\.md))$/i;
const SOURCE_ADD_EXTENSIONS = new Set([...BOOK_EXTENSIONS, ...EXTERNAL_DOC_EXTENSIONS]);

function outputAllowed(category, name) {
  const ext = path.extname(name).toLowerCase().slice(1);
  if (!ext || OUTPUT_SKIP_NAMES.test(name)) return "";
  if (category === "polish") return ext === "epub" || ext === "md" ? ext : "";
  if (category === "quizzes") {
    if (!["html", "htm", "json", "md"].includes(ext)) return "";
    return /audit\.json$/i.test(name) ? "" : ext;
  }
  if (category === "extracts") {
    if (!["md", "markdown", "html", "htm", "json", "txt"].includes(ext)) return "";
    return /audit\.json$/i.test(name) ? "" : ext;
  }
  if (category === "notes") return ["md", "markdown", "html", "htm", "txt"].includes(ext) ? ext : "";
  if (category === "exports" || category === "translations") {
    return ["epub", "pdf", "docx", "html", "htm", "md", "markdown", "txt", "azw3", "mobi", "cbz"].includes(ext) ? ext : "";
  }
  return OUTPUT_DOC_EXTENSIONS.has(ext) ? ext : "";
}

function sourceBases(source) {
  const values = [source?.name, source?.originalName, source?.relativePath]
    .map((value) => String(value || ""))
    .filter(Boolean);
  return [...new Set(values.map((value) => path.basename(value, path.extname(value))).filter(Boolean))];
}

function matchSource(name, sources) {
  const base = path.basename(name, path.extname(name));
  let best = null;
  for (const source of sources) {
    for (const candidate of sourceBases(source)) {
      if (base !== candidate && !base.startsWith(`${candidate}.`) && !base.startsWith(`${candidate}-`)
        && !base.startsWith(`${candidate} `) && !base.startsWith(`${candidate}（`) && !base.startsWith(`${candidate}(`)) {
        continue;
      }
      if (!best || candidate.length > best.base.length) best = { source, base: candidate };
    }
  }
  return best?.source?.id || "";
}

function listOutputs(root, sources = []) {
  const sourcePaths = new Set(sources.map((source) => String(source.relativePath || "").replace(/\\/g, "/")).filter(Boolean));
  const outputs = [];
  const visit = (dir, relativeDir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = String(entry.name || "");
      if (!name || name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (name.endsWith(".assets") || /^backup-/i.test(name)) continue;
        if (!relativeDir && name === "reading") continue;
        visit(path.join(dir, name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || sourcePaths.has(relativePath)) continue;
      const top = relativePath.includes("/") ? relativePath.split("/")[0] : "";
      const category = top === "books"
        ? (/\.(?:AI|普通)答题页\.html?$/i.test(name) ? "quizzes" : "extracts")
        : (OUTPUT_ORDER[top] != null && top !== "other" ? top : "other");
      const ext = outputAllowed(category, name);
      if (!ext) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, name)); } catch { continue; }
      outputs.push({
        name,
        relativePath,
        path: path.join(dir, name),
        category,
        ext,
        size: stat.size,
        mtime: stat.mtimeMs,
        sourceId: matchSource(name, sources),
      });
    }
  };
  visit(root, "", 0);
  outputs.sort((a, b) => (OUTPUT_ORDER[a.category] ?? 9) - (OUTPUT_ORDER[b.category] ?? 9) || b.mtime - a.mtime);
  return outputs;
}

function spaceId() {
  return `sp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function uniqueTargetName(dir, name, hash) {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || "文件";
  let candidate = path.join(dir, `${base}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  candidate = path.join(dir, `${base} [${hash.slice(0, 8)}]${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} [${hash.slice(0, 8)}-${index}]${ext}`);
    index += 1;
  }
  return candidate;
}

export function createSpaceService({ libraryRoot, registryPath, userData = "" } = {}) {
  if (!libraryRoot) throw new Error("空间服务缺少书库目录");
  const library = path.resolve(libraryRoot);
  const registry = path.resolve(registryPath || path.join(userData || library, "spaces.json"));
  const spacesRoot = path.join(library, "Spaces");

  function readRegistry() {
    return normalizeSpaces(readJson(registry, { schemaVersion: SPACE_SCHEMA, spaces: [] }));
  }

  function writeRegistry(value) {
    writeJson(registry, normalizeSpaces(value));
  }

  function indexFile(root) {
    return path.join(root, ".uvreader", "index.json");
  }

  function metaFile(root) {
    return path.join(root, ".uvreader", "space.json");
  }

  function readIndex(root) {
    const value = readJson(indexFile(root), { schemaVersion: SPACE_SCHEMA, sources: [] });
    return {
      schemaVersion: SPACE_SCHEMA,
      sources: Array.isArray(value?.sources) ? value.sources.filter((item) => item && item.id && item.relativePath) : [],
    };
  }

  function writeIndex(root, value) {
    writeJson(indexFile(root), value);
  }

  function relativePathOf(root, file) {
    return path.relative(root, file).split(path.sep).join("/");
  }

  function isDerivedBookName(name) {
    return /\.(?:AI|普通)答题页\.html?$/i.test(name)
      || /\.audit\.json$/i.test(name)
      || /^polish\./i.test(name);
  }

  function listBookFiles(root) {
    const booksDir = path.join(root, "books");
    const files = [];
    const visit = (dir, depth) => {
      if (depth > 8) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const name = String(entry.name || "");
        if (!name || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (entry.isDirectory()) {
          if (name.endsWith(".assets") || /^backup-/i.test(name)) continue;
          visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        files.push({
          abs: path.resolve(full),
          relativePath: relativePathOf(root, full),
          name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    };
    visit(booksDir, 0);
    return files;
  }

  function sourceTitle(name) {
    return path.basename(String(name || ""), path.extname(String(name || "")));
  }

  function addableSource(file) {
    if (isDerivedBookName(file.name)) return false;
    const ext = path.extname(file.name).toLowerCase().slice(1);
    return SOURCE_ADD_EXTENSIONS.has(ext);
  }

  // The source index is a cache; the books directory is the source of truth.
  // Reconcile it on space open: rename by content hash, remove deleted files,
  // add newly copied books/documents, and refresh size/title when a file is
  // replaced in place.
  async function syncSources(root) {
    const index = readIndex(root);
    const before = JSON.stringify(index.sources);
    const files = listBookFiles(root);
    const byPath = new Map(files.map((file) => [file.relativePath.toLowerCase(), file]));
    const claimed = new Set();
    const next = [];
    const missing = [];
    const errors = [];
    let added = 0;
    let renamed = 0;
    let removed = 0;

    for (const source of index.sources) {
      const relative = String(source.relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const file = byPath.get(relative.toLowerCase());
      if (file) {
        claimed.add(file.abs);
        const updated = {
          ...source,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
        };
        if (source.size !== file.size) {
          try {
            updated.sha256 = await hashFile(file.abs);
          } catch (error) {
            errors.push(`${file.relativePath}: ${String(error?.message || error)}`);
          }
        }
        if (source.name !== file.name || source.relativePath !== file.relativePath) {
          updated.title = sourceTitle(file.name);
        }
        next.push(updated);
        continue;
      }
      // A source can live outside books when a user points a space at a custom
      // layout; keep it if it still exists there.
      const outside = path.resolve(root, relative);
      try {
        const stat = fs.statSync(outside);
        if (stat.isFile()) {
          next.push({ ...source, size: stat.size });
          continue;
        }
      } catch { /* missing below */ }
      missing.push(source);
    }

    const candidates = files.filter((file) => !claimed.has(file.abs));
    const hashCache = new Map();
    const hashOf = async (file) => {
      if (!hashCache.has(file.abs)) hashCache.set(file.abs, await hashFile(file.abs));
      return hashCache.get(file.abs);
    };
    let transientHashError = false;

    for (const source of missing) {
      let match = null;
      if (source.sha256) {
        for (const file of candidates) {
          if (claimed.has(file.abs)) continue;
          let hash = "";
          try {
            hash = await hashOf(file);
          } catch (error) {
            transientHashError = true;
            errors.push(`${file.relativePath}: ${String(error?.message || error)}`);
            continue;
          }
          if (hash === source.sha256) {
            match = { file, hash };
            break;
          }
        }
      }
      if (match) {
        claimed.add(match.file.abs);
        next.push({
          ...source,
          name: match.file.name,
          relativePath: match.file.relativePath,
          size: match.file.size,
          sha256: match.hash,
          title: sourceTitle(match.file.name),
        });
        renamed += 1;
      } else if (!transientHashError) {
        removed += 1;
      } else {
        // A locked file must not make us drop a source entry.
        next.push(source);
      }
    }

    if (!transientHashError) {
      for (const file of candidates) {
        if (claimed.has(file.abs) || !addableSource(file)) continue;
        try {
          const hash = await hashOf(file);
          claimed.add(file.abs);
          next.push({
            id: sourceId(),
            name: file.name,
            originalName: file.name,
            relativePath: file.relativePath,
            size: file.size,
            sha256: hash,
            addedAt: new Date().toISOString(),
            title: sourceTitle(file.name),
          });
          added += 1;
        } catch (error) {
          errors.push(`${file.relativePath}: ${String(error?.message || error)}`);
        }
      }
    }

    const changed = JSON.stringify(next) !== before;
    if (changed) writeIndex(root, { ...index, sources: next });
    return { changed, added, renamed, removed, count: next.length, errors };
  }

  async function sync(id = "") {
    const wanted = String(id || "");
    const records = wanted ? [recordFor(wanted)] : readRegistry().spaces;
    const results = [];
    for (const record of records) {
      if (!fs.existsSync(record.root)) {
        results.push({ id: record.id, ok: false, error: "空间目录不存在" });
        continue;
      }
      try {
        const result = await syncSources(record.root);
        results.push({ id: record.id, ok: true, ...result });
      } catch (error) {
        results.push({ id: record.id, ok: false, error: String(error?.message || error) });
      }
    }
    return results;
  }

  function sourceView(source) {
    const root = source.root || "";
    return {
      ...source,
      path: root ? path.join(root, source.relativePath) : source.relativePath,
    };
  }

  function recordFor(id) {
    const found = readRegistry().spaces.find((item) => item.id === id);
    if (!found) throw new Error("找不到这个空间");
    return found;
  }

  function list() {
    const data = readRegistry();
    return data.spaces.map((record) => {
      const exists = fs.existsSync(record.root);
      const meta = exists ? readJson(metaFile(record.root), {}) : {};
      const sources = exists ? readIndex(record.root).sources : [];
      return {
        ...record,
        ...(meta && typeof meta === "object" ? { name: cleanText(meta.name, record.name), type: SPACE_TYPES[meta.type] ? meta.type : record.type, color: COLOR.test(String(meta.color || "")) ? meta.color : record.color } : {}),
        exists,
        books: sources.map((source) => sourceView({ ...source, root: record.root })),
        outputs: exists ? listOutputs(record.root, sources) : [],
        bookCount: sources.length,
      };
    });
  }

  function get(id) {
    return list().find((item) => item.id === id) || null;
  }

  function create({ name, type = "reading", color = "", root = "" } = {}) {
    const title = cleanText(name, "未命名空间");
    const kind = SPACE_TYPES[type] ? type : "reading";
    const id = spaceId();
    const wantedRoot = root ? path.resolve(String(root)) : path.join(spacesRoot, safeFolderName(title));
    if (!inside(library, wantedRoot)) throw new Error("空间目录需要位于书库目录内");
    if (fs.existsSync(wantedRoot) && fs.readdirSync(wantedRoot).length) {
      throw new Error("这个目录已经存在且不为空，请换一个名称或目录");
    }
    const now = new Date().toISOString();
    const chosenColor = COLOR.test(String(color || "")) ? String(color) : SPACE_TYPES[kind].color;
    fs.mkdirSync(path.join(wantedRoot, "books"), { recursive: true });
    fs.mkdirSync(path.join(wantedRoot, ".uvreader"), { recursive: true });
    const meta = {
      schemaVersion: SPACE_SCHEMA,
      id,
      name: title,
      type: kind,
      color: chosenColor,
      createdAt: now,
      updatedAt: now,
    };
    writeJson(metaFile(wantedRoot), meta);
    if (!fs.existsSync(indexFile(wantedRoot))) writeIndex(wantedRoot, { schemaVersion: SPACE_SCHEMA, sources: [] });
    const data = readRegistry();
    data.spaces.push({ id, name: title, type: kind, color: chosenColor, root: wantedRoot, createdAt: now, updatedAt: now });
    writeRegistry(data);
    return { ...get(id) };
  }

  async function importFiles(id, filePaths = []) {
    const record = recordFor(id);
    if (!fs.existsSync(record.root)) throw new Error("空间目录不存在");
    const index = readIndex(record.root);
    const booksDir = path.join(record.root, "books");
    fs.mkdirSync(booksDir, { recursive: true });
    const imported = [];
    const duplicates = [];
    const failed = [];
    for (const raw of Array.isArray(filePaths) ? filePaths : []) {
      const file = path.resolve(String(raw || ""));
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error("不是文件");
        const hash = await hashFile(file);
        const existing = index.sources.find((source) => source.sha256 === hash);
        if (existing) {
          duplicates.push({ ...sourceView({ ...existing, root: record.root }), input: file });
          continue;
        }
        const target = uniqueTargetName(booksDir, path.basename(file), hash);
        await fs.promises.copyFile(file, target, fs.constants.COPYFILE_EXCL);
        const copiedHash = await hashFile(target);
        if (copiedHash !== hash) {
          await fs.promises.rm(target, { force: true });
          throw new Error("复制校验失败，已清理不完整文件");
        }
        const source = {
          id: sourceId(),
          name: path.basename(target),
          originalName: path.basename(file),
          relativePath: `books/${path.basename(target)}`,
          size: stat.size,
          sha256: hash,
          addedAt: new Date().toISOString(),
          title: path.basename(file).replace(/\.[^.]+$/, ""),
        };
        index.sources.push(source);
        imported.push(sourceView({ ...source, root: record.root }));
      } catch (error) {
        failed.push({ file: String(raw || ""), error: String(error?.message || error) });
      }
    }
    writeIndex(record.root, index);
    const data = readRegistry();
    const stored = data.spaces.find((item) => item.id === id);
    if (stored) {
      stored.updatedAt = new Date().toISOString();
      writeRegistry(data);
    }
    return { imported, duplicates, failed };
  }

  async function deleteOutput(id, relativePath, { remove = (file) => fs.promises.unlink(file) } = {}) {
    const record = recordFor(id);
    const root = path.resolve(record.root);
    const relative = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relative || relative.split("/").includes("..")) throw new Error("衍生文件路径无效");
    const target = path.resolve(root, relative);
    const insideRoot = path.relative(root, target);
    if (!insideRoot || insideRoot.startsWith("..") || path.isAbsolute(insideRoot)) throw new Error("衍生文件不在空间目录内");
    if (insideRoot.split(path.sep)[0] === ".uvreader") throw new Error("不能删除空间的内部数据");
    const sources = readIndex(root).sources;
    if (sources.some((source) => path.resolve(root, source.relativePath) === target)) {
      throw new Error("不能删除空间里的源文件");
    }
    let stat;
    try { stat = fs.statSync(target); } catch { throw new Error("找不到这个衍生文件"); }
    if (!stat.isFile()) throw new Error("只能删除衍生文件");
    await remove(target);
    return { ok: true, relativePath: relative };
  }

  return {
    registry,
    spacesRoot,
    list,
    get,
    create,
    sync,
    importFiles,
    deleteOutput,
  };
}
