// Book search and download service (main process). Search fans out to every
// enabled source and normalizes through the shared pure module; downloads run
// through a small queue (two at a time), write into the library folder, verify
// the bytes and are cancellable. Network access is injectable for tests.
import { bookSearchRequest, dedupeBookResults, downloadLinkFromZlibPage, resultsFromSource } from "../../../../packages/reader/src/book-sources.js";
import fs from "node:fs";
import path from "node:path";

export const BOOK_SEARCH_TIMEOUT = 9000;
export const BOOK_DOWNLOAD_CONCURRENCY = 2;
const MIN_BOOK_BYTES = 1024;

const MAGIC = [
  { ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: "epub", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { ext: "mobi", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { ext: "azw3", bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function log(...args) {
  try { console.error("[qbr-books]", ...args); } catch { /* stderr may be gone */ }
}

export function bookFileLooksValid(buffer, name = "") {
  if (!buffer || buffer.length < MIN_BOOK_BYTES) return false;
  const head = Buffer.from(buffer.buffer || buffer, buffer.byteOffset || 0, Math.min(512, buffer.length)).toString("latin1");
  if (/^\s*<(!doctype|html)/i.test(head)) return false;
  const ext = String(name).split(".").pop()?.toLowerCase() || "";
  if (ext === "txt") return !/^\s*</.test(head);
  const magic = MAGIC.find((entry) => entry.ext === ext);
  if (!magic) return true;
  return magic.bytes.every((byte, index) => (buffer[index] ?? -1) === byte);
}

export function uniqueBookName(dir, name) {
  const parsed = path.parse(String(name || "book.epub"));
  const stem = parsed.name || "book";
  const ext = parsed.ext || ".epub";
  let candidate = `${stem}${ext}`;
  let suffix = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${stem} (${suffix++})${ext}`;
  return candidate;
}

// The Internet Archive item page becomes a real file URL through the item's
// metadata; epub wins over pdf, both over the rest.
export function pickArchiveFile(metadata, identifier) {
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const ranked = [];
  for (const file of files) {
    const name = String(file?.name || "");
    if (!name || /_meta\.|_files\.xml|_reviews|_djvu\.txt|\.torrent$/i.test(name)) continue;
    const format = /\.epub$/i.test(name) ? "epub" : /\.pdf$/i.test(name) ? "pdf" : /\.txt$/i.test(name) ? "txt" : "";
    if (!format) continue;
    ranked.push({ format, url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}` });
  }
  for (const wanted of ["epub", "pdf", "txt"]) {
    const hit = ranked.find((entry) => entry.format === wanted);
    if (hit) return hit;
  }
  return null;
}

export function createBookDownloads({ fetchImpl = fetch, downloadRoot = "" } = {}) {
  const root = String(downloadRoot || "");
  const jobs = new Map();
  const waiting = [];
  let active = 0;

  function ensureRoot() {
    if (!root) throw new Error("缺少书籍下载目录");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  async function fetchSource(source, query, signal) {
    const request = bookSearchRequest(source, query);
    if (!request) return [];
    const response = await fetchImpl(request.url, { signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = request.kind === "json" ? await response.json() : await response.text();
    return resultsFromSource(source, payload);
  }

  // Fan out; one failing source never fails the search.
  async function search({ sources = [], query = "" } = {}, { timeout = BOOK_SEARCH_TIMEOUT } = {}) {
    const cleaned = String(query || "").trim();
    const enabled = (Array.isArray(sources) ? sources : []).filter((source) => source?.enabled !== false);
    if (!cleaned || !enabled.length) return { results: [], errors: [] };
    const settled = await Promise.all(enabled.map(async (source) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const results = await fetchSource(source, cleaned, controller.signal);
        return { source, results };
      } catch (error) {
        const message = String(error?.name === "AbortError" ? "超时" : error?.message || error).slice(0, 160);
        log("search failed", source.id, message);
        return { source, error: message };
      } finally {
        clearTimeout(timer);
      }
    }));
    const errors = settled.filter((entry) => entry.error).map((entry) => ({ source: entry.source.id, name: entry.source.name, message: entry.error }));
    const results = dedupeBookResults(settled.flatMap((entry) => entry.results || []));
    return { results, errors };
  }

  // Resolves a result into a concrete file URL: Internet Archive metadata, or
  // a session-gated book page whose /dl/ link needs the login cookies.
  async function resolveDownload(result) {
    const url = String(result?.url || "");
    if (url) return { url, format: String(result?.format || "") };
    if (result?.needsSession && result?.info) {
      const page = await fetchImpl(String(result.info), { redirect: "follow" });
      if (!page.ok) throw new Error(`HTTP ${page.status}`);
      const picked = downloadLinkFromZlibPage(await page.text(), String(result.info), [String(result?.format || "epub").toLowerCase(), "epub", "pdf"]);
      if (!picked?.url) throw new Error("没有找到下载链接；请先在上方登录来源，登录后再试");
      return picked;
    }
    const info = String(result?.info || "");
    const identifier = info.match(/archive\.org\/details\/([^/?#]+)/)?.[1];
    if (!identifier) return null;
    const response = await fetchImpl(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    const picked = pickArchiveFile(metadata, identifier);
    return picked;
  }

  function startNext() {
    while (active < BOOK_DOWNLOAD_CONCURRENCY && waiting.length) {
      const task = waiting.shift();
      if (task.cancelled) continue;
      active += 1;
      task.run().catch(() => {}).finally(() => {
        active -= 1;
        startNext();
      });
    }
  }

  async function downloadOne(jobId, result, handlers) {
    const job = jobs.get(jobId);
    const picked = await resolveDownload(result);
    if (!picked?.url) throw new Error("这个来源没有可直接下载的文件");
    const format = picked.format || String(result?.format || "").toLowerCase() || "epub";
    const title = String(result?.title || "book").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "book";
    const dir = ensureRoot();
    const response = await fetchImpl(picked.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers?.get?.("content-length")) || 0;
    const chunks = [];
    let received = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      for (;;) {
        if (job?.cancelled) { try { await reader.cancel(); } catch { /* gone */ } throw new Error("已取消"); }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value?.length || 0;
        handlers?.onProgress?.({ jobId, received, total });
      }
    } else {
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    const buffer = Buffer.concat(chunks);
    const provisional = `${title}.${format}`;
    if (!bookFileLooksValid(buffer, provisional)) throw new Error("下载到的不是有效书籍文件");
    const name = uniqueBookName(dir, provisional);
    const target = path.join(dir, name);
    fs.writeFileSync(target, buffer);
    return { ok: true, jobId, path: target, name, bytes: buffer.length, source: result?.source || "", format };
  }

  // Queues a download; handlers see progress and the final result.
  function download(jobId, result, handlers = {}) {
    const id = String(jobId || "");
    if (!id) throw new Error("缺少任务 id");
    if (jobs.has(id)) throw new Error(`任务已存在：${id}`);
    ensureRoot();
    const job = { jobId: id, cancelled: false };
    jobs.set(id, job);
    log("download queued", id, result?.title, result?.source || "");
    waiting.push({
      jobId: id,
      get cancelled() { return job.cancelled; },
      run: async () => {
        try {
          const outcome = await downloadOne(id, result, handlers);
          handlers.onDone?.(outcome);
        } catch (error) {
          handlers.onDone?.({ ok: false, jobId: id, cancelled: job.cancelled, error: String(error?.message || error).slice(0, 200) });
        } finally {
          jobs.delete(id);
          startNext();
        }
      },
    });
    startNext();
    return { jobId: id };
  }

  function cancel(jobId) {
    const job = jobs.get(String(jobId || ""));
    if (!job) return false;
    job.cancelled = true;
    jobs.delete(String(jobId));
    return true;
  }

  function cancelAll() {
    for (const job of jobs.values()) job.cancelled = true;
    jobs.clear();
    waiting.length = 0;
  }

  return { search, download, cancel, cancelAll, jobs };
}
