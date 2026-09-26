// Per-book reading data folders. Reading traces used to live in three global
// files (reading-progress.json, reading-highlights.json, reading-pins.json),
// keyed by book path: every write rewrote every book, sync conflicts covered
// the whole library, and a book could not travel with its own annotations.
//
// The store keeps one folder per book under the reading root:
//
//   <root>/index.json               light summary of every book (rebuildable)
//   <root>/<book title>/book.json   identity: source path, title, note link
//   <root>/<book title>/progress.json
//   <root>/<book title>/highlights.json
//   <root>/<book title>/pins.json
//
// Writes go through the same verified-write helpers as the legacy stores, so a
// damaged file still blocks its own book instead of the whole library.
import { cloneJson, createSerialTaskQueue, readJsonRecordStore, writeVerifiedJsonRecord } from "./storage.js";

export const READING_STORE_SCHEMA = 1;
export const READING_STORE_FILES = Object.freeze([
  "progress", "highlights", "pins", "drafts", "marks",
]);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeReadingFolder(title) {
  let value = String(title || "").replace(/[\\/:*?"<>|]/g, " ");
  // Control characters never belong in a folder name.
  value = Array.from(value, (char) => (char.codePointAt(0) <= 31 ? " " : char)).join("");
  value = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!value || WINDOWS_RESERVED.test(value)) value = value ? `${value} (book)` : "未命名书籍";
  return value.slice(0, 60).trim() || "未命名书籍";
}

export function readingProjectPath(root, project) {
  return `${root}/_projects/${project}`;
}

// Two locations per book. Its own folder holds the identity and everything
// bound to the text itself (book.json, pinned pinyin, reading-position
// bookmarks, later derivatives). The moveable reading traces (progress,
// highlights, drafts, conversations, attachments) live in the same folder by
// default, or under the project folder once the book joins a reading project.
export function readingBookPaths(root, folder, project = "") {
  const book = `${root}/${folder}`;
  const traces = project ? `${readingProjectPath(root, project)}/${folder}` : book;
  return {
    dir: book,
    tracesDir: traces,
    meta: `${book}/book.json`,
    pins: `${book}/pins.json`,
    marks: `${book}/marks.json`,
    progress: `${traces}/progress.json`,
    highlights: `${traces}/highlights.json`,
    drafts: `${traces}/drafts.json`,
    chats: `${traces}/chats`,
    attachments: `${traces}/attachments`,
  };
}

// Chat ids come from generators, but imported records may carry anything; the
// file name has to stay inside the chats folder and be stable.
export function sanitizeReadingFileName(id, fallback = "chat") {
  const value = String(id || "").replace(/[^\w.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return value.slice(0, 120) || fallback;
}

function emptyIndex() {
  return { schemaVersion: READING_STORE_SCHEMA, updatedAt: 0, books: {} };
}

function normalizeIndex(value) {
  if (!value || typeof value !== "object" || typeof value.books !== "object" || !value.books) return emptyIndex();
  return { schemaVersion: READING_STORE_SCHEMA, updatedAt: Number(value.updatedAt) || 0, books: value.books };
}

function percentOf(progress) {
  const pct = Number(progress?.pct);
  return Number.isFinite(pct) ? Math.round(Math.max(0, Math.min(1, pct)) * 100) : 0;
}

// A light summary per book: the library and home read this instead of every
// book's folder. Only the kinds actually written are recomputed, so a partial
// save never wipes the rest of the summary.
function summarize(entry, values) {
  const next = { ...entry, updatedAt: Date.now() };
  if (values.progress && typeof values.progress === "object") {
    next.percent = percentOf(values.progress);
    next.lastRead = Number(values.progress.lastRead) || entry.lastRead || 0;
  }
  if (Array.isArray(values.highlights)) next.highlights = values.highlights.length;
  if (Array.isArray(values.pins)) next.pins = values.pins.length;
  if (Array.isArray(values.chats)) next.chats = values.chats.length;
  if (Array.isArray(values.marks)) next.marks = values.marks.length;
  if (values.drafts && typeof values.drafts === "object") next.draft = Boolean(String(values.drafts.text || "").trim());
  return next;
}

function sortChats(chats) {
  return chats.slice().sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
}

export function createReadingStore({ adapter, root, now = Date.now }) {
  const base = String(root || "").replace(/^\/+|\/+$/g, "");
  const indexPath = `${base}/index.json`;
  // Every write goes through one queue: the index is shared by all books and
  // all kinds, so concurrent saves would otherwise race on it.
  const queue = createSerialTaskQueue();

  async function readIndex() {
    const result = await readJsonRecordStore(adapter, indexPath, "reading index");
    return result.status === "unreadable" ? emptyIndex() : normalizeIndex(result.value);
  }

  async function writeIndexUnlocked(index) {
    index.updatedAt = now();
    await writeVerifiedJsonRecord(adapter, indexPath, index, { validateExisting: false });
    return index;
  }

  function uniqueFolder(index, bookPath, wanted) {
    const taken = new Set();
    for (const [path, entry] of Object.entries(index.books)) {
      if (path === bookPath) continue;
      if (entry?.folder) taken.add(String(entry.folder).toLowerCase());
    }
    let folder = wanted;
    let suffix = 2;
    while (taken.has(folder.toLowerCase())) folder = `${wanted} (${suffix++})`;
    return folder;
  }

  // Creates a folder and any missing parents. Obsidian's data adapter does not
  // create parents on write, so the reading root and every book folder are made
  // explicitly (opening a book is enough; no save is required first).
  async function ensureFolderUnlocked(dir) {
    const segments = String(dir || "").split("/").filter(Boolean);
    if (!segments.length) return;
    if (await adapter.exists(dir)) return;
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        if (!await adapter.exists(current)) await adapter.mkdir(current);
      } catch {
        // A failed mkdir surfaces right after as a failed file write.
      }
    }
  }

  // Identity of one book. The folder is assigned once and never renamed; the
  // note always points at the book's own folder, and the source records where
  // the anchors (block indices, CFI) were taken from.
  async function ensureBookUnlocked(bookPath, meta = {}) {
    const index = await readIndex();
    let entry = index.books[bookPath];
    let dirty = false;
    if (!entry) {
      entry = {
        folder: uniqueFolder(index, bookPath, sanitizeReadingFolder(meta.title || String(bookPath).split("/").pop() || "")),
        title: String(meta.title || ""),
        author: String(meta.author || ""),
        format: String(meta.format || ""),
        addedAt: now(),
        lastRead: 0,
        percent: 0,
        highlights: 0,
        pins: 0,
      };
      index.books[bookPath] = entry;
      dirty = true;
    }
    for (const key of ["title", "author", "format"]) {
      const value = String(meta[key] || "");
      if (!entry[key] && value) { entry[key] = value; dirty = true; }
    }
    const paths = readingBookPaths(base, entry.folder);
    if (!await adapter.exists(paths.meta)) {
      await ensureFolderUnlocked(paths.dir);
      await writeVerifiedJsonRecord(adapter, paths.meta, {
        schemaVersion: READING_STORE_SCHEMA,
        title: entry.title,
        author: entry.author,
        format: entry.format,
        source: { path: String(meta.sourcePath || bookPath), size: Number(meta.size) || 0, mtime: Number(meta.mtime) || 0 },
        note: String(meta.note || ""),
        project: entry.project || null,
        anchorSource: { kind: "source" },
        preferred: {},
        addedAt: entry.addedAt,
      }, { validateExisting: false });
    }
    if (dirty) await writeIndexUnlocked(index);
    return { folder: entry.folder, entry };
  }

  // Reads one book's files from its folder(s). A missing file is "no data yet";
  // an unreadable one is reported so the caller can keep it blocked.
  async function loadBookFrom(folder, project = "") {
    const paths = readingBookPaths(base, folder, project);
    const values = { progress: null, highlights: null, pins: null, drafts: null, marks: null, chats: [], blocked: [] };
    for (const kind of READING_STORE_FILES) {
      const result = await readJsonRecordStore(adapter, paths[kind], kind);
      if (result.status === "unreadable") { values.blocked.push(paths[kind]); continue; }
      if (result.status !== "ok" || !result.value || typeof result.value !== "object") continue;
      // Files carry a schema envelope; the raw value is unwrapped here.
      values[kind] = "data" in result.value ? result.value.data : result.value;
    }
    // Conversations live one file per chat under chats/ so a lost write can
    // only damage that one conversation.
    try {
      if (await adapter.exists(paths.chats)) {
        const names = await adapter.list(paths.chats);
        for (const name of Array.isArray(names) ? names : []) {
          if (!String(name).endsWith(".json")) continue;
          const file = `${paths.chats}/${name}`;
          const result = await readJsonRecordStore(adapter, file, "chat");
          if (result.status === "unreadable") { values.blocked.push(file); continue; }
          if (result.status !== "ok") continue;
          const chat = "data" in result.value ? result.value.data : result.value;
          if (chat && typeof chat === "object" && chat.id) values.chats.push(chat);
        }
      }
    } catch { /* no chats folder yet */ }
    values.chats = sortChats(values.chats);
    return values;
  }

  async function loadBook(bookPath) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return { progress: null, highlights: null, pins: null, drafts: null, marks: null, chats: [], blocked: [] };
    return loadBookFrom(entry.folder, entry.project);
  }

  // The index is a cache: if it is lost, the folders' book.json files rebuild
  // it. Candidate folders follow the title (plus the collision suffixes).
  async function rebuildIndexUnlocked(books = []) {
    const index = emptyIndex();
    for (const book of books) {
      if (!book?.bookPath) continue;
      const wanted = sanitizeReadingFolder(book.title || String(book.bookPath).split("/").pop() || "");
      const candidates = [wanted, ...Array.from({ length: 9 }, (_, i) => `${wanted} (${i + 2})`)];
      const used = new Set(Object.values(index.books).map((entry) => String(entry.folder).toLowerCase()));
      let folder = "";
      for (const candidate of candidates) {
        if (used.has(candidate.toLowerCase())) continue;
        if (await adapter.exists(readingBookPaths(base, candidate).meta)) {
          folder = candidate;
          used.add(candidate.toLowerCase());
          break;
        }
      }
      if (!folder) continue;
      // book.json knows whether the traces live in a project folder.
      let project = "";
      const meta = await readJsonRecordStore(adapter, readingBookPaths(base, folder).meta, "book");
      if (meta.status === "ok") project = String(meta.value?.project || "");
      const values = await loadBookFrom(folder, project);
      index.books[book.bookPath] = summarize({
        folder,
        project,
        title: String(book.title || ""),
        author: String(book.author || ""),
        format: String(book.format || ""),
        addedAt: 0,
        lastRead: 0,
        percent: 0,
        highlights: 0,
        pins: 0,
      }, values);
    }
    await writeIndexUnlocked(index);
    return index;
  }

  // Writes one kind for one book and refreshes that book's summary. A book
  // that has no folder yet (opened before any migration) gets one on the spot.
  async function saveBookUnlocked(bookPath, kind, value, meta = {}) {
    if (!READING_STORE_FILES.includes(kind)) throw new Error(`unknown reading store kind: ${kind}`);
    let index = await readIndex();
    let entry = index.books[bookPath];
    if (!entry?.folder) {
      await ensureBookUnlocked(bookPath, meta);
      index = await readIndex();
      entry = index.books[bookPath];
    }
    if (!entry?.folder) throw new Error("book has no reading folder");
    const paths = readingBookPaths(base, entry.folder, entry.project);
    await ensureFolderUnlocked(paths[kind].substring(0, paths[kind].lastIndexOf("/")));
    await writeVerifiedJsonRecord(adapter, paths[kind], { schemaVersion: READING_STORE_SCHEMA, data: value }, { validateExisting: false });
    const values = {};
    values[kind] = value;
    index.books[bookPath] = summarize(entry, values);
    await writeIndexUnlocked(index);
    return true;
  }

  // The book's identity file: source, note link, project, anchor source and the
  // derived copies (searchable PDF, covers) recorded next to the original.
  async function readBookMetaUnlocked(bookPath) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return null;
    const result = await readJsonRecordStore(adapter, readingBookPaths(base, entry.folder).meta, "book");
    return result.status === "ok" ? result.value : null;
  }

  async function updateBookMetaUnlocked(bookPath, patch = {}) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return null;
    const file = readingBookPaths(base, entry.folder).meta;
    const current = await readJsonRecordStore(adapter, file, "book");
    const next = { ...(current.status === "ok" ? current.value : {}), ...patch };
    await writeVerifiedJsonRecord(adapter, file, next, { validateExisting: false });
    return next;
  }

  // Drops one kind's file for a book (a cleared draft is no file instead of an
  // empty record) and refreshes the summary flag.
  async function clearBookUnlocked(bookPath, kind) {
    if (!READING_STORE_FILES.includes(kind)) throw new Error(`unknown reading store kind: ${kind}`);
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return false;
    const paths = readingBookPaths(base, entry.folder, entry.project);
    try { await adapter.remove(paths[kind]); } catch { /* nothing to remove */ }
    const summary = kind === "drafts" ? { draft: false } : kind === "marks" ? { marks: 0 } : null;
    if (summary) {
      const fresh = await readIndex();
      const current = fresh.books[bookPath];
      if (current) {
        fresh.books[bookPath] = { ...current, ...summary, updatedAt: now() };
        await writeIndexUnlocked(fresh);
      }
    }
    return true;
  }

  // Conversations are stored one file per chat. The in-memory history stays the
  // working copy; these two calls are how it reaches the book folder.
  async function updateChatCountUnlocked(bookPath, paths) {
    let count = 0;
    try {
      if (await adapter.exists(paths.chats)) {
        const names = await adapter.list(paths.chats);
        count = (Array.isArray(names) ? names : []).filter((name) => String(name).endsWith(".json")).length;
      }
    } catch { count = 0; }
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry || entry.chats === count) return;
    index.books[bookPath] = { ...entry, chats: count, updatedAt: now() };
    await writeIndexUnlocked(index);
  }

  async function saveChatUnlocked(bookPath, chat, meta = {}) {
    if (!chat?.id) throw new Error("chat has no id");
    const { folder, entry } = await ensureBookUnlocked(bookPath, meta);
    const paths = readingBookPaths(base, folder, entry.project);
    await ensureFolderUnlocked(paths.chats);
    await writeVerifiedJsonRecord(adapter, `${paths.chats}/${sanitizeReadingFileName(chat.id)}.json`, {
      schemaVersion: READING_STORE_SCHEMA,
      data: chat,
    }, { validateExisting: false });
    await updateChatCountUnlocked(bookPath, paths);
    return true;
  }

  // Vault path for one attachment's bytes (in the book's trace folder).
  async function attachmentPathUnlocked(bookPath, fileName) {
    const { folder, entry } = await ensureBookUnlocked(bookPath, {});
    return `${readingBookPaths(base, folder, entry.project).attachments}/${fileName}`;
  }

  async function deleteChatUnlocked(bookPath, chatId) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return false;
    const paths = readingBookPaths(base, entry.folder, entry.project);
    try { await adapter.remove(`${paths.chats}/${sanitizeReadingFileName(chatId)}.json`); }
    catch { /* the file is already gone */ }
    await updateChatCountUnlocked(bookPath, paths);
    return true;
  }

  // Splits the legacy global files into per-book folders. Files are written and
  // verified one book at a time; the caller flips the layout flag only after
  // this resolves, so a failure leaves the legacy files authoritative.
  async function migrateUnlocked({ progress = {}, highlights = {}, pins = {}, notes = {}, titles = {} } = {}) {
    const bookPaths = new Set([
      ...Object.keys(progress || {}),
      ...Object.keys(highlights || {}),
      ...Object.keys(pins || {}),
    ]);
    const report = { books: 0, files: 0, errors: [] };
    for (const bookPath of bookPaths) {
      try {
        const meta = titles[bookPath] || {};
        const has = Boolean(progress?.[bookPath] || highlights?.[bookPath]?.length || pins?.[bookPath]?.length);
        if (!has) continue;
        await ensureBookUnlocked(bookPath, { ...meta, note: notes[bookPath] || "" });
        if (progress?.[bookPath]) {
          await saveBookUnlocked(bookPath, "progress", progress[bookPath]);
          report.files += 1;
        }
        if (highlights?.[bookPath]?.length) {
          await saveBookUnlocked(bookPath, "highlights", highlights[bookPath]);
          report.files += 1;
        }
        if (pins?.[bookPath]?.length) {
          await saveBookUnlocked(bookPath, "pins", pins[bookPath]);
          report.files += 1;
        }
        report.books += 1;
      } catch (error) {
        report.errors.push({ bookPath, message: String(error?.message || error) });
      }
    }
    return report;
  }

  // ── reading projects ───────────────────────────────────────────────────────
  // A project groups the moveable traces of related books so they can travel
  // together. Identity, pinned pinyin and bookmarks always stay with the book.
  const TRACE_MEMBERS = Object.freeze(["progress.json", "highlights.json", "drafts.json", "chats", "attachments"]);

  async function writeProjectUnlocked(project, patch = {}) {
    const dir = readingProjectPath(base, project);
    await ensureFolderUnlocked(dir);
    const file = `${dir}/project.json`;
    const current = await readJsonRecordStore(adapter, file, "project");
    const baseValue = current.status === "ok"
      ? current.value
      : { schemaVersion: READING_STORE_SCHEMA, createdAt: now(), books: [] };
    const next = { ...baseValue, ...patch, schemaVersion: READING_STORE_SCHEMA, name: project, updatedAt: now() };
    await writeVerifiedJsonRecord(adapter, file, next, { validateExisting: false });
    return next;
  }

  async function readProjectUnlocked(project) {
    const result = await readJsonRecordStore(adapter, `${readingProjectPath(base, project)}/project.json`, "project");
    if (result.status !== "ok") return { name: project, books: [] };
    return {
      ...result.value,
      name: String(result.value.name || project),
      books: Array.isArray(result.value.books) ? result.value.books : [],
    };
  }

  async function listProjectsUnlocked() {
    const dir = `${base}/_projects`;
    const out = [];
    try {
      if (await adapter.exists(dir)) {
        for (const name of await adapter.list(dir)) {
          if (!await adapter.exists(`${dir}/${name}/project.json`)) continue;
          out.push(await readProjectUnlocked(name));
        }
      }
    } catch { /* no projects folder yet */ }
    out.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return out;
  }

  function projectBookPath(item) {
    return typeof item === "string" ? item : String(item?.path || "");
  }

  async function addProjectBookUnlocked(project, bookPath, folder, title) {
    const data = await readProjectUnlocked(project);
    const books = data.books.filter((item) => projectBookPath(item) !== bookPath);
    books.push({ path: bookPath, folder, title: String(title || "") });
    await writeProjectUnlocked(project, { books });
  }

  async function removeProjectBookUnlocked(project, bookPath) {
    const data = await readProjectUnlocked(project);
    await writeProjectUnlocked(project, { books: data.books.filter((item) => projectBookPath(item) !== bookPath) });
  }

  async function createProjectUnlocked(name) {
    const wanted = sanitizeReadingFolder(String(name || "").trim()).slice(0, 40) || "未命名项目";
    const taken = new Set();
    for (const project of await listProjectsUnlocked()) taken.add(project.name.toLowerCase());
    let project = wanted;
    let suffix = 2;
    while (taken.has(project.toLowerCase())) project = `${wanted} (${suffix++})`;
    await writeProjectUnlocked(project, { books: [] });
    return project;
  }

  // Moves a book's traces between its own folder and a project folder (or
  // between projects). Every member that moved is moved back if anything
  // fails, so the book never ends up half in a project.
  async function moveBookUnlocked(bookPath, project) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) throw new Error("book has no reading folder");
    const from = String(entry.project || "");
    const to = String(project || "");
    if (from === to) return { moved: 0, project: to, from };
    const bookDir = `${base}/${entry.folder}`;
    const fromDir = from ? `${readingProjectPath(base, from)}/${entry.folder}` : bookDir;
    const toDir = to ? `${readingProjectPath(base, to)}/${entry.folder}` : bookDir;
    const moved = [];
    try {
      await ensureFolderUnlocked(toDir);
      for (const member of TRACE_MEMBERS) {
        const source = `${fromDir}/${member}`;
        if (!await adapter.exists(source)) continue;
        const target = `${toDir}/${member}`;
        if (await adapter.exists(target)) throw new Error(`目标目录里已有同名内容：${member}`);
        await adapter.rename(source, target);
        moved.push(member);
      }
    } catch (error) {
      for (const member of moved.reverse()) {
        try { await adapter.rename(`${toDir}/${member}`, `${fromDir}/${member}`); }
        catch { /* the file stays in the target and is reported */ }
      }
      throw error;
    }
    const rollback = async () => {
      for (const member of moved.reverse()) {
        try { await adapter.rename(`${toDir}/${member}`, `${fromDir}/${member}`); }
        catch { /* reported to the caller */ }
      }
    };
    try {
      const metaPath = `${bookDir}/book.json`;
      const meta = await readJsonRecordStore(adapter, metaPath, "book");
      if (meta.status === "ok") {
        await writeVerifiedJsonRecord(adapter, metaPath, { ...meta.value, project: to || null }, { validateExisting: false });
      }
      index.books[bookPath] = { ...entry, project: to, updatedAt: now() };
      await writeIndexUnlocked(index);
      if (to) await addProjectBookUnlocked(to, bookPath, entry.folder, entry.title);
      if (from) await removeProjectBookUnlocked(from, bookPath);
      return { moved: moved.length, project: to, from };
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  async function deleteProjectUnlocked(project, { moveBooks = true } = {}) {
    const data = await readProjectUnlocked(project);
    const result = { moved: [], failed: [] };
    if (moveBooks) {
      for (const item of data.books) {
        const bookPath = projectBookPath(item);
        if (!bookPath) continue;
        try { await moveBookUnlocked(bookPath, ""); result.moved.push(bookPath); }
        catch { result.failed.push(bookPath); }
      }
    }
    if (!result.failed.length) {
      try { await adapter.remove(readingProjectPath(base, project)); } catch { /* left in place */ }
    }
    return result;
  }

  const ensureBook = (bookPath, meta = {}) => queue.run(() => ensureBookUnlocked(bookPath, meta));
  // The snapshot is taken when the call is made, not when the queued write runs.
  const saveBook = (bookPath, kind, value, meta = {}) => {
    const snapshot = cloneJson(value);
    return queue.run(() => saveBookUnlocked(bookPath, kind, snapshot, meta));
  };
  const writeIndex = (index) => queue.run(() => writeIndexUnlocked(index));
  const rebuildIndex = (books = []) => queue.run(() => rebuildIndexUnlocked(books));
  const migrate = (data = {}) => queue.run(() => migrateUnlocked(data));
  const clearBook = (bookPath, kind) => queue.run(() => clearBookUnlocked(bookPath, kind));
  const readBookMeta = (bookPath) => queue.run(() => readBookMetaUnlocked(bookPath));
  const updateBookMeta = (bookPath, patch = {}) => {
    const snapshot = cloneJson(patch);
    return queue.run(() => updateBookMetaUnlocked(bookPath, snapshot));
  };
  const saveChat = (bookPath, chat, meta = {}) => {
    const snapshot = cloneJson(chat);
    return queue.run(() => saveChatUnlocked(bookPath, snapshot, meta));
  };
  const deleteChat = (bookPath, chatId) => queue.run(() => deleteChatUnlocked(bookPath, chatId));
  const attachmentPath = (bookPath, fileName) => queue.run(() => attachmentPathUnlocked(bookPath, fileName));
  const listProjects = () => queue.run(() => listProjectsUnlocked());
  const createProject = (name) => queue.run(() => createProjectUnlocked(name));
  const moveBook = (bookPath, project) => queue.run(() => moveBookUnlocked(bookPath, project));
  const deleteProject = (project, options) => queue.run(() => deleteProjectUnlocked(project, options));

  return {
    root: base,
    indexPath,
    readIndex,
    writeIndex,
    ensureBook,
    loadBook,
    loadBookFrom,
    rebuildIndex,
    saveBook,
    clearBook,
    readBookMeta,
    updateBookMeta,
    migrate,
    saveChat,
    deleteChat,
    attachmentPath,
    listProjects,
    createProject,
    moveBook,
    deleteProject,
    // Resolves when every queued write has settled, so a read right after a
    // save sees the file it just wrote.
    drain: () => queue.drain(),
  };
}
