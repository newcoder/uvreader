// 论文类 PDF 的「文字层互补」:正文用 PDF 文字层(PyMuPDF,逐字精确),公式用 MinerU
// 的 LaTeX —— MinerU 偶尔丢字/符号(实测:丢过 "3000 rpm for"、把 "1 × 2" 变成 "1 2"),
// 文字层把公式拆成乱序字形,两者按上下文对齐后取长补短。
//
// 对齐用「压缩键」:只保留字母/数字/汉字并小写(NFKC 展开连字 ﬁ→fi、全角、上标),
// 于是换行、连字符断词、空格与符号差异都不影响匹配;任何一段对不上就回退 MinerU
// 原文——宁可少并,不丢不造。
import { looksLikeProseBlock } from "../shared/markdown-fix.js";

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

const MIN_ANCHOR = 12; // 压缩键短于这个长度的正文片段不参与定位(容易撞车)
const ANCHOR_EDGE = 32; // 长片段的头/尾定位长度
const LONG_SEGMENT = 64; // 超过这个长度就头/尾定位(中间丢字也能容忍)

// 文本 → 正文 / 公式 交替片段(公式保留原定界符,便于原样写回)。
export function splitMathSegments(text) {
  const raw = String(text || "");
  const out = [];
  let last = 0;
  for (const match of raw.matchAll(MATH_RE)) {
    if (match.index > last) out.push({ kind: "prose", text: raw.slice(last, match.index) });
    out.push({ kind: "math", latex: String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim(), raw: match[0].trim() });
    last = match.index + match[0].length;
  }
  if (last < raw.length) out.push({ kind: "prose", text: raw.slice(last) });
  return out;
}

// 压缩键:NFKC + 小写 + 只留字母/数字/汉字(丢掉空格、连字符、×、标点)。
export function squashKey(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// 文字层索引:压缩键 + 键位置 → 原文位置映射。
export function buildSquashIndex(text) {
  const value = String(text ?? "").normalize("NFKC");
  const chars = [];
  const map = [];
  const keyOfRaw = new Array(value.length + 1);
  for (let i = 0; i <= value.length; i += 1) keyOfRaw[i] = chars.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      chars.push(ch.toLowerCase());
      map.push(i);
    }
  }
  return { text: value, key: chars.join(""), map, keyOfRaw };
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// 在索引里找 key 的区间。短键(≤6)要求落在词边界上——否则 "30" 会命中 "3000"、
// "the" 会命中 "there";长键本身就够具体,允许切在词中(分块会切断单词)。
function findKeyRange(index, key, fromKey = 0) {
  if (!key) return null;
  const strict = key.length <= 6;
  let at = Math.max(0, fromKey);
  for (;;) {
    const found = index.key.indexOf(key, at);
    if (found < 0) return null;
    const start = index.map[found];
    const lastRaw = index.map[found + key.length - 1];
    if (!strict) return { start, end: lastRaw + 1, startKey: found, endKey: found + key.length };
    const before = index.text[start - 1];
    const after = index.text[lastRaw + 1];
    const leftOk = !before || !/[\p{L}\p{N}]/u.test(before);
    const rightOk = !after || !/[\p{L}\p{N}]/u.test(after);
    if (leftOk && rightOk) return { start, end: lastRaw + 1, startKey: found, endKey: found + key.length };
    at = found + 1;
  }
}

// 把一段正文锚到文字层上;返回原文区间(压缩键无法定位时返回 null)。
export function anchorText(index, prose, fromKey = 0) {
  const key = squashKey(prose);
  if (key.length < MIN_ANCHOR) return null;
  if (key.length <= LONG_SEGMENT) return findKeyRange(index, key, fromKey);
  const head = key.slice(0, ANCHOR_EDGE);
  const headRange = findKeyRange(index, head, fromKey);
  if (!headRange) return null;
  const tail = key.slice(-ANCHOR_EDGE);
  const tailRange = findKeyRange(index, tail, headRange.endKey);
  if (!tailRange) return null;
  return { start: headRange.start, end: tailRange.end, startKey: headRange.startKey, endKey: tailRange.endKey };
}

// 长正文片段 → 若干「锚块」(默认 ~8 词;超长的单个词——中文没有空格——按压缩键长度切开):
// 短锚点抗局部差异,定位失败时还会继续二分。
export function proseChunks(text, words = 8) {
  const raw = String(text || "");
  const pieces = [];
  let current = "";
  let count = 0;
  const flush = () => {
    if (current.trim()) pieces.push(current);
    current = "";
    count = 0;
  };
  for (const token of raw.split(/(\s+)/)) {
    if (!token) continue;
    if (/\S/.test(token) && squashKey(token).length > 48) {
      flush();
      let buffer = "";
      for (const ch of token) {
        buffer += ch;
        if (squashKey(buffer).length >= 40) {
          if (buffer.trim()) pieces.push(buffer);
          buffer = "";
        }
      }
      current = buffer;
      continue;
    }
    current += token;
    if (/\S/.test(token)) count += 1;
    if (count >= words) flush();
  }
  flush();
  return pieces.length ? pieces : [raw];
}

// 锚点在文字层里落在字母/数字上:往前带 1–3 个标点(逗号、句号),免得丢标点。
function extendStart(index, rawStart) {
  let at = rawStart;
  let guard = 0;
  while (at > 0 && guard < 3 && /[,.;:!?，。；：！？)\]]/.test(index.text[at - 1])) {
    at -= 1;
    guard += 1;
  }
  return at;
}

// 锚点结束位置之后跟着的标点也带上(「first」→「first.」)。
function extendEnd(index, rawEnd) {
  let at = rawEnd;
  let guard = 0;
  while (at < index.text.length && guard < 3 && /[,.;:!?，。；：！？、)\]]/.test(index.text[at])) {
    at += 1;
    guard += 1;
  }
  return at;
}

// 一段文本(可含 $…$)→ 用文字层正文 + MinerU 公式拼回来。
// 返回 { text, cursor }(cursor = 最后一个锚点的结束位置)或 null(定位不上,调用方保留原文)。
// fallbackKey = 本页在整篇索引里的起点(从光标起找不到时,回到本页开头再试一次)。
export function mergeParagraph(text, index, cursorRaw = 0, fallbackKey = 0) {
  const segments = splitMathSegments(text);
  const fromKey = index.keyOfRaw[Math.max(0, Math.min(cursorRaw, index.keyOfRaw.length - 1))] ?? 0;

  const parts = [];
  const state = { cursor: -1, searchFrom: fromKey, pending: [], anchored: false, lastSlice: false };
  const pendingText = () => state.pending.map((item) => (item.kind === "math" ? item.raw : item.text)).join(" ");

  // 两个锚点之间的文字层内容 → 按「待定项」模板对齐:
  // 正文项取文字层原文(逐字、能补 MinerU 丢的词),公式项换成 LaTeX(字形跳掉)。
  // 模板对不上就返回 false,整段回退,不冒险。
  const resolvePending = (gap) => {
    if (!state.pending.length) {
      if (squashKey(gap).length > 240) return false; // 间隙过长:对齐串位
      if (gap.trim()) {
        // 与上一段文字层切片连续:直接拼接,不插空格。
        if (state.lastSlice && parts.length) parts[parts.length - 1] += gap;
        else parts.push(gap);
      }
      return true;
    }
    const gapIndex = buildSquashIndex(gap);
    let at = 0;
    let prevProseEnd = null;
    let region = "";
    for (const item of state.pending) {
      if (item.kind === "math") {
        region += ` ${item.raw} `; // 公式:放 LaTeX,后面的字形随 cursor 跳过
        prevProseEnd = null;
        continue;
      }
      const key = squashKey(item.text);
      const match = findKeyRange(gapIndex, key, at);
      if (!match) {
        if (key.length >= 4) return false; // 长片段对不上 → 整段回退
        region += `${item.text} `; // 太短的片段:按 MinerU 原文
        prevProseEnd = null;
        continue;
      }
      const start = match.start;
      const end = extendEnd(gapIndex, match.end);
      if (prevProseEnd !== null && prevProseEnd <= start) {
        const between = gap.slice(prevProseEnd, start); // 两段正文之间:丢掉的词(文字层更全)
        if (squashKey(between).length > 240) return false;
        region += between;
      } else {
        region += " ";
      }
      region += gap.slice(start, end);
      at = match.endKey;
      prevProseEnd = end;
    }
    // 末个正文项之后、下一个锚点之前,剩下的文字层内容同样是「MinerU 丢掉的词」。
    if (prevProseEnd !== null) {
      const suffix = gap.slice(prevProseEnd);
      if (squashKey(suffix).length > 240) return false;
      region += suffix;
    }
    // 公式字形被跳过后,收尾的句号 / 逗号要留在正文里。
    const tail = gap.match(/[.,;:!?，。；：！？)\]]\s*$/);
    if (tail) region += ` ${tail[0].trim()} `;
    parts.push(region);
    return true;
  };

  const takeRange = (range) => {
    const start = extendStart(index, range.start);
    const end = extendEnd(index, range.end);
    if (state.anchored) {
      if (!resolvePending(index.text.slice(state.cursor, start))) return false;
    } else if (state.pending.length) {
      parts.push(pendingText()); // 首个锚点之前的片段按 MinerU 原样保留
    }
    state.pending = [];
    parts.push(index.text.slice(start, end));
    state.cursor = end;
    state.searchFrom = range.endKey;
    state.anchored = true;
    state.lastSlice = true;
    return true;
  };

  // 正文块定位:失败就二分(丢字往往落在切点上),单词都锚不上就记为待定项。
  const walk = (prose) => {
    if (!prose.trim()) return true;
    const range = anchorText(index, prose, state.searchFrom) || anchorText(index, prose, fallbackKey);
    if (range) return takeRange(range);
    const words = prose.trim().split(/\s+/);
    if (words.length >= 2) {
      const half = Math.ceil(words.length / 2);
      return walk(words.slice(0, half).join(" ")) && walk(words.slice(half).join(" "));
    }
    state.pending.push({ kind: "prose", text: prose });
    return true;
  };

  for (const segment of segments) {
    if (segment.kind === "math") {
      state.pending.push({ kind: "math", raw: segment.raw });
      continue;
    }
    for (const chunk of proseChunks(segment.text)) {
      if (!walk(chunk)) return null;
    }
  }
  if (state.pending.length) parts.push(pendingText());
  if (!state.anchored) return null; // 一段都没定位上:交给调用方保留 MinerU 原文

  const merged = parts
    .map((part) => clean(part))
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/(\p{L})- (\p{L})/gu, "$1$2") // PDF 断词(「de- signed」→「designed」)
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1");
  return merged ? { text: merged, cursor: state.cursor } : null;
}

// 块要合并的全文(caption 是 MinerU 塞进去的正文前半段,先拼回一段)。
export function blockFullText(block) {
  const caption = String(block?.caption || "").trim();
  const body = String(block?.text ?? block?.content ?? "");
  return [caption, body].filter((part) => part.trim()).join("\n");
}

// 页眉 / 页脚 / 水印(如 IEEE 的下载戳)会在多页重复出现:按行统计,重复页数达到
// 「页数 × 0.3(至少 2 页)」的行才算噪声删掉——只重复两三次的多半是正文里的公式或句子。
export function stripRepeatedLines(pages, { minPages = 0, minLength = 12, ratio = 0.3 } = {}) {
  const list = (Array.isArray(pages) ? pages : []).map((page) => String(page ?? "").normalize("NFKC"));
  const threshold = Math.max(minPages || 0, 2, Math.ceil(list.length * ratio));
  const counts = new Map();
  for (const page of list) {
    const seen = new Set();
    for (const line of page.split("\n")) {
      const key = line.trim().replace(/\s+/g, " ");
      if (key.length < minLength || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const repeated = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
  if (!repeated.size) return list;
  return list.map((page) => page
    .split("\n")
    .map((line) => (repeated.has(line.trim().replace(/\s+/g, " ")) ? "" : line))
    .join("\n"));
}

// 块列表 → 合并后的块列表(只动 text / heading / 被判成 code 的正文;公式、图片、表格保持)。
// 用整篇(清洗过的)文字层建一个索引:段落跨页也能定位,页码只决定搜索起点。
export function mergeBlocksWithTextLayer(blocks, pages, { log = () => {} } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const cleaned = stripRepeatedLines(pages);
  if (!cleaned.length || !cleaned.some((page) => page.trim())) return list.slice();

  // 整篇拼接:记住每页在拼接文本里的原始偏移(页码 → 键位置)。
  const pageStarts = [];
  let joined = "";
  for (const page of cleaned) {
    pageStarts.push(joined.length);
    joined += `${page}\n`;
  }
  const index = buildSquashIndex(joined);
  const pageStartKey = pageStarts.map((offset) => index.keyOfRaw[Math.min(offset, index.keyOfRaw.length - 1)] ?? 0);

  const out = [];
  let cursor = 0;
  for (const block of list) {
    const page = Number(block?.page) || 0;
    const type = String(block?.type || "text");
    const mergeable = type === "text" || type === "heading" || type === "code";
    if (!mergeable) {
      out.push(block);
      continue;
    }
    const full = blockFullText(block);
    if (squashKey(full).length < MIN_ANCHOR) {
      out.push(block);
      continue;
    }
    // 真代码块不参与正文合并:文字层按行取文本会把代码的换行/缩进压平(只有被上游
    // 判成 code 的正文段落才该按段落还原,靠 looksLikeProseBlock 判断)。
    if (type === "code" && !looksLikeProseBlock(full)) {
      out.push(block);
      continue;
    }
    const from = page > 0 && page <= pageStartKey.length ? pageStartKey[page - 1] : 0;
    const merged = mergeParagraph(full, index, Math.max(cursor, from), from);
    if (!merged) {
      log("text layer: block left as-is", block?.id || "", clean(full).slice(0, 40));
      out.push(block);
      continue;
    }
    cursor = merged.cursor;
    out.push({ ...block, type: type === "code" ? "text" : type, text: merged.text, content: undefined, caption: undefined });
  }
  return out;
}
