// Regenerates the product logo assets from `logo.jpg`:
//   - apps/desktop/assets/logo.png  (512×512, transparent master copy)
//   - apps/desktop/build/icon.png   (the installer/app icon electron-builder
//     derives .ico/.icns from)
//
// Chromium's decoders handle the JPEG; the background removal and the PNG
// encoding are done here. The logo is a round button on white, so the
// background is removed with a measured circular alpha mask (edge smoothed),
// which keeps the button's own colours and its white holes intact.
// Run: npm run build:logo (from apps/desktop) or npm run build:icon (root).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { app, nativeImage } = require("electron");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const sourcePath = path.join(repoRoot, "logo.jpg");
const logoOut = path.join(desktopRoot, "assets/logo.png");
const iconOut = path.join(desktopRoot, "build/icon.png");
const SIZE = 512;

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

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) throw new Error(`could not read ${sourcePath}`);
  const sourceSize = source.getSize();
  const resized = source.resize({ width: SIZE, height: SIZE, quality: "best" });
  const bitmap = resized.toBitmap(); // BGRA

  // The button is the only saturated / dark region; the paper and the soft
  // shadow are near-white, so they fall outside this mask.
  const solid = (i) => {
    const b = bitmap[i * 4], g = bitmap[i * 4 + 1], r = bitmap[i * 4 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 232 || Math.max(r, g, b) - Math.min(r, g, b) > 24;
  };
  let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!solid(y * SIZE + x)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("could not find the logo button in logo.jpg");
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radius = ((maxX - minX + 1) + (maxY - minY + 1)) / 4;

  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      // One-pixel falloff at the rim keeps the edge antialiased.
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      rgba[i * 4] = bitmap[i * 4 + 2];
      rgba[i * 4 + 1] = bitmap[i * 4 + 1];
      rgba[i * 4 + 2] = bitmap[i * 4];
      rgba[i * 4 + 3] = Math.round(coverage * 255);
    }
  }
  const png = encodePng(SIZE, SIZE, rgba);
  fs.mkdirSync(path.dirname(logoOut), { recursive: true });
  fs.mkdirSync(path.dirname(iconOut), { recursive: true });
  fs.writeFileSync(logoOut, png);
  fs.writeFileSync(iconOut, png);
  console.log(`logo written: ${path.relative(repoRoot, logoOut)} and ${path.relative(repoRoot, iconOut)} (button ${Math.round(radius * 2)}px of ${SIZE}, from ${sourceSize.width}x${sourceSize.height})`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
