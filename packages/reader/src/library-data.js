// Library data helpers: reading status, folder/tag tallies, header chips and
// the book filter. Pure data work — the host injects path normalization and
// translation, so the module stays testable without Obsidian.

export const IMPORT_MIME_EXT = new Map([["application/pdf", "pdf"], ["application/epub+zip", "epub"]]);

// ── Library tree / new-book helpers (pure, host-free) ────────────────────────

// Tags of one book; shared by the factory below and by the plugin's import
// flow, so it lives at module level.
export function bookTagsOf(settings, bookPath) {
  const m = (settings && settings.bookTags) || {};
  const v = m[bookPath];
  return Array.isArray(v) ? v.filter(Boolean) : [];
}

// Union of two tag lists, first-seen order, blanks dropped. Auto-tagging merges
// with whatever the user already set instead of replacing it.
export function mergeBookTags(existing, added) {
  const out = [];
  const seen = new Set();
  for (const tag of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])]) {
    const name = String(tag || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// "book.epub" → "book.epub", "book.epub" → "book (2).epub" … `exists` is the
// caller's vault lookup so the helper stays host-free.
export function freeBookPath(dir, name, exists) {
  const clean = String(name || "book").replace(/[\\/:*?"<>|\n\r\t]/g, "_").trim() || "book";
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  const join = (candidate) => (dir ? `${dir}/${candidate}${ext}` : `${candidate}${ext}`);
  let candidate = join(base);
  let index = 1;
  while (exists(candidate)) candidate = join(`${base} (${index++})`);
  return candidate;
}

// The importer only copies books living outside the vault. A path that already
// resolves to a vault file — recent lists and home cards hand over
// vault-relative paths — is reused as-is; copying one forked a duplicate book
// with its own tags and reading record.
export function existingVaultBookPath(sourcePath, lookup) {
  const rel = String(sourcePath || "").replace(/\\/g, "/");
  if (!rel || typeof lookup !== "function") return "";
  const file = lookup(rel);
  return file && file.extension ? String(file.path || rel) : "";
}

// The desktop vault adapter resolves absolute paths against the real
// filesystem (that is how books outside the library are read), so a plain
// existence lookup cannot tell an imported book from one that merely lives on
// disk — every outside book looked "already in the vault" and importers
// skipped their copy. Obsidian itself never resolves absolute paths, so an
// absolute candidate only counts as in-vault when it sits under the vault root.
export function isInsideVaultPath(candidatePath, vaultRoot) {
  const normalized = String(candidatePath || "").replace(/\\/g, "/");
  const absolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/");
  if (!absolute) return true;
  const root = String(vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return true;
  const candidate = normalized.toLowerCase();
  const base = root.toLowerCase();
  return candidate === base || candidate.startsWith(`${base}/`);
}

// Where new books land: the configured folder, or the folder already holding
// the most books of the accepted extensions.
export function pickLibraryFolder(bookFiles, booksFolder, extensions) {
  const configured = String(booksFolder || "");
  if (configured) return configured;
  const wanted = extensions instanceof Set ? extensions : new Set(extensions || []);
  const counts = new Map();
  for (const file of Array.isArray(bookFiles) ? bookFiles : []) {
    if (wanted.size && !wanted.has(String(file?.extension || "").toLowerCase())) continue;
    const parent = String(file?.parent?.path || "");
    const dir = parent && parent !== "/" ? parent : "";
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = "";
  let bestCount = -1;
  for (const [dir, count] of counts) {
    if (count > bestCount) { best = dir; bestCount = count; }
  }
  return best;
}

// Partitions the flat chip list into the navigation tree groups. Folder chips
// carry their subfolder chips (`sub: true`) right after the parent.
export function groupLibChips(chips) {
  const list = Array.isArray(chips) ? chips : [];
  const all = list.find((chip) => chip.id === "all");
  const statuses = list.filter((chip) => String(chip.id || "").startsWith("status:"));
  const tags = list.filter((chip) => String(chip.id || "").startsWith("tag:"));
  const folders = [];
  for (const chip of list) {
    const id = String(chip.id || "");
    if (!id.startsWith("folder:")) continue;
    if (chip.sub) {
      const parent = folders[folders.length - 1];
      if (parent && id.startsWith(parent.id + "/")) parent.subs.push(chip);
      continue;
    }
    folders.push({ ...chip, subs: [] });
  }
  return { total: all?.count || 0, statuses, tags, folders };
}

export function createLibraryData({ translate, path }) {
  // Reading-status chips in the fixed order shown by the library header; labels
  // are translated at build time, once the UI language is configured.
  const LIB_STATUS_CHIPS = [
    { key: "reading", id: "status:reading", text: "reading-2" },
    { key: "new", id: "status:new", text: "not-started" },
    { key: "done", id: "status:done", text: "finished" }
  ];

  function bookRelFolder(bookPath, booksFolder) {
    const base = path(booksFolder);
    let rel = path(bookPath);
    if (base && rel.startsWith(base + "/")) rel = rel.slice(base.length + 1);
    const i = rel.lastIndexOf("/");
    return i > 0 ? rel.slice(0, i) : "";
  }

  function bookCategoryOf(bookPath, booksFolder) {
    const base = path(booksFolder);
    let rel = path(bookPath);
    if (base && rel.startsWith(base + "/")) rel = rel.slice(base.length + 1);
    const i = rel.indexOf("/");
    return i > 0 ? rel.slice(0, i) : "";
  }

  function bookStatusOf(prog) {
    if (!prog || !prog.lastRead) return "new";
    const pct = typeof prog.percent === "number" ? prog.percent : 0;
    if (pct >= 98) return "done";
    if (pct > 0) return "reading";
    return "new";
  }

  function libBump(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function libTallyBooks(bookFiles, booksFolder, getProgress, getTags) {
    const statuses = {};
    for (const def of LIB_STATUS_CHIPS) statuses[def.key] = 0;
    const folders = new Map();
    const tags = new Map();
    for (const f of bookFiles) {
      statuses[bookStatusOf(getProgress(f.path))] += 1;
      libBump(folders, bookCategoryOf(f.path, booksFolder));
      const owned = getTags ? getTags(f.path) : [];
      for (const t of owned) libBump(tags, t);
    }
    return { statuses, folders, tags };
  }

  // Counts the immediate subfolders below an opened folder chip.
  function libSubfolderCounts(bookFiles, booksFolder, openFolder) {
    const subs = new Map();
    if (!openFolder) return subs;
    for (const f of bookFiles) {
      const where = bookRelFolder(f.path, booksFolder);
      if (where === openFolder || !where.startsWith(openFolder + "/")) continue;
      const tail = where.slice(openFolder.length + 1);
      libBump(subs, openFolder + "/" + tail.split("/")[0]);
    }
    return subs;
  }

  function buildLibChips(bookFiles, booksFolder, getProgress, getTags, activeChip) {
    const { statuses, folders, tags } = libTallyBooks(bookFiles, booksFolder, getProgress, getTags);
    const chips = [{ id: "all", label: translate("all"), count: bookFiles.length }];
    for (const def of LIB_STATUS_CHIPS) {
      if (statuses[def.key]) chips.push({ id: def.id, label: translate(def.text), count: statuses[def.key] });
    }
    for (const t of [...tags.keys()].sort((a, b) => a.localeCompare(b, "ru"))) {
      chips.push({ id: "tag:" + t, label: t, count: tags.get(t) });
    }
    const named = [...folders.entries()]
      .filter(([c]) => c)
      .sort((x, y) => x[0].localeCompare(y[0], "ru"));
    const openFolder = activeChip && activeChip.startsWith("folder:")
      ? activeChip.slice(7)
      : null;
    const subs = libSubfolderCounts(bookFiles, booksFolder, openFolder);
    const showFolders = named.length > 1 || (named.length === 1 && folders.has(""));
    if (showFolders) {
      for (const [group, total] of named) {
        chips.push({ id: "folder:" + group, label: group, count: total });
        const expandable = openFolder === group && subs.size > 1;
        if (expandable) {
          const sortedSubs = [...subs.entries()].sort((x, y) => x[0].localeCompare(y[0], "ru"));
          for (const [sub, sn] of sortedSubs) {
            const subLabel = "└ " + sub.slice(group.length + 1);
            chips.push({ id: "folder:" + sub, label: subLabel, count: sn, sub: true });
          }
        }
      }
      const unfiled = folders.get("");
      if (unfiled) chips.push({ id: "folder:", label: translate("no-folder"), count: unfiled });
    }
    return chips;
  }

  // Chip ids read "status:x", "folder:x" or "tag:x"; "folder:" with an empty
  // key selects the books sitting directly inside the library root folder.
  function libChipMatches(chipId, f, booksFolder, getProgress, getTags) {
    const colon = chipId.indexOf(":");
    if (colon < 0) return true;
    const kind = chipId.slice(0, colon);
    const arg = chipId.slice(colon + 1);
    if (kind === "status") return bookStatusOf(getProgress(f.path)) === arg;
    if (kind === "folder") {
      const here = bookRelFolder(f.path, booksFolder);
      return arg === "" ? here === "" : (here === arg || here.startsWith(arg + "/"));
    }
    if (kind === "tag") return (getTags ? getTags(f.path) : []).includes(arg);
    return true;
  }

  function filterLibBooks(bookFiles, chipId, query, booksFolder, getProgress, getTags) {
    const needle = (query || "")
      .trim()
      .toLowerCase();
    return bookFiles.filter((f) => {
      const haystack = f.basename.toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      const noChip = !chipId || chipId === "all";
      if (noChip) return true;
      return libChipMatches(chipId, f, booksFolder, getProgress, getTags);
    });
  }

  function allBookTags(settings) {
    const m = (settings && settings.bookTags) || {};
    const set = new Set();
    for (const k of Object.keys(m)) for (const t of (Array.isArray(m[k]) ? m[k] : [])) if (t) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, "ru"));
  }

  function parseBookTags(raw) {
    return String(raw || "")
      .split(/[,;\n]+/)
      .map((t) => t.trim().replace(/^#+/, "").trim())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i);
  }

  return {
    bookRelFolder,
    bookCategoryOf,
    bookStatusOf,
    libTallyBooks,
    libSubfolderCounts,
    buildLibChips,
    libChipMatches,
    filterLibBooks,
    bookTagsOf,
    allBookTags,
    parseBookTags,
  };
}
