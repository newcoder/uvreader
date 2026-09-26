// ReadingProjectsModal assembly. The host supplies the Modal base class and the
// reader helpers; the store work runs on the plugin.

export function createReadingProjectsModal({
  Modal, Notice, ConfirmModal, ReaderNameModal, qiaomuReaderTranslate,
}) {
  return class ReadingProjectsModal extends Modal {
    constructor(app, plugin, options = {}) {
      super(app);
      this.plugin = plugin;
      this.mode = options.mode === "pick" ? "pick" : "manage";
      this.bookFile = options.bookFile || null;
      this.focus = String(options.project || "");
      this.onDone = typeof options.onDone === "function" ? options.onDone : null;
    }
    async onOpen() {
      await this._draw();
    }
    async _draw() {
      const c = this.contentEl;
      c.empty();
      c.addClass("qiaomu-reader-projects-modal");
      const title = this.mode === "pick"
        ? qiaomuReaderTranslate("add-to-reading-project")
        : qiaomuReaderTranslate("reading-projects");
      c.createDiv("qiaomu-reader-info-title").setText(title);
      if (this.bookFile) c.createDiv("qiaomu-reader-info-sub").setText(this.bookFile.basename);
      else c.createDiv("qiaomu-reader-info-sub").setText(qiaomuReaderTranslate("reading-projects-hint"));

      const bar = c.createDiv("qiaomu-reader-projects-bar");
      const create = bar.createEl("button", { cls: "mod-cta", text: qiaomuReaderTranslate("new-reading-project") });
      create.addEventListener("click", () => this._createProject());
      const current = this.bookFile ? await this.plugin.readingProjectOf(this.bookFile.path) : "";
      if (current) bar.createDiv({ cls: "qiaomu-reader-projects-current", text: qiaomuReaderTranslate("currently-in-0", current) });

      const projects = await this.plugin.listReadingProjects();
      const list = c.createDiv("qiaomu-reader-projects-list");
      if (!projects.length) {
        list.createDiv({ cls: "qiaomu-reader-set-note", text: qiaomuReaderTranslate("no-reading-projects-yet") });
        return;
      }
      projects.sort((a, b) => (a.name === this.focus ? -1 : b.name === this.focus ? 1 : 0));
      for (const project of projects) {
        const row = list.createDiv("qiaomu-reader-project-row");
        const head = row.createDiv("qiaomu-reader-project-head");
        head.createDiv("qiaomu-reader-project-name").setText(project.name);
        head.createDiv("qiaomu-reader-project-count").setText(
          qiaomuReaderTranslate("books-0", project.books.length));
        const actions = row.createDiv("qiaomu-reader-project-actions");
        if (this.mode === "pick" && this.bookFile) {
          const add = actions.createEl("button", { cls: "mod-cta", text: qiaomuReaderTranslate("project-add-book") });
          add.addEventListener("click", () => this._run(add, async () => {
            await this.plugin.moveBookToReadingProject(this.bookFile.path, project.name);
            new Notice(qiaomuReaderTranslate("moved-to-0", project.name));
            this.onDone?.(project.name);
            this.close();
          }));
        }
        const del = actions.createEl("button", { text: qiaomuReaderTranslate("delete-project") });
        del.addEventListener("click", () => new ConfirmModal(this.app, {
          title: qiaomuReaderTranslate("delete-project"),
          body: qiaomuReaderTranslate("deleting-a-project-moves-its-books-back-and-keeps-their-traces"),
          okText: qiaomuReaderTranslate("delete"),
          cancelText: qiaomuReaderTranslate("cancel"),
          onYes: async () => {
            const result = await this.plugin.deleteReadingProject(project.name);
            if (result.failed.length) {
              new Notice(qiaomuReaderTranslate("project-delete-incomplete-0", result.failed.length), 8000);
            }
            await this._draw();
          },
        }).open());

        const books = row.createDiv("qiaomu-reader-project-books");
        if (!project.books.length) {
          books.createDiv({ cls: "qiaomu-reader-set-note", text: qiaomuReaderTranslate("no-books-in-this-project") });
          continue;
        }
        for (const item of project.books) {
          const path = typeof item === "string" ? item : String(item?.path || "");
          if (!path) continue;
          const bookRow = books.createDiv("qiaomu-reader-project-book");
          bookRow.createDiv("qiaomu-reader-project-book-title").setText(
            String(item?.title || path.split("/").pop() || ""));
          const remove = bookRow.createEl("button", { text: qiaomuReaderTranslate("project-remove-book") });
          remove.addEventListener("click", () => this._run(remove, async () => {
            await this.plugin.removeBookFromReadingProject(path);
            new Notice(qiaomuReaderTranslate("removed-from-0", project.name));
            if (this.bookFile?.path === path) this.onDone?.("");
            await this._draw();
          }));
        }
      }
    }
    async _run(button, task) {
      button.disabled = true;
      try {
        await task();
      } catch (error) {
        button.disabled = false;
        new Notice(qiaomuReaderTranslate("project-move-failed-0", String(error?.message || error).slice(0, 140)), 8000);
      }
    }
    _createProject() {
      new ReaderNameModal(this.app, qiaomuReaderTranslate("new-reading-project"), "", async (name) => {
        const project = await this.plugin.createReadingProject(name);
        if (!project) {
          new Notice(qiaomuReaderTranslate("could-not-create-the-project"), 8000);
          return;
        }
        this.focus = project;
        new Notice(qiaomuReaderTranslate("created-reading-project-0", project));
        await this._draw();
      }).open();
    }
    onClose() { this.contentEl.empty(); }
  };
}
