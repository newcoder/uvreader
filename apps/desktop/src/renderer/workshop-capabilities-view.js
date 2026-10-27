import { Modal } from "obsidian";

import { groupWorkshopCapabilities, workshopCapabilitiesFor } from "../shared/workshop-capabilities.js";

// A user-facing catalogue: outcomes first, implementation names never shown.
// Actions open the matching workshop tool with its key option preselected;
// they do not start a task.
export function openWorkshopCapabilitiesModal(app, {
  extension = "",
  readerView = null,
  onPick = null,
  actionLabel = "开始",
  lead = "这些操作会用于当前文档，不会自动开始；选择后会先确认参数。",
} = {}) {
  const capabilities = workshopCapabilitiesFor({ extension, readerView }).filter((capability) => !capability.hidden);
  const modal = new (class WorkshopCapabilitiesModal extends Modal {
    onOpen() {
      this.titleEl?.setText("我能对文档做什么");
      this.contentEl.addClass("qbr-capability-modal");
      this.contentEl.createDiv({
        cls: "qbr-capability-lead",
        text: lead,
      });
      for (const group of groupWorkshopCapabilities(capabilities)) {
        this.contentEl.createEl("h3", { cls: "qbr-capability-group", text: group.label });
        const grid = this.contentEl.createDiv("qbr-capability-grid");
        for (const capability of group.items) {
          const card = grid.createDiv("qbr-capability-card");
          const title = card.createDiv("qbr-capability-title");
          title.createSpan({ text: capability.title });
          if (capability.recommended) title.createSpan({ cls: "qbr-capability-badge", text: "适合当前文档" });
          card.createDiv({ cls: "qbr-capability-summary", text: capability.summary });
          if (capability.cue) card.createDiv({ cls: "qbr-capability-cue", text: capability.cue });
          const open = card.createEl("button", {
            cls: "qbr-capability-open",
            text: actionLabel,
            attr: { type: "button" },
          });
          open.addEventListener("click", () => {
            if (typeof onPick !== "function") return;
            this.close();
            onPick(capability);
          });
        }
      }
    }

    onClose() {
      this.contentEl.empty();
    }
  })(app);
  modal.open();
  return modal;
}
