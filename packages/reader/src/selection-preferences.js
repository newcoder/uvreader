const DEFAULT_ACTIONS = ["highlight", "comment", "ai", "translate", "copy"];

// Keep saved order, discard unknown/duplicate entries and append new actions.
// Missing or corrupt preferences always recover to usable defaults.
export function selectionActionPreferences(value) {
  const result = [], seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (!DEFAULT_ACTIONS.includes(item?.id) || seen.has(item.id)) continue;
    result.push({ id: item.id, visible: item.visible !== false });
    seen.add(item.id);
  }
  for (const id of DEFAULT_ACTIONS) if (!seen.has(id)) result.push({ id, visible: true });
  return result;
}
