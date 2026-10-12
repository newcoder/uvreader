// 书坊:图片打包成 CBZ(漫画/相册)。CBZ 就是"图片 ZIP",按文件名自然排序。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "jp2"];

// 自然排序:1.jpg < 2.jpg < 10.jpg(数字段按数值比较)。
export function compareImageNames(a, b) {
  return String(a).localeCompare(String(b), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

export function imageFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => String(file || ""))
    .filter((file) => IMAGE_EXTENSIONS.includes(String(path.extname(file)).replace(/^\./, "").toLowerCase()));
}

// 输出:图片所在目录旁 `<目录名>.cbz`(漫画惯例);冲突时加序号,不覆盖既有文件。
export function cbzPath(images, exists = () => false) {
  const first = String((images || [])[0] || "");
  const dir = path.dirname(first);
  const name = path.basename(dir) || "comic";
  const join = (candidate) => path.join(path.dirname(dir), candidate);
  let candidate = join(`${name}.cbz`);
  let index = 1;
  while (exists(candidate)) candidate = join(`${name} (${index++}).cbz`);
  return candidate;
}

export async function buildCbz(images, out) {
  const files = imageFiles(images);
  if (!files.length) throw new Error("没有可打包的图片(png/jpg/jpeg/webp/gif/bmp/tiff/jp2)");
  const zip = new JSZip();
  const seen = new Map();
  for (const file of [...files].sort(compareImageNames)) {
    if (!fs.existsSync(file)) throw new Error(`图片不存在：${file}`);
    let entry = path.basename(file);
    const count = seen.get(entry) || 0;
    seen.set(entry, count + 1);
    if (count) {
      const ext = path.extname(entry);
      entry = `${path.basename(entry, ext)} (${count})${ext}`;
    }
    zip.file(entry, fs.readFileSync(file));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buffer);
  return { out, pages: files.length, bytes: buffer.length };
}
