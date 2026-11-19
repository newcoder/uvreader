// 精修工作区的文件读写：polish.md / polish-report.json / polish-session.json。
//
// 工作区不是任务：用户编辑的是整本书 Markdown，session 只存进度、点状态和
// UI 位置。所有路径都以 polish.json 为锚点，避免渲染层传任意文件路径进来。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildPolishOutline, derivePolishReport, mergePolishNoteTexts, normalizePolishToc, parsePolishMarkdown, polishChapterKey, splitPolishMarkdown } from "../shared/polish-markdown.js";

const MAX_MARKDOWN_BYTES = 40 * 1024 * 1024;
const STATUSES = new Set(["open", "resolved", "ignored"]);
const STAGES = new Set(["notes", "body", "done"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

function bundlePaths(manifestPath) {
  const absolute = path.resolve(String(manifestPath || ""));
  if (path.basename(absolute) !== "polish.json") {
    throw new Error("精修清单路径无效");
  }
  if (!fs.existsSync(absolute)) throw new Error("精修清单不存在，请重新生成电子书");
  const dir = path.dirname(absolute);
  return {
    dir,
    manifestPath: absolute,
    markdownPath: path.join(dir, "polish.md"),
    baselinePath: path.join(dir, "polish.baseline.md"),
    reportPath: path.join(dir, "polish-report.json"),
    sessionPath: path.join(dir, "polish-session.json"),
  };
}

function defaultSession(manifest = {}) {
  return {
    schemaVersion: 1,
    buildId: String(manifest.buildId || ""),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ui: { filter: "review", selectedPointId: "", scrollTop: 0 },
    stage: "notes",
    pointStatus: {},
    progress: {},
    files: {},
  };
}

function normalizeStage(value) {
  return STAGES.has(String(value)) ? String(value) : "notes";
}

function normalizeUi(value) {
  const ui = isObject(value) ? value : {};
  const sideTab = ["preview", "inspect", "editor"].includes(String(ui.sideTab)) ? String(ui.sideTab) : "preview";
  return {
    filter: ["review", "all", "done", "repeated", "notes"].includes(String(ui.filter)) ? String(ui.filter) : "review",
    selectedPointId: String(ui.selectedPointId || ""),
    scrollTop: Math.max(0, Number(ui.scrollTop) || 0),
    sideTab,
    tocOpen: ui.tocOpen !== false,
    tocDepth: [1, 2, 3].includes(Number(ui.tocDepth)) ? Number(ui.tocDepth) : 2,
    hideComments: ui.hideComments !== false,
  };
}

function normalizePointStatus(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [id, entry] of Object.entries(value)) {
    const status = String(entry?.status || "");
    if (!id || !STATUSES.has(status)) continue;
    out[id] = {
      status,
      updatedAt: String(entry?.updatedAt || new Date().toISOString()),
    };
  }
  return out;
}

function progressFor(report, pointStatus) {
  const points = Array.isArray(report?.points) ? report.points : [];
  let reviewed = 0;
  let ignored = 0;
  for (const point of points) {
    const status = pointStatus?.[point.id]?.status;
    if (status === "resolved") reviewed += 1;
    else if (status === "ignored") ignored += 1;
  }
  return {
    reviewed,
    ignored,
    remaining: Math.max(0, points.length - reviewed - ignored),
  };
}

export function readPolishBundle(manifestPath) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath);
  if (!isObject(manifest)) throw new Error("精修清单损坏，请重新生成电子书");
  const storedReport = readJson(paths.reportPath, { schemaVersion: 1, summary: {}, points: [] });
  const session = {
    ...defaultSession(manifest),
    ...(readJson(paths.sessionPath, {}) || {}),
  };
  const markdown = fs.existsSync(paths.markdownPath) ? fs.readFileSync(paths.markdownPath, "utf8") : "";
  if (!markdown) throw new Error("polish.md 不存在，请重新生成电子书");
  const hash = hashText(markdown);
  // 修正点是当前文本的检查结果，不是生成时的快照：打开工作区时按当前
  // polish.md 重算，修好的点不再出现，新出现的问题会补进来。顺手把修好的
  // 报告写回磁盘，书坊列表和下次重建就不必再看到旧点数。
  const report = derivePolishReport(markdown, storedReport, manifest);
  if (JSON.stringify(report) !== JSON.stringify(storedReport)) {
    try {
      writeJson(paths.reportPath, report);
    } catch {
      // 只读缓存目录也要能打开工作区；下次保存 Markdown 时再写报告。
    }
  }
  return {
    ...paths,
    manifest,
    report,
    session: {
      ...session,
      ui: normalizeUi(session.ui),
      stage: normalizeStage(session.stage),
      pointStatus: normalizePointStatus(session.pointStatus),
      progress: progressFor(report, normalizePointStatus(session.pointStatus)),
      files: {
        markdown: "polish.md",
        baseline: "polish.baseline.md",
        ...(isObject(session.files) ? session.files : {}),
        markdownHash: hash,
      },
    },
    markdown,
    hash,
    markdownChanged: Boolean(session?.files?.markdownHash && session.files.markdownHash !== hash),
  };
}

export function savePolishMarkdown(manifestPath, markdown) {
  const paths = bundlePaths(manifestPath);
  const text = String(markdown ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new Error("精修文件超过 40 MB，已停止保存");
  }
  const temp = `${paths.markdownPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, paths.markdownPath);
  const hash = hashText(text);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const session = {
    ...defaultSession(manifest),
    ...(readJson(paths.sessionPath, {}) || {}),
  };
  const storedReport = readJson(paths.reportPath, { points: [] });
  const report = derivePolishReport(text, storedReport, manifest);
  if (JSON.stringify(report) !== JSON.stringify(storedReport)) {
    try {
      writeJson(paths.reportPath, report);
    } catch {
      // 报告只是检查结果；写不进报告不能让已经成功的 Markdown 保存失败。
    }
  }
  const pointStatus = normalizePointStatus(session.pointStatus);
  const next = {
    ...session,
    updatedAt: new Date().toISOString(),
    pointStatus,
    progress: progressFor(report, pointStatus),
    files: {
      markdown: "polish.md",
      baseline: "polish.baseline.md",
      ...(isObject(session.files) ? session.files : {}),
      markdownHash: hash,
    },
  };
  writeJson(paths.sessionPath, next);
  return { hash, session: next, report };
}

export function savePolishSession(manifestPath, patch = {}) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const report = readJson(paths.reportPath, { points: [] });
  const session = {
    ...defaultSession(manifest),
    ...(readJson(paths.sessionPath, {}) || {}),
  };
  if (isObject(patch?.ui)) session.ui = normalizeUi({ ...(session.ui || {}), ...patch.ui });
  if (isObject(patch?.extra)) Object.assign(session, patch.extra);
  if (patch && "stage" in patch) session.stage = normalizeStage(patch.stage);
  if (patch && "pointStatus" in patch) session.pointStatus = normalizePointStatus(patch.pointStatus);
  const pointStatus = normalizePointStatus(session.pointStatus);
  const markdownHash = fs.existsSync(paths.markdownPath)
    ? hashText(fs.readFileSync(paths.markdownPath, "utf8"))
    : String(session?.files?.markdownHash || "");
  const next = {
    ...session,
    schemaVersion: 1,
    buildId: String(manifest.buildId || session.buildId || ""),
    updatedAt: new Date().toISOString(),
    ui: normalizeUi(session.ui),
    stage: normalizeStage(session.stage),
    pointStatus,
    progress: progressFor(report, pointStatus),
    files: {
      markdown: "polish.md",
      baseline: "polish.baseline.md",
      ...(isObject(session.files) ? session.files : {}),
      markdownHash,
    },
  };
  writeJson(paths.sessionPath, next);
  return next;
}

// 用户在精修界面主动删掉/合并一条注文后，把它从清单和报告里一起移除，
// 否则重建前的结构校验会误报“缺少 N 个注文定位注释”。
export function forgetPolishNote(manifestPath, noteId) {
  const id = String(noteId || "").trim();
  const paths = bundlePaths(manifestPath);
  if (!id) return readJson(paths.manifestPath, {});
  const manifest = readJson(paths.manifestPath, {}) || {};
  const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
  const markers = Array.isArray(manifest.markers) ? manifest.markers : [];
  manifest.notes = notes.filter((note) => note.id !== id);
  manifest.markers = markers.filter((marker) => marker.noteId !== id && marker.note !== id);
  manifest.updatedAt = new Date().toISOString();
  writeJson(paths.manifestPath, manifest);
  const report = readJson(paths.reportPath, {}) || {};
  if (Array.isArray(report.points)) {
    report.points = report.points.filter((point) => point.noteId !== id);
    writeJson(paths.reportPath, report);
  }
  return manifest;
}

export function savePolishManifest(manifestPath, patch = {}) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const next = {
    ...manifest,
    ...(isObject(patch) ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  writeJson(paths.manifestPath, next);
  return next;
}

// 精修封面只有“指定图片”模式会读取 imagePath。旧版选图后模式仍停在
// “模板生成”，图片因此被忽略。保存时修复这种旧状态；用户主动改回模板、
// 自动或不要封面时传 explicit，以模式为准并清掉闲置图片路径。
export function normalizePolishCover(cover = {}, { explicit = false } = {}) {
  const next = { ...(isObject(cover) ? cover : {}) };
  const imagePath = String(next.imagePath || "").trim();
  if (!imagePath) {
    next.imagePath = "";
    return next;
  }
  if (!explicit && (!next.mode || next.mode === "template")) next.mode = "image";
  if (next.mode !== "image") next.imagePath = "";
  return next;
}

// 精修里的「书籍信息」：封面 + 元数据。只改 polish.json，不改正文；
// 下一次 book-polish 重建时使用这些字段。
export function savePolishInfo(manifestPath, info = {}) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const book = isObject(manifest.book) ? manifest.book : {};
  const build = isObject(manifest.build) ? manifest.build : {};
  const title = String(info.title ?? build.title ?? book.title ?? "").trim();
  if (!title) throw new Error("书名不能为空");
  const author = String(info.author ?? build.author ?? book.author ?? "").trim();
  const language = String(info.language || build.language || book.language || "zh").trim();
  const identifier = String(info.identifier ?? build.identifier ?? "").trim();
  const cover = normalizePolishCover({
    ...(isObject(build.cover) ? build.cover : {}),
    ...(isObject(info.cover) ? info.cover : {}),
  }, { explicit: info.coverModeExplicit === true });
  const next = {
    ...manifest,
    book: { ...book, title, author, language },
    build: { ...build, title, author, language, identifier, cover },
    updatedAt: new Date().toISOString(),
  };
  writeJson(paths.manifestPath, next);
  return readPolishBundle(manifestPath);
}

// 精修预览里的图片通常是相对路径（例如 mineru/images/page_0_image_0.jpg）。
// 渲染层用 file:// 打开不了相对路径，这里按清单的 baseDir 解析成绝对 file URL。
export function resolvePolishAsset(manifestPath, source = "") {
  const requested = String(source || "").trim();
  if (!requested) return "";
  if (/^(?:data:|file:|https?:|blob:)/i.test(requested)) return requested;
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const build = isObject(manifest.build) ? manifest.build : {};
  const baseDir = String(build.baseDir || (build.source ? path.dirname(build.source) : ""));
  let decoded = requested.split(/[?#]/)[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch { /* keep the raw path */ }
  const target = path.isAbsolute(decoded)
    ? decoded
    : path.resolve(baseDir, decoded.replace(/^\.?[\\/]/, ""));
  if (!baseDir && !path.isAbsolute(decoded)) return "";
  if (!fs.existsSync(target)) return "";
  return pathToFileURL(target).href;
}

export function revertPolishMarkdown(manifestPath) {
  const paths = bundlePaths(manifestPath);
  if (!fs.existsSync(paths.baselinePath)) throw new Error("没有可用的基线 Markdown");
  fs.copyFileSync(paths.baselinePath, paths.markdownPath);
  return savePolishSession(manifestPath, {
    pointStatus: {},
    stage: "notes",
    ui: { filter: "review", selectedPointId: "", scrollTop: 0 },
  });
}

function latestPolishBackup(manifestPath) {
  const dir = path.dirname(path.resolve(String(manifestPath || "")));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const backups = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map((entry) => path.join(dir, entry.name, "polish.md"))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return backups[0] || "";
}

// 重新从 PDF 生成后，旧精修里的注文正文已经人工校对过。把最近一份
// backup-*/polish.md 的注文正文迁移到当前编辑内容，保留新文件的章节、
// 注文编号、正文链接和修正点。返回合并后的 Markdown，由渲染层应用并保存。
export function importPolishNotes(manifestPath, markdown = "") {
  const paths = bundlePaths(manifestPath);
  const current = String(markdown || "").trim()
    ? String(markdown)
    : fs.readFileSync(paths.markdownPath, "utf8");
  const backupPath = latestPolishBackup(manifestPath);
  if (!backupPath) return { ok: false, error: "没有找到旧精修备份（backup-*/polish.md）" };
  const result = mergePolishNoteTexts(fs.readFileSync(backupPath, "utf8"), current);
  if (!result.updates) return { ok: false, error: "旧备份里没有可导入的注文正文" };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const currentBackupPath = path.join(paths.dir, `polish.before-import-${stamp}.md`);
  fs.writeFileSync(currentBackupPath, current, "utf8");
  return {
    ok: true,
    markdown: result.markdown,
    updates: result.updates,
    warnings: result.warnings,
    backupPath,
    currentBackupPath,
    oldNotes: result.summary.oldNotes,
    newNotes: result.summary.newNotes,
  };
}

function chapterMetaForTitles(oldChapters, titles) {
  const unused = (Array.isArray(oldChapters) ? oldChapters : []).filter(isObject);
  return titles.map((title, index) => {
    const key = polishChapterKey(title);
    const at = unused.findIndex((chapter) => {
      const oldKey = polishChapterKey(chapter.title);
      return oldKey && key && (oldKey === key || oldKey.includes(key) || key.includes(oldKey));
    });
    if (at >= 0) {
      const [meta] = unused.splice(at, 1);
      return { ...meta, title };
    }
    return { id: `ch-${String(index + 1).padStart(3, "0")}`, title, format: "markdown" };
  });
}

function navFromPolishOutline(markdown, chapterTitles) {
  const outline = buildPolishOutline(markdown, { chapterTitles });
  const chapters = outline.filter((item) => item.kind === "chapter");
  return outline.map((item) => {
    let chapterIndex = 0;
    for (let index = 0; index < chapters.length; index += 1) {
      if (chapters[index].line <= item.line) chapterIndex = index;
    }
    return {
      title: item.title,
      file: `chapter-${String(chapterIndex + 1).padStart(3, "0")}.xhtml`,
      level: item.level,
    };
  });
}

// Imported polish documents often flatten every heading to ##. Restore the
// chapter/section levels from the workspace baseline, then persist the chapter
// list and a fresh outline so the editor preview and the next EPUB rebuild
// agree on the TOC.
function normalizePolishTocInWorkspace(manifestPath, markdown, { backupPrefix = "" } = {}) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const text = String(markdown ?? "");
  if (!text.trim()) throw new Error("精修 Markdown 是空的");
  const baseline = fs.existsSync(paths.baselinePath) ? fs.readFileSync(paths.baselinePath, "utf8") : "";
  const oldTitles = (Array.isArray(manifest.chapters) ? manifest.chapters : [])
    .map((chapter) => String(chapter?.title || "").trim())
    .filter(Boolean);
  const normalized = normalizePolishToc(text, { baselineMarkdown: baseline, chapterTitles: oldTitles });
  const changed = normalized.markdown !== text;
  let backupPath = "";
  if (changed && backupPrefix) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    backupPath = path.join(paths.dir, `${backupPrefix}-${stamp}.md`);
    fs.writeFileSync(backupPath, text, "utf8");
  }
  const saved = changed ? savePolishMarkdown(manifestPath, normalized.markdown) : null;
  let split = splitPolishMarkdown(normalized.markdown, { chapterTitles: normalized.chapterTitles });
  // A forced import of a different book has no titles matching the baseline;
  // fall back to its own ## headings instead of replacing the chapter list
  // with an empty one.
  if (!split.chapters.length) split = splitPolishMarkdown(normalized.markdown, {});
  const chapters = split.chapters;
  const nav = navFromPolishOutline(normalized.markdown, normalized.chapterTitles);
  savePolishManifest(manifestPath, {
    ...(saved ? { markdownHash: saved.hash } : {}),
    chapters: chapterMetaForTitles(manifest.chapters, chapters.map((chapter) => chapter.title)),
    nav,
  });
  return {
    ok: true,
    changed,
    markdown: normalized.markdown,
    chapterTitles: normalized.chapterTitles,
    chapters: chapters.length,
    nav: nav.length,
    backupPath,
    saved,
  };
}

export function repairPolishHeadings(manifestPath, markdown = "") {
  const paths = bundlePaths(manifestPath);
  const current = String(markdown || "").trim()
    ? String(markdown)
    : (fs.existsSync(paths.markdownPath) ? fs.readFileSync(paths.markdownPath, "utf8") : "");
  return normalizePolishTocInWorkspace(manifestPath, current, { backupPrefix: "polish.before-toc-repair" });
}

export function validatePolishStructure(manifestPath, markdown) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const report = readJson(paths.reportPath, { points: [] });
  const parsed = parsePolishMarkdown(markdown);
  const chapterTitles = (Array.isArray(manifest.chapters) ? manifest.chapters : [])
    .map((chapter) => String(chapter?.title || "").trim())
    .filter(Boolean);
  const split = splitPolishMarkdown(markdown, { chapterTitles });
  const errors = [];
  const warnings = [];
  const expectedChapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
  if (!split.chapters.length) errors.push("没有找到任何章节标题（##）");
  if (expectedChapters.length && split.chapters.length !== expectedChapters.length) {
    // 手工整理时可能合并/删除章节标题。重建会按当前 Markdown 生成，
    // 并重新对齐清单里的章节元数据和目录；不要因此阻断。
    warnings.push(`章节数从 ${expectedChapters.length} 变成 ${split.chapters.length}；将按当前 ## 标题重建目录`);
  }
  const seenNotes = new Set();
  for (const note of parsed.notes) {
    if (seenNotes.has(note.id)) errors.push(`注释 ${note.id} 重复出现`);
    seenNotes.add(note.id);
  }
  const expectedNotes = new Set((Array.isArray(manifest.notes) ? manifest.notes : []).map((note) => note.id));
  const missingNotes = [...expectedNotes].filter((id) => !seenNotes.has(id));
  if (missingNotes.length) {
    // polish.md 是可直接手工编辑的。注文定位注释被合并/删除后，清单里的旧 ID
    // 不应该阻断重建；按当前 Markdown 继续，并在重建结束时清理旧清单项。
    warnings.push(`清单里有 ${missingNotes.length} 个注文已不在 polish.md（如 ${missingNotes.slice(0, 3).join("、")}）；将按当前 Markdown 继续`);
  }
  const seenMarkers = new Set();
  for (const marker of parsed.markers) {
    if (seenMarkers.has(marker.id)) errors.push(`正文标记 ${marker.id} 重复出现`);
    seenMarkers.add(marker.id);
  }
  // 实时检查生成的修正点没有对应的隐藏注释（point-live-*），它们靠
  // note/marker 注释定位；校验时不能把它们当成“注释被删了”。
  const expectedPoints = new Set((Array.isArray(report.points) ? report.points : [])
    .filter((point) => !String(point?.id || "").startsWith("point-live-"))
    .map((point) => point.id));
  const seenPoints = new Set(parsed.points.map((point) => point.id));
  const missingPoints = [...expectedPoints].filter((id) => !seenPoints.has(id));
  if (missingPoints.length) {
    warnings.push(`${missingPoints.length} 个修正点注释已被删除；已按文本内容继续`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    parsed,
    split,
    missingPoints,
    missingNotes,
  };
}

export function copyPolishMarkdown(manifestPath, targetPath, markdown) {
  const paths = bundlePaths(manifestPath);
  const target = path.resolve(String(targetPath || ""));
  if (!target) throw new Error("请选择另存位置");
  const text = markdown === undefined
    ? fs.readFileSync(paths.markdownPath, "utf8")
    : String(markdown ?? "");
  const info = polishSnapshotInfo(manifestPath, text);
  const encoded = Buffer.from(JSON.stringify(info), "utf8").toString("base64");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `<!-- polish:snapshot ${encoded} -->\n\n${text}`, "utf8");
  return target;
}

// 另存/导入用的轻量指纹。原书路径和构建 ID 是判断“同一本书”的强信号；
// 章节标题用于旧文件没有指纹、或书被移动过时做兜底。
export function polishSnapshotInfo(manifestPath, markdown) {
  const paths = bundlePaths(manifestPath);
  const manifest = readJson(paths.manifestPath, {}) || {};
  const text = markdown === undefined
    ? (fs.existsSync(paths.markdownPath) ? fs.readFileSync(paths.markdownPath, "utf8") : "")
    : String(markdown ?? "");
  const book = isObject(manifest.book) ? manifest.book : {};
  const build = isObject(manifest.build) ? manifest.build : {};
  const parsed = parsePolishMarkdown(text);
  const chapterTitles = (Array.isArray(manifest.chapters) ? manifest.chapters : [])
    .map((chapter) => String(chapter?.title || "").trim())
    .filter(Boolean);
  return {
    schemaVersion: 1,
    kind: "uvreader-polish",
    createdAt: new Date().toISOString(),
    title: String(book.title || build.title || ""),
    author: String(book.author || build.author || ""),
    language: String(book.language || build.language || ""),
    source: String(build.source || ""),
    buildId: String(manifest.buildId || ""),
    chapterTitles,
    chapterCount: chapterTitles.length,
    noteCount: parsed.notes.length,
    markerCount: parsed.markers.length,
    markdownHash: hashText(text),
  };
}

const SNAPSHOT_HEADER_RE = /^\uFEFF?\s*<!--\s*polish:snapshot\s+([A-Za-z0-9+/=]+)\s*-->\s*\n*/;

export function parsePolishSnapshot(value) {
  const raw = String(value || "").replace(/^\uFEFF/, "");
  const match = raw.match(SNAPSHOT_HEADER_RE);
  if (!match) return { info: null, markdown: raw };
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const info = JSON.parse(decoded);
    return {
      info: isObject(info) ? info : null,
      markdown: raw.slice(match[0].length),
    };
  } catch {
    return { info: null, markdown: raw };
  }
}

function fingerprintPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLowerCase();
}

function titleFingerprint(value) {
  return String(value || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function titleMatches(left, right) {
  const a = titleFingerprint(left);
  const b = titleFingerprint(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// 导入前先看文件指纹和章节结构，返回给渲染层做确认；不写任何文件。
export function inspectPolishImport(manifestPath, filePath) {
  const paths = bundlePaths(manifestPath);
  const file = path.resolve(String(filePath || ""));
  if (!file || !fs.existsSync(file)) throw new Error("找不到要导入的精修文件");
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("请选择一个精修 Markdown 文件");
  if (stat.size > MAX_MARKDOWN_BYTES) throw new Error("精修文件超过 40 MB，已停止读取");
  const raw = fs.readFileSync(file, "utf8");
  const snapshot = parsePolishSnapshot(raw);
  const markdown = snapshot.markdown;
  const manifest = readJson(paths.manifestPath, {}) || {};
  const book = isObject(manifest.book) ? manifest.book : {};
  const build = isObject(manifest.build) ? manifest.build : {};
  const parsed = parsePolishMarkdown(markdown);
  const currentTitles = (Array.isArray(manifest.chapters) ? manifest.chapters : [])
    .map((chapter) => String(chapter?.title || "").trim())
    .filter(Boolean);
  const baseline = fs.existsSync(paths.baselinePath) ? fs.readFileSync(paths.baselinePath, "utf8") : "";
  const normalized = normalizePolishToc(markdown, { baselineMarkdown: baseline, chapterTitles: currentTitles });
  let split = splitPolishMarkdown(normalized.markdown, { chapterTitles: normalized.chapterTitles });
  if (!split.chapters.length) split = splitPolishMarkdown(normalized.markdown, {});
  const incomingTitles = split.chapters
    .map((chapter) => String(chapter.title || "").trim())
    .filter(Boolean);
  const errors = [];
  const warnings = [];
  if (!markdown.trim()) errors.push("文件是空的");
  if (!split.chapters.length) errors.push("文件里没有找到章节标题（##）");
  const noteIds = parsed.notes.map((note) => note.id);
  if (new Set(noteIds).size !== noteIds.length) errors.push("文件里的注文 ID 有重复");
  const markerIds = parsed.markers.map((marker) => marker.id);
  if (new Set(markerIds).size !== markerIds.length) errors.push("文件里的正文标记 ID 有重复");

  const currentTitle = String(book.title || build.title || "");
  const infoTitle = String(snapshot.info?.title || "");
  const currentSource = fingerprintPath(build.source || "");
  const incomingSource = fingerprintPath(snapshot.info?.source || "");
  const currentBuild = String(manifest.buildId || "");
  const incomingBuild = String(snapshot.info?.buildId || "");
  const sameBuild = Boolean(currentBuild && incomingBuild && currentBuild === incomingBuild);
  const sameSource = Boolean(currentSource && incomingSource && currentSource === incomingSource);
  const titleSame = Boolean(currentTitle && infoTitle && titleMatches(currentTitle, infoTitle));
  const matchedTitles = incomingTitles.filter((title) => (
    currentTitles.some((current) => titleMatches(current, title))
  )).length;
  const overlap = incomingTitles.length ? matchedTitles / incomingTitles.length : 0;
  const hasFingerprint = Boolean(snapshot.info);
  let confidence = "different";
  if (sameBuild || sameSource) confidence = "same";
  else if (hasFingerprint) {
    if (titleSame && (overlap >= 0.5 || currentTitles.length === incomingTitles.length)) confidence = "likely";
    else if (overlap >= 0.7) confidence = "likely";
  } else if (overlap >= 0.7) confidence = "likely";

  if (sameBuild) warnings.push("构建 ID 与当前工作区一致");
  if (sameSource) warnings.push("原书路径与当前工作区一致");
  if (infoTitle && currentTitle && !titleSame) {
    warnings.push(`书名不同：文件是“${infoTitle}”，当前是“${currentTitle}”`);
  }
  if (incomingSource && currentSource && !sameSource) {
    warnings.push(`原书路径不同：${snapshot.info?.source || ""}`);
  }
  if (incomingTitles.length && overlap < 1) {
    warnings.push(`章节标题匹配 ${Math.round(overlap * 100)}%`);
  }
  if (!hasFingerprint) {
    warnings.push("文件没有精修指纹，只能按章节标题判断是否同一本书");
  }
  if (currentTitles.length && incomingTitles.length && currentTitles.length !== incomingTitles.length) {
    warnings.push(`文件有 ${incomingTitles.length} 章，当前工作区有 ${currentTitles.length} 章`);
  }
  const stats = {
    chapters: split.chapters.length,
    notes: parsed.notes.length,
    markers: parsed.markers.length,
    points: parsed.points.length,
    bytes: stat.size,
  };
  return {
    ok: errors.length === 0,
    filePath: file,
    info: snapshot.info,
    sameBook: confidence !== "different",
    confidence,
    reasons: warnings,
    warnings,
    errors,
    stats,
    current: {
      title: currentTitle,
      source: String(build.source || ""),
      buildId: currentBuild,
      chapters: currentTitles.length,
    },
    incoming: {
      title: infoTitle,
      source: String(snapshot.info?.source || ""),
      buildId: incomingBuild,
      chapters: incomingTitles.length,
    },
  };
}

// 整套精修内容的导入：用文件替换 polish.md，保留当前清单里的章节/封面/
// 输出设置，重建时会直接读取替换后的 Markdown。导入前自动备份当前文本。
export function importPolishMarkdown(manifestPath, filePath, { force = false, currentMarkdown = "" } = {}) {
  const inspection = inspectPolishImport(manifestPath, filePath);
  if (!inspection.ok) {
    return { ok: false, error: inspection.errors.join("；"), inspection };
  }
  if (!inspection.sameBook && !force) {
    return {
      ok: false,
      error: "这个文件看起来不是同一本书；确认要覆盖当前精修后才能导入",
      needsForce: true,
      inspection,
    };
  }
  const paths = bundlePaths(manifestPath);
  const snapshot = parsePolishSnapshot(fs.readFileSync(inspection.filePath, "utf8"));
  const text = snapshot.markdown;
  const current = String(currentMarkdown || "")
    || (fs.existsSync(paths.markdownPath) ? fs.readFileSync(paths.markdownPath, "utf8") : "");
  if (current === text) {
    return { ok: true, unchanged: true, backupPath: "", inspection };
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const backupPath = path.join(paths.dir, `polish.before-import-${stamp}.md`);
  fs.writeFileSync(backupPath, current, "utf8");
  const imported = savePolishMarkdown(manifestPath, text);
  // The imported file may have flattened every heading to ##. Restore chapter
  // levels from the workspace baseline before the next rebuild reads it.
  const normalized = normalizePolishTocInWorkspace(manifestPath, text);
  const saved = normalized.saved || imported;
  const parsed = parsePolishMarkdown(normalized.markdown);
  savePolishSession(manifestPath, {
    pointStatus: {},
    stage: parsed.markers.length ? "body" : "notes",
    ui: { filter: "review", selectedPointId: "", scrollTop: 0, sideTab: "preview" },
  });
  const manifest = readJson(paths.manifestPath, {}) || {};
  manifest.markdownHash = saved.hash;
  manifest.updatedAt = new Date().toISOString();
  if (saved.report?.summary) {
    manifest.stats = { ...(isObject(manifest.stats) ? manifest.stats : {}), ...saved.report.summary };
  }
  writeJson(paths.manifestPath, manifest);
  return {
    ok: true,
    unchanged: false,
    changedHeadings: normalized.changed,
    chapters: normalized.chapters,
    nav: normalized.nav,
    backupPath,
    inspection,
    bundle: readPolishBundle(manifestPath),
  };
}

export function polishWorkspaceDir(manifestPath) {
  const absolute = path.resolve(String(manifestPath || ""));
  if (path.basename(absolute) !== "polish.json") throw new Error("精修清单路径无效");
  if (!fs.existsSync(absolute)) throw new Error("精修清单不存在，可能已经删除");
  const dir = path.dirname(absolute);
  if (path.basename(dir) !== "polish") throw new Error("精修工作区路径无效");
  return dir;
}

export function findPolishBundleForSource(cacheRoot, source, vaultRoot = "") {
  if (!cacheRoot || !source) return null;
  const target = path.resolve(String(vaultRoot || ""), String(source || "")).replace(/\\/g, "/").toLowerCase();
  for (const item of listPolishBundles(cacheRoot, 200, { audit: false })) {
    const manifest = readJson(item.manifestPath, {}) || {};
    const buildSource = String(manifest.build?.source || "").replace(/\\/g, "/").toLowerCase();
    if (buildSource && buildSource === target) return item;
  }
  return null;
}

export function listPolishBundles(cacheRoot, limit = 12, { audit = true } = {}) {
  if (!cacheRoot) return [];
  const root = path.join(String(cacheRoot), "work");
  if (!fs.existsSync(root)) return [];
  const items = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "polish", "polish.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const stat = fs.statSync(manifestPath);
      const sessionPath = path.join(path.dirname(manifestPath), "polish-session.json");
      const sessionStat = fs.existsSync(sessionPath) ? fs.statSync(sessionPath) : null;
      const manifest = readJson(manifestPath, {}) || {};
      const report = readJson(path.join(path.dirname(manifestPath), "polish-report.json"), { summary: {}, points: [] });
      const session = readJson(sessionPath, {}) || {};
      const pointStatus = normalizePointStatus(session.pointStatus);
      const progress = progressFor(report, pointStatus);
      items.push({
        manifestPath,
        buildId: String(manifest.buildId || ""),
        title: String(manifest.book?.title || ""),
        author: String(manifest.book?.author || ""),
        output: String(manifest.build?.out || ""),
        needsReview: Array.isArray(report.points) ? report.points.length : 0,
        chapterIssues: Number(report.summary?.chapterIssues) || 0,
        reviewed: progress.reviewed,
        ignored: progress.ignored,
        remaining: progress.remaining,
        updatedAt: Math.max(Number(stat.mtimeMs) || 0, Number(sessionStat?.mtimeMs) || 0),
      });
    } catch {
      // 缓存目录里可能有写到一半的清单，跳过即可。
    }
  }
  const selected = items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Number(limit) || 12));
  // 列表里的“待确认”也要反映当前文本；只对最终返回的少量条目做实时检查，
  // findPolishBundleForSource 这类批量查找可以传 audit:false 跳过。
  if (!audit) return selected;
  for (const item of selected) {
    try {
      const dir = path.dirname(item.manifestPath);
      const markdownPath = path.join(dir, "polish.md");
      if (!fs.existsSync(markdownPath)) continue;
      const manifest = readJson(item.manifestPath, {}) || {};
      const session = readJson(path.join(dir, "polish-session.json"), {}) || {};
      const report = derivePolishReport(fs.readFileSync(markdownPath, "utf8"), readJson(path.join(dir, "polish-report.json"), { points: [] }), manifest);
      const progress = progressFor(report, normalizePointStatus(session.pointStatus));
      item.needsReview = report.points.length;
      item.chapterIssues = Number(report.summary?.chapterIssues) || 0;
      item.reviewed = progress.reviewed;
      item.ignored = progress.ignored;
      item.remaining = progress.remaining;
    } catch {
      // 单个条目的 Markdown 坏了不影响整张列表。
    }
  }
  return selected;
}
