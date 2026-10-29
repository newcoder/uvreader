export const AI_SUGGESTION_KINDS = new Set(["ai-metadata", "ai-cover-copy", "ai-chapters", "ai-clean"]);

// Suggestions are only safe to show for the source that produced them. Old
// task history has no source field, so it is deliberately ignored instead of
// leaking into whichever book happens to be selected now.
export function pickAiSuggestion(tasks, { source = "", dismissed = null } = {}) {
  const current = String(source || "");
  if (!current) return null;
  return (Array.isArray(tasks) ? tasks : []).find((task) => (
    AI_SUGGESTION_KINDS.has(task?.kind)
    && task.status === "done"
    && task.result
    && String(task.source || "") === current
    && !dismissed?.has?.(task.id)
  )) || null;
}
