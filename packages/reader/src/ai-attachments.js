// Attachments for AI turns: images from upload/drop/paste (and, later, screen
// captures) plus small text files. Only metadata and a thumbnail live in the
// saved conversation; the bytes live in `<dataFolder>/ai-files/`, so chat
// history stays small and an image can be re-read when a saved chat reopens.
export const MAX_AI_ATTACHMENTS = 4;
export const MAX_AI_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_AI_TEXT_BYTES = 200 * 1024;
export const AI_IMAGE_MAX_EDGE = 1600;
export const AI_THUMB_EDGE = 160;

export const AI_IMAGE_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});

export const AI_TEXT_EXTENSIONS = Object.freeze(["txt", "md", "markdown", "csv", "json", "log"]);

export function aiImageMime(name = "", type = "") {
  const declared = String(type || "").toLowerCase();
  if (AI_IMAGE_TYPES[declared]) return declared;
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return Object.keys(AI_IMAGE_TYPES).find((mime) => AI_IMAGE_TYPES[mime] === ext) || "";
}

export function aiTextFile(name = "") {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return AI_TEXT_EXTENSIONS.includes(ext);
}

function cleanText(value, limit) {
  return String(value ?? "").slice(0, limit);
}

function positiveNumber(value, limit) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), limit) : 0;
}

// Persisted and in-memory attachments share one shape. `data` (base64) is only
// present while the turn is being sent or right after intake.
export function normalizeAiAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_AI_ATTACHMENTS).map((item) => {
    const kind = item?.kind === "text" ? "text" : "image";
    const mimeType = cleanText(item?.mimeType, 80) || (kind === "image" ? "image/png" : "text/plain");
    const id = cleanText(item?.id, 60).replace(/[^\w-]/g, "");
    if (!id) return null;
    const attachment = {
      id,
      kind,
      name: cleanText(item?.name, 120) || (kind === "image" ? "image" : "text"),
      mimeType,
      bytes: positiveNumber(item?.bytes, 64 * 1024 * 1024),
      source: ["pick", "drop", "paste", "shot", "page"].includes(item?.source) ? item.source : "pick",
    };
    if (kind === "image") {
      if (item?.width) attachment.width = positiveNumber(item.width, 20000);
      if (item?.height) attachment.height = positiveNumber(item.height, 20000);
      if (item?.thumb) attachment.thumb = cleanText(item.thumb, 200_000);
      if (item?.file) attachment.file = cleanText(item.file, 400);
      if (item?.data) attachment.data = cleanText(item.data, 24 * 1024 * 1024);
    } else {
      if (item?.file) attachment.file = cleanText(item.file, 400);
      if (item?.text) attachment.text = cleanText(item.text, MAX_AI_TEXT_BYTES);
    }
    if (item?.page) attachment.page = positiveNumber(item.page, 100000) || undefined;
    return attachment;
  }).filter(Boolean);
}

export function aiAttachmentFileName(attachment) {
  if (attachment.kind === "text") return `${attachment.id}.txt`;
  const ext = AI_IMAGE_TYPES[String(attachment.mimeType || "").toLowerCase()] || "png";
  return `${attachment.id}.${ext}`;
}

// The vault-relative path for the stored bytes.
export function aiAttachmentPath(dataFolder, attachment) {
  const folder = String(dataFolder || "plugin").replace(/[\\/]+$/, "");
  return `${folder}/ai-files/${aiAttachmentFileName(attachment)}`;
}

// Metadata only: what a saved conversation keeps.
export function stripAttachmentData(attachments) {
  return normalizeAiAttachments(attachments).map(({ data, text, ...rest }) => rest);
}

// Messages sent to the model: text attachments first (they carry the
// instructions and notes), then the image parts.
export function aiAttachmentBlocks(attachments) {
  const list = normalizeAiAttachments(attachments);
  const blocks = [];
  for (const attachment of list) {
    if (attachment.kind === "text" && attachment.text) {
      blocks.push({ type: "text", text: `【附件：${attachment.name}】\n${attachment.text}` });
    }
  }
  for (const attachment of list) {
    if (attachment.kind === "image" && attachment.data) {
      blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
    }
  }
  return blocks;
}

export function aiAttachmentsHaveImages(attachments) {
  return normalizeAiAttachments(attachments).some((attachment) => attachment.kind === "image" && attachment.data);
}

export function bytesLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function scaleSize(width, height, maxEdge) {
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  if (!longest || longest <= maxEdge) return { width: Number(width) || 0, height: Number(height) || 0 };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function attachmentId(now = Date.now(), random = Math.random) {
  return `att-${now.toString(36)}-${Math.floor(random() * 1e6).toString(36)}`;
}

export function bytesFromBase64(data) {
  const binary = atob(String(data || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64FromBytes(buffer) {
  const bytes = new Uint8Array(buffer || []);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function blobFromBase64(data, mimeType) {
  return new Blob([bytesFromBase64(data)], { type: mimeType || "application/octet-stream" });
}

// Draws the decoded image onto a canvas at the given size and returns a data
// URL. The caller owns the canvas document so this works in a test too.
function drawToDataUrl(bitmap, width, height, doc, mimeType) {
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType, 0.92);
}

async function decodeImageBlob(blob, win) {
  const decode = win?.createImageBitmap;
  if (typeof decode === "function") return decode.call(win, blob);
  throw new Error("qiaomu-reader-image-decode-unavailable");
}

// Downscales the image for the model and builds a small thumbnail for the
// conversation list. PNG stays PNG (screenshots and diagrams keep their
// edges); photos go through JPEG.
export async function imageAttachmentFromBlob(blob, options = {}) {
  const win = options.win || globalThis;
  const doc = win?.document;
  if (!doc) throw new Error("qiaomu-reader-image-decode-unavailable");
  const bitmap = await decodeImageBlob(blob, win);
  const mimeType = aiImageMime(options.name || "", blob.type || options.mimeType || "") || "image/png";
  const sourceWidth = bitmap.width || 0;
  const sourceHeight = bitmap.height || 0;
  const full = scaleSize(sourceWidth, sourceHeight, AI_IMAGE_MAX_EDGE);
  const thumbSize = scaleSize(sourceWidth, sourceHeight, AI_THUMB_EDGE);
  const outputMime = mimeType === "image/png" || mimeType === "image/gif" ? "image/png" : "image/jpeg";
  try {
    const dataUrl = drawToDataUrl(bitmap, full.width, full.height, doc, outputMime);
    const thumb = drawToDataUrl(bitmap, thumbSize.width, thumbSize.height, doc, "image/jpeg");
    const data = String(dataUrl).split(",")[1] || "";
    if (!data) throw new Error("qiaomu-reader-image-encode-failed");
    return {
      id: options.id || attachmentId(),
      kind: "image",
      name: String(options.name || "image"),
      mimeType: outputMime,
      bytes: blob.size || Math.ceil((data.length * 3) / 4),
      width: full.width,
      height: full.height,
      thumb,
      data,
      source: options.source || "pick",
    };
  } finally {
    bitmap.close?.();
  }
}

// One turn may carry at most MAX_AI_ATTACHMENTS items; anything unsupported
// or too large is reported instead of silently dropped.
export async function intakeAiFiles(files, options = {}) {
  const attachments = [];
  const errors = [];
  for (const file of Array.from(files || []).slice(0, MAX_AI_ATTACHMENTS)) {
    const name = String(file.name || "file");
    const mimeType = aiImageMime(name, file.type || "");
    const bytes = Number(file.size) || 0;
    try {
      if (mimeType) {
        if (bytes > MAX_AI_IMAGE_BYTES) {
          errors.push({ name, reason: "imagetooolarge" });
          continue;
        }
        attachments.push(await imageAttachmentFromBlob(file, { ...options, name, mimeType }));
      } else if (aiTextFile(name)) {
        if (bytes > MAX_AI_TEXT_BYTES) {
          errors.push({ name, reason: "texttoolarge" });
          continue;
        }
        attachments.push({
          id: attachmentId(),
          kind: "text",
          name,
          mimeType: "text/plain",
          bytes,
          text: String(await file.text()).slice(0, MAX_AI_TEXT_BYTES),
          source: options.source || "pick",
        });
      } else {
        errors.push({ name, reason: "unsupported" });
      }
    } catch {
      errors.push({ name, reason: "unreadable" });
    }
  }
  return { attachments, errors };
}

// Reads the stored bytes of every attachment that no longer carries them.
export async function hydrateAiAttachments(attachments, readBytes) {
  const list = normalizeAiAttachments(attachments);
  for (const attachment of list) {
    if (attachment.kind !== "image" || attachment.data || !attachment.file || typeof readBytes !== "function") continue;
    try {
      const data = await readBytes(attachment.file);
      if (data) attachment.data = String(data);
    } catch {
      attachment.missing = true;
    }
  }
  return list;
}
