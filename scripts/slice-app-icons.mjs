// Slices the design sheet `uvreader_icons.png` (24px and 32px sets) into the
// individual toolbar icons used by the desktop shell. The 32px set is used:
// its higher resolution stays crisp when the icons are displayed at 15-20px.
//
// The sheet has an opaque near-white background, so each slice is keyed to
// transparency (luminance → alpha, antialiasing preserved). The desktop shell
// then renders them as CSS masks coloured by `currentColor`, which keeps them
// legible on every reading theme.
//
// Run: npm run build:icons  (regenerate after editing the sheet)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sheetPath = path.join(repoRoot, "uvreader_icons.png");
const outDir = path.join(repoRoot, "apps/desktop/assets/icons");

// Cell centres on the 32×32 half of the sheet (absolute pixels, 820×820).
// Names match the labels printed under each glyph.
const ICONS = [
  { name: "fit-width", x: 62, y: 523 },
  { name: "ai-chat", x: 159, y: 519 },
  { name: "back", x: 242, y: 523 },
  { name: "home", x: 328, y: 523 },
  { name: "search", x: 415, y: 523 },
  { name: "zoom-out", x: 503, y: 523 },
  { name: "zoom-in", x: 590, y: 523 },
  { name: "next-page", x: 675, y: 523 },
  { name: "previous-page", x: 761, y: 523 },
  { name: "comment", x: 61, y: 698 },
  { name: "notes", x: 174, y: 698 },
  { name: "outline", x: 280, y: 698 },
  { name: "navigator", x: 394, y: 698 },
  { name: "toc", x: 504, y: 698 },
  { name: "library", x: 614, y: 698 },
  { name: "tag", x: 726, y: 698 },
];
const WINDOW_HALF = 40;
const PADDING = 3;
const BACKGROUND = 249; // the sheet's near-white background level

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("uvreader_icons.png is not a PNG");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error("uvreader_icons.png has no IHDR");
  if (header.interlace !== 0 || header.bitDepth !== 8) throw new Error("uvreader_icons.png must be a non-interlaced 8-bit PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = value & 0xff;
    }
    previous = row;
  }
  // Normalize to RGBA.
  const rgba = Buffer.alloc(header.width * header.height * 4);
  for (let i = 0; i < header.width * header.height; i++) {
    if (header.colorType === 6) {
      rgba.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
    } else if (header.colorType === 2) {
      rgba[i * 4] = pixels[i * 3];
      rgba[i * 4 + 1] = pixels[i * 3 + 1];
      rgba[i * 4 + 2] = pixels[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (header.colorType === 0) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[i];
      rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[i * 2];
      rgba[i * 4 + 3] = pixels[i * 2 + 1];
    }
  }
  return { width: header.width, height: header.height, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0;
    rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sheet = decodePng(fs.readFileSync(sheetPath));
const luminance = (x, y) => {
  const i = (y * sheet.width + x) * 4;
  return 0.2126 * sheet.rgba[i] + 0.7152 * sheet.rgba[i + 1] + 0.0722 * sheet.rgba[i + 2];
};

fs.mkdirSync(outDir, { recursive: true });
const summary = [];
for (const icon of ICONS) {
  // Tight ink box inside the cell window; the crop keeps the design's own
  // scale and antialiasing, only the paper is removed.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = icon.y - WINDOW_HALF; y <= icon.y + WINDOW_HALF; y++) {
    for (let x = icon.x - WINDOW_HALF; x <= icon.x + WINDOW_HALF; x++) {
      if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) continue;
      if (luminance(x, y) < BACKGROUND - 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) throw new Error(`no ink found for icon "${icon.name}" at ${icon.x},${icon.y}`);
  const x0 = Math.max(0, minX - PADDING);
  const y0 = Math.max(0, minY - PADDING);
  const x1 = Math.min(sheet.width - 1, maxX + PADDING);
  const y1 = Math.min(sheet.height - 1, maxY + PADDING);
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((y0 + y) * sheet.width + (x0 + x)) * 4;
      const dst = (y * width + x) * 4;
      const r = sheet.rgba[src];
      const g = sheet.rgba[src + 1];
      const b = sheet.rgba[src + 2];
      // Luminance key: paper → transparent, ink → opaque, edges stay soft.
      let alpha = Math.round(((BACKGROUND - (0.2126 * r + 0.7152 * g + 0.0722 * b)) * 255) / BACKGROUND);
      if (alpha < 8) alpha = 0;
      if (alpha > 255) alpha = 255;
      rgba[dst] = r;
      rgba[dst + 1] = g;
      rgba[dst + 2] = b;
      rgba[dst + 3] = alpha;
    }
  }
  const png = encodePng(width, height, rgba);
  fs.writeFileSync(path.join(outDir, `${icon.name}.png`), png);
  summary.push(`${icon.name} ${width}x${height}`);
}
console.log(`icons written to ${path.relative(repoRoot, outDir)}: ${summary.length}`);
console.log(summary.join(", "));
