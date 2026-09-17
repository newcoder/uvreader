// Obsidian uses aria-label as hover-tooltip text. Keep accessible names through
// aria-labelledby instead, only on this plugin's UI, including later updates.
const scope = '[class*="qiaomu-reader-"], [data-type="qiaomu-book-reader-ai-chat"]';
let nextLabel = 0;
const session = Math.random().toString(36).slice(2);

export function watchQuietUi(document) {
  const view = document.defaultView;
  const normalize = el => {
    if (!el.closest(scope) || el.closest('[data-qbr-tooltip="essential"]')) return;
    const name = el.getAttribute("aria-label");
    const title = el.getAttribute("title");
    const text = name || (!el.textContent.trim() ? title : "");
    if (title !== null) el.removeAttribute("title");
    if (!text || !el.parentElement) return;
    let label = document.getElementById(el.dataset.qbrLabelId || "");
    // Respect semantic labels supplied by the component itself.
    if (!label && el.hasAttribute("aria-labelledby")) {
      if (name !== null) el.removeAttribute("aria-label");
      return;
    }
    if (!label) {
      label = document.createElement("span");
      label.id = `qbr-label-${session}-${++nextLabel}`;
      label.className = "qiaomu-reader-a11y-label";
      label.hidden = true;
      el.parentElement.appendChild(label);
      el.dataset.qbrLabelId = label.id;
      el.setAttribute("aria-labelledby", label.id);
    }
    if (label.textContent !== text) label.textContent = text;
    if (name !== null) el.removeAttribute("aria-label");
  };
  const scan = node => {
    if (node.nodeType !== 1) return;
    if (node.matches("[aria-label], [title]")) normalize(node);
    for (const el of node.querySelectorAll("[aria-label], [title]")) normalize(el);
  };
  scan(document.body);
  const observer = new view.MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") normalize(record.target);
      else for (const node of record.addedNodes) scan(node);
      // Hidden labels are siblings, so removing a control should remove its label.
      if (record.type === "childList") for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue;
        const removed = [node, ...node.querySelectorAll("[data-qbr-label-id]")];
        for (const el of removed) if (el.dataset.qbrLabelId) document.getElementById(el.dataset.qbrLabelId)?.remove();
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "title"] });
  return () => {
    observer.disconnect();
    for (const el of document.querySelectorAll("[data-qbr-label-id]")) {
      const label = document.getElementById(el.dataset.qbrLabelId);
      if (label) { el.setAttribute("aria-label", label.textContent); label.remove(); }
      el.removeAttribute("aria-labelledby");
      delete el.dataset.qbrLabelId;
    }
  };
}
