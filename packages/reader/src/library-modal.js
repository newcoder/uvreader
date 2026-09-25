// LibraryModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { STARTER_BOOKS } from "./starter-book-data.js";
import { coverFromBytes } from "./reader-engine.js";
import { coverPalette } from "./book-cover.js";
import { docOf } from "./reader-dom.js";
import { findStarterBook } from "./starter-library.js";
import { svgIcon } from "./reader-icons.js";

export function createLibraryModal({
  Menu, Modal, Notice, TFile, BOOK_EXTENSIONS, IMPORT_MIME_EXT, addBookFileMenu, bookNoteLinkFor, bookStatusOf, bookTagsOf, buildLibChips, deleteBookFromVault, filterLibBooks, openOrCreateBookNoteBeside, qiaomuReaderLibTheme, qiaomuReaderLocale, qiaomuReaderPath, qiaomuReaderTranslate, readerHud, resolveBookNote, setupWorker,
}) {
  return class LibraryModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  async onOpen() { const { modalEl, contentEl } = this;
    const render = this._libraryRender = {};
    contentEl.empty();
    // The stylesheet matches `.qiaomu-reader-modal-lib .modal`, so the marker
    // class must sit on the modal element itself, not only the outer container.
    this.containerEl.addClass("qiaomu-reader-modal-lib");
    modalEl.addClass("qiaomu-reader-modal-lib");
    contentEl.addClass("qiaomu-reader-lib");
    this._applyLibTheme(modalEl);
    const hdr = this._buildLibBrand(contentEl); this._setupDropZone();
    const { input } = this._buildLibTools(hdr);
    try { await this.plugin.ensureStarterBooks(); }
    catch (error) {
      console.warn("UV Reader: starter books could not be installed", error);
      new Notice(qiaomuReaderTranslate("starter-books-failed"));
    }
    if (!contentEl.isConnected || this._libraryRender !== render) return;
    const refreshed = this.plugin.refreshProgress();
    await refreshed;
    if (!contentEl.isConnected || this._libraryRender !== render) return;
    const folder = qiaomuReaderPath(this.plugin.settings.booksFolder);
    const files = this._libVaultBooks(folder);
    if (files.length === 0) {
      this._buildLibEmpty(contentEl, folder);
      return;
    }
    this._sortLibBooks(files);
    const chipRow = contentEl.createDiv("qiaomu-reader-lib-chips"), grid = contentEl.createDiv("qiaomu-reader-lib-grid");
    this._grid = grid;
    const progressOf = (p) => this.plugin.getProgress(p);
    const tagsOf = (p) => bookTagsOf(this.plugin.settings, p);
    let selected = this.plugin.settings.libCategory || "all";
    const marked = new Set(files.filter(f => this.plugin.getHighlights(f.path).length).map(f => f.path));
    const rebuildChips = () => {
      const items = buildLibChips(files, folder, progressOf, tagsOf, selected);
      if (marked.size) items.splice(1, 0, { id: "study:highlights", label: qiaomuReaderTranslate("library-with-highlights"), count: marked.size });
      return items;
    };
    let chips = rebuildChips();
    if (!chips.some((c) => c.id === selected)) {
      selected = "all";
      chips = rebuildChips();
    }
    const redraw = (query) => {
      grid.empty();
      const shown = filterLibBooks(files, selected, query, folder, progressOf, tagsOf)
        .filter(f => selected !== "study:highlights" || marked.has(f.path));
      if (shown.length === 0) {
        grid.createDiv("qiaomu-reader-lib-noresult").setText(qiaomuReaderTranslate("nothing-found"));
        return;
      }
      if (selected === "all" && !query.trim()) {
        const recent = files.find(f => bookStatusOf(progressOf(f.path)) === "reading");
        if (recent) this._buildLibResume(grid, recent);
      }
      shown.forEach((f) => this.renderCard(grid, f));
    };
    const drawChipRow = () => {
      chips = rebuildChips();
      chipRow.empty();
      if (chips.length <= 1) {
        chipRow.addClass("qiaomu-reader-hidden");
        return;
      }
      chipRow.removeClass("qiaomu-reader-hidden");
      for (const c of chips) {
        const el = chipRow.createDiv("qiaomu-reader-lib-chip");
        const [labelText, countText] = [c.label, String(c.count)];
        el.createSpan({ text: labelText });
        el.createSpan({ cls: "qiaomu-reader-lib-chip-n", text: countText });
        this._setAttrs(el, { role: "button", tabindex: "0", "aria-pressed": String(c.id === selected) });
        if (c.sub) el.addClass("qiaomu-reader-lib-chip-sub");
        if (c.id === selected) el.addClass("qiaomu-reader-lib-chip-on");
        this._activateOnClick(el, () => activateChip(c));
      }
    };
    const activateChip = async (c) => {
      this.plugin.settings.libCategory = selected = c.id;
      await this.plugin._saveLocalData(); drawChipRow(); redraw(input.value);
    };
    drawChipRow();
    input.addEventListener("input", () => redraw(input.value));
    redraw("");
    readerHud.autoFocus(input, 60);
    readerHud.blurOnTapOutside(this.contentEl, input);
  }
  _applyLibTheme(modalEl) {
    const theme = qiaomuReaderLibTheme(this.plugin.settings);
    const vars = {
      "--qiaomu-reader-lib-bg": theme.bg,
      "--qiaomu-reader-lib-text": theme.text,
      "--qiaomu-reader-lib-card": theme.ui,
      "--qiaomu-reader-lib-border": theme.border,
      "--qiaomu-reader-lib-accent": theme.accent,
      "--qiaomu-reader-lib-muted": theme.muted
    };
    for (const [name, value] of Object.entries(vars)) modalEl.style.setProperty(name, value);
  }
  _setAttrs(el, attrs) {
    for (const name of Object.keys(attrs)) el.setAttribute(name, attrs[name]);
  }
  // Click plus Enter/Space activation for pseudo-button divs.
  _activateOnClick(el, handler) {
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); handler(); }
    });
  }
  _buildLibBrand(contentEl) {
    const hdr = contentEl.createDiv("qiaomu-reader-lib-hdr");
    const headline = hdr.createDiv("qiaomu-reader-lib-headline");
    const brand = headline.createDiv("qiaomu-reader-lib-brand");
    const mark = brand.createDiv("qiaomu-reader-lib-logo");
    svgIcon(mark, "qiaomu-library");
    const hw = brand.createDiv("qiaomu-reader-lib-hw");
    hw.createDiv("qiaomu-reader-lib-title").setText(qiaomuReaderTranslate("library"));

    // Primary action: import book files into the library folder.
    const add = headline.createDiv("qiaomu-reader-lib-add");
    const addText = qiaomuReaderTranslate("add-a-book");
    this._setAttrs(add, { role: "button", tabindex: "0" });
    add.setAttribute("aria-label", addText);
    svgIcon(add, "plus");
    add.createSpan({ cls: "qiaomu-reader-lib-add-label", text: addText });
    this._activateOnClick(add, () => this._pickBooks());
    return hdr;
  }
  _buildLibTools(hdr) {
    const tools = hdr.createDiv("qiaomu-reader-lib-tools");
    const search = tools.createDiv("qiaomu-reader-lib-search");
    const searchIcon = search.createDiv("qiaomu-reader-lib-search-ic");
    svgIcon(searchIcon, "search");
    const input = search.createEl("input", { cls: "qiaomu-reader-lib-search-input", attr: { type: "text", placeholder: qiaomuReaderTranslate("search-a-book"), spellcheck: "false" } });
    return { input };
  }
  _libVaultBooks(folder) {
    const prefix = folder ? `${folder}/` : "";
    return this.app.vault.getFiles().filter((f) => BOOK_EXTENSIONS.has(f.extension) && (prefix === "" || f.path.startsWith(prefix)));
  }
  _sortLibBooks(bookFiles) {
    const lastRead = (p) => this.plugin.getProgress(p)?.lastRead ?? 0;
    bookFiles.sort((a, b) => {
      const pa = lastRead(a.path), pb = lastRead(b.path);
      if (pb !== pa) return pb - pa;
      return a.basename.localeCompare(b.basename, "ru");
    });
  }
  _buildLibEmpty(contentEl, folder) {
    const box = contentEl.createDiv("qiaomu-reader-lib-empty");
    const mark = box.createDiv("qiaomu-reader-lib-empty-icon");
    svgIcon(mark, "qiaomu-library");
    box.createDiv("qiaomu-reader-lib-empty-text").setText(qiaomuReaderTranslate("no-books"));
    box.createDiv("qiaomu-reader-lib-empty-hint").setText(folder || qiaomuReaderTranslate("all-vault-folders"));
    const add = box.createDiv("qiaomu-reader-lib-empty-add");
    this._setAttrs(add, { role: "button", tabindex: "0" });
    svgIcon(add, "plus");
    add.createSpan({ text: qiaomuReaderTranslate("add-a-book") });
    this._activateOnClick(add, () => this._pickBooks());
    const samples = box.createEl("button", { text: qiaomuReaderTranslate("add-starter-books") });
    samples.addEventListener("click", async () => {
      samples.disabled = true;
      try { await this.plugin.ensureStarterBooks(true); this.contentEl.empty(); await this.onOpen(); }
      catch { samples.disabled = false; new Notice(qiaomuReaderTranslate("starter-books-failed")); }
    });
  }
  _pickBooks() {
    const doc = docOf(this.contentEl);
    const inp = doc.createElement("input");
    inp.type = "file";
    inp.accept = [...BOOK_EXTENSIONS].map((e) => "." + e).join(",") + ",application/pdf,application/epub+zip";
    inp.multiple = true;
    inp.addClass("qiaomu-reader-hidden");
    inp.addEventListener("change", async () => {
      const files = Array.from(inp.files || []);
      inp.remove();
      await this._importBooks(files);
    });
    doc.body.appendChild(inp);
    inp.click();
  }
  _setupDropZone() {
    if (this._dropBound) { return; }
    this._dropBound = true; const host = this.modalEl;
    const overlay = host.createDiv("qiaomu-reader-lib-drop");
    const inner = overlay.createDiv("qiaomu-reader-lib-drop-inner");
    svgIcon(inner, "plus"); inner.createSpan({ text: qiaomuReaderTranslate("drop-the-files-to-add-them-to-your-library") });
    let depth = 0; const carriesFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const onEnter = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); depth += 1;
      host.addClass("qiaomu-reader-lib-dragging");
    };
    const onOver = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) host.removeClass("qiaomu-reader-lib-dragging");
    };
    const onDrop = async (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); depth = 0;
      host.removeClass("qiaomu-reader-lib-dragging");
      await this._importBooks(this._usableDropFiles(e));
    };
    host.addEventListener("dragenter", onEnter);
    host.addEventListener("dragover", onOver);
    host.addEventListener("dragleave", onLeave);
    host.addEventListener("drop", onDrop);
  }
  _usableDropFiles(e) {
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
    const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const probeEntries = items.length === dropped.length && typeof items[0]?.webkitGetAsEntry === "function";
    if (!probeEntries) {
      return dropped;
    }
    const usable = dropped.filter((f, i) => {
      const item = items[i];
      const entry = item.webkitGetAsEntry();
      const keep = !entry || entry.isFile;
      return keep;
    });
    const skippedFolders = dropped.length - usable.length;
    if (skippedFolders) new Notice(qiaomuReaderTranslate("folders-were-skipped-drop-the-book-files-themselves-0", skippedFolders));
    return usable;
  }
  _targetDir() {
    const set = qiaomuReaderPath(this.plugin.settings.booksFolder || "");
    if (set) return set;
    const exts = [...BOOK_EXTENSIONS];
    const counts = new Map();
    for (const f of this.app.vault.getFiles()) {
      if (!exts.includes(f.extension)) continue;
      const dir = f.parent && f.parent.path && f.parent.path !== "/" ? f.parent.path : "";
      counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    let best = "", bestN = -1;
    for (const [dir, n] of counts) if (n > bestN) { best = dir; bestN = n; }
    return best;
  }
  _freeBookPath(dir, name) {
    const clean = (name || "book").replace(/[\\/:*?"<>|\n\r\t]/g, "_").trim() || "book";
    const dot = clean.lastIndexOf(".");
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    // Every constructed vault path goes through normalizePath (qiaomuReaderPath). This one
    const join = (b) => qiaomuReaderPath((dir ? dir + "/" : "") + b + ext);
    let p = join(base), i = 1;
    while (this.app.vault.getAbstractFileByPath(p)) p = join(`${base} (${i++})`);
    return p;
  }
  async _importBooks(incoming) {
    const exts = [...BOOK_EXTENSIONS];
    const batch = incoming || [];
    const detectExt = (f) => {
      const label = (f && f.name) || (f && f.path ? String(f.path).split(/[\\/]/).pop() : "");
      const stem = String(label || "").trim().replace(/[.\s]+$/, "");
      const dot = stem.lastIndexOf(".");
      const ext = dot > 0 ? stem.slice(dot + 1).toLowerCase() : "";
      if (exts.includes(ext)) return ext;
      const rawType = f && f.type;
      const mime = String(rawType || "").toLowerCase();
      if (IMPORT_MIME_EXT.has(mime)) return IMPORT_MIME_EXT.get(mime);
      return ext;
    };
    const picked = [], rejected = [];
    for (const f of batch) {
      if (exts.includes(detectExt(f))) picked.push(f);
      else rejected.push(f);
    }
    if (rejected.length !== 0) {
      const describeRejected = (f) => {
        const label = (f && f.name) || (f && f.path) || "?";
        const seen = detectExt(f) || "—";
        const mimeNote = f && f.type ? ", " + f.type : "";
        return `${label} [${seen}${mimeNote}]`;
      };
      const detail = rejected.slice(0, 5).map(describeRejected).join("; ");
      console.warn("UV Reader: rejected on import —", rejected.map((f) => ({
        name: f && f.name,
        path: f && f.path,
        type: f && f.type,
        size: f && f.size,
        seenAs: detectExt(f)
      })));
      new Notice(qiaomuReaderTranslate("not-accepted-0-1-supported-formats-are-epub-pdf-fb2-mobi-azw3-an", rejected.length, detail), 10000);
    }
    if (picked.length === 0) {
      if (!rejected.length) new Notice(qiaomuReaderTranslate("no-files-selected"));
      return;
    }
    const target = this._targetDir();
    if (target && !this.app.vault.getAbstractFileByPath(target)) {
      const making = this.app.vault.createFolder(target);
      await making.catch(() => {});
    }
    let ok = 0; const errors = [];
    for (const item of picked) {
      try {
        const data = await item.arrayBuffer();
        await this.app.vault.createBinary(this._freeBookPath(target, item.name), data);
        ok += 1;
      } catch (error) {
        errors.push(item.name);
        console.warn("UV Reader: could not import", item && item.name, error);
      }
    }
    if (ok) new Notice(qiaomuReaderTranslate("books-added-0", ok) + (rejected.length ? " · " + qiaomuReaderTranslate("skipped-0", rejected.length) : ""));
    if (errors.length) new Notice(qiaomuReaderTranslate("could-not-add-0", errors.join(", ")));
    if (ok > 0) this._refresh();
  }
  _refresh() {
    this.contentEl.empty();
    this.onOpen();
  }
  _buildLibResume(host, file) {
    const row = host.createDiv("qiaomu-reader-lib-resume");
    const text = row.createDiv("qiaomu-reader-lib-resume-copy");
    text.createDiv({ cls: "qiaomu-reader-lib-resume-label", text: qiaomuReaderTranslate("library-continue") });
    text.createDiv({ cls: "qiaomu-reader-lib-resume-title", text: file.basename });
    const excerpt = this.plugin.getHighlights(file.path).filter(h => h.text).at(-1);
    if (excerpt) text.createDiv({ cls: "qiaomu-reader-lib-resume-quote", text: excerpt.text });
    const button = row.createEl("button", { cls: "qiaomu-reader-lib-resume-button", text: qiaomuReaderTranslate("library-continue") });
    svgIcon(button.createSpan(), "arrow-right");
    button.addEventListener("click", () => { this.close(); void this.plugin.openFile(file); });
  }
  async _openLibHighlights(file) {
    const request = this._highlightOpenRequest = {};
    this.close();
    const view = await this.plugin.openFile(file);
    const deadline = Date.now() + 15000;
    while (this._highlightOpenRequest === request && !view?._closed && Date.now() < deadline
      && (view?.file?.path !== file.path || view._openingBook || !view.hlPan)) {
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    if (this._highlightOpenRequest !== request || view?._closed || view?.file?.path !== file.path) return;
    if (view._openingBook || !view.hlPan) { new Notice(qiaomuReaderTranslate("could-not-open-the-book")); return; }
    if (view.panelOpen !== "highlights") (view.togglePanel || view._togglePanel).call(view, "highlights");
  }
  _libCardMenu(file) {
    const removeItem = (menu) => menu.addItem((it) => it.setTitle(qiaomuReaderTranslate("delete-book")).setIcon("trash").onClick(() => {
      const afterGone = () => this._refresh();
      deleteBookFromVault(this.app, this.plugin, file, afterGone);
    }));
    return (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const menu = addBookFileMenu(this.app, new Menu(), file, this.plugin);
      menu.addSeparator(); removeItem(menu);
      menu.showAtMouseEvent(ev);
    };
  }
  renderCard(host, file) {
    const bookPath = file.path;
    const prog = this.plugin.getProgress(bookPath);
    const pct = prog?.percent ?? 0;
    const card = host.createDiv("qiaomu-reader-lib-card");
    this._setAttrs(card, { role: "group", tabindex: "0" });
    card.setAttribute("aria-label", qiaomuReaderTranslate("open-book-0", file.basename));
    const cover = card.createDiv("qiaomu-reader-lib-cover");
    const settings = this.plugin.settings;
    const fits = settings.coverFits ?? (settings.coverFits = {});
    if (fits[bookPath] === "fill") cover.addClass("qiaomu-reader-fit-fill");
    const ph = cover.createDiv("qiaomu-reader-lib-ph");
    const [paper, ink] = coverPalette(file.basename);
    ph.style.setProperty("--qbr-cover-paper", paper);
    ph.style.setProperty("--qbr-cover-ink", ink);
    ph.createDiv("qiaomu-reader-lib-ph-ext").setText(file.extension.toUpperCase());
    ph.createDiv("qiaomu-reader-lib-ph-title").setText(file.basename);
    void this.loadThumb(file, cover, ph);
    const fitBtn = cover.createEl("button", { cls: "qiaomu-reader-lib-fitbtn", attr: { type: "button" } });
    fitBtn.setAttribute("aria-label", qiaomuReaderTranslate("cover-fit"));
    const refreshFitView = () => {
      const fill = cover.hasClass("qiaomu-reader-fit-fill");
      const [mode, glyph] = fill ? ["cover", "cover-fit"] : ["contain", "cover-fill"];
      cover.style.setProperty("background-size", mode, "important");
      svgIcon(fitBtn, glyph);
    };
    refreshFitView();
    fitBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const nowFill = !cover.hasClass("qiaomu-reader-fit-fill");
      cover.toggleClass("qiaomu-reader-fit-fill", nowFill);
      if (nowFill) fits[bookPath] = "fill";
      else delete fits[bookPath];
      refreshFitView();
      void this.plugin.saveAll();
    });
    const showStrip = pct > 0;
    if (showStrip) {
      const strip = cover.createDiv("qiaomu-reader-lib-strip");
      strip.createDiv("qiaomu-reader-lib-strip-fill").style.width = `${pct}%`;
    }
    const info = card.createDiv("qiaomu-reader-lib-info");
    info.createDiv("qiaomu-reader-lib-book-title").setText(file.basename);
    const meta = info.createDiv("qiaomu-reader-lib-book-meta");
    if (prog?.lastRead) {
      const day = new Date(prog.lastRead).toLocaleDateString(qiaomuReaderLocale(), { day: "numeric", month: "short" });
      meta.setText(`${pct}% · ${day}`);
    } else {
      meta.setText(qiaomuReaderTranslate("not-started-2"));
    }
    const actions = info.createDiv("qiaomu-reader-lib-study");
    const highlights = this.plugin.getHighlights(bookPath);
    const highlightsButton = actions.createEl("button", { cls: "qiaomu-reader-lib-study-button", text: qiaomuReaderTranslate("library-highlight-count", highlights.length) });
    highlightsButton.addEventListener("click", ev => { ev.stopPropagation(); void this._openLibHighlights(file); });
    const noteName = bookNoteLinkFor(this.plugin, file);
    const hasNote = noteName && resolveBookNote(this.app, noteName);
    const notesButton = actions.createEl("button", { cls: "qiaomu-reader-lib-study-button", text: qiaomuReaderTranslate(hasNote ? "library-open-note" : "library-create-note") });
    notesButton.addEventListener("click", ev => { ev.stopPropagation(); this.close(); void openOrCreateBookNoteBeside(this.plugin, file); });
    const openBook = () => {
      this.close();
      void this.plugin.openFile(file);
    };
    const bookMenu = this._libCardMenu(file); card.addEventListener("contextmenu", bookMenu);
    const menuBtn = cover.createEl("button", { cls: "qiaomu-reader-lib-morebtn", attr: { type: "button" } });
    menuBtn.setAttribute("aria-label", qiaomuReaderTranslate("book-actions"));
    svgIcon(menuBtn, "more");
    menuBtn.addEventListener("click", bookMenu);
    card.addEventListener("click", ev => { if (!ev.target.closest("button")) openBook(); });
    card.addEventListener("keydown", ev => {
      if (ev.target === card && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openBook(); }
    });
  }
  async loadThumb(bookFile, coverEl, placeholder) {
    const own = this.coverFromBookNote(bookFile);
    if (own && await this.showImg(coverEl, placeholder, own)) return;
    const cached = this.plugin.thumbCache[bookFile.path];
    // Old caches persisted object URLs that die with their creating window.
    if (cached && !cached.startsWith("blob:") && await this.showImg(coverEl, placeholder, cached)) return;
    const prior = this._thumbQueue || Promise.resolve();
    this._thumbQueue = prior.then(async () => {
      const again = this.plugin.thumbCache[bookFile.path];
      if (again && !again.startsWith("blob:") && await this.showImg(coverEl, placeholder, again)) return;
      try {
        const url = bookFile.extension === "pdf"
          ? await this.makePdfThumb(bookFile)
          : await this.makeEngineThumb(bookFile);
        if (!url) { return; }
        this.plugin.thumbCache[bookFile.path] = url; this._thumbDirty = true;
        await this.showImg(coverEl, placeholder, url);
      } catch (e) {
        console.warn("UV Reader: cover failed for", bookFile.path, e);
      }
    }).then(() => this._scheduleThumbFlush());
    const queued = this._thumbQueue;
    return queued;
  }
  _scheduleThumbFlush() {
    window.clearTimeout(this._thumbSaveT); this._thumbSaveT = window.setTimeout(() => this._flushThumbs(), 800);
  }
  _flushThumbs() {
    if (!this._thumbDirty) {
      return;
    }
    this._thumbDirty = false;
    this.plugin._saveThumbCache();
  }
  coverFromBookNote(bookFile) {
    try {
      const name = bookNoteLinkFor(this.plugin, bookFile);
      if (!name) {
        return null;
      }
      const linked = resolveBookNote(this.app, name);
      if (!linked) {
        return null;
      }
      const fm = this.app.metadataCache.getFileCache(linked)?.frontmatter;
      if (!fm) {
        return null;
      }
      const raw = fm.cover ?? fm.обложка
        ?? fm.Cover ?? fm.Обложка;
      const first = Array.isArray(raw) ? raw[0] : (raw ?? "");
      const val = String(first).trim();
      if (!val) {
        return null;
      }
      if (/^https?:\/\//i.test(val)) {
        return val;
      }
      const wiki = (val.match(/^!?\[\[([^\]|#]+)/) || [])[1];
      const inner = wiki || val;
      const img = this.app.metadataCache.getFirstLinkpathDest(inner.trim(), linked.path)
        || this.app.vault.getAbstractFileByPath(qiaomuReaderPath(inner.trim()));
      if (!(img instanceof TFile)) {
        return null;
      }
      return this.app.vault.getResourcePath(img);
    } catch {
      return null;
    }
  }
  async showImg(coverEl, ph, src) {
    if (!src) return false;
    const image = docOf(coverEl).createElement("img");
    image.src = src;
    let timer;
    const loaded = await Promise.race([
      image.decode().then(() => true, () => false),
      new Promise(resolve => { timer = window.setTimeout(() => resolve(false), 5000); }),
    ]);
    window.clearTimeout(timer);
    if (!loaded || !coverEl.isConnected) return false;
    ph.addClass("qiaomu-reader-hidden");
    coverEl.style.setProperty("background-image", `url("${src.replace(/"/g, '\\"')}")`, "important");
    coverEl.addClass("qiaomu-reader-cover-img");
    coverEl.style.setProperty("background-size", coverEl.hasClass("qiaomu-reader-fit-fill") ? "cover" : "contain", "important");
    coverEl.addClass("qiaomu-reader-has-cover");
    return true;
  }
  async makePdfThumb(pdfFile) {
    await setupWorker(this.app); const bytes = await this.app.vault.readBinary(pdfFile);
    return this._renderPdfCover(bytes);
  }
  async _renderPdfCover(bytes) {
    const loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
    try {
      const doc = await loadingTask.promise;
      const firstPage = await doc.getPage(1);
      const vp = firstPage.getViewport({ scale: this._pdfCoverScale(firstPage) });
      const cv = docOf(this.contentEl).createElement("canvas");
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      const task = firstPage.render({ canvasContext: ctx, viewport: vp });
      await task.promise;
      const shot = cv.toDataURL("image/jpeg", 0.85);
      return shot;
    } finally {
      await loadingTask.destroy();
    }
  }
  _pdfCoverScale(page) {
    const unit = page.getViewport({ scale: 1 });
    return Math.min(2.5, Math.max(1, 520 / (unit.width || 400)));
  }
  // MOBI/AZW3/FB2/FBZ/CBZ covers come from the rendering engine's own parser,
  // which knows where each container format hides its embedded cover image.
  async makeEngineThumb(file) {
    const buf = await this.app.vault.readBinary(file);
    const blob = await coverFromBytes(buf, file.name, async metadata => {
      const starter = findStarterBook(metadata, STARTER_BOOKS);
      if (!starter) return null;
      // Read the current bundled edition's artwork; never overwrite the user's
      // older EPUB or use title matching to substitute another edition's cover.
      const bytes = Uint8Array.from(atob(starter.data), char => char.charCodeAt(0));
      return coverFromBytes(bytes, starter.filename);
    });
    if (!blob) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  onClose() {
    this._libraryRender = null;
    // Flush any covers generated this session before the library closes.
    window.clearTimeout(this._thumbSaveT);
    if (this._thumbDirty) { this._thumbDirty = false; this.plugin.saveAll(); }
    this.contentEl.empty();
  }
};
}
