// 提取工具(MinerU 等)偶尔把正文段落判成代码块(JSON type=code / md 里是无语言围栏),
// 段落因此显示成代码、里面的 $…$ 公式也不渲染。这里统一判定「这段文本其实是正文」。

// 像代码的特征(命中就不算正文)。
const CODE_HINT_RE = /(?:^\s{4,}\S|=>|\b(?:function|const|let|var|import|export|class|def|return|print|console\.|#include|public\s|private\s)\b|[{};]\s*$|\bself\b|\bdef\b)/m;
const CODE_CHAR_RE = /[{}[\]()<>;=]/g;

// 判定:够长 + 去掉公式后没有代码 / LaTeX 特征 + 有句子和足够多的词。
export function looksLikeProseBlock(text) {
  const value = String(text || "").trim();
  if (value.length < 40) return false;
  // 先把 $…$ 公式摘掉:LaTeX 的花括号、反斜杠不是「代码」证据。
  const prose = value.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, " ").replace(/\s+/g, " ").trim();
  if (prose.length < 20) return false;
  if (CODE_HINT_RE.test(prose)) return false;
  if (/\\[a-zA-Z]{2,}/.test(prose)) return false;
  if ((prose.match(CODE_CHAR_RE) || []).length / prose.length > 0.02) return false;
  const sentences = (prose.match(/[.!?。;](?:\s+|$)/g) || []).length;
  const cjk = (prose.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (prose.match(/\s+/g) || []).length + Math.floor(cjk / 2);
  return sentences >= 1 && words >= 8;
}

// 无语言标记的围栏 + 内容像正文 → 「假代码块」,拆回段落;真代码块保留。
export function isProseFence(info, body) {
  return !String(info || "").trim() && looksLikeProseBlock(body);
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
