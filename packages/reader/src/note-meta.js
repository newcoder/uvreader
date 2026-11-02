// Small, pure metadata lines for notes and appended excerpts. The visible
// labels come from the host translation function so every entry says when it
// was added, where it came from and whether it was written by a person or AI.
export function formatNoteTime(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function noteMetaLine({ translate, created, source = "", detail = "", origin = "" }) {
  const parts = [];
  const time = formatNoteTime(created);
  if (time) parts.push(`${translate("note-meta-time")}：${time}`);
  const from = [source, detail].filter(Boolean).join(" · ");
  if (from) parts.push(`${translate("note-meta-source")}：${from}`);
  if (origin) parts.push(origin);
  return parts.length ? `> ${parts.join(" · ")}` : "";
}
