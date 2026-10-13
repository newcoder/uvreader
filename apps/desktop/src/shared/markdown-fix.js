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

// MinerU 按页切块:一段程序跨页时会被切成两个相邻的无语言围栏(第二段通常从行号继续,
// 如 22 memset…),md 里就成了两段代码。这里把这种「跨页截断」的围栏并回一段:
// 中间只能有空行;两段都必须是没语言标记的裸围栏;第二段第一行要以行号开头;
// 若第一段末尾也带行号,则必须连续(22 接 21)。有文字/题目标签隔开的一律不动。
export function joinSplitCodeFences(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    const match = line.trim().match(/^```(.*)$/);
    if (!match) return;
    if (!open) {
      open = { start: index, info: String(match[1] || "").trim(), bodyStart: index + 1 };
      return;
    }
    blocks.push({ start: open.start, info: open.info, bodyStart: open.bodyStart, end: index });
    open = null;
  });
  if (blocks.length < 2) return lines.join("\n");
  const drop = new Set();
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const first = blocks[index];
    const second = blocks[index + 1];
    if (first.info || second.info) continue;
    if (lines.slice(first.end + 1, second.start).some((line) => line.trim())) continue;
    const firstBody = lines.slice(first.bodyStart, first.end).filter((line) => line.trim());
    const secondBody = lines.slice(second.bodyStart, second.end).filter((line) => line.trim());
    if (!firstBody.length || !secondBody.length) continue;
    const secondNumber = /^\s*(\d{1,3})[\s.]/.exec(secondBody[0]);
    if (!secondNumber) continue;
    const firstNumber = /^\s*(\d{1,3})[\s.]/.exec(firstBody[firstBody.length - 1]);
    if (firstNumber && Number(secondNumber[1]) !== Number(firstNumber[1]) + 1) continue;
    for (let line = first.end; line <= second.start; line += 1) drop.add(line);
    // 合并后的块继续参与下一轮(整段程序跨三页也能接上)。
    blocks[index + 1] = { ...second, start: first.start, info: "", bodyStart: first.bodyStart };
  }
  if (!drop.size) return lines.join("\n");
  return lines.filter((_line, index) => !drop.has(index)).join("\n");
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
