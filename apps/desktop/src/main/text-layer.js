// PDF 文字层(PyMuPDF):「公式优先」链路用它逐字校正 MinerU 的正文。
// 结果写 UTF-8 文件——Windows 控制台编码会把连字(ﬁ)等字符弄坏,不能走 stdout。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TEXT_LAYER_SCRIPT = `import fitz, json, sys
doc = fitz.open(sys.argv[1])
pages = [page.get_text() for page in doc]
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(pages, fh, ensure_ascii=False)
`;

// Windows 不接受以点/空格结尾的目录名(mkdir 会静默改名,Python 再按原名写入就会报错),修一下。
export function safeDir(raw) {
  const resolved = path.resolve(String(raw || "."));
  const parts = resolved.split(/[\\/]+/);
  const last = (parts.pop() || "").replace(/[. ]+$/, "");
  return [...parts, last].join(path.sep) || ".";
}

export function createTextLayerReader({ spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  // 返回 { ok, pages }(pages[i] = 第 i+1 页的纯文本)。
  async function read(pdfPath, { python = "python", workDir = "", signal } = {}) {
    const source = String(pdfPath || "");
    if (!source || !fs.existsSync(source)) return { ok: false, error: `找不到 PDF：${source}` };
    const base = safeDir(String(workDir || path.dirname(source) || "."));
    try {
      fs.mkdirSync(base, { recursive: true });
      const outFile = path.join(base, "text-layer.json");
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(python, ["-c", TEXT_LAYER_SCRIPT, source, outFile], { stdio: ["ignore", "pipe", "pipe"] });
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
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => {
          try { child.kill(); } catch { /* gone */ }
          finish({ ok: false, cancelled: true, error: "任务已取消" });
        };
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* gone */ }
          finish({ ok: false, error: "读取 PDF 文字层超时" });
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
        child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : (out.trim().slice(-200) || `退出码 ${code}`) }));
      });
      if (!result.ok) return result;
      if (!fs.existsSync(outFile)) return { ok: false, error: "没有生成文字层文件" };
      const pages = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (!Array.isArray(pages) || !pages.length) return { ok: false, error: "文字层为空（可能是扫描件）" };
      return { ok: true, pages, path: outFile };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { read };
}
