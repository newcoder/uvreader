import { createSerialTaskQueue, readJsonRecordStore, writeVerifiedJsonRecord } from "./storage.js";

export const DRAFT_LIMIT = 20000;
export function normalizeDrafts(value) {
  return Object.fromEntries(Object.entries(value || {})
    .filter(([path, item]) => path && path.length <= 500 && typeof item?.text === "string" && item.text)
    .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0))
    .slice(0, 30).map(([path, item]) => [path, { text: item.text.slice(0, DRAFT_LIMIT), updatedAt: Number(item.updatedAt) || 0 }]));
}

// Unsent composer text keyed by book path. `load` returns the stored records;
// `save` receives only the keys that changed (a null record means the draft was
// cleared), so a per-book backend writes one file instead of the whole map.
// A backend that throws from load pauses writes instead of guessing.
export async function createAiDraftStore({ load, save }, onError, clock = globalThis) {
  let blocked = false;
  let notified = false;
  let records = {};
  let timer;
  const dirty = new Set();
  const queue = createSerialTaskQueue();
  const report = () => { if (!notified) onError?.(); notified = true; };
  try {
    records = normalizeDrafts(await load());
  } catch (error) {
    blocked = true;
    records = {};
    if (error?.code !== "QIAOMU_READER_STORE_UNREADABLE") console.error("UV Reader: could not load AI drafts", error);
  }
  const texts = new Map(Object.entries(records).map(([key, item]) => [key, item.text]));
  if (blocked) report();
  const flush = () => {
    clock.clearTimeout(timer);
    if (!dirty.size || blocked) return queue.drain();
    const keys = [...dirty];
    dirty.clear();
    const changed = {};
    for (const key of keys) changed[key] = records[key] ? { ...records[key] } : null;
    const snapshot = JSON.parse(JSON.stringify(records));
    return queue.run(async () => {
      try {
        await save(changed, snapshot);
        notified = false;
      } catch (error) {
        for (const key of keys) dirty.add(key);
        if (error.code === "QIAOMU_READER_STORE_UNREADABLE") blocked = true;
        report();
      }
    });
  };
  return {
    texts,
    set(key, text) {
      if (!key) return;
      const value = String(text || "").slice(0, DRAFT_LIMIT);
      if ((texts.get(key) || "") === value) return;
      if (value) records[key] = { text: value, updatedAt: Date.now() };
      else delete records[key];
      records = normalizeDrafts(records);
      texts.clear();
      for (const [book, item] of Object.entries(records)) texts.set(book, item.text);
      dirty.add(key);
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => { void flush(); }, 350);
    },
    flush,
  };
}

// Legacy backend: one JSON record for every book, written whole.
export async function loadAiDrafts(adapter, path, onError, clock = globalThis) {
  return createAiDraftStore({
    load: async () => {
      const result = await readJsonRecordStore(adapter, path, "AI drafts");
      if (result.status === "unreadable") {
        throw Object.assign(new Error("AI drafts are unreadable"), { code: "QIAOMU_READER_STORE_UNREADABLE" });
      }
      return result.value;
    },
    save: async (changed, snapshot) => { await writeVerifiedJsonRecord(adapter, path, snapshot); },
  }, onError, clock);
}
