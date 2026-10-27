// Turning a preview <img> source into bytes for the native save dialog.
// The source can be a data URL (AI screenshots), a blob URL (PDF images) or a
// normal URL. The desktop bridge owns the file dialog and the final encoding.
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function dataUrlPayload(src, name) {
  const comma = String(src).indexOf(",");
  if (comma < 0) throw new Error("图片数据无效");
  const meta = String(src).slice(5, comma);
  const body = String(src).slice(comma + 1);
  const mimeType = String(meta.split(";")[0] || "image/png").trim() || "image/png";
  if (!/;\s*base64/i.test(meta)) {
    return { data: bytesToBase64(new TextEncoder().encode(decodeURIComponent(body))), mimeType, name };
  }
  return { data: body.replace(/\s+/g, ""), mimeType, name };
}

// Blob URLs are created by the renderer, but the page CSP treats them as a
// blocked connect target. The already-loaded <img> is the reliable fallback:
// draw it to a canvas and let the save dialog do any format conversion.
async function canvasPayload(image, name) {
  if (!image) return null;
  if (!image.complete || !image.naturalWidth) {
    try { await image.decode?.(); } catch { /* fall back to the current bitmap */ }
  }
  const width = Number(image.naturalWidth) || 0;
  const height = Number(image.naturalHeight) || 0;
  if (!width || !height) return null;
  const doc = image.ownerDocument;
  const canvas = doc?.createElement?.("canvas");
  const ctx = canvas?.getContext?.("2d");
  if (!canvas || !ctx) return null;
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, 0, 0, width, height);
  const dataUrl = String(canvas.toDataURL("image/png"));
  return dataUrlPayload(dataUrl, name);
}

// Returns { data: base64, mimeType, name } ready for the main process.
export async function imageSavePayload(src, { name = "图片", image = null } = {}) {
  const value = String(src || "").trim();
  if (!value) throw new Error("没有可保存的图片");
  if (/^data:/i.test(value)) return dataUrlPayload(value, name);
  // Blob/file URLs are already decoded in the preview; drawing the loaded
  // element avoids a CSP-blocked fetch and keeps the bytes local.
  if (image && /^(blob:|file:)/i.test(value)) {
    const fallback = await canvasPayload(image, name);
    if (fallback) return fallback;
  }
  try {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`读取图片失败（${response.status}）`);
    const blob = await response.blob();
    if (blob.type && !String(blob.type).toLowerCase().startsWith("image/")) {
      throw new Error("图片数据格式不正确");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error("图片数据为空");
    return {
      data: bytesToBase64(bytes),
      mimeType: String(blob.type || "").toLowerCase() || "image/png",
      name,
    };
  } catch (error) {
    const fallback = await canvasPayload(image, name);
    if (fallback) return fallback;
    throw error;
  }
}

// The bridge is injected in tests; the desktop shell exposes it as
// window.qbrDesktop.image.save(payload).
export async function saveImageFromSource(src, { name = "图片", bridge = null, image = null } = {}) {
  const target = bridge || globalThis.window?.qbrDesktop?.image;
  if (!target?.save) throw new Error("保存图片需要在桌面应用中使用");
  const payload = await imageSavePayload(src, { name, image });
  return target.save(payload);
}
