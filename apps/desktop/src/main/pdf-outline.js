// PDF 自带大纲(书签 / outline):浏览器左侧那份目录就是它,和有没有文字层无关
// (扫描件也常带)。它是作者给的完整三级结构,页码是 **PDF 页**,正好和 pdf_tool 的
// `<!--page:N-->` 页锚点对上 —— 比 OCR 印刷目录、正文标题都准。
// 读不到(PyMuPDF 缺失等)就返回空,调用方回退到上游条目 / 印刷目录 / 标题分章。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { tocKey } from "../shared/printed-toc.js";
import { safeDir } from "./text-layer.js";

export const PDF_OUTLINE_SCRIPT = `import fitz, json, sys
doc = fitz.open(sys.argv[1])
out = []
for item in doc.get_toc(simple=True):
    try:
        level, title, page = int(item[0]), str(item[1]).strip(), int(item[2])
    except Exception:
        continue
    if title:
        out.append({"level": level, "title": title, "page": page})
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False)
`;

// 大纲条目 → 我们的目录条目(page 是 PDF 页;层级用大纲给的)。
export function outlineToTocEntries(outline) {
  return (Array.isArray(outline) ? outline : [])
    .map((item) => {
      const label = String(item?.title || "").replace(/\s+/g, " ").trim();
      if (!label) return null;
      return {
        label,
        key: tocKey(label),
        page: Number(item?.page) || 0,
        level: Math.min(Math.max(Number(item?.level) || 1, 1), 3),
      };
    })
    .filter(Boolean);
}

export function createPdfOutlineReader({ spawnImpl = spawn, timeoutMs = 60_000 } = {}) {
  // 返回 { ok, outline }(outline[i] = { level, title, page });失败时 ok=false。
  async function read(pdfPath, { python = "python", workDir = "", signal } = {}) {
    const source = String(pdfPath || "");
    if (!source || !fs.existsSync(source)) return { ok: false, error: `找不到 PDF:${source}` };
    const base = safeDir(String(workDir || path.dirname(source) || "."));
    try {
      fs.mkdirSync(base, { recursive: true });
      const outFile = path.join(base, "pdf-outline.json");
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(python, ["-c", PDF_OUTLINE_SCRIPT, source, outFile], { stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          resolve({ ok: false, error: String(error?.message || error) });
          return;
        }
        let out = "";
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* gone */ }
          finish({ ok: false, error: "读取 PDF 大纲超时" });
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
        child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : out.trim().slice(-200) }));
        signal?.addEventListener("abort", () => {
          try { child.kill(); } catch { /* gone */ }
          finish({ ok: false, error: "已取消" });
        }, { once: true });
      });
      if (!result.ok) return { ok: false, error: result.error };
      if (!fs.existsSync(outFile)) return { ok: false, error: "没有大纲输出" };
      return { ok: true, outline: JSON.parse(fs.readFileSync(outFile, "utf8")) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { read };
}
