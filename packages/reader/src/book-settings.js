// buildBookSettings lives here so the reader logic stays host-agnostic.

export function createBuildBookSettings({
  Notice, BookNotePicker, TemplatePicker, allBookTags, bookNoteFiles, bookNotesFolderPath, bookTagsOf, notesFolderPath, parseBookTags, qiaomuReaderTranslate, writeBookProperty,
}) {
  function buildBookSettings(view, p) {
  const plugin = view.plugin;
  const file = view.file;
  if (!plugin || !file) return;

  const perBookStore = (key) => {
    if (!plugin.settings[key]) plugin.settings[key] = {};
    return plugin.settings[key];
  };

  // Reset every per-book override; the setup prompt reappears on next open.
  const resetRow = p.createDiv("qiaomu-reader-pan-hint");
  const resetLink = resetRow.createSpan({ text: qiaomuReaderTranslate("forget-this-book-s-settings") });
  resetLink.addClass("qiaomu-reader-inline-link");
  resetLink.addEventListener("click", async () => {
    for (const key of ["bookNoteLinks", "bookNotePrompted", "bookTags", "bookTemplates"]) {
      const store = plugin.settings[key];
      if (store) delete store[path0()];
    }
    await plugin.saveAll();
    new Notice(qiaomuReaderTranslate("book-settings-cleared-the-setup-screen-will-appear-next-time-you"));

    function path0() { return view.file.path; }
  });

  /**
   * Group heading + hint + text input whose commits land in a per-book map.
   * Both change and blur commit; an emptied field removes the override.
   */
  function row(spec) {
    p.createDiv("qiaomu-reader-info-group").setText(qiaomuReaderTranslate(spec.heading));
    const wrap = p.createDiv("qiaomu-reader-info-booknote");
    const hint = wrap.createDiv("qiaomu-reader-info-rowdesc");
    hint.setText(qiaomuReaderTranslate(spec.hint));
    hint.addClass("qiaomu-reader-panel-hint");
    const input = wrap.createEl("input", { type: "text" });
    input.addClass("qiaomu-reader-panel-input");
    if (spec.fill) input.value = spec.fill();
    input.disabled = !view.file;
    const commit = async () => {
      if (!view.file) return;
      await spec.save(input);
      await plugin.saveAll();
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    return { wrap, input };
  }

  function appendPick(wrap, cls, labelKey, onClick) {
    const el = wrap.createDiv("qiaomu-reader-booknote-pick");
    el.setText(qiaomuReaderTranslate(labelKey));
    el.addClass(cls);
    el.addEventListener("click", onClick);
  }

  // ── reading-note backlink target ──────────────────────────────────────────
  const linkRow = row({
    heading: "book-note-for-links",
    hint: "where-the-from-link-in-highlight-notes-points-empty-the-book-s-f",
    fill: () => (plugin.settings.bookNoteLinks || {})[file.path] || "",
    save: async (input) => {
      const name = input.value.trim().replace(/^\[\[|\]\]$/g, "").trim();
      const store = perBookStore("bookNoteLinks");
      if (name) store[file.path] = name;
      else delete store[file.path];
      if (name) await writeBookProperty(view.app, name, file);
    },
  });
  linkRow.input.placeholder = file.basename;

  const actions = linkRow.wrap.createDiv("qiaomu-reader-booknote-actions");
  actions.addClass("qiaomu-reader-panel-actions");

  const createLink = actions.createDiv("qiaomu-reader-booknote-pick");
  createLink.setText(qiaomuReaderTranslate("create-new"));
  createLink.addClass("qiaomu-reader-panel-link-strong");
  createLink.addEventListener("click", async () => {
    const folder = bookNotesFolderPath(view.app) || notesFolderPath(view.app) || "";
    const note = await plugin.createBookNote(file, file.basename, folder);
    if (!note) return;
    linkRow.input.value = note.path;
    new Notice(qiaomuReaderTranslate("book-note-created-0", note.basename));
  });

  const chooseLink = actions.createDiv("qiaomu-reader-booknote-pick");
  chooseLink.setText(qiaomuReaderTranslate("choose-from-the-list"));
  chooseLink.addClass("qiaomu-reader-panel-link");
  chooseLink.addEventListener("click", () => {
    const files = bookNoteFiles(view.app);
    if (!files.length) {
      const base = bookNotesFolderPath(view.app);
      new Notice(base ? qiaomuReaderTranslate("no-notes-in-0", base) : qiaomuReaderTranslate("no-notes-in-the-vault"));
      return;
    }
    new BookNotePicker(view.app, files, async (chosen) => {
      perBookStore("bookNoteLinks")[file.path] = chosen.path;
      await plugin.saveAll();
      await writeBookProperty(view.app, chosen.path, file);
      linkRow.input.value = chosen.path;
      new Notice(qiaomuReaderTranslate("book-note-0", chosen.basename));
    }).open();
  });

  // ── library category / tags ───────────────────────────────────────────────
  const tagRow = row({
    heading: "category",
    hint: "genre-or-topic-books-are-grouped-by-it-in-the-library-separate-s-2",
    fill: () => bookTagsOf(plugin.settings, file.path).join(", "),
    save: async (input) => {
      await plugin.setBookTags(file.path, parseBookTags(input.value));
    },
  });
  tagRow.input.placeholder = qiaomuReaderTranslate("e-g-psychology-business");
  const knownTags = allBookTags(plugin.settings);
  if (knownTags.length) {
    const dl = tagRow.input.ownerDocument.createElement("datalist");
    dl.id = "qiaomu-reader-info-tags-" + Math.random().toString(36).slice(2, 8);
    for (const t of knownTags) dl.appendChild(new Option(t));
    tagRow.input.setAttr("list", dl.id);
    tagRow.input.after(dl);
  }

  // ── per-book note template ────────────────────────────────────────────────
  const tplRow = row({
    heading: "template-for-this-book",
    hint: "a-template-just-for-this-book-for-example-per-genre-empty-the-sh",
    fill: () => (plugin.settings.bookTemplates || {})[file.path] || "",
    save: async (input) => {
      const v = input.value.trim();
      const store = perBookStore("bookTemplates");
      if (v) store[file.path] = v;
      else delete store[file.path];
    },
  });
  tplRow.input.placeholder = (plugin.settings.noteTemplate || "").trim() || qiaomuReaderTranslate("templates-template-md");

  appendPick(tplRow.wrap, "qiaomu-reader-panel-link-spaced", "choose-from-the-list", () => {
    const files = view.app.vault.getMarkdownFiles();
    if (!files.length) { new Notice(qiaomuReaderTranslate("no-notes-in-the-vault")); return; }
    new TemplatePicker(view.app, files, async (chosen) => {
      perBookStore("bookTemplates")[file.path] = chosen.path;
      await plugin.saveAll();
      tplRow.input.value = chosen.path;
      new Notice(qiaomuReaderTranslate("book-template-0", chosen.basename));
    }).open();
  });
}
  return buildBookSettings;
}
