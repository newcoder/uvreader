// One-time migration from the old app-data directory to the new one.
//
// The desktop shell used to keep everything under
// %APPDATA%/qiaomu-reader-desktop. The product is now UV Reader, so the
// canonical directory is %APPDATA%/uvreader-desktop. Move (or copy) the old
// tree and rewrite absolute paths stored inside JSON/Markdown, otherwise the
// space registry, polish workspaces and quiz records would still point at the
// old location.
import fs from "node:fs";
import path from "node:path";

import { removeTree } from "./paths.js";

export const LEGACY_USER_DATA_NAME = "qiaomu-reader-desktop";
export const USER_DATA_NAME = "uvreader-desktop";
export const MIGRATION_MARKER = ".uvreader-data-migration.json";

const BACKUP_PREFIX = ".migration-backup-";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".json", ".jsonc", ".md", ".markdown", ".txt", ".html", ".htm", ".log",
  ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".css", ".xml", ".yaml",
  ".yml", ".csv", ".ini", ".conf",
]);

function isTextCandidate(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function stampFor(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function hasMarker(root) {
  try {
    return fs.existsSync(path.join(root, MIGRATION_MARKER));
  } catch {
    return false;
  }
}

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, MIGRATION_MARKER), "utf8"));
  } catch {
    return null;
  }
}

// Rewrite only small text files that actually contain the old directory name.
// Keeping a copy of every touched file makes the path rewrite reversible.
export function rewriteStoredPaths(root, { fromName = LEGACY_USER_DATA_NAME, toName = USER_DATA_NAME, now = new Date() } = {}) {
  const backupRoot = path.join(root, `${BACKUP_PREFIX}${stampFor(now)}`);
  const errors = [];
  let files = 0;
  let bytes = 0;

  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push(`${dir}: ${String(error?.message || error)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(BACKUP_PREFIX)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile() || !isTextCandidate(full)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_TEXT_BYTES) continue;
      let text = "";
      try {
        text = fs.readFileSync(full, "utf8");
      } catch (error) {
        errors.push(`${full}: ${String(error?.message || error)}`);
        continue;
      }
      if (!text.includes(fromName)) continue;
      const relative = path.relative(root, full);
      const backup = path.join(backupRoot, relative);
      try {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(full, backup);
        const next = text.split(fromName).join(toName);
        fs.writeFileSync(full, next, "utf8");
        files += 1;
        bytes += stat.size;
      } catch (error) {
        errors.push(`${full}: ${String(error?.message || error)}`);
      }
    }
  };

  visit(root);
  return {
    files,
    bytes,
    backupRoot: files ? backupRoot : "",
    errors,
  };
}

function writeMarker(root, marker) {
  try {
    fs.writeFileSync(path.join(root, MIGRATION_MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch {
    /* the migration itself already succeeded; the marker is only a hint */
  }
}

function copyTree(from, to, copy) {
  copy(from, to, { recursive: true, force: true });
}

// A target directory without a migration marker is either empty (created by a
// previous launch) or a partial copy from an interrupted migration. Keep it as
// a backup instead of merging it into the fresh migration, otherwise an old
// partial file can mask the complete file from the legacy tree.
function moveExistingTargetAside(to, now) {
  if (!fs.existsSync(to)) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(to);
  } catch (error) {
    throw new Error(`无法读取现有数据目录 ${to}: ${String(error?.message || error)}`);
  }
  if (!entries.length) {
    fs.rmdirSync(to);
    return "";
  }
  const backup = `${to}.before-migration-${stampFor(now)}`;
  fs.renameSync(to, backup);
  return backup;
}

export function migrateUserData({
  appData,
  fromName = LEGACY_USER_DATA_NAME,
  toName = USER_DATA_NAME,
  rename = fs.renameSync,
  copy = fs.cpSync,
  now = new Date(),
} = {}) {
  if (!appData) throw new Error("缺少 appData 目录");
  const from = path.join(appData, fromName);
  const to = path.join(appData, toName);
  fs.mkdirSync(appData, { recursive: true });

  if (!fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    return { ok: true, mode: "created", userData: to, from, to };
  }

  if (fs.existsSync(to) && hasMarker(to)) {
    return { ok: true, mode: "current", userData: to, from, to };
  }

  let previousTarget = "";
  try {
    previousTarget = moveExistingTargetAside(to, now);
  } catch (error) {
    return {
      ok: false,
      mode: "failed",
      userData: from,
      from,
      to,
      error: String(error?.message || error),
    };
  }

  let mode = "move";
  let error = null;
  try {
    rename(from, to);
  } catch (renameError) {
    // Rename can fail when a file is still open or when the two paths are on
    // different volumes. Copy into a staging directory first, then publish it
    // atomically; a failed copy must not leave a half-migrated target.
    mode = "copy";
    const staging = path.join(appData, `${toName}.migration-${stampFor(now)}-${process.pid}`);
    try {
      copyTree(from, staging, copy);
      rename(staging, to);
    } catch (copyError) {
      try { removeTree(staging); } catch { /* best effort */ }
      error = copyError;
    }
  }

  if (error) {
    return {
      ok: false,
      mode: "failed",
      userData: from,
      from,
      to,
      previousTarget,
      error: String(error?.message || error),
    };
  }

  const rewrite = rewriteStoredPaths(to, { fromName, toName, now });
  const marker = {
    schema: 1,
    from,
    to,
    mode,
    migratedAt: now.toISOString(),
    previousTarget,
    rewrittenFiles: rewrite.files,
    rewrittenBytes: rewrite.bytes,
    backup: rewrite.backupRoot,
    errors: rewrite.errors,
  };
  writeMarker(to, marker);
  return {
    ok: true,
    mode,
    userData: to,
    from,
    to,
    previousTarget,
    rewrite,
    marker: readMarker(to),
  };
}
