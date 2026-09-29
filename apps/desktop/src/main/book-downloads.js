// Book search and download service (main process). Search fans out to every
// enabled source and normalizes through the shared pure module; downloads run
// through a small queue (two at a time), write into the library folder, verify
// the bytes and are cancellable. Network access is injectable for tests.
import { bookSearchRequest, dedupeBookResults, downloadLinkFromOpdsPage, downloadLinkFromStandardEbooksPage, downloadLinkFromZlibPage, resultsFromSource } from "../../../../packages/reader/src/book-sources.js";
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
  return bookHeadLooksValid(buffer, name);
}

// Header/magic checks only; the caller owns the size rule (browser downloads
// are validated from their first bytes plus the file size on disk).
export function bookHeadLooksValid(buffer, name = "") {
  if (!buffer || !buffer.length) return false;
  const head = Buffer.from(buffer.buffer || buffer, buffer.byteOffset || 0, Math.min(512, buffer.length)).toString("latin1");
  if (/^\s*<(!doctype|html)/i.test(head)) return false;
  const ext = String(name).split(".").pop()?.toLowerCase() || "";
  if (ext === "txt") return !/^\s*</.test(head);
  const magic = MAGIC.find((entry) => entry.ext === ext);
  if (!magic) return true;
  return magic.bytes.every((byte, index) => (buffer[index] ?? -1) === byte);
}

function readFileHead(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(512);
      const read = fs.readSync(fd, buffer, 0, 512, 0);
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
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

export function createBookDownloads({ fetchImpl = fetch, pageFetch = null, fileDownload = null, pageDownload = null, pdfdriveSearch = null, forgetSession = null, downloadRoot = "" } = {}) {
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
    // PDF Drive has no catalogue endpoint: the hidden renderer runs the Google
    // widget and hands back the rendered result links (all pages).
    if (source.kind === "pdfdrive" && typeof pdfdriveSearch === "function") {
      return resultsFromSource(source, await pdfdriveSearch(query));
    }
    const request = bookSearchRequest(source, query);
    if (!request) return [];
    // Z-Library's anti-bot page only clears in a real renderer.
    if (source.kind === "zlib" && typeof pageFetch === "function") {
      const html = await pageFetch(request.url);
      const rows = resultsFromSource(source, html);
      // A verification page can pass the title check yet carry no book cards;
      // surface that instead of pretending the search found nothing.
      if (!rows.length) throw new Error("来源没有返回可解析的结果（可能卡在验证页）");
      return rows;
    }
    const response = await fetchImpl(request.url, { signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = request.kind === "json" ? await response.json() : await response.text();
    return resultsFromSource(source, payload);
  }

  // A source that keeps failing (offline mirror, blocked host, broken
  // endpoint) is skipped for a while instead of stalling every book in the
  // batch with its timeout.
  const sourceFails = new Map();
  const sourceCooldown = new Map();
  const SOURCE_FAIL_LIMIT = 2;
  // Long cooldowns silently emptied every Book Finder book when one source
  // hiccuped twice; two minutes is enough to stop a stalling source dragging a
  // batch down without hiding it for the rest of the session.
  const SOURCE_COOLDOWN_MS = 2 * 60 * 1000;

  // Fan out; one failing source never fails the search.
  async function search({ sources = [], query = "" } = {}, { timeout = BOOK_SEARCH_TIMEOUT, onSource = null } = {}) {
    const cleaned = String(query || "").trim();
    const enabled = (Array.isArray(sources) ? sources : []).filter((source) => source?.enabled !== false);
    if (!cleaned || !enabled.length) return { results: [], errors: [] };
    // Progressive results: every source reports the moment it settles, so the
    // caller can render (and start downloading) rows while slower sources
    // (zlib's browser challenge, PDF Drive's widget) are still running.
    let done = 0;
    const notify = (source, results, error = "") => {
      done += 1;
      try { onSource?.({ source: source.id, name: source.name, results, error, done, total: enabled.length }); }
      catch { /* the listener must never break the search */ }
    };
    const settled = await Promise.all(enabled.map(async (source) => {
      if ((sourceCooldown.get(source.id) || 0) > Date.now()) {
        log("search skipped (cooling down)", source.id);
        notify(source, []);
        return { source, results: [] };
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      // The hidden-window sources (zlib's challenge, PDF Drive's Google widget)
      // ignore the abort signal, so every source also races a wall-clock
      // budget: the fan-out never waits on the slowest browser for minutes.
      const budget = source.kind === "zlib" || source.kind === "pdfdrive" ? Math.max(timeout, 20000) : timeout;
      let hardTimer = null;
      const hardStop = new Promise((_, reject) => {
        hardTimer = setTimeout(() => { controller.abort(); reject(new Error("超时")); }, budget);
      });
      try {
        const results = await Promise.race([fetchSource(source, cleaned, controller.signal), hardStop]);
        sourceFails.delete(source.id);
        sourceCooldown.delete(source.id);
        log("search", source.id, `${Date.now() - startedAt}ms`, results.length, "hits");
        notify(source, results);
        return { source, results };
      } catch (error) {
        const message = String(error?.name === "AbortError" ? "超时" : error?.message || error).slice(0, 160);
        log("search failed", source.id, message, `${Date.now() - startedAt}ms`);
        notify(source, [], message);
        const fails = (sourceFails.get(source.id) || 0) + 1;
        sourceFails.set(source.id, fails);
        if (fails >= SOURCE_FAIL_LIMIT) {
          sourceCooldown.set(source.id, Date.now() + SOURCE_COOLDOWN_MS);
          sourceFails.delete(source.id);
        }
        return { source, error: message };
      } finally {
        clearTimeout(timer);
        clearTimeout(hardTimer);
      }
    }));
    const errors = settled.filter((entry) => entry.error).map((entry) => ({ source: entry.source.id, name: entry.source.name, message: entry.error }));
    const results = dedupeBookResults(settled.flatMap((entry) => entry.results || []));
    log(`search "${cleaned}"`, `${results.length} results,`, `${errors.length} source(s) failed`);
    return { results, errors };
  }

  // Resolves a result into a concrete file URL: Internet Archive metadata, or
  // a session-gated book page whose /dl/ link needs the login cookies.
  async function resolveDownload(result) {
    const url = String(result?.url || "");
    // Session-gated sources hand out bare /dl/ links that only work when the
    // book page triggers them; go through the page whenever we can (a Z-Library
    // row counts even if the marker got lost on the way).
    const info = String(result?.info || "");
    const wantsPage = info && !url && (result?.needsSession === true || result?.source === "zlib" || /\/book\//i.test(info));
    if (wantsPage && typeof pageDownload === "function") {
      return { page: info, format: String(result?.format || ""), session: true };
    }
    if (url) return { url, format: String(result?.format || ""), session: result?.needsSession === true };
    if (result?.needsSession && result?.info) {
      if (typeof pageFetch === "function") {
        const html = await pageFetch(String(result.info));
        const picked = downloadLinkFromZlibPage(String(html || ""), String(result.info), [String(result?.format || "epub").toLowerCase(), "epub", "pdf"]);
        if (!picked?.url) throw new Error("没有找到下载链接；请先在上方登录来源，登录后再试");
        return { ...picked, session: true };
      }
      const page = await fetchImpl(String(result.info), { redirect: "follow" });
      if (!page.ok) throw new Error(`HTTP ${page.status}`);
      const picked = downloadLinkFromZlibPage(await page.text(), String(result.info), [String(result?.format || "epub").toLowerCase(), "epub", "pdf"]);
      if (!picked?.url) throw new Error("没有找到下载链接；请先在上方登录来源，登录后再试");
      return picked;
    }
    // Standard Ebooks book pages carry their own .epub/.azw3 links.
    if (result?.source === "standard-ebooks" || /standardebooks\.org\/ebooks\//i.test(info)) {
      const page = await fetchImpl(info, { redirect: "follow" });
      if (!page.ok) throw new Error(`HTTP ${page.status}`);
      const picked = downloadLinkFromStandardEbooksPage(
        await page.text(),
        info,
        [String(result?.format || "epub").toLowerCase() || "epub", "epub", "azw3"],
      );
      if (!picked?.url) throw new Error("这个来源没有可直接下载的文件");
      return picked;
    }
    // Gutenberg book pages are OPDS documents: the file link lives there.
    if (/\.opds($|[?#])/i.test(info)) {
      const page = await fetchImpl(info, { redirect: "follow" });
      if (!page.ok) throw new Error(`HTTP ${page.status}`);
      const picked = downloadLinkFromOpdsPage(await page.text(), info, [String(result?.format || "epub").toLowerCase() || "epub", "epub", "pdf"]);
      if (!picked?.url && !picked?.page) throw new Error("这个来源没有可直接下载的文件");
      return picked;
    }
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
    if (!picked?.url && !picked?.page) throw new Error("这个来源没有可直接下载的文件");
    const format = picked.format || String(result?.format || "").toLowerCase() || "epub";
    const title = String(result?.title || "book").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "book";
    const dir = ensureRoot();
    if (picked.session && picked.page && typeof pageDownload === "function") {
      return downloadViaBrowser(jobId, result, picked, { format, title, dir, handlers, run: pageDownload, source: picked.page });
    }
    if (picked.session && typeof fileDownload === "function") {
      return downloadViaBrowser(jobId, result, picked, { format, title, dir, handlers, run: fileDownload, source: picked.url });
    }
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

  // Session-gated files come through the hidden renderer, where the source's
  // challenge clearance applies; the file is validated from disk afterwards.
  async function downloadViaBrowser(jobId, result, picked, { format, title, dir, handlers, run = fileDownload, source = "" }) {
    const job = jobs.get(jobId);
    const name = uniqueBookName(dir, `${title}.${format}`);
    const target = path.join(dir, name);
    const attempt = () => run(source, target, {
      onProgress: (progress) => {
        if (job?.cancelled) return;
        handlers?.onProgress?.({ jobId, received: progress?.received || 0, total: progress?.total || 0 });
      },
      format,
    });
    try {
      await attempt();
    } catch (error) {
      if (job?.cancelled) throw error;
      const message = String(error?.message || error);
      // An auth wall (the site answers 204 and never starts the transfer) is
      // not transient: retrying only wastes a minute, and the dead session
      // must go so the row offers the login flow again.
      if (/没有开始下载|204/.test(message)) {
        try { fs.unlinkSync(target); } catch { /* gone */ }
        try { await forgetSession?.(source); } catch { /* best effort */ }
        throw error;
      }
      // Transient drops (proxy resets, interrupted downloads) get one retry;
      // a session source that fails twice counts as a dead login.
      try { fs.unlinkSync(target); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        await attempt();
      } catch (second) {
        if (picked.session) {
          try { fs.unlinkSync(target); } catch { /* gone */ }
          try { await forgetSession?.(source); } catch { /* best effort */ }
        }
        throw second;
      }
    }
    if (job?.cancelled) {
      try { fs.unlinkSync(target); } catch { /* gone */ }
      throw new Error("已取消");
    }
    const size = fs.statSync(target).size;
    if (size < MIN_BOOK_BYTES || !bookHeadLooksValid(readFileHead(target), name)) {
      const head = readFileHead(target).toString("utf8").trimStart();
      try { fs.unlinkSync(target); } catch { /* gone */ }
      if (head.startsWith("<")) {
        // A login/limit page in place of the file: same dead-session story.
        try { await forgetSession?.(source); } catch { /* best effort */ }
        throw new Error("下载到的是网页而不是文件（可能触发来源限额或需要登录）");
      }
      throw new Error("下载到的不是有效书籍文件");
    }
    return { ok: true, jobId, path: target, name, bytes: size, source: result?.source || "", format };
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
          log("download failed", id, result?.source || "", String(error?.message || error).slice(0, 160));
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
