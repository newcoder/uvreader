// Starter books are installed once, on the first library visit. Keep an
// installation journal so partial failures resume without overwriting files.
export function findStarterBook(metadata, books) {
  return books.find(book => metadata?.identifier === `urn:qbr:starter:${book.id}`);
}

export function createStarterLibraryInstaller({ vault, books, getState, saveState, getFolder }) {
  let pending;
  const install = async (explicit) => {
    const state = getState() || {};
    // Older versions marked non-empty vaults as skipped without installing.
    // Repair that state once, but never recreate books deleted after installation.
    if (!explicit && state.version === 1 && !state.skipped && !state.pending) return [];
    const folder = state.pending && state.folder || getFolder();
    await saveState({ ...state, pending: true, folder });
    const parts = folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!vault.getAbstractFileByPath(path)) {
        try { await vault.createFolder(path); }
        catch (error) { if (!vault.getAbstractFileByPath(path)) throw error; }
      }
      if (!Array.isArray(vault.getAbstractFileByPath(path)?.children)) throw new Error(`Folder unavailable: ${path}`);
    }
    const created = [];
    for (const book of books) {
      const path = `${folder}/${book.filename}`;
      if (vault.getAbstractFileByPath(path)) continue;
      const binary = atob(book.data);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      try { await vault.createBinary(path, bytes.buffer); created.push(path); }
      catch (error) { if (!vault.getAbstractFileByPath(path)) throw error; }
    }
    await saveState({ version: 1, folder });
    return created;
  };
  return (explicit = false) => {
    if (!pending) pending = install(explicit).finally(() => { pending = null; });
    return pending;
  };
}
