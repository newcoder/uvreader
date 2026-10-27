import { ItemView, setIcon } from "obsidian";
import { createQuizStore, quizManifestHash, quizPaperKey, quizQuestionKey } from "../../../../packages/reader/src/quiz-store.js";
import { quizPageStatSignature, quizPageScanKey, readQuizPageManifest } from "../../../../packages/reader/src/quiz-page-scan.js";
import { withHostBridge } from "./quiz-view.js";

const QUIZ_PAGE_CACHE_SCHEMA = "uvreader.quiz-page-cache/v1";
const QUIZ_PAGE_CACHE_FILE = "page-cache.json";

function baseName(value) {
  const text = String(value || "").replace(/\\/g, "/");
  return text.split("/").filter(Boolean).pop() || text;
}

function timeLabel(value) {
  const time = Number(value) || 0;
  if (!time) return "";
  return new Date(time).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(manifest) {
  const source = String(manifest?.source?.path || "").trim();
  return source ? baseName(source) : "";
}

function durationLabel(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (!seconds) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function vaultRoot() {
  return String(window.qbrDesktop?.paths?.vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function absoluteVaultPath(value) {
  const path = String(value || "").replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(path) || path.startsWith("/")) return path;
  const root = vaultRoot();
  return root ? `${root}/${path.replace(/^\/+/, "")}` : path;
}

function canonicalPath(value) {
  const root = vaultRoot().replace(/^\/+/, "");
  let path = absoluteVaultPath(value).replace(/^\/+/, "");
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) path = path.slice(root.length + 1);
  return path.toLowerCase();
}

function samePath(a, b) {
  return canonicalPath(a) === canonicalPath(b);
}

async function mapLimited(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Math.min(list.length, Math.max(1, Math.trunc(Number(limit) || 1)));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
}

export function createQuizListView(leaf, { app, plugin } = {}) {
  class QuizListView extends ItemView {
    constructor(hostLeaf) {
      super(hostLeaf);
      this.filter = "all";
      this.entries = [];
      this._loaded = false;
      this._closed = false;
      this._calibrating = false;
      this._calibrationFailed = new Set();
      this._calibrationCleanup = null;
      if (plugin && !plugin._quizPageManifestCache) plugin._quizPageManifestCache = new Map();
      this._manifestCache = plugin?._quizPageManifestCache || new Map();
      this._manifestCacheLoaded = Boolean(plugin?._quizPageManifestCacheLoaded);
      this._manifestCacheDirty = false;
      this._manifestCacheTimer = null;
      this.store = createQuizStore({
        adapter: app.vault.adapter,
        root: plugin?._readingRoot?.() || "reading",
      });
    }

    getViewType() {
      return "qbr-quiz-list";
    }

    getDisplayText() {
      return "答题页";
    }

    getIcon() {
      return "file-text";
    }

    async onOpen() {
      this._closed = false;
      this._calibrationFailed.clear();
      this.contentEl.addClass("qbr-quiz-list-view");
      await this._loadManifestCache();
      await this.render();
    }

    async onClose() {
      this._closed = true;
      if (this._manifestCacheTimer) {
        window.clearTimeout(this._manifestCacheTimer);
        this._manifestCacheTimer = null;
      }
      this._calibrationCleanup?.();
      this._calibrationCleanup = null;
      await this._writeManifestCache();
      await this.store?.drain?.().catch(() => {});
      this.contentEl.empty();
    }

    _manifestCachePath() {
      return `${this.store.root}/${QUIZ_PAGE_CACHE_FILE}`;
    }

    async _loadManifestCache() {
      if (this._manifestCacheLoaded) return;
      this._manifestCacheLoaded = true;
      if (plugin) plugin._quizPageManifestCacheLoaded = true;
      try {
        const raw = await app.vault.adapter.read(this._manifestCachePath());
        const data = JSON.parse(raw);
        if (data?.schema !== QUIZ_PAGE_CACHE_SCHEMA || !data.pages || typeof data.pages !== "object") return;
        for (const [key, value] of Object.entries(data.pages)) {
          if (!key || typeof value?.signature !== "string") continue;
          // A fresh in-memory entry wins over an older file entry.
          if (this._manifestCache.has(key)) continue;
          this._manifestCache.set(key, {
            signature: value.signature,
            manifest: value.manifest ?? null,
          });
        }
      } catch {
        // A missing or damaged cache only costs one scan.
      }
    }

    _scheduleManifestCacheWrite() {
      if (this._manifestCacheTimer) return;
      this._manifestCacheTimer = window.setTimeout(() => {
        this._manifestCacheTimer = null;
        void this._writeManifestCache();
      }, 200);
    }

    async _writeManifestCache() {
      if (!this._manifestCacheDirty) return;
      const pages = {};
      for (const [key, value] of this._manifestCache) {
        if (!key || typeof value?.signature !== "string") continue;
        pages[key] = {
          signature: value.signature,
          manifest: value.manifest ?? null,
        };
      }
      const raw = JSON.stringify({
        schema: QUIZ_PAGE_CACHE_SCHEMA,
        updatedAt: Date.now(),
        pages,
      });
      try {
        await app.vault.adapter.write(this._manifestCachePath(), raw);
        this._manifestCacheDirty = false;
      } catch {
        // Keep the in-memory cache; the next list open can retry.
      }
    }

    async _collectEntries() {
      const files = (app.vault.getFiles?.() || [])
        .filter((file) => /\.html?$/i.test(String(file.path || "")))
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0));
      const index = await this.store.readIndex().catch(() => ({ papers: {} }));
      const summaries = Object.values(index.papers || {}).filter((entry) => entry?.htmlPath);
      const summaryByPath = new Map();
      for (const summary of summaries) summaryByPath.set(canonicalPath(summary.htmlPath), summary);
      let generated = [];
      try {
        const state = await window.qbrDesktop?.workshop?.list?.();
        generated = (state?.tasks || [])
          .filter((task) => task.kind === "quiz-llm-export"
            && task.status === "done" && /\.html?$/i.test(String(task.output || "")))
          .map((task) => String(task.output));
      } catch {
        generated = [];
      }

      const fileByPath = new Map();
      for (const file of files) fileByPath.set(canonicalPath(file.path), file);
      const candidates = new Map();
      const addCandidate = (path, { file = null, summary = null } = {}) => {
        const text = String(path || "");
        // The removed standard generator wrote `.quiz.html`. Keep old files on
        // disk, but do not surface them as current answer pages.
        if (!text || /\.quiz\.html?$/i.test(text)) return;
        const key = canonicalPath(text);
        if (!key) return;
        let candidate = candidates.get(key);
        if (!candidate) {
          candidate = { key, path: absoluteVaultPath(text), file: null, summary: null };
          candidates.set(key, candidate);
        }
        if (!candidate.file) candidate.file = file || fileByPath.get(key) || null;
        if (summary && !candidate.summary) candidate.summary = summary;
      };

      // Generated answer pages can live next to an external source, outside
      // the vault. Task history covers newly generated pages; the quiz index
      // covers pages that were opened or submitted.
      for (const output of generated) addCandidate(output);
      for (const file of files) addCandidate(file.path, { file });
      for (const summary of summaries) addCandidate(summary.htmlPath, { summary });

      const entries = (await mapLimited([...candidates.values()], 8, async (candidate) => {
        try {
          return await this._loadPageEntry(candidate, { index, summaryByPath });
        } catch {
          return null;
        }
      })).filter(Boolean);
      entries.sort((a, b) => b.updatedAt - a.updatedAt);
      if (this._manifestCacheDirty) this._scheduleManifestCacheWrite();
      return entries;
    }

    async _loadPageEntry(candidate, { index, summaryByPath }) {
      const { key, path } = candidate;
      const file = candidate.file || null;
      let stat = file?.stat || null;
      if (!stat) {
        try { stat = await app.vault.adapter.stat?.(path); } catch { stat = null; }
      }
      const signature = quizPageStatSignature(stat);
      const cacheKey = quizPageScanKey(path);
      const cacheHit = Boolean(signature)
        && this._manifestCache.get(cacheKey)?.signature === signature;
      const manifest = await readQuizPageManifest({
        adapter: app.vault.adapter,
        path,
        stat,
        cache: this._manifestCache,
        cacheKey,
        // A page that is already known from a task or the quiz index may have
        // its manifest later in the file. Only those pages get the full-file
        // fallback; unindexed HTML is scanned by prefix and never loaded whole.
        fullReadOnHeadMiss: Boolean(candidate.summary) || /答题页/i.test(path),
      });
      const cacheEntry = this._manifestCache.get(cacheKey);
      if (!cacheHit && cacheEntry?.signature === signature) this._manifestCacheDirty = true;
      if (!manifest || !Array.isArray(manifest.questions) || !manifest.questions.length) return null;
      const htmlPath = absoluteVaultPath(path);
      const paperKey = quizPaperKey({
        sourcePath: manifest?.source?.path || "",
        htmlPath,
        manifest,
      });
      const summary = candidate.summary || summaryByPath.get(key) || index.papers?.[paperKey] || null;
      // A regenerated answer page for the same source can share a paper key
      // with an older page. Only claim the summary when it belongs to this
      // HTML file, so an unopened page is not shown as answered.
      const current = Boolean(summary) && (!summary.htmlPath || samePath(summary.htmlPath, htmlPath));
      let detail = null;
      if (current && Number(summary.attempts) > 0) {
        detail = (await this.store.loadPaper(paperKey).catch(() => null))?.paper || null;
      }
      const lastAttempt = detail?.attempts?.[detail.attempts.length - 1] || null;
      const resolved = file || {
        path,
        basename: baseName(path).replace(/\.[^.]+$/, ""),
        stat: stat || {},
      };
      return {
        file: resolved,
        manifest,
        paperKey,
        title: String(manifest.title || resolved.basename || baseName(path) || "答题页"),
        source: sourceLabel(manifest),
        questions: manifest.questions.length,
        answered: Boolean(current && Number(summary.attempts) > 0),
        lastScore: current ? summary.lastScore ?? null : null,
        lastPageScore: current ? summary.lastPageScore ?? lastAttempt?.pageScore ?? null : null,
        lastPageScoreTotal: current ? summary.lastPageScoreTotal ?? lastAttempt?.pageScoreTotal ?? null : null,
        lastDurationSec: current ? Number(summary.lastDurationSec) || Number(lastAttempt?.durationSec) || 0 : 0,
        lastAttemptAt: current ? Number(summary.lastAttemptAt) || Number(lastAttempt?.submittedAt) || 0 : 0,
        lastAttempt,
        hasDraft: Boolean(current && summary.hasDraft),
        updatedAt: Number((current && (summary.lastAttemptAt || summary.updatedAt)) || 0)
          || Number((stat || resolved.stat)?.mtimeMs || (stat || resolved.stat)?.mtime) || 0,
      };
    }

    async _calibrateLegacyScores() {
      if (this._calibrating || this._closed) return;
      const targets = this.entries.filter((entry) => entry.answered
        && entry.lastPageScore == null
        && !this._calibrationFailed.has(entry.paperKey));
      if (!targets.length) return;
      this._calibrating = true;
      let changed = false;
      try {
        for (const entry of targets) {
          if (this._closed) break;
          try {
            const result = await this._calibrateEntry(entry);
            if (!result) {
              this._calibrationFailed.add(entry.paperKey);
              continue;
            }
            const updated = await this.store.updateAttemptResult(entry.paperKey, {
              attemptId: entry.lastAttempt?.attemptId,
              pageScore: result.score,
              pageScoreTotal: result.scoreTotal,
            });
            if (!updated) {
              this._calibrationFailed.add(entry.paperKey);
              continue;
            }
            entry.lastPageScore = result.score;
            entry.lastPageScoreTotal = result.scoreTotal;
            changed = true;
          } catch {
            this._calibrationFailed.add(entry.paperKey);
          }
        }
      } finally {
        this._calibrating = false;
      }
      if (changed && !this._closed && this.contentEl?.isConnected) await this.render(false);
    }

    async _calibrateEntry(entry) {
      const last = entry.lastAttempt;
      if (!last || !entry.manifest) return null;
      if (last.manifestHash && last.manifestHash !== quizManifestHash(entry.manifest)) return null;
      const answers = {};
      for (const question of entry.manifest.questions) {
        const saved = last.answers?.[quizQuestionKey(question)];
        if (saved && typeof saved === "object" && "value" in saved) answers[question.id] = String(saved.value ?? "");
        else if (typeof saved === "string") answers[question.id] = saved;
      }
      if (!Object.values(answers).some((value) => String(value || "").trim())) return null;

      return new Promise((resolve, reject) => {
        let prepared = null;
        let frame = null;
        let timer = null;
        let settled = false;
        let restored = false;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          window.removeEventListener("message", onMessage);
          if (frame) {
            frame.remove();
            frame = null;
          }
          const temp = prepared?.path || "";
          prepared = null;
          if (temp) void window.qbrDesktop?.quiz?.discard?.(temp);
          if (this._calibrationCleanup === cancel) this._calibrationCleanup = null;
        };
        const finish = (value, error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value);
        };
        const cancel = () => finish(null, new Error("calibration cancelled"));
        const onMessage = (event) => {
          if (!frame || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (!data || data.source !== "qbr-quiz") return;
          if (data.type === "ready") {
            if (restored) return;
            restored = true;
            try {
              frame.contentWindow.postMessage({
                source: "qbr-quiz-host",
                type: "restore",
                answers,
                submitted: true,
              }, "*");
            } catch (error) {
              finish(null, error);
            }
          } else if (data.type === "result") {
            if (data.score == null || data.score === "") {
              finish(null);
              return;
            }
            const score = Number(data.score);
            if (!Number.isFinite(score)) {
              finish(null);
              return;
            }
            const total = data.scoreTotal == null || data.scoreTotal === "" ? null : Number(data.scoreTotal);
            finish({ score, scoreTotal: Number.isFinite(total) && total > 0 ? total : null });
          }
        };

        this._calibrationCleanup = cancel;
        void (async () => {
          try {
            const html = await app.vault.adapter.read(entry.file.path);
            if (settled) return;
            prepared = await window.qbrDesktop?.quiz?.prepare?.(withHostBridge(html, { offline: true }));
            if (settled) {
              const temp = prepared?.path || "";
              prepared = null;
              if (temp) void window.qbrDesktop?.quiz?.discard?.(temp);
              return;
            }
            if (!prepared?.ok || !prepared.url) throw new Error("无法准备答题页");
            frame = document.createElement("iframe");
            frame.setAttribute("sandbox", "allow-scripts");
            frame.setAttribute("aria-hidden", "true");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.title = "答题页得分校准";
            frame.tabIndex = -1;
            frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
            window.addEventListener("message", onMessage);
            timer = window.setTimeout(() => finish(null, new Error("答题页得分读取超时")), 8000);
            document.body.appendChild(frame);
            frame.src = prepared.url;
          } catch (error) {
            finish(null, error);
          }
        })();
      });
    }

    async render(reload = true) {
      const host = this.contentEl;
      host.empty();
      const head = host.createDiv("qbr-quiz-list-head");
      const title = head.createDiv("qbr-quiz-list-title");
      title.createDiv({ cls: "qbr-quiz-list-title-text", text: "答题页" });
      const stats = title.createDiv({ cls: "qbr-quiz-list-stats", text: "正在读取…" });
      const actions = head.createDiv("qbr-quiz-list-actions");
      const refresh = actions.createEl("button", {
        cls: "qbr-quiz-list-action",
        attr: { type: "button", "aria-label": "刷新答题页列表" },
      });
      setIcon(refresh, "rotate-ccw");
      refresh.addEventListener("click", () => {
        this._calibrationFailed.clear();
        void this.render(true);
      });

      if (reload || !this._loaded) {
        try {
          this.entries = await this._collectEntries();
          this._loaded = true;
        } catch (error) {
          stats.setText("读取失败");
          host.createDiv("qbr-quiz-list-error").setText(`答题页读取失败：${String(error?.message || error)}`);
          return;
        }
      }

      const answered = this.entries.filter((entry) => entry.answered).length;
      const unanswered = this.entries.length - answered;
      stats.setText(`共 ${this.entries.length} 个 · 已作答 ${answered} · 未作答 ${unanswered}`);

      const filters = host.createDiv("qbr-quiz-list-filters");
      const options = [
        ["all", "全部", this.entries.length],
        ["answered", "已作答", answered],
        ["unanswered", "未作答", unanswered],
      ];
      for (const [id, label, count] of options) {
        const button = filters.createEl("button", {
          cls: `qbr-quiz-list-filter${this.filter === id ? " is-active" : ""}`,
          text: `${label} ${count}`,
          attr: { type: "button" },
        });
        button.addEventListener("click", () => {
          this.filter = id;
          void this.render(false);
        });
      }

      const shown = this.entries.filter((entry) => this.filter === "all"
        || (this.filter === "answered" ? entry.answered : !entry.answered));
      if (!shown.length) {
        host.createDiv("qbr-quiz-list-empty").setText(
          this.entries.length
            ? "没有符合当前筛选的答题页。"
            : "还没有答题页。可以在书坊用「AI 答题页」生成。",
        );
        return;
      }

      const list = host.createDiv("qbr-quiz-list-list");
      for (const entry of shown) this._renderItem(list, entry);
      void this._calibrateLegacyScores();
    }

    _renderItem(list, entry) {
      const row = list.createDiv(`qbr-quiz-list-item ${entry.answered ? "is-answered" : "is-unanswered"}`);
      const open = () => void window.qbrOpenQuiz?.(entry.file.path);
      row.addEventListener("click", open);

      const main = row.createDiv("qbr-quiz-list-main");
      const line = main.createDiv("qbr-quiz-list-row");
      line.createDiv({ cls: "qbr-quiz-list-name", text: entry.title });
      line.createDiv({
        cls: `qbr-quiz-list-badge ${entry.answered ? "is-answered" : "is-unanswered"}`,
        text: entry.answered ? "已作答" : "未作答",
      });
      if (entry.hasDraft && !entry.answered) {
        line.createDiv({ cls: "qbr-quiz-list-draft", text: "有草稿" });
      }

      const meta = main.createDiv("qbr-quiz-list-meta");
      meta.createSpan({ text: `${entry.questions} 道题` });
      if (entry.source) meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
      if (entry.source) meta.createSpan({ text: `来源：${entry.source}` });
      if (entry.file.basename && entry.file.basename !== entry.title) {
        meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
        meta.createSpan({ text: `文件：${entry.file.basename}` });
      }
      if (entry.answered) {
        meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
        const score = entry.lastPageScore != null
          ? `${entry.lastPageScore}${entry.lastPageScoreTotal > 0 ? ` / ${entry.lastPageScoreTotal}` : ""} 分`
          : entry.lastScore != null ? `${entry.lastScore}%（正确率）` : "已交卷";
        meta.createSpan({ cls: "qbr-quiz-list-score", text: score });
        const duration = durationLabel(entry.lastDurationSec);
        meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
        meta.createSpan({ text: duration ? `用时 ${duration}` : "用时未记录" });
        const submittedAt = timeLabel(entry.lastAttemptAt);
        if (submittedAt) {
          meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
          meta.createSpan({ text: submittedAt });
        }
      } else if (entry.hasDraft) {
        meta.createSpan({ cls: "qbr-quiz-list-sep", text: "·" });
        meta.createSpan({ text: "未完成作答已保存" });
      }

      const actions = row.createDiv("qbr-quiz-list-item-actions");
      const button = actions.createEl("button", { cls: "qbr-quiz-list-open", text: "打开", attr: { type: "button" } });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        open();
      });
    }
  }

  return new QuizListView(leaf);
}
