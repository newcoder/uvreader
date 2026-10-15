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

// 章节标题去噪:PDF 提取出的标题常带脚注标记与行内标记,例如
// 「集合论的一种公理化 $^{①}$」「论大规模计算机器的原理 $^{①②}$」。
// 导航目录用的是标题纯文本,不清掉就会在目录里看到 $ ^ { } 这些符号。
export function cleanChapterTitle(value) {
  let title = String(value || "");
  title = title.replace(/`([^`]*)`/g, "$1");
  title = title.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*\n]+)\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  title = title.replace(/\\\(([\s\S]*?)\\\)/g, "$1").replace(/\$([^$]*)\$/g, "$1");
  title = title.replace(/\\[a-zA-Z]+\s*/g, " ");
  title = title.replace(/[\^_]\s*\{([^{}]*)\}/g, "$1");
  title = title.replace(/[{}]/g, "").replace(/[\^_]/g, " ");
  return title.replace(/\s+/g, " ").trim();
}

// R2:把上游标了 continuation 的半句接回上一行(pdf_tool 只在页首、且不像标题时才标)。
export function joinContinuationLines(markdown, texts) {
  const wanted = new Set(
    (Array.isArray(texts) ? texts : []).map((text) => String(text || "").replace(/\s+/g, " ").trim()).filter(Boolean),
  );
  if (!wanted.size) return String(markdown || "");
  const out = [];
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const value = line.replace(/\s+/g, " ").trim();
    if (!value || !wanted.has(value)) {
      out.push(line);
      continue;
    }
    let at = out.length - 1;
    while (at >= 0 && !out[at].trim()) at -= 1;
    const last = at >= 0 ? out[at].trim() : "";
    if (at >= 0 && !/^[!|#>`]/.test(last)) out[at] = joinInlineFragment(out[at], value);
    else out.push(line);
    wanted.delete(value);
  }
  return out.join("\n");
}

// 把被误判成标题的半句接回上一行:中文直接接;任一侧是拉丁字符时补一个空格。
export function joinInlineFragment(text, fragment) {
  const head = String(text ?? "").replace(/\s+$/, "");
  const tail = String(fragment ?? "").trim();
  if (!head) return tail;
  if (!tail) return head;
  const needSpace = /[A-Za-z0-9]$/.test(head) || /^[A-Za-z0-9]/.test(tail);
  return `${head}${needSpace ? " " : ""}${tail}`;
}

// 标题合理性:提取工具会把「页首/页尾被截断的半句」误判成标题(用户实测:一句的
// 最后三个字「的努力？」成了子标题)。这些规则只用来判断「不像标题」,命中就把那行
// 当回正文,接进上一章。
const HEADING_PARTICLE_START = /^[的地得着吗呢吧啊呀]\s*/;
const HEADING_MID_PUNCT_END = /[，、；：,;:]$/;
const HEADING_SHORT_SENTENCE = /^.{0,6}[。？！?!]$/;
const HEADING_LOWERCASE_START = /^[a-z][a-z0-9'’-]*(\s|$)/;

export function looksLikeHeadingTitle(value) {
  const title = String(value || "").trim();
  if (!title) return false;
  if (HEADING_PARTICLE_START.test(title)) return false;
  if (HEADING_MID_PUNCT_END.test(title)) return false;
  if (HEADING_SHORT_SENTENCE.test(title)) return false;
  // 纯英文里的小写开头多半是上一句的续写;含中文的标题(如「iPhone 使用指南」)照旧。
  if (!/[\u3400-\u9fff]/.test(title) && HEADING_LOWERCASE_START.test(title)) return false;
  return true;
}

// 提取出的 Markdown → 章节:按 1–3 级标题分;标题缺失时交给调用方按长度分块。
// 两个去噪规则(用户反馈「目录有点乱」):
//   ① 标题清成纯文本(见 cleanChapterTitle);
//   ② 连续的重复标题不当新章(页眉/书名在每页重复,提取出来会变成一串同名章节)。
export function splitMarkdownChapters(markdown, { bookTitle = "", keepTitle = null } = {}) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const chapters = [];
  const book = cleanChapterTitle(bookTitle).replace(/\s+/g, "").toLowerCase();
  let current = { title: "", lines: [], level: 1 };
  let inFence = false;
  const push = () => {
    const text = current.lines.join("\n").trim();
    // 标题后面紧跟下一级标题时,这一章是「空的」——但目录条目(如文章标题
    // 《形式主义的数学基础》《关于 EDVAC 报告的第一份草稿》)指的就是这里,丢了它
    // 目录条目就找不到落点。所以目录点名要的标题,空章也保留(就是它的标题页)。
    const keepEmpty = !text && current.title && typeof keepTitle === "function" && keepTitle(current.title) === true;
    if (text || keepEmpty) chapters.push({ title: current.title, text, level: current.level || 1 });
    current = { title: "", lines: [], level: 1 };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line.trim())) inFence = !inFence;
    const heading = !inFence && line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      let title = cleanChapterTitle(heading[2]).slice(0, 80);
      // 半句碎片(如页首的「的努力？」)不是标题:去掉井号,接回上一行末尾。
      if (!title) continue;
      // 上游偶尔把标题拆成两行(如「第」+「4章 电磁学」):标题极短、下一行像是续写 → 合并成一条标题,
      // 否则「第4章」这类条目在正文里根本找不到对应章节(表现为导航缺章)。
      if (title.length <= 2 && !/[。.?!？!，,]/.test(title)) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        const tail = (lines[next] || "").replace(/^#{1,3}\s*/, "").trim();
        if (tail && /^[\d一二三四五六七八九十]/.test(tail) && !/[。.?!？!]$/.test(tail.slice(-1)) && tail.length <= 30) {
          title = cleanChapterTitle(`${title}${tail}`).slice(0, 80);
          index = next;
        }
      }
      if (!looksLikeHeadingTitle(title)) {
        let at = current.lines.length - 1;
        while (at >= 0 && !String(current.lines[at]).trim()) at -= 1;
        const last = at >= 0 ? String(current.lines[at]).trim() : "";
        // 上一行是图片/表格/标题时不要往上粘,单独成行更安全。
        if (at >= 0 && !/^[!|#>`]/.test(last)) current.lines[at] = joinInlineFragment(current.lines[at], heading[2]);
        else current.lines.push(heading[2].trim());
        continue;
      }
      const key = title.replace(/\s+/g, "").toLowerCase();
      const last = chapters.length ? chapters[chapters.length - 1] : null;
      const previous = current.title ? current.title.replace(/\s+/g, "").toLowerCase() : (last ? last.title.replace(/\s+/g, "").toLowerCase() : "");
      // 页眉/书名重复出现的标题:并进上一章,不另开一章(标题行本身也丢掉)。
      if (key === previous || (book && key === book)) continue;
      push();
      current.title = title;
      current.level = Math.min(3, heading[1].length); // h1/h2/h3 → 导航层级
      continue;
    }
    current.lines.push(line);
  }
  push();
  return chapters;
}
