// AiChatHistoryModal assembly. The host supplies the Modal base class and the
// reader helpers, so the module runs outside Obsidian; pure helpers are
// imported directly.
import { svgIcon } from "./reader-icons.js";

export function createAiChatHistoryModal({
  Modal, setIcon, ConfirmModal, ReaderNameModal, normalizeAiChatHistory, qiaomuReaderLocale, qiaomuReaderTranslate,
}) {
  return class AiChatHistoryModal extends Modal {
  constructor(app, chat) {
    super(app);
    this.chat = chat;
    this.filterScope = chat.bookFile?.path ? "book" : "all";
  }
  onOpen() {
    const c = this.contentEl;
    c.empty();
    this.modalEl.addClass("qiaomu-reader-ai-history-modal");
    const head = c.createDiv("qiaomu-reader-ai-history-head");
    head.createEl("h3", { text: qiaomuReaderTranslate("chat-history") });
    const clearBook = this.filterScope === "book" && !!this.chat.bookFile?.path;
    const clear = head.createEl("button", { text: qiaomuReaderTranslate(clearBook ? "clear-this-book-s-history" : "clear-all-history") });
    clear.addEventListener("click", () => {
      if (this.chat.busy) return;
      const bookPath = this.chat.bookFile?.path || "";
      new ConfirmModal(this.app, {
        title: qiaomuReaderTranslate(clearBook ? "clear-this-book-s-history" : "clear-all-history"),
        body: clearBook
          ? qiaomuReaderTranslate("clear-the-chat-history-for-0", this.chat.bookFile.basename)
          : qiaomuReaderTranslate("clear-all-chat-history"),
        okText: qiaomuReaderTranslate("clear"),
        cancelText: qiaomuReaderTranslate("cancel"),
        onYes: async () => {
          await this.chat._removeHistory((item) => !clearBook || item.bookPath === bookPath);
          this.onOpen();
        },
      }).open();
    });
    const allItems = normalizeAiChatHistory(this.chat.plugin.settings.aiChatHistory);
    if (this.chat.bookFile?.path) {
      const scopes = c.createDiv("qiaomu-reader-ai-history-scopes");
      for (const [id, label] of [["book", qiaomuReaderTranslate("this-book")], ["all", qiaomuReaderTranslate("all-2")]]) {
        const button = scopes.createEl("button", { text: label });
        button.toggleClass("is-active", this.filterScope === id);
        button.addEventListener("click", () => {
          this.filterScope = id;
          this.onOpen();
        });
      }
    }
    const items = this.filterScope === "book" && this.chat.bookFile?.path
      ? allItems.filter((item) => item.bookPath === this.chat.bookFile.path)
      : allItems;
    const list = c.createDiv("qiaomu-reader-ai-history-list");
    const query = c.createEl("input", { cls: "qiaomu-reader-ai-history-search", attr: { type: "search", placeholder: qiaomuReaderTranslate("search-conversation-titles-or-books"), "aria-label": qiaomuReaderTranslate("search-conversation-titles-or-books") } });
    c.insertBefore(query, list);
    query.value = this.query || "";
    const noMatch = c.createDiv({ cls: "qiaomu-reader-ai-history-empty", text: qiaomuReaderTranslate("nothing-found") });
    const filter = () => {
      this.query = query.value;
      const text = query.value.trim().toLocaleLowerCase();
      for (const row of list.children) row.hidden = text && !row.textContent.toLocaleLowerCase().includes(text);
      noMatch.hidden = !items.length || Array.from(list.children).some((row) => !row.hidden);
    };
    query.addEventListener("input", filter);
    if (!items.length) list.createDiv({ cls: "qiaomu-reader-ai-history-empty", text: qiaomuReaderTranslate("no-chat-history-yet") });
    for (const item of items) {
      const row = list.createDiv("qiaomu-reader-ai-history-item");
      const open = row.createEl("button", { cls: "qiaomu-reader-ai-history-open" });
      open.createDiv({ cls: "qiaomu-reader-ai-history-title", text: item.title });
      const when = item.updatedAt ? new Date(item.updatedAt).toLocaleString(qiaomuReaderLocale()) : "";
      open.createDiv({ cls: "qiaomu-reader-ai-history-meta", text: [item.book, when].filter(Boolean).join(" · ") });
      open.addEventListener("click", () => {
        if (this.chat.busy) return;
        this.chat.loadSession(item);
        this.close();
      });
      const rename = row.createEl("button", { cls: "qiaomu-reader-ai-history-delete", attr: { "aria-label": qiaomuReaderTranslate("rename-conversation") } });
      setIcon(rename, "pencil");
      rename.addEventListener("click", () => {
        if (this.chat.busy) return;
        new ReaderNameModal(this.app, qiaomuReaderTranslate("rename-conversation"), item.title, async (title) => {
          const record = this.chat.plugin.settings.aiChatHistory.find((candidate) => candidate.id === item.id);
          if (!record || this.chat.busy) return;
          const previous = { title: record.title, titleEdited: record.titleEdited };
          record.title = title; record.titleEdited = true;
          try {
            await this.chat.plugin.saveAll();
            if (this.chat.chatRecordId === item.id) this.chat.sessionTitle = title;
            this.onOpen();
          } catch (error) { Object.assign(record, previous); throw error; }
        }).open();
      });
      const del = row.createEl("button", { cls: "qiaomu-reader-ai-history-delete" });
      svgIcon(del, "trash");
      del.setAttribute("aria-label", `${qiaomuReaderTranslate("delete")} · ${item.title}`);
      del.addEventListener("click", () => {
        if (this.chat.busy) return;
        new ConfirmModal(this.app, {
          title: `${qiaomuReaderTranslate("delete")} · ${item.title}`,
          body: qiaomuReaderTranslate("deleting-this-conversation-cannot-be-undone"),
          okText: qiaomuReaderTranslate("delete"),
          cancelText: qiaomuReaderTranslate("cancel"),
          onYes: async () => {
            await this.chat._removeHistory((candidate) => candidate.id === item.id);
            this.onOpen();
          },
        }).open();
      });
    }
    filter();
  }
  onClose() { this.contentEl.empty(); }
};
}
