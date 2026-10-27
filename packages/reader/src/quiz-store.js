// Persistent attempts for standalone quiz HTML pages. The store is
// intentionally independent from the per-book reading traces. All writes go
// through the same verified JSON helpers as reading data so one damaged paper
// cannot block the rest of the library.
import { cloneJson, createSerialTaskQueue, readJsonRecordStore, writeVerifiedJsonRecord } from "./storage.js";

export const QUIZ_STORE_SCHEMA = "uvreader.quiz-store/v1";
export const QUIZ_PAPER_SCHEMA = "uvreader.quiz-paper/v1";
export const QUIZ_ATTEMPT_SCHEMA = "uvreader.quiz-attempt/v2";
const MAX_ATTEMPTS = 50;

function normalized(value) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, "")
    .replace(/_{3,}|（\s*）|\(\s*\)/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

// FNV-1a is enough for a local filename/identity key. Content comparisons use
// normalized question text, not this hash alone.
export function quizHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value == null ? "" : value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function quizPaperKey({ sourcePath = "", htmlPath = "", manifest = null } = {}) {
  const identity = sourcePath || manifest?.source?.path || htmlPath || manifest?.paperId || manifest?.title || "quiz";
  return `p_${quizHash(identity)}`;
}

export function quizQuestionKey(question = {}) {
  const options = (question.options || []).map((option) => `${option.key || ""}:${normalized(option.html || option.text)}`).join("|");
  return `q_${quizHash(`${question.type || ""}|${normalized(question.stemHtml || question.stemText)}|${options}`)}`;
}

export function quizManifestHash(manifest = {}) {
  return quizHash(JSON.stringify(manifest?.questions || []));
}

function emptyIndex() {
  return { schema: QUIZ_STORE_SCHEMA, updatedAt: 0, papers: {} };
}

function normalizeIndex(value) {
  if (!value || typeof value !== "object" || !value.papers || typeof value.papers !== "object") return emptyIndex();
  return { schema: QUIZ_STORE_SCHEMA, updatedAt: Number(value.updatedAt) || 0, papers: value.papers };
}

function emptyPaper(paperKey, meta = {}) {
  return {
    schema: QUIZ_PAPER_SCHEMA,
    paperKey,
    title: String(meta.title || "答题页"),
    source: meta.source || null,
    htmlPath: String(meta.htmlPath || ""),
    manifestHash: String(meta.manifestHash || ""),
    attempts: [],
    draft: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function summarizePaper(paper) {
  const last = paper.attempts?.[paper.attempts.length - 1];
  return {
    title: paper.title,
    sourcePath: paper.source?.path || "",
    htmlPath: paper.htmlPath || "",
    attempts: paper.attempts?.length || 0,
    lastScore: last?.summary?.score ?? null,
    lastPageScore: last?.pageScore ?? null,
    lastPageScoreTotal: last?.pageScoreTotal ?? null,
    lastDurationSec: Number(last?.durationSec) || 0,
    lastAttemptAt: last?.submittedAt || 0,
    hasDraft: Boolean(paper.draft && Object.keys(paper.draft.answers || {}).length),
    updatedAt: paper.updatedAt || 0,
  };
}

export function createQuizStore({ adapter, root, now = Date.now }) {
  const base = `${String(root || "").replace(/^\/+|\/+$/g, "")}/_quiz`;
  const indexPath = `${base}/index.json`;
  const papersDir = `${base}/papers`;
  const queue = createSerialTaskQueue();

  async function ensureDir(dir) {
    const parts = String(dir || "").split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await adapter.exists(current)) await adapter.mkdir(current);
    }
  }

  function paperPath(paperKey) {
    return `${papersDir}/${paperKey}.json`;
  }

  async function readIndex() {
    const result = await readJsonRecordStore(adapter, indexPath, "quiz index");
    return result.status === "unreadable" ? emptyIndex() : normalizeIndex(result.value);
  }

  async function writeIndex(index) {
    index.schema = QUIZ_STORE_SCHEMA;
    index.updatedAt = now();
    await writeVerifiedJsonRecord(adapter, indexPath, index, { validateExisting: false });
  }

  async function loadPaper(paperKey) {
    const result = await readJsonRecordStore(adapter, paperPath(paperKey), "quiz paper");
    if (result.status === "unreadable") return { status: "unreadable", error: result.error };
    if (result.status !== "ok") return { status: "missing", paper: null };
    return { status: "ok", paper: result.value };
  }

  async function savePaperUnlocked(paper) {
    paper.schema = QUIZ_PAPER_SCHEMA;
    // Older builds kept a per-question wrong bank and question snapshots here.
    // Drop them when the paper is next written.
    delete paper.wrong;
    delete paper.questions;
    paper.updatedAt = now();
    await ensureDir(papersDir);
    await writeVerifiedJsonRecord(adapter, paperPath(paper.paperKey), paper);
    const index = await readIndex();
    index.papers[paper.paperKey] = summarizePaper(paper);
    await writeIndex(index);
    return paper;
  }

  function ensurePaperUnlocked(paperKey, meta = {}) {
    return loadPaper(paperKey).then(async (loaded) => {
      if (loaded.status === "unreadable") throw new Error("答题记录文件损坏，已保留原文件");
      const paper = loaded.paper || emptyPaper(paperKey, meta);
      paper.title = String(meta.title || paper.title || "答题页");
      paper.source = meta.source || paper.source || null;
      paper.htmlPath = String(meta.htmlPath || paper.htmlPath || "");
      paper.manifestHash = String(meta.manifestHash || paper.manifestHash || "");
      return savePaperUnlocked(paper);
    });
  }

  function ensurePaper(paperKey, meta = {}) {
    return queue.run(() => ensurePaperUnlocked(paperKey, cloneJson(meta)));
  }

  function saveDraft(paperKey, draft) {
    return queue.run(async () => {
      const loaded = await loadPaper(paperKey);
      if (loaded.status === "unreadable" || !loaded.paper) return false;
      const paper = loaded.paper;
      paper.draft = cloneJson(draft);
      await savePaperUnlocked(paper);
      return true;
    });
  }

  function clearDraft(paperKey) {
    return queue.run(async () => {
      const loaded = await loadPaper(paperKey);
      if (loaded.status !== "ok" || !loaded.paper?.draft) return false;
      loaded.paper.draft = null;
      await savePaperUnlocked(loaded.paper);
      return true;
    });
  }

  function submitAttempt(paperKey, attempt) {
    return queue.run(async () => {
      const loaded = await loadPaper(paperKey);
      if (loaded.status === "unreadable" || !loaded.paper) throw new Error("答题记录文件不可用");
      const paper = loaded.paper;
      const submitted = {
        ...cloneJson(attempt),
        schema: QUIZ_ATTEMPT_SCHEMA,
        attemptId: String(attempt.attemptId || `attempt-${now().toString(36)}`),
        submittedAt: Number(attempt.submittedAt) || now(),
      };
      paper.attempts = [...(paper.attempts || []), submitted].slice(-MAX_ATTEMPTS);
      paper.draft = null;
      return savePaperUnlocked(paper);
    });
  }

  function updateAttemptResult(paperKey, patch = {}) {
    return queue.run(async () => {
      const loaded = await loadPaper(paperKey);
      if (loaded.status !== "ok" || !loaded.paper?.attempts?.length) return false;
      const last = loaded.paper.attempts[loaded.paper.attempts.length - 1];
      if (last.attemptId && last.attemptId !== patch.attemptId) return false;
      if (patch.pageScore != null && patch.pageScore !== "" && Number.isFinite(Number(patch.pageScore))) {
        last.pageScore = Number(patch.pageScore);
      }
      if (patch.pageScoreTotal != null && patch.pageScoreTotal !== "" && Number.isFinite(Number(patch.pageScoreTotal)) && Number(patch.pageScoreTotal) > 0) {
        last.pageScoreTotal = Number(patch.pageScoreTotal);
      }
      await savePaperUnlocked(loaded.paper);
      return true;
    });
  }

  return {
    root: base,
    indexPath,
    quizHash,
    quizPaperKey,
    quizQuestionKey,
    loadPaper: (paperKey) => queue.run(() => loadPaper(paperKey)),
    ensurePaper: (paperKey, meta) => ensurePaper(paperKey, meta),
    saveDraft: (paperKey, draft) => saveDraft(paperKey, draft),
    clearDraft: (paperKey) => clearDraft(paperKey),
    submitAttempt: (paperKey, attempt) => submitAttempt(paperKey, attempt),
    updateAttemptResult: (paperKey, patch) => updateAttemptResult(paperKey, patch),
    readIndex: () => queue.run(readIndex),
    drain: () => queue.drain(),
  };
}
