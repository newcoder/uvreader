// Library data helpers: reading status, folder/tag tallies, header chips and
// the book filter. Pure data work — the host injects path normalization and
// translation, so the module stays testable without Obsidian.

export const IMPORT_MIME_EXT = new Map([["application/pdf", "pdf"], ["application/epub+zip", "epub"]]);

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

  function bookTagsOf(settings, bookPath) {
    const m = (settings && settings.bookTags) || {};
    const v = m[bookPath];
    return Array.isArray(v) ? v.filter(Boolean) : [];
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
