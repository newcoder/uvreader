// 书坊「电子书制作」的可执行部分:电子书互转(Calibre)与图片打包(CBZ/EPUB)。
// 电子书产物全部走这里;向导(W1-2/W1-3)之后复用同一批 runner。
import fs from "node:fs";
import path from "node:path";

import { buildCbz, cbzPath } from "./cbz.js";
import { uniqueFile } from "./paths.js";
import { EBOOK_TARGETS, IMAGE_BOOK_TARGETS, ebookTargetExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

export { EBOOK_TARGETS, IMAGE_BOOK_TARGETS };

export function registerBookRunners(workshop, { calibre, vaultRoot = "", engine = null, log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };
  // 引擎优先、失败回退本机(与其它链路同一条规则):配了 engineUrl 才走引擎。
  const convertViaEngine = async (settings, { source, out, report, signal, label }) => {
    if (!engine?.runJob || !String(settings?.engineUrl || "").trim()) return null;
    report?.({ label: label || "引擎转换中…" });
    const ran = await engine.runJob(settings, "ebook-convert", { source, out }, {
      signal,
      onProgress: (item) => report?.({ label: String(item?.label || label || "引擎转换中…") }),
    });
    if (!ran.ok) {
      log("engine ebook-convert failed, falling back to the local Calibre:", ran.error);
      return { ok: false, error: String(ran.error || "引擎转换失败") };
    }
    return { ok: true, out: String(ran.result?.out || out), bytes: Number(ran.result?.bytes || 0) };
  };

  // 检测 Calibre(ebook-convert);面板里的「检测 Calibre」按钮。
  workshop.register("calibre-probe", async ({ payload, signal }) => {
    const result = await calibre.probe(payload?.settings || {});
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.detail || "Calibre 不可用"));
    return { output: String(result.detail), detail: `${result.kind} · ${result.command}` };
  });

  // 电子书互转:EPUB/MOBI/AZW3/KFX… → AZW3/MOBI/KFX(Calibre ebook-convert / boko)。
  // boko(单文件 Rust 转换器)负责 KFX 与 AZW3:实测 EPUB→AZW3 0.1s(Calibre 3.1s)、EPUB→KFX <1s;
  // KFX 只有它能写(Calibre 那条要 Kindle Previewer),而它**只读 MOBI** → MOBI 仍走 Calibre。
  workshop.register("ebook-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const format = String(payload?.format || "azw3").toLowerCase();
    // 同名不覆盖:本地文件也要按 §7 加序号(渲染层的书库判断看不到本地文件)。
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, ebookTargetExt(format))));
    report({ label: `转换为 ${format.toUpperCase()}` });
    log("ebook convert", source, "→", out);
    const wantsBoko = format === "kfx" || format === "azw3" || /\.kfx$/i.test(source);
    if (wantsBoko && engine?.runJob && String(settings.engineUrl || "").trim()) {
      report({ label: `boko 转 ${format.toUpperCase()}` });
      const ran = await engine.runJob(settings, "boko-convert", { source, out }, {
        signal,
        onProgress: (item) => report({ label: String(item?.label || `boko 转 ${format.toUpperCase()}`) }),
      });
      if (ran.ok) {
        return { output: String(ran.result?.out || out), detail: `${format.toUpperCase()} · ${path.basename(out)}(引擎 · boko)` };
      }
      if (format === "kfx") throw new Error(`KFX 需要 boko:${String(ran.error || "引擎转换失败")}`);
      log("engine boko-convert failed, falling back to Calibre:", ran.error);
    }
    if (format === "kfx") {
      throw new Error("KFX 需要 boko(Calibre 写 KFX 要装 Kindle Previewer):在引擎配置里填 bokoPath,或先装 boko");
    }
    const viaEngine = await convertViaEngine(settings, { source, out, report, signal, label: `引擎转换 ${format.toUpperCase()}` });
    if (viaEngine?.ok) {
      return { output: viaEngine.out, detail: `${format.toUpperCase()} · ${path.basename(viaEngine.out)}(引擎)` };
    }
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
    const viaEngine = await convertViaEngine(settings, { source: built.out, out: epubOut, report, signal, label: "引擎转 EPUB" });
    if (viaEngine?.ok) {
      return { output: viaEngine.out, detail: `EPUB · ${built.pages} 页(源 CBZ:${path.basename(built.out)} · 引擎)` };
    }
    const converted = await calibre.convert(settings, { source: built.out, out: epubOut, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!converted.ok) throw new Error(String(converted.error || "EPUB 转换失败"));
    return { output: epubOut, detail: `EPUB · ${built.pages} 页(源 CBZ:${path.basename(built.out)})` };
  });
}
