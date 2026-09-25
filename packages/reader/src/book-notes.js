// Book notes: creation from selections and AI answers, highlight export,
// reading-note synchronisation and book-file actions. Host bits (Notice,
// TFile, modal factories, translation and path helpers) are injected.

import { composeAiAnswerNote } from "./ai-note.js";
import { suggestAiNoteTitle } from "./ai-note-title.js";
import { aiAnswerMarker, appendAiAnswer } from "./reading-workflow.js";
import { appendReadingNoteExcerpts, migrateAndReplaceReadingHighlights, replaceManagedReadingHighlights } from "./reading-note.js";
import { highlightBacklink } from "./highlight-navigation.js";

export function createBookNotes({
  translate,
  path,
  Notice,
  TFile,
  getHlColors,
  normalizeAiTurnContext,
  readerSettings,
  getWhatsNew,
  noteTemplatePath,
  bookNotesFolderPath,
  notesFolderPath,
  inboxNotePath,
  resolveNotesFolder,
  resolveBookNote,
  bookNoteLinkFor,
  sanitizeNoteTitle,
  suggestNoteTitle,
  isUnsafeReadingNote,
  flattenSelectionText,
  processTemplateManually,
  getNoteTitleModal,
  getConfirmModal,
  getHighlightExportModal,
}) {
  async function appendLinkToBookNote(app, plugin, bookFile, newFile, headingOverride = "") {
    try {
      const linkName = bookNoteLinkFor(plugin, bookFile);
      if (!linkName) return;
      const noteFile = resolveBookNote(app, linkName);
      if (!noteFile || noteFile.path === newFile.path) { return; }
      const heading = headingOverride || translate("notes-from-highlights");
      const entry = `- [[${newFile.basename}]]`;
      const attach = (data) => {
        const trimmed = data.replace(/\s*$/, "");
        return data.includes(heading) ? `${trimmed}\n${entry}\n` : `${trimmed}\n\n${heading}\n${entry}\n`;
      };
      await writeNoteText(app, noteFile, attach);
    } catch (e) {
      console.error("UV Reader: append to book note failed", e);
    }
  }

  const SELECTION_CURSOR_SPOT = /<%\s*tp\.file\.cursor\([^)]*\)\s*%>/;
  const SELECTION_CURSOR_SPOT_ALL = /<%\s*tp\.file\.cursor\([^)]*\)\s*%>/g;

  // Vault writes go through process() when available so concurrent edits survive.
  async function writeNoteText(app, file, reshaped) {
    if (typeof app.vault.process === "function") return app.vault.process(file, reshaped);
    return app.vault.modify(file, reshaped(await app.vault.read(file)));
  }

  function promptForNoteTitle(app, plugin, fragment, bookFile, kind) {
    return new Promise((resolve) => {
      new (getNoteTitleModal())(app, plugin, fragment, bookFile, resolve, { kind }).open();
    });
  }

  function firstFreeNoteName(app, base, folder, reserved) {
    let name = base;
    for (let n = 2; app.vault.getAbstractFileByPath(inboxNotePath(app, name, folder)) || reserved && reserved.has(name); n++) {
      name = `${base} ${n}`;
    }
    if (reserved) reserved.add(name);
    return name;
  }

  function tagPrefix(tags) {
    return tags.length ? tags.map((t) => "#" + t).join(" ") + "\n\n" : "";
  }

  function composeExcerptQuote(app, parts, excerpt, source, tagLine) {
    if (parts.noteKind === "ai-answer") {
      return composeAiAnswerNote({
        answer: String(parts.noteBody || "").trim(),
        sourceText: String(parts.sourceText || "").trim(),
        attribution: source.trim(),
        sourceHeading: translate("original"),
        tagLine,
      });
    }
    const blockQuoted = excerpt.replace(/\n/g, "\n> ");
    const marked = parts.color ? hlMark(app, blockQuoted, parts.color) : blockQuoted;
    return `${tagLine}> ${marked}${parts.extra}${source}`;
  }

  async function renderNoteTemplate(app, templateFile, filename) {
    try {
      return processTemplateManually(await app.vault.read(templateFile), filename);
    } catch {
      // template rendering is best-effort; an unusable template means no preamble
      return "";
    }
  }

  async function createTemplatedNote(app, bookFile, folder, filename, folderChoice, quote) {
    const templater = app.plugins?.plugins?.["templater-obsidian"]?.templater;
    const tplPath = noteTemplatePath(app, bookFile);
    const templateFile = tplPath ? app.vault.getAbstractFileByPath(tplPath) : null;
    const canUseTemplater = templater && templateFile && folder && typeof templater.create_new_note_from_template === "function";
    if (canUseTemplater) {
      let made = await templater.create_new_note_from_template(templateFile, folder, filename, false);
      if (!made) made = app.vault.getAbstractFileByPath(inboxNotePath(app, filename, folderChoice));
      if (made) {
        const splice = (data) => {
          const placed = SELECTION_CURSOR_SPOT.test(data)
            ? data.replace(SELECTION_CURSOR_SPOT, `\n${quote}\n`)
            : `${data.replace(/\s*$/, "")}\n\n${quote}\n`;
          return placed.replace(SELECTION_CURSOR_SPOT_ALL, "");
        };
        await writeNoteText(app, made, splice);
      }
      return made;
    }
    const rendered = templateFile ? await renderNoteTemplate(app, templateFile, filename) : "";
    return app.vault.create(inboxNotePath(app, filename, folderChoice), `${rendered}\n\n${quote}\n`);
  }

  async function createNoteFromSelection(app, plugin, selText, bookFile, opts = {}) {
    const say = (text, ...rest) => new Notice(translate(text, ...rest));
    const { open = true, silent = false, reserved = null, color = null, extra = "", noteKind = "selection", noteBody = "", sourceText = "", bookLinkHeading = "", openMode = null, openBackground = false } = opts;
    const excerpt = flattenSelectionText(selText);
    if (!excerpt) {
      if (!silent) say("empty-highlight");
      return null;
    }
    let chosenTitle = sanitizeNoteTitle(excerpt);
    let folderChoice = null;
    let tagChoices = [];
    const wantsTitleDialog = !silent && plugin.settings.askNoteTitle !== false;
    if (wantsTitleDialog) {
      const chosen = await promptForNoteTitle(app, plugin, excerpt, bookFile, noteKind);
      if (chosen === null) { return null; }
      if (!chosen.toBookNote) {
        chosenTitle = sanitizeNoteTitle(chosen.title);
        folderChoice = chosen.folder || null;
        tagChoices = chosen.tags || [];
      } else {
        if (noteKind === "ai-answer") {
          return appendAnswerToBookNote(app, plugin, bookFile, noteBody, chosen.title || chosenTitle);
        }
        const hlInfo = opts.hl && typeof opts.hl === "object" ? opts.hl : {};
        await exportHighlightsToBookNote(app, plugin, bookFile, [
          { ...hlInfo, text: excerpt, color: color != null ? color : hlInfo.color },
        ]);
        return null;
      }
    }
    if (!wantsTitleDialog && !silent && plugin.settings.shortNoteTitles) {
      chosenTitle = sanitizeNoteTitle(suggestNoteTitle(excerpt));
    }
    const besideBook = plugin.settings.notesNextToBook && bookFile && bookFile.parent;
    if (!folderChoice && besideBook) {
      const near = path(bookFile.parent.path || "");
      if (near) folderChoice = near;
    }
    const filename = firstFreeNoteName(app, chosenTitle, folderChoice, reserved);
    const linkName = bookFile
      ? bookNoteLinkFor(plugin, bookFile) || bookFile.basename
      : "";
    const source = bookFile ? translate("from-0", linkName) : "";
    const quote = composeExcerptQuote(app, { color, extra, noteKind, noteBody, sourceText }, excerpt, source, tagPrefix(tagChoices));
    try {
      const targetFolder = await resolveNotesFolder(app, folderChoice);
      const made = await createTemplatedNote(app, bookFile, targetFolder, filename, folderChoice, quote);
      if (made) {
        if (!silent && bookFile) await appendLinkToBookNote(app, plugin, bookFile, made, bookLinkHeading);
        if (open) await openNoteBesideBook(app, plugin, made, null, { mode: openMode, background: openBackground });
        if (!silent) say("note-created");
      }
      return made;
    } catch (e) {
      console.error("UV Reader: note creation failed", e);
      if (!silent) say("could-not-create-the-note");
      return null;
    }
  }
  async function createNoteFromAiAnswer(app, plugin, answer, question, context, bookFile, opts = {}) {
    const cleanAnswer = String(answer || "").trim();
    if (!cleanAnswer) {
      new Notice(translate("the-model-returned-nothing"));
      return null;
    }
    const normalizedContext = normalizeAiTurnContext(context);
    const title = suggestAiNoteTitle(cleanAnswer, { fallback: translate("ai-reply") });
    if (opts.toBookNote) return appendAnswerToBookNote(app, plugin, bookFile, cleanAnswer, title);
    return createNoteFromSelection(app, plugin, title, bookFile, {
      ...opts,
      noteKind: "ai-answer",
      noteBody: cleanAnswer,
      sourceText: normalizedContext?.text || "",
      bookLinkHeading: translate("ai-reading-notes"),
    });
  }
  async function appendAnswerToBookNote(app, plugin, bookFile, answer, title) {
    if (!bookFile) return null;
    try {
      let note = resolveBookNote(app, bookNoteLinkFor(plugin, bookFile));
      if (!note) {
        const folder = bookNotesFolderPath(app) || notesFolderPath(app) || "";
        // A coincidental filename is not consent to modify an unrelated note.
        let name = sanitizeNoteTitle(bookFile.basename), index = 2;
        const base = name;
        while (app.vault.getAbstractFileByPath(path(`${folder}/${name}.md`))) name = `${base} ${index++}`;
        note = await plugin.createBookNote(bookFile, name, folder);
      }
      if (!(note instanceof TFile) || isUnsafeReadingNote(app, note)) throw new Error("Unsafe book note target");
      const marker = await aiAnswerMarker(bookFile.path, answer);
      await app.vault.process(note, (text) => appendAiAnswer(text, { title: sanitizeNoteTitle(title), answer, marker }));
      new Notice(translate("ai-reply-appended-to-the-book-note"));
      return note;
    } catch (error) {
      console.error("UV Reader: answer append failed", error);
      new Notice(translate("could-not-append-the-reply-existing-notes-were-not-overwritten-c"));
      return null;
    }
  }
  function _escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function hlMark(app, text, colorId) {
    const c = getHlColors().find((x) => x.id === colorId);
    if (!c || readerSettings(app).exportColors === false) return text;
    return `<mark style="background:${c.css}">${_escHtml(text)}</mark>`;
  }
  function normalizeHlText(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/==+/g, " ").replace(/^\s*>+\s?/gm, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function splitExportedHighlights(noteText, highlights) {
    const hay = normalizeHlText(noteText);
    const fresh = [], already = [];
    for (const hl of highlights || []) {
      const needle = normalizeHlText(hl && hl.text);
      if (needle && hay && hay.includes(needle)) already.push(hl);
      else fresh.push(hl);
    }
    return { fresh, already };
  }
  async function openNoteBesideBook(app, plugin, file, line, opts = {}) {
    const mode = opts.mode || plugin && plugin.settings && plugin.settings.noteOpenMode || "split";
    if (mode === "none" || !file) return null;
    const back = opts.background === true;
    const prev = back ? app.workspace.getMostRecentLeaf() : null;
    const leaf = app.workspace.getLeaf(mode === "tab" ? "tab" : "split");
    await leaf.openFile(file, back ? { active: false } : void 0);
    if (back && prev) app.workspace.setActiveLeaf(prev, { focus: true });
    if (typeof line === "number" && line > 0) {
      try {
        const view = leaf.view;
        if (view && view.editor) view.editor.setCursor({ line, ch: 0 });
      } catch { /* optional step; a failure here must not interrupt reading */ }
    }
    return leaf;
  }
  async function openOrCreateBookNoteBeside(plugin, bookFile) {
    if (!(plugin && bookFile)) return null;
    let name = bookNoteLinkFor(plugin, bookFile);
    let note = name ? resolveBookNote(plugin.app, name) : null;
    if (!(note instanceof TFile)) {
      if (name && plugin.settings.bookNoteLinks) delete plugin.settings.bookNoteLinks[bookFile.path];
      note = await plugin.ensureBookNote(bookFile);
    }
    if (!(note instanceof TFile)) {
      new Notice(translate("could-not-open-the-book-note"));
      return null;
    }
    const openLeaf = plugin.app.workspace.getLeavesOfType("markdown")
      .find((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === note.path);
    if (openLeaf) {
      plugin.app.workspace.revealLeaf(openLeaf);
      return openLeaf;
    }
    if (typeof plugin.app.qbrDesktopOpenNote === "function") return plugin.app.qbrDesktopOpenNote(note, plugin);
    return openNoteBesideBook(plugin.app, plugin, note, null, { mode: "split" });
  }
  function addBookFileMenu(app, menu, file, plugin = null) {
    if (!file) return menu;
    menu.addSeparator();
    // The reading note is no longer a tray button: the book's own menus carry
    // it, so the toolbar stays about reading.
    if (plugin) {
      menu.addItem((it) => it.setTitle(translate("the-book-note")).setIcon("file-text").onClick(() => {
        void openOrCreateBookNoteBeside(plugin, file);
      }));
    }
    menu.addItem((it) => it.setTitle(translate("reveal-in-file-explorer")).setIcon("folder-open").onClick(() => {
      const explorer = app.workspace.getLeavesOfType("file-explorer")[0];
      if (!explorer) return;
      app.workspace.revealLeaf(explorer);
      const tree = explorer.view;
      if (tree && typeof tree.revealInFolder === "function") tree.revealInFolder(file);
    }));
    app.workspace.trigger("file-menu", menu, file, "qiaomu-reader");
    return menu;
  }
  // Path-keyed stores have to forget the removed book, otherwise stale progress,
  // backups, highlights and cover fits resurface if the path is ever reused.
  async function dropBookState(plugin, bookPath) {
    const stores = [plugin.progress, plugin.progressBackups, plugin.highlights, plugin.settings && plugin.settings.coverFits];
    for (const store of stores) if (store) delete store[bookPath];
    return plugin.saveAll();
  }
  function deleteBookFromVault(app, plugin, file, onDone) {
    if (!file) {
      return;
    }
    const wipe = async () => {
      try {
        const trash = app.fileManager.trashFile(file);
        await trash;
        await dropBookState(plugin, file.path);
        new Notice(translate("book-deleted-0", file.basename));
        if (typeof onDone === "function") onDone();
      } catch (e) {
        console.error("UV Reader: delete book failed", e);
        new Notice(translate("could-not-delete-the-book"));
      }
    };
    const confirmDelete = new (getConfirmModal())(app, {
      title: translate("delete-the-book"),
      body: translate("0-will-be-deleted-from-the-vault-together-with-its-reading-progr", file.basename),
      okText: translate("delete"),
      cancelText: translate("cancel"),
      onYes: wipe
    });
    confirmDelete.open();
  }
  const QUOTE_TEMPLATE_DEFAULT = "> {text}\n\n— [[{book}]]{page}{link}";
  // Keep the backlink useful without inserting interface prose into the reader's
  // notes. The arrow is the complete visible label; old custom text settings are
  // intentionally ignored so copied quotations stay clean.
  function backlinkLabel() { return "↩"; }
  function quoteMarkdown(plugin, hl, bookFile) {
    const clean = String(hl && hl.text || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
    if (!clean) return "";
    const bookName = bookFile ? bookNoteLinkFor(plugin, bookFile) || bookFile.basename : "";
    const page = hl && hl.page ? translate("p-0-2", hl.page) : "";
    let link = "";
    const uri = highlightBacklink(plugin.app.vault.getName(), bookFile?.path, hl);
    if (plugin.settings.quoteBacklinks !== false && uri) {
      link = ` [${backlinkLabel()}](${uri})`;
    }
    const commentText = hl && hl.comment ? String(hl.comment).trim() : "";
    const comment = commentText ? `\n\n**${translate("comment-on-a-highlight")}：** ${commentText.replace(/\n/g, "\n\n")}` : "";
    const tpl = plugin.settings.quoteTemplate || QUOTE_TEMPLATE_DEFAULT;
    return tpl.split("{text}").join(clean + comment).split("{book}").join(bookName).split("{page}").join(page).split("{link}").join(link).split("{comment}").join(commentText).trim();
  }
  function hlCommentMd(hl) {
    const c = hl && hl.comment ? String(hl.comment).trim() : "";
    return c ? `\n\n**${translate("comment-on-a-highlight")}：** ${c.replace(/\n/g, "\n\n")}` : "";
  }
  function renderManagedReadingHighlights(plugin, bookFile, highlights) {
    const list = [...(highlights || [])].filter((hl) => hl && hl.text).sort((a, b) => (a.block || 0) - (b.block || 0) || (a.occ || 0) - (b.occ || 0));
    if (!list.length) return "";
    const rows = list.map((hl) => {
      const clean = String(hl.text).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
      let where = hl.page ? translate("p-0-3", hl.page) : "";
      const uri = highlightBacklink(plugin.app.vault.getName(), bookFile.path, hl);
      if (plugin.settings.quoteBacklinks !== false && uri) {
        where += ` [${backlinkLabel()}](${uri})`;
      }
      const comment = hl.comment
        ? `\n\n**${translate("comment-on-a-highlight")}：** ${String(hl.comment).replace(/\n/g, "\n\n")}`
        : "";
      const chapter = hl.chapter ? `**${hl.chapter}**\n\n` : "";
      return `${chapter}> ${hlMark(plugin.app, clean, hl.color)}${where}${comment}`;
    });
    return `${translate("quotes")}\n\n${rows.join("\n\n")}`;
  }
  async function syncHighlightsToReadingNote(app, plugin, bookPath, highlights, options = {}) {
    try {
      const bookFile = app.vault.getAbstractFileByPath(bookPath);
      if (!(bookFile instanceof TFile)) return;
      let name = bookNoteLinkFor(plugin, bookFile);
      if (!name && plugin.settings.autoBookNote === true) {
        const created = await plugin.ensureBookNote(bookFile);
        name = created ? created.basename : bookNoteLinkFor(plugin, bookFile);
      }
      if (!name) return;
      const note = resolveBookNote(app, name);
      if (!(note instanceof TFile) || isUnsafeReadingNote(app, note)) return;
      const block = renderManagedReadingHighlights(plugin, bookFile, highlights);
      const update = options.migrateManualExcerpts
        ? (data) => migrateAndReplaceReadingHighlights(data, block, translate("legacy-excerpts"), translate("excerpts"))
        : (data) => replaceManagedReadingHighlights(data, block, translate("legacy-excerpts"));
      if (typeof app.vault.process === "function") await app.vault.process(note, update);
      else await app.vault.modify(note, update(await app.vault.read(note)));
    } catch (e) {
      console.error("UV Reader: reading-note sync failed", e);
    }
  }
  async function exportHighlightsSeparate(app, plugin, bookFile, highlights) {
    if (!highlights || !highlights.length) {
      new Notice(translate("no-highlights-to-export"));
      return;
    }
    new Notice(translate("creating-notes-0", highlights.length));
    const reserved = /* @__PURE__ */ new Set();
    let ok = 0, fail = 0;
    for (const hl of highlights) {
      const f = await createNoteFromSelection(app, plugin, hl.text, bookFile, { open: false, silent: true, reserved, extra: hlCommentMd(hl), color: hl.color });
      if (f) ok++;
      else fail++;
    }
    new Notice(fail ? translate("notes-created-0-errors-1", ok, fail) : translate("notes-created-0", ok));
  }
  async function openNoteInTab(app, file, line) {
    const leaf = app.workspace.getLeaf("tab");
    if (!leaf) return;
    const eState = typeof line === "number" ? { line, cursor: { from: { line, ch: 0 }, to: { line, ch: 0 } }, focus: true } : void 0;
    await leaf.openFile(file, eState ? { eState } : void 0);
  }

  function collectHighlightGroups(app, plugin, bookFile, marks) {
    const grouped = [];
    for (const hl of marks) {
      const clean = flattenSelectionText(hl.text);
      if (!clean) { continue; }
      const chapter = hl.chapter ? hl.chapter : "";
      let group = grouped.find((entry) => entry.chapter === chapter);
      if (!group) {
        group = { chapter, lines: [] };
        grouped.push(group);
      }
      let where = hl.page ? translate("p-0-3", hl.page) : "";
      const uri = highlightBacklink(app.vault.getName(), bookFile?.path, hl);
      if (plugin.settings.quoteBacklinks !== false && uri) {
        where += ` [${backlinkLabel()}](${uri})`;
      }
      const comment = hl.comment
        ? `\n\n**${translate("comment-on-a-highlight")}：** ${hl.comment.replace(/\n/g, "\n\n")}`
        : "";
      group.lines.push(`> ${hlMark(app, clean, hl.color)}${where}${comment}`);
    }
    return grouped;
  }
  async function exportHighlightsToBookNote(app, plugin, bookFile, highlights) {
    const say = (text, ...rest) => new Notice(translate(text, ...rest));
    if (!(highlights && highlights.length)) {
      say("no-highlights-to-export");
      return;
    }
    const linkedName = bookFile
      ? bookNoteLinkFor(plugin, bookFile)
      : "";
    if (!linkedName) {
      say("no-note-is-linked-to-this-book-set-it-in-settings");
      return;
    }
    const noteFile = resolveBookNote(app, linkedName);
    if (!noteFile) { say("book-note-not-found-0", linkedName); return; }
    let currentText = "";
    try { currentText = await app.vault.read(noteFile); } catch { currentText = ""; }
    const deduped = splitExportedHighlights(currentText, highlights);
    if (deduped.fresh.length === 0) {
      say(deduped.already.length === 1
        ? "that-quote-is-already-in-0"
        : "all-the-selected-quotes-are-already-in-0", noteFile.basename);
      return;
    }
    const skippedCount = deduped.already.length;
    const groups = collectHighlightGroups(app, plugin, bookFile, deduped.fresh);
    const parts = groups.flatMap((grp) => grp.lines);
    if (parts.length === 0) {
      say("no-highlights-to-export");
      return;
    }
    const heading = translate("excerpts");
    const block = groups
      .map((grp) => (grp.chapter ? `**${grp.chapter}**\n\n` : "") + grp.lines.join("\n\n"))
      .join("\n\n");
    let insertAt = 0;
    const applyAppend = (data) => {
      const next = appendReadingNoteExcerpts(data, heading, block);
      const blockAt = next.indexOf(block);
      insertAt = blockAt < 0 ? 0 : (next.slice(0, blockAt).match(/\n/g) || []).length;
      return next;
    };
    try {
      await writeNoteText(app, noteFile, applyAppend);
      say(skippedCount
        ? "added-to-0-1-skipped-as-already-present-2"
        : "quotes-added-to-0-1", noteFile.basename, parts.length, skippedCount);
      // Explain the destination once, then get out of the reader's way. The book
      // already has a permanent "reading note" button, so asking after every
      // append adds a decision without adding a capability.
      if (plugin.settings.bookNoteAppendPromptSeen !== true) {
        plugin.settings.bookNoteAppendPromptSeen = true;
        await plugin._saveLocalData();
        const ask = new (getConfirmModal())(app, {
          title: translate("quotes-added"),
          body: translate("open-the-note-0-in-a-new-tab-next-time-the-excerpt-will-be-added", noteFile.basename),
          okText: translate("yes-open"),
          cancelText: translate("not-now"),
          onYes: () => openNoteInTab(app, noteFile, insertAt)
        });
        ask.open();
      }
    } catch (e) {
      console.error("UV Reader: append quotes to book note failed", e);
      say("could-not-add-quotes-to-the-book-note");
    }
  }

  async function exportHighlightsMenu(app, plugin, bookFile, highlights, evt) {
    if (!highlights || !highlights.length) {
      new Notice(translate("no-highlights-to-export"));
      return;
    }
    const name = bookFile ? bookNoteLinkFor(plugin, bookFile) : "";
    const noteFile = name ? resolveBookNote(app, name) : null;
    let noteText = "";
    if (noteFile) {
      try {
        noteText = await app.vault.cachedRead(noteFile);
      } catch {
        noteText = "";
      }
    }
    new (getHighlightExportModal())(app, plugin, bookFile, highlights, noteText, noteFile ? noteFile.basename : "").open();
  }

  function bookNoteAction(settings, bookPath) {
    const s = settings || {};
    const links = s.bookNoteLinks || {};
    const asked = s.bookNotePrompted || {};
    if (!bookPath) return "prompted";
    if (links[bookPath]) return "linked";
    if (s.autoBookNote) return asked[bookPath] ? "prompted" : "auto";
    return asked[bookPath] ? "prompted" : "ask";
  }

  function cmpVer(a, b) {
    const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  function whatsNewSince(lastSeen, current, log) {
    return (log || getWhatsNew()).filter((r) => cmpVer(r.v, lastSeen) > 0 && cmpVer(r.v, current) <= 0);
  }
  async function writeWhatsNewNote(app, plugin, releases) {
    try {
      if (!releases || !releases.length) return null;
      const title = sanitizeNoteTitle(`UV Reader ${plugin.manifest.version} — ${translate("what-s-new")}`);
      const path = inboxNotePath(app, title, null);
      const exist = app.vault.getAbstractFileByPath(path);
      if (exist instanceof TFile) return exist;
      const body = releases.map((r) => `## ${r.v}

${r.items.map((i) => `- ${translate(i)}`).join("\n")}`).join("\n\n");
      await resolveNotesFolder(app, null);
      const f = await app.vault.create(path, `${translate("book-reader-has-been-updated-to-0-here-is-what-changed", plugin.manifest.version)}

${body}
`);
      return f instanceof TFile ? f : null;
    } catch (e) {
      console.warn("UV Reader: could not write the what's-new note", e);
      return null;
    }
  }


  return {
    QUOTE_TEMPLATE_DEFAULT,
    appendLinkToBookNote,
    writeNoteText,
    promptForNoteTitle,
    firstFreeNoteName,
    tagPrefix,
    composeExcerptQuote,
    renderNoteTemplate,
    createTemplatedNote,
    createNoteFromSelection,
    createNoteFromAiAnswer,
    appendAnswerToBookNote,
    _escHtml,
    hlMark,
    normalizeHlText,
    splitExportedHighlights,
    openNoteBesideBook,
    openOrCreateBookNoteBeside,
    addBookFileMenu,
    dropBookState,
    deleteBookFromVault,
    backlinkLabel,
    quoteMarkdown,
    hlCommentMd,
    renderManagedReadingHighlights,
    syncHighlightsToReadingNote,
    exportHighlightsSeparate,
    openNoteInTab,
    collectHighlightGroups,
    exportHighlightsToBookNote,
    exportHighlightsMenu,
    bookNoteAction,
    cmpVer,
    whatsNewSince,
    writeWhatsNewNote,
  };
}
