// A completed ebook-build task outside the library should be adopted once,
// during the session that created it. Re-adopting historical tasks on every
// app start resurrects books the reader deliberately deleted.
export function shouldAdoptBookBuildOutput(task, { sessionStartedAt = 0, vaultRoot = "" } = {}) {
  if (task?.kind !== "book-build" || task?.status !== "done" || !task?.output) return false;
  const raw = String(task.output).replace(/\\/g, "/");
  const root = String(vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const absolute = /^[a-zA-Z]:\//.test(raw) || raw.startsWith("//");
  // Paths already inside the library do not need a copy or an import; they
  // are safe to remember on every start.
  if (!absolute || (root && raw.toLowerCase().startsWith(`${root.toLowerCase()}/`))) return true;
  const finishedAt = Number(task.finishedAt) || Date.parse(task.finishedAt) || 0;
  return finishedAt > 0 && finishedAt >= Number(sessionStartedAt || 0);
}
