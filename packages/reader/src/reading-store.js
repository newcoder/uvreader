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
  "progress", "highlights", "pins",
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

export function readingBookPaths(root, folder) {
  const base = `${root}/${folder}`;
  return {
    dir: base,
    meta: `${base}/book.json`,
    progress: `${base}/progress.json`,
    highlights: `${base}/highlights.json`,
    pins: `${base}/pins.json`,
    chats: `${base}/chats`,
    attachments: `${base}/attachments`,
    drafts: `${base}/drafts.json`,
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

  // Reads one book's files from its folder. A missing file is "no data yet";
  // an unreadable one is reported so the caller can keep it blocked.
  async function loadBookFrom(folder) {
    const paths = readingBookPaths(base, folder);
    const values = { progress: null, highlights: null, pins: null, chats: [], blocked: [] };
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
    if (!entry?.folder) return { progress: null, highlights: null, pins: null, chats: [], blocked: [] };
    return loadBookFrom(entry.folder);
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
      const values = await loadBookFrom(folder);
      index.books[book.bookPath] = summarize({
        folder,
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
    const paths = readingBookPaths(base, entry.folder);
    await ensureFolderUnlocked(paths.dir);
    await writeVerifiedJsonRecord(adapter, paths[kind], { schemaVersion: READING_STORE_SCHEMA, data: value }, { validateExisting: false });
    const values = {};
    values[kind] = value;
    index.books[bookPath] = summarize(entry, values);
    await writeIndexUnlocked(index);
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
    const { folder } = await ensureBookUnlocked(bookPath, meta);
    const paths = readingBookPaths(base, folder);
    await ensureFolderUnlocked(paths.chats);
    await writeVerifiedJsonRecord(adapter, `${paths.chats}/${sanitizeReadingFileName(chat.id)}.json`, {
      schemaVersion: READING_STORE_SCHEMA,
      data: chat,
    }, { validateExisting: false });
    await updateChatCountUnlocked(bookPath, paths);
    return true;
  }

  async function deleteChatUnlocked(bookPath, chatId) {
    const index = await readIndex();
    const entry = index.books[bookPath];
    if (!entry?.folder) return false;
    const paths = readingBookPaths(base, entry.folder);
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

  const ensureBook = (bookPath, meta = {}) => queue.run(() => ensureBookUnlocked(bookPath, meta));
  // The snapshot is taken when the call is made, not when the queued write runs.
  const saveBook = (bookPath, kind, value, meta = {}) => {
    const snapshot = cloneJson(value);
    return queue.run(() => saveBookUnlocked(bookPath, kind, snapshot, meta));
  };
  const writeIndex = (index) => queue.run(() => writeIndexUnlocked(index));
  const rebuildIndex = (books = []) => queue.run(() => rebuildIndexUnlocked(books));
  const migrate = (data = {}) => queue.run(() => migrateUnlocked(data));
  const saveChat = (bookPath, chat, meta = {}) => {
    const snapshot = cloneJson(chat);
    return queue.run(() => saveChatUnlocked(bookPath, snapshot, meta));
  };
  const deleteChat = (bookPath, chatId) => queue.run(() => deleteChatUnlocked(bookPath, chatId));

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
    migrate,
    saveChat,
    deleteChat,
    // Resolves when every queued write has settled, so a read right after a
    // save sees the file it just wrote.
    drain: () => queue.drain(),
  };
}
