// 提取工具(MinerU 等)偶尔会把正文段落包进没有语言标记的围栏,导致段落变成代码块、
// 里面的 $…$ 公式也不渲染。这里把这类「假代码块」拆回段落;真代码块原样保留。

// 像代码的特征(命中就不拆)。
const CODE_HINT_RE = /(?:^\s{4,}\S|=>|\b(?:function|const|let|var|import|export|class|def|return|print|console\.|#include|public\s|private\s)\b|[{};]\s*$|\bself\b|\bdef\b)/m;

// 判定:无语言标记 + 不是代码 + 像正文(含 $…$ 公式,或以句末标点收句)。
export function isProseFence(info, body) {
  if (String(info || "").trim()) return false;
  const text = String(body || "").trim();
  if (text.length < 40) return false;
  if (CODE_HINT_RE.test(text)) return false;
  return /\$[^$\n]+\$/.test(text) || /[。.!?;:、,，]\s*(?:\n|$)/.test(text);
}

export function unwrapProseFences(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  const flush = () => {
    if (!fence) return;
    const body = fence.lines.join("\n");
    if (isProseFence(fence.info, body)) {
      out.push("", body.trim(), "");
    } else {
      out.push(`\`\`\`${fence.info}`, ...fence.lines, "```");
    }
    fence = null;
  };
  for (const line of lines) {
    const start = line.trim().match(/^```(.*)$/);
    if (fence) {
      if (start) flush();
      else fence.lines.push(line);
      continue;
    }
    if (start) {
      fence = { info: start[1], lines: [] };
      continue;
    }
    out.push(line);
  }
  if (fence) flush();
  return out.join("\n");
}

// 提取出的 Markdown → 章节:按 1–3 级标题分;标题缺失时交给调用方按长度分块。
export function splitMarkdownChapters(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const chapters = [];
  let current = { title: "", lines: [] };
  let inFence = false;
  const push = () => {
    const text = current.lines.join("\n").trim();
    if (text) chapters.push({ title: current.title, text });
    current = { title: "", lines: [] };
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const heading = !inFence && line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      push();
      current.title = heading[2].replace(/[#*`]/g, "").trim().slice(0, 80);
      continue;
    }
    current.lines.push(line);
  }
  push();
  return chapters;
}
