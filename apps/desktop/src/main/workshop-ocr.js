// 书坊文字层工具:批量生成文字层(写入阅读器缓存)或导出可搜索 PDF。
// The runners are thin wrappers around pdf-ocr; the naming helper lives in
// src/shared so the renderer can compute the same `.uvtext.pdf` path.
import path from "node:path";

import { uvtextPath } from "../shared/workshop-names.js";

function cancelled() {
  const error = new Error("任务已取消");
  error.cancelled = true;
  return error;
}

export function registerOcrRunners(workshop, { pdfOcr, vaultRoot = "", log = (...args) => console.log(...args) } = {}) {
  // 渲染层传来的是书库相对路径;sidecar 需要绝对路径。
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };
  // 生成文字层:逐页 OCR 写进阅读器缓存(与阅读器同一 cacheRoot),打开书即可搜索。
  workshop.register("ocr-cache", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const session = await pdfOcr.openSession(settings, source);
    try {
      const pages = Number(session?.pages) || 0;
      if (!pages) throw new Error("无法读取 PDF 页数");
      report({ total: pages, label: "生成文字层" });
      let lines = 0;
      for (let page = 1; page <= pages; page += 1) {
        if (signal.aborted) throw cancelled();
        const result = await pdfOcr.page(session.sessionId, page);
        lines += Number(result?.lines) || 0;
        report({ done: page, total: pages });
      }
      return {
        output: `${pages} 页文字层已生成（${lines} 行）`,
        detail: "阅读器打开即可搜索 / 划线",
      };
    } finally {
      pdfOcr.closeSession(session.sessionId);
    }
  });

  // 导出可搜索 PDF:输出固定在源文件旁(<源名>.uvtext.pdf),同名覆盖。
  workshop.register("ocr-export", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const rawOut = String(payload?.out || "") || uvtextPath(payload?.source);
    if (!rawOut) throw new Error("缺少输出路径");
    const out = absolute(rawOut);
    const jobId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log("workshop export", source, "→", out);
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        pdfOcr.cancel(jobId);
        reject(cancelled());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (fn, value) => {
        signal.removeEventListener("abort", onAbort);
        fn(value);
      };
      try {
        pdfOcr.start(settings, { source, out, jobId }, {
          onProgress: (progress) => report({
            done: Number(progress?.done) || 0,
            total: Number(progress?.total) || 0,
            label: "导出可搜索 PDF",
          }),
          onDone: (result) => {
            if (!result?.ok) {
              settle(reject, new Error(String(result?.error || "导出失败")));
              return;
            }
            const stats = result.stats || {};
            settle(resolve, {
              output: out,
              detail: `插入 ${Number(stats.lines_inserted) || 0} 行 · 跳过 ${Number(stats.skipped_text_pages) || 0} 页已有文字层`,
            });
          },
        });
      } catch (error) {
        settle(reject, error);
      }
    });
  });

  return { uvtextPath };
}
