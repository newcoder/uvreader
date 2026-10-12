// 书坊「电子书制作」的可执行部分:电子书互转(Calibre)与图片打包(CBZ/EPUB)。
// 电子书产物全部走这里;向导(W1-2/W1-3)之后复用同一批 runner。
import fs from "node:fs";
import path from "node:path";

import { buildCbz, cbzPath } from "./cbz.js";
import { EBOOK_TARGETS, IMAGE_BOOK_TARGETS, ebookTargetExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

export { EBOOK_TARGETS, IMAGE_BOOK_TARGETS };

export function registerBookRunners(workshop, { calibre, vaultRoot = "", log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 检测 Calibre(ebook-convert);面板里的「检测 Calibre」按钮。
  workshop.register("calibre-probe", async ({ payload, signal }) => {
    const result = await calibre.probe(payload?.settings || {});
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.detail || "Calibre 不可用"));
    return { output: String(result.detail), detail: `${result.kind} · ${result.command}` };
  });

  // 电子书互转:EPUB/MOBI/AZW3… → AZW3/MOBI(Calibre ebook-convert)。
  workshop.register("ebook-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const format = String(payload?.format || "azw3");
    const out = payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, ebookTargetExt(format)));
    report({ label: `转换为 ${format.toUpperCase()}` });
    log("ebook convert", source, "→", out);
    const result = await calibre.convert(settings, { source, out, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "转换失败"));
    return { output: out, detail: `${format.toUpperCase()} · ${path.basename(out)}` };
  });

  // 图片 → CBZ(自己打包)/ EPUB(先打 CBZ,再交 Calibre 转)。
  workshop.register("images-cbz", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const images = (Array.isArray(payload?.images) ? payload.images : []).map(absolute);
    const target = String(payload?.format || "cbz");
    const cbzOut = absolute(cbzPath(images, (candidate) => fs.existsSync(candidate)));
    report({ label: `打包 ${images.length} 张图片` });
    let built;
    try {
      built = await buildCbz(images, cbzOut);
    } catch (error) {
      throw new Error(String(error?.message || error));
    }
    if (signal.aborted) throw new Error("任务已取消");
    if (target === "cbz") {
      return { output: built.out, detail: `CBZ · ${built.pages} 页 · ${Math.round(built.bytes / 1024)} KB` };
    }
    // EPUB:CBZ → Calibre;输出与 CBZ 同目录、同名。
    const epubOut = payload?.out ? absolute(payload.out) : built.out.replace(/\.cbz$/i, ".epub");
    report({ label: "Calibre 转 EPUB" });
    const converted = await calibre.convert(settings, { source: built.out, out: epubOut, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!converted.ok) throw new Error(String(converted.error || "EPUB 转换失败"));
    return { output: epubOut, detail: `EPUB · ${built.pages} 页(源 CBZ:${path.basename(built.out)})` };
  });
}
