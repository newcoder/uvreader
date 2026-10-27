// Standalone image files get their own reading page (the reader mounts the
// image directly), while this module still provides the small ZIP helper used
// by older callers/tests. Only browser-renderable image types are listed here;
// TIFF/JP2 remain conversion/OCR inputs in the workshop.
export const IMAGE_BOOK_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

export function imageMimeType(extension) {
  const ext = String(extension || "").split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function isImageBookFile(file) {
  const extension = String(file?.extension || file || "").split(".").pop().toLowerCase();
  return IMAGE_BOOK_EXTENSIONS.includes(extension);
}

// A minimal store-only ZIP with one image entry. CBZ readers sniff the image
// entry by extension, so no manifest or extra metadata is needed.
export function imageBookBytes(bytes, name = "image.png") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const entry = String(name || "image.png").replace(/(\.[^.]+)$/, (suffix) => suffix.toLowerCase());
  const filename = new TextEncoder().encode(entry);
  const crc = crc32(data);
  const local = new Uint8Array(30 + filename.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true); // UTF-8 file name
  lv.setUint16(8, 0, true); // stored, no compression
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, filename.length, true);
  lv.setUint16(28, 0, true);
  local.set(filename, 30);
  local.set(data, 30 + filename.length);

  const central = new Uint8Array(46 + filename.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 0, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, filename.length, true);
  cv.setUint32(42, 0, true); // local header offset
  central.set(filename, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  return concatBytes([local, central, eocd]);
}
