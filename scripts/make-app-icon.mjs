// Generates apps/desktop/build/icon.png (512x512) without external image
// tooling: electron-builder derives the Windows .ico and macOS .icns from it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const size = 512;
const scale = 3;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../apps/desktop/build/icon.png");

const hex = (value) => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
const TOP = hex("#5c4ee5");
const BOTTOM = hex("#8f7ff5");
const PAPER = hex("#f8f5ee");
const INK = hex("#c3b8f6");
const SPINE = hex("#4b3fd0");

function inRoundedSquare(x, y, radius) {
  const dx = Math.max(0.5 - radius - x, x - (1 - radius));
  const dy = Math.max(0.5 - radius - y, y - (1 - radius));
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= radius || (x >= radius && x <= 1 - radius) || (y >= radius && y <= 1 - radius);
}

function inQuad(x, y, quad) {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % quad.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign && next !== sign) return false;
    sign = next;
  }
  return true;
}

const leftPage = [[0.15, 0.30], [0.475, 0.365], [0.475, 0.735], [0.15, 0.67]];
const rightPage = [[0.525, 0.365], [0.85, 0.30], [0.85, 0.67], [0.525, 0.735]];
const spine = [[0.475, 0.365], [0.525, 0.365], [0.525, 0.735], [0.475, 0.735]];
const lines = [];
for (const side of [-1, 1]) {
  for (let row = 0; row < 3; row++) {
    const y = 0.44 + row * 0.09;
    const x0 = 0.5 + side * 0.055;
    const x1 = 0.5 + side * (0.055 + (row === 2 ? 0.19 : 0.28));
    lines.push([[x0, y], [x1, y - side * 0.008], [x1, y + 0.028], [x0, y + 0.036]]);
  }
}

function sample(x, y) {
  if (!inRoundedSquare(x, y, 0.225)) return [0, 0, 0, 0];
  const gradient = Math.min(1, Math.max(0, y));
  let color = TOP.map((channel, index) => Math.round(channel + (BOTTOM[index] - channel) * gradient));
  let alpha = 255;
  const onPage = inQuad(x, y, leftPage) || inQuad(x, y, rightPage);
  if (inQuad(x, y, spine)) color = SPINE;
  else if (lines.some((quad) => inQuad(x, y, quad))) color = INK;
  else if (onPage) color = PAPER;
  return [...color, alpha];
}

const raw = Buffer.alloc(size * size * 4);
for (let py = 0; py < size; py++) {
  for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const [cr, cg, cb, ca] = sample((px + (sx + 0.5) / scale) / size, (py + (sy + 0.5) / scale) / size);
        const weight = ca / 255;
        r += cr * weight; g += cg * weight; b += cb * weight; a += ca;
      }
    }
    const samples = scale * scale;
    const alpha = a / samples;
    const weight = alpha / 255 || 1;
    const at = (py * size + px) * 4;
    raw[at] = Math.round(r / samples / weight);
    raw[at + 1] = Math.round(g / samples / weight);
    raw[at + 2] = Math.round(b / samples / weight);
    raw[at + 3] = Math.round(alpha);
  }
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

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  scanlines[y * (size * 4 + 1)] = 0;
  raw.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`icon written: ${path.relative(path.resolve(here, ".."), out)} (${png.length} bytes)`);
