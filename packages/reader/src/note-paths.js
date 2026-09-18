// Note paths, vault pickers and note metadata helpers. The host injects the
// path normalizer, translation, Obsidian classes and the folder-creation modal,
// so the module stays testable without Obsidian.

import { isReadingHighlightsHeading } from "./reading-note.js";

export function createNotePaths({
  translate,
  path,
  TFile,
  TFolder,
  AbstractInputSuggest,
  FuzzySuggestModal,
  Setting,
  window: win,
  getCreateFolderModal,
}) {
  function _readerSettings(app) {
    const plugins = app && app.plugins && app.plugins.plugins;
    const p = plugins ? plugins["qiaomu-reader"] : null;
    return p && p.settings || {};
  }
  function noteTemplatePath(app, bookFile) {
    const s = _readerSettings(app);
    if (bookFile && s.bookTemplates && s.bookTemplates[bookFile.path]) return path(s.bookTemplates[bookFile.path]);
    return path(s.noteTemplate);
  }
  function bookNoteTemplatePath(app) {
    return path(_readerSettings(app).bookNoteTemplate);
  }
  function notesFolderPath(app) {
    return path(_readerSettings(app).notesFolder);
  }
  function bookNotesFolderPath(app) {
    return path(_readerSettings(app).bookNotesFolder);
  }
  function inboxNotePath(app, name, override) {
    const f = typeof override === "string" && override !== "" ? path(override) : notesFolderPath(app);
    return path(f ? `${f}/${name}.md` : `${name}.md`);
  }
  async function resolveNotesFolder(app, override) {
    const f = typeof override === "string" && override !== "" ? path(override) : notesFolderPath(app);
    if (!f) return app.vault.getRoot();
    let folder = app.vault.getAbstractFileByPath(f);
    if (!folder) {
      await app.vault.createFolder(f).catch(() => {
      });
      folder = app.vault.getAbstractFileByPath(f);
    }
    return folder || app.vault.getRoot();
  }
  function bookNoteFiles(app) {
    const base = bookNotesFolderPath(app);
    const all = app.vault.getMarkdownFiles();
    if (!base) return all;
    const prefix = base + "/";
    return all.filter((f) => f.path.startsWith(prefix));
  }
  function resolveBookNote(app, name) {
    if (!name) return null;
    const normalized = path(name);
    // New links store the full vault path. Missing explicit targets must never
    // fall back to an unrelated file with the same basename.
    if (normalized.includes("/") || normalized.endsWith(".md")) {
      const exact = app.vault.getAbstractFileByPath(normalized.endsWith(".md") ? normalized : `${normalized}.md`);
      return exact instanceof TFile && exact.extension === "md" ? exact : null;
    }
    // Legacy basename links remain valid only when they identify one note.
    const candidates = app.vault.getMarkdownFiles().filter((file) => file.basename === normalized);
    if (candidates.length > 1) return null;
    if (candidates.length === 1) return candidates[0];
    const byLink = app.metadataCache.getFirstLinkpathDest?.(name, "");
    return byLink instanceof TFile && byLink.extension === "md" ? byLink : null;
  }


  const BookNotePicker = class extends FuzzySuggestModal {
    constructor(app, files, onChoose) {
      super(app);
      this._files = files;
      this._onChoose = onChoose;
      this.setPlaceholder(translate("book-note-for-links-start-typing-a-name"));
    }
    getItems() {
      return this._files;
    }
    getItemText(f) {
      return f.basename;
    }
    onChooseItem(f) {
      this._onChoose(f);
    }
  };
  const BookQuickOpen = class extends FuzzySuggestModal {
    constructor(app, plugin) {
      super(app);
      this.plugin = plugin;
      this.setPlaceholder(translate("which-book-do-you-want-to-open"));
    }
    getItems() {
      const prog = this.plugin.progress || {};
      const started = (f) => {
        const p = prog[f.path];
        return p && typeof p.pct === "number" && p.pct > 0 ? p.pct : -1;
      };
      return this.plugin.bookFiles().sort((a, b) => {
        const sa = started(a), sb = started(b);
        if (sa >= 0 !== sb >= 0) return sa >= 0 ? -1 : 1;
        return a.basename.localeCompare(b.basename);
      });
    }
    getItemText(f) {
      const p = (this.plugin.progress || {})[f.path];
      const pct = p && typeof p.pct === "number" ? Math.round(p.pct * 100) : 0;
      return pct > 0 ? `${f.basename} — ${pct}%` : f.basename;
    }
    onChooseItem(f) {
      this.plugin.openFile(f);
    }
  };
  const TemplatePicker = class extends FuzzySuggestModal {
    constructor(app, files, onChoose) {
      super(app);
      this._files = files;
      this._onChoose = onChoose;
      this.setPlaceholder(translate("note-template-start-typing-a-path"));
    }
    getItems() {
      return this._files;
    }
    getItemText(f) {
      return f.path;
    }
    onChooseItem(f) {
      this._onChoose(f);
    }
  };


  function vaultFolders(app) {
    return app.vault.getAllLoadedFiles()
      .filter((file) => file instanceof TFolder && path(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  const FolderPicker = class extends FuzzySuggestModal {
    constructor(app, currentPath, onChoose) {
      super(app);
      this._currentPath = path(currentPath);
      this._onChoose = onChoose;
      this.setPlaceholder(translate("search-folders"));
      this.emptyStateText = translate("no-folders-found");
    }
    getItems() {
      return [
        { kind: "root", path: "", label: translate("vault-root") },
        { kind: "create", path: "", label: translate("create-new-folder") },
        ...vaultFolders(this.app).map((folder) => ({ kind: "folder", path: folder.path, label: folder.path })),
      ];
    }
    getItemText(item) {
      return item.label;
    }
    onChooseItem(item) {
      if (item.kind === "create") {
        const proposed = path(this.inputEl.value) || this._currentPath;
        win.setTimeout(() => new (getCreateFolderModal())(this.app, proposed, this._onChoose).open(), 0);
        return;
      }
      this._onChoose(item.path);
    }
    onOpen() {
      super.onOpen();
      this.modalEl.addClass("qiaomu-reader-folder-picker-modal");
    }
  };
  const FolderSuggest = AbstractInputSuggest ? class extends AbstractInputSuggest {
    constructor(app, inputEl) {
      super(app, inputEl);
      this._inputEl = inputEl;
    }
    getSuggestions(query) {
      const q = (query || "").toLowerCase();
      let out = [];
      for (const f of this.app.vault.getAllLoadedFiles()) {
        if (f instanceof TFolder && f.path && f.path.toLowerCase().includes(q)) out.push(f.path);
      }
      return out.sort().slice(0, 50);
    }
    renderSuggestion(path5, el) {
      el.setText(path5);
    }
    selectSuggestion(path5) {
      this._inputEl.value = path5;
      this._inputEl.dispatchEvent(new Event("input"));
      this._inputEl.dispatchEvent(new Event("qiaomu-reader-path-pick"));
      this.close();
    }
  } : null;
  function attachFolderSuggest(app, textComp) {
    try {
      if (FolderSuggest && textComp && textComp.inputEl) new FolderSuggest(app, textComp.inputEl);
    } catch (e) {
      console.warn("UV Reader: folder suggest unavailable", e);
    }
  }
  function attachPathInput(app, field, commit) {
    attachFolderSuggest(app, field);
    const input = field.inputEl;
    let touched = false;
    const flushEdits = () => {
      if (touched) {
        touched = false;
        commit(input.value.trim());
      }
    };
    field.onChange(() => { touched = true; });
    for (const evName of ["blur", "qiaomu-reader-path-pick"]) input.addEventListener(evName, flushEdits);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      flushEdits();
    });
    return field;
  }
  function addFolderPathControl(setting, app, options) {
    let textComp;
    const current = path(options.value);
    const statusEl = setting.controlEl.createDiv({ cls: "qiaomu-reader-folder-path-status" });
    statusEl.setAttr("aria-live", "polite");
    const paintStatus = (value, error = false) => {
      const normalized = path(value);
      statusEl.toggleClass("is-error", error);
      statusEl.setText(error
        ? translate("folder-0-was-not-found-choose-an-existing-folder-or-create-it", normalized)
        : translate("current-folder-0", normalized || translate("vault-root")));
    };
    const apply = async (raw) => {
      const normalized = path(raw);
      const target = normalized ? app.vault.getAbstractFileByPath(normalized) : app.vault.getRoot();
      if (!(target instanceof TFolder)) {
        textComp.inputEl.setAttr("aria-invalid", "true");
        paintStatus(normalized, true);
        return false;
      }
      textComp.setValue(normalized);
      textComp.inputEl.removeAttribute("aria-invalid");
      paintStatus(normalized);
      await options.commit(normalized);
      return true;
    };
    setting.addText((text) => {
      textComp = text;
      text.setPlaceholder(options.placeholder || translate("vault-root"));
      text.setValue(current);
      attachPathInput(app, text, apply);
      text.inputEl.addClass("qiaomu-reader-folder-path-input");
      text.inputEl.setAttr("aria-label", options.label || translate("folder-path"));
    });
    setting.addExtraButton(button => {
      button.setIcon("folder-open").onClick(() => new FolderPicker(app, textComp.getValue(), path => apply(path)).open());
      button.extraSettingsEl.setAttribute("aria-label", translate("choose-folder"));
    });
    setting.settingEl.addClass("qiaomu-reader-folder-setting");
    setting.controlEl.appendChild(statusEl);
    paintStatus(current);
    return setting;
  }
  function addMarkdownFilePathControl(setting, app, options) {
    let textComp;
    const files = () => app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
    const apply = async (raw) => {
      const normalized = path(raw);
      textComp.setValue(normalized);
      await options.commit(normalized);
    };
    setting.addText((text) => {
      textComp = text;
      text.setPlaceholder(options.placeholder || translate("note-template-start-typing-a-path"));
      text.setValue(path(options.value));
      text.onChange((value) => options.commit(path(value)));
      text.inputEl.setAttr("aria-label", options.label || translate("template"));
    });
    setting.addExtraButton(button => {
      button.setIcon("file-search").onClick(() => new TemplatePicker(app, files(), apply).open());
      button.extraSettingsEl.setAttribute("aria-label", translate("choose-template"));
    });
    setting.settingEl.addClass("qiaomu-reader-file-path-setting");
    return setting;
  }
  const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  function sanitizeNoteTitle(raw, max = 100) {
    // eslint-disable-next-line no-control-regex -- removing control characters is exactly what this replace is for
    let t = (raw || "").replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
    if (t.length > max) t = t.slice(0, max).replace(/[.\s]+$/, "");
    if (!t) t = translate("note");
    if (RESERVED_NAMES.test(t)) t = `_${t}`;
    return t;
  }
  function suggestNoteTitle(text, max = 60) {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (!flat) return "";
    const tail = /[.,;:!?…\s]+$/;
    if (flat.length <= max) return flat.replace(tail, "");
    const sentence = flat.match(/^(.{10,}?[.!?…])(\s|$)/);
    if (sentence && sentence[1].length <= max && /[\p{L}]{3}[.!?…]+$/u.test(sentence[1])) {
      return sentence[1].replace(tail, "");
    }
    let cut = flat.slice(0, max + 1);
    const gap = cut.lastIndexOf(" ");
    if (gap > max * 0.5) cut = cut.slice(0, gap);
    cut = cut.replace(/\s+[a-zа-яё]{1,2}$/i, "");
    return cut.replace(/[.,;:!?…\-—\s]+$/, "");
  }

  function bindSettingsTabKeys(tablist) {
    tablist.addEventListener("keydown", event => {
      const tabs = [...tablist.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      const parent = tablist.closest(".qiaomu-reader-settings-root,.qiaomu-reader-rs");
      tabs[next].click();
      parent?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    });
  }

  function parseNoteTags(raw) {
    return String(raw || "").replace(/\s+#/g, ",#").split(/[,;\n]+/).map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, "-")).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i);
  }
  function allVaultTags(app) {
    try {
      const counts = app.metadataCache && app.metadataCache.getTags && app.metadataCache.getTags();
      if (!counts) return [];
      return Object.keys(counts).map((t) => t.replace(/^#/, "")).sort((a, b) => (counts["#" + b] || 0) - (counts["#" + a] || 0)).slice(0, 60);
    } catch {
      return [];
    }
  }

  function processTemplateManually(tplText, title) {
    let today;
    try {
      today = win.moment ? win.moment().format("YYYY-MM-DD") : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    } catch {
      today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    }
    return tplText.replace(/<%[-_]?\s*tp\.file\.title\s*[-_]?%>/g, title).replace(/<%[-_]?\s*tp\.date\.now\([^)]*\)\s*[-_]?%>/g, today).replace(/<%[-_]?\s*tp\.file\.cursor\([^)]*\)\s*[-_]?%>/g, "").replace(/<%[\s\S]*?%>/g, "");
  }
  function bookNoteLinkFor(plugin, bookFile) {
    let _a, _b;
    if (!bookFile) return "";
    const map = (_a = plugin == null ? void 0 : plugin.settings) == null ? void 0 : _a.bookNoteLinks;
    const raw = map ? (_b = map[bookFile.path]) != null ? _b : "" : "";
    const fromSettings = String(raw).trim().replace(/^\[\[|\]\]$/g, "").trim();
    if (fromSettings) return fromSettings;
    return bookNoteFromFrontmatter(plugin, bookFile);
  }
  function isUnsafeReadingNote(app, note) {
    if (!(note instanceof TFile)) return true;
    if (/(^|\/)(?:_?templates?|模板)(\/|$)/i.test(note.path)) return true;
    const cache = app.metadataCache.getFileCache(note);
    const fm = cache && cache.frontmatter || {};
    const type = String(fm.type || "").trim().toLowerCase();
    return ["person", "people", "meeting", "daily", "project", "template"].includes(type);
  }
  function isMarkedReadingNote(app, note) {
    if (!(note instanceof TFile) || isUnsafeReadingNote(app, note)) return false;
    const cache = app.metadataCache.getFileCache(note);
    const fm = cache && cache.frontmatter || {};
    const type = String(fm.type || "").trim().toLowerCase();
    return fm["book-reader-note"] === true || ["reading-note", "book-note"].includes(type);
  }
  function stripGeneratedReadingNoteTitle(data, title) {
    const original = String(data || "");
    const lines = original.split(/\r?\n/);
    let i = 0;
    if (lines[0] === "---") {
      i = 1;
      while (i < lines.length && lines[i] !== "---") i++;
      if (i < lines.length) i++;
    }
    while (i < lines.length && !lines[i].trim()) i++;
    if (!/^#\s+/.test(lines[i])) return original;
    const heading = lines[i].replace(/^#\s+/, "").trim();
    const filename = String(title || "").trim();
    const sameGeneratedTitle = heading === filename
      || (filename.startsWith(heading) && /^[（(]/.test(filename.slice(heading.length).trimStart()));
    if (!sameGeneratedTitle) return original;
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    if (next < lines.length && !isReadingHighlightsHeading(lines[next]) && !/^## (?:旧版摘录|Старые цитаты)\s*$/.test(lines[next])) return original;
    lines.splice(i, next - i);
    return lines.join("\n").replace(/^(---\n[\s\S]*?\n---)\n{3,}/, "$1\n\n");
  }
  function bookNoteFromFrontmatter(plugin, bookFile) {
    try {
      const { app } = plugin || {};
      if (!app || !bookFile) { return ""; }
      const want = path(bookFile.path);
      const baseName = bookFile.basename;
      const candidates = app.vault.getMarkdownFiles();
      for (const md of candidates) {
        // A generic `book` property means only "related to this book". It must
        // never promote a person/project/template note to the canonical reading
        // note. Only notes explicitly marked by Book Reader are eligible.
        if (!isMarkedReadingNote(app, md)) continue;
        const cache = app.metadataCache.getFileCache(md);
        const meta = cache && cache.frontmatter;
        if (!meta) continue;
        const value = meta.book != null ? meta.book : meta["annotation-target"];
        if (!value) { continue; }
        const target = String(value).trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
        if (!target) { continue; }
        if (path(target) === want || target === baseName) return md.basename;
      }
    } catch {
      // scanning vault frontmatter is best-effort; it must never disturb reading
    }
    return "";
  }
  async function writeBookProperty(app, noteName, bookFile) {
    try {
      if (!noteName || !bookFile) return;
      const note = resolveBookNote(app, noteName);
      if (!note) return;
      await app.fileManager.processFrontMatter(note, (fm) => {
        fm.book = `[[${bookFile.path}]]`;
        if (!fm.type) fm.type = "reading-note";
        fm["book-reader-note"] = true;
      });
    } catch (e) {
      console.warn("UV Reader: could not write the book property into the note", e);
    }
  }
  function flattenSelectionText(raw) {
    return (raw || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  }


  return {
    _readerSettings,
    noteTemplatePath,
    bookNoteTemplatePath,
    notesFolderPath,
    bookNotesFolderPath,
    inboxNotePath,
    resolveNotesFolder,
    bookNoteFiles,
    resolveBookNote,
    BookNotePicker,
    BookQuickOpen,
    TemplatePicker,
    vaultFolders,
    FolderPicker,
    FolderSuggest,
    attachFolderSuggest,
    attachPathInput,
    addFolderPathControl,
    addMarkdownFilePathControl,
    sanitizeNoteTitle,
    suggestNoteTitle,
    bindSettingsTabKeys,
    parseNoteTags,
    allVaultTags,
    processTemplateManually,
    bookNoteLinkFor,
    isUnsafeReadingNote,
    isMarkedReadingNote,
    stripGeneratedReadingNoteTitle,
    bookNoteFromFrontmatter,
    writeBookProperty,
    flattenSelectionText,
  };
}
