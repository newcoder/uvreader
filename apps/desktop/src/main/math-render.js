// LaTeX → MathML(EPUB 3 阅读器通用)。用 Python 的 latex2mathml(docvortex 依赖);
// 缺失/失败时回退:保留原 LaTeX 文本,不阻断出书。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MATH_HELPER_SCRIPT = `import json, re, sys
try:
    from latex2mathml.converter import convert
except Exception as exc:  # latex2mathml 缺失:交给上层回退
    print(json.dumps({"ok": False, "error": "latex2mathml missing: %s" % exc}))
    sys.exit(0)
items = json.load(open(sys.argv[1], encoding="utf-8"))

def clean(latex):
    c = re.sub(r"\\\\tag\\{[^}]*\\}", "", latex)
    c = re.sub(r"\\\\begin\\{(aligned|align|array|matrix|pmatrix|bmatrix|cases)\\}", "", c)
    c = re.sub(r"\\\\end\\{(aligned|align|array|matrix|pmatrix|bmatrix|cases)\\}", "", c)
    return c.replace("&", "").strip()

def repair(cleaned):
    # 上游链路偶尔把字体命令的字母丢成空壳(\\\\mathbb { }),留下没有基底的上下标 ——
    # latex2mathml 会直接报错,整条公式退回原文(实测 Notes_Boltzmann 4 处;空壳来自
    # pdf_tool 的水印行内剔除,见 pdf_tool/docs/reader-request-watermark-token-loss-2026-10-18.md)。
    # 空壳补方块(提示"这里少了个符号"),悬空上下标去掉,只在这一步失败后的重试里用。
    r = re.sub(r"\\\\(mathbb|mathcal|mathfrak|mathbf|mathsf|mathtt|mathit|mathrm)\\s*\\{\\s*\\}", r"\\\\square", cleaned)
    r = re.sub(r"}\\s*(?=[_^]\\s*\\{)", "", r)
    r = re.sub(r"(?<![\\\\\\w}\\]])[_^]\\s*\\{([^{}]*)\\}", "", r)
    r = re.sub(r"^\\s*[_^]\\s*\\{([^{}]*)\\}\\s*", "", r)
    return r.strip()

out = {}
for latex in items:
    cleaned = clean(latex)
    try:
        out[latex] = convert(cleaned)
    except Exception:
        try:
            out[latex] = convert(repair(cleaned))
        except Exception:
            out[latex] = ""
json.dump({"ok": True, "mathml": out}, open(sys.argv[2], "w", encoding="utf-8"))
`;

// 同一个交替顺序:先 $$…$$ / \[…\](行间),再 $…$ / \(…\)(行内)。
const MATH_SCAN_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

// 抓出文本里的 LaTeX 片段(去重,按出现顺序)。
export function collectLatex(text) {
  const found = [];
  const source = String(text || "");
  for (const match of source.matchAll(MATH_SCAN_RE)) {
    const latex = String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (latex && !found.includes(latex)) found.push(latex);
  }
  return found;
}

export function createMathRenderer({ spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  async function renderMap(latexes, { python = "python", workDir = "" } = {}) {
    const items = (Array.isArray(latexes) ? latexes : []).filter(Boolean);
    if (!items.length) return { ok: true, map: {} };
    const base = String(workDir || ".");
    try {
      fs.mkdirSync(base, { recursive: true });
      const inFile = path.join(base, "math-in.json");
      const outFile = path.join(base, "math-out.json");
      const script = path.join(base, "math-render.py");
      fs.writeFileSync(inFile, JSON.stringify(items), "utf8");
      fs.writeFileSync(script, MATH_HELPER_SCRIPT, "utf8");
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(python, [script, inFile, outFile], { stdio: ["ignore", "pipe", "pipe"] });
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
          finish({ ok: false, error: "公式渲染超时" });
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
        child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : out.trim().slice(-200) }));
      });
      if (!result.ok) return { ok: false, error: result.error };
      if (!fs.existsSync(outFile)) return { ok: false, error: "公式渲染没有输出" };
      const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (!parsed?.ok) return { ok: false, error: String(parsed?.error || "公式渲染不可用") };
      return { ok: true, map: parsed.mathml || {} };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { renderMap };
}

// 行间公式改成 display="block"(latex2mathml 默认 inline),交给 CSS 排版。
export function shareFormulaHtml(mathml, display) {
  const text = String(mathml || "");
  if (!text) return "";
  return display ? text.replace('display="inline"', 'display="block"') : text;
}
