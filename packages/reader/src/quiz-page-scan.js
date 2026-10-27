// Quiz pages embed their manifest near the top of a self-contained HTML file.
// Reading the whole page (often hundreds of KiB of inline images) just to list
// it is unnecessarily slow, especially for pages outside the vault. Read a
// bounded prefix first and only fall back to the full file when the manifest
// script is incomplete or the file is known to be an answer page.
import { extractQuizManifest } from "./quiz-manifest.js";

export const QUIZ_PAGE_MANIFEST_HEAD_BYTES = 128 * 1024;

export function quizPageScanKey(path) {
  return String(path == null ? "" : path).replace(/\\/g, "/").trim();
}

export function quizPageStatSignature(stat) {
  if (!stat) return "";
  const mtime = Number(stat.mtimeMs ?? stat.mtime);
  const size = Number(stat.size);
  if (!Number.isFinite(mtime) || !Number.isFinite(size)) return "";
  return `${mtime}:${size}`;
}

function manifestMarker(text) {
  return /<script\b[^>]*\bid\s*=\s*(["'])quiz-manifest\1[^>]*>/i.exec(text);
}

function manifestScriptComplete(text, marker) {
  if (!marker) return false;
  return /^<script\b[^>]*>[\s\S]*?<\/script\s*>/i.test(text.slice(marker.index));
}

export async function readQuizPageManifest({
  adapter,
  path,
  stat = null,
  cache = null,
  cacheKey = "",
  headBytes = QUIZ_PAGE_MANIFEST_HEAD_BYTES,
  fullReadOnHeadMiss = false,
} = {}) {
  if (!adapter || !path) return null;
  const key = cacheKey || quizPageScanKey(path);
  const signature = quizPageStatSignature(stat);
  const cached = signature && cache?.get(key);
  if (cached && cached.signature === signature) return cached.manifest;

  const size = Number(stat?.size);
  const limit = Math.max(0, Math.trunc(Number(headBytes) || 0));
  const canReadHead = limit > 0
    && Number.isFinite(size)
    && size > limit
    && typeof adapter.readHead === "function";
  let text = "";
  let usedHead = false;
  if (canReadHead) {
    try {
      text = String(await adapter.readHead(path, limit) || "");
      usedHead = text.length > 0;
    } catch {
      text = "";
    }
  }
  if (!usedHead) text = String(await adapter.read(path) || "");

  let manifest = extractQuizManifest(text);
  let scanComplete = !usedHead;
  if (usedHead) {
    const marker = manifestMarker(text);
    if ((marker && !manifestScriptComplete(text, marker)) || (!marker && fullReadOnHeadMiss)) {
      manifest = extractQuizManifest(await adapter.read(path));
      scanComplete = true;
    } else {
      // A complete script also proves that a JSON parse failure is a genuine
      // invalid manifest, not a prefix that stopped short.
      scanComplete = Boolean(marker);
    }
  }

  // Do not persist "no manifest" for a prefix-only scan: an unfamiliar answer
  // page can keep its manifest below the prefix, and a negative cache entry
  // would hide it forever.
  if (signature && cache && (manifest || scanComplete)) cache.set(key, { signature, manifest });
  return manifest;
}
