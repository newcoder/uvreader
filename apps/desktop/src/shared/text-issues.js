// AI 清理的两半:① 本地体检(发现问题,免费,不调用 AI)② 清理结果的护栏与对比。
// 体检只报「可疑」,由用户确认后再清理;护栏保证模型只做最小修正,改写一律丢弃。

// ── ① 体检 ────────────────────────────────────────────────────────────

// 私用区 / 替换字符 / 控制符 —— OCR 与编码事故的典型残留。
const ODD_CHAR_RE = /[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
// 乱码片段:UTF-8 被当 Latin-1 读出来的「Â¡ Ã¢」这类连续重音字母(整段算一条)。
const MOJIBAKE_RE = /(?:[\u00C0-\u00FF]{2,}|[\u00C2\u00C3\u00D0\u00D1][\u0080-\u00BF])+/g;
// 同一个汉字连写 4 次以上(「的的的的」):正常行文几乎不会出现。
const REPEAT_RE = /([\p{Script=Han}])\1{3,}/gu;
// 行首就是章名、但整行太长(标题后面直接接着正文):标题被吞进正文。
const SWALLOWED_HEAD_RE = /^(?:#{1,4}\s+)?第[零一二三四五六七八九十百千万〇0-9]{1,10}[章节回卷篇部集幕][\s:：.、-]/;
// 断行碎片:连续 3 行都很短、且不以句末标点结尾。
const SENTENCE_END_RE = /[。！？…”』」]$/;

function clip(value, max = 60) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sampleAround(text, index, span = 24) {
  return clip(String(text).slice(Math.max(0, index - span), index + span), 70);
}

// 一章的体检:四类可疑 + 总评分(0 = 干净)。纯本地,不联网。
export function scanTextIssues(text) {
  const source = String(text ?? "");
  const issues = { oddChars: [], mojibake: [], repeats: [], swallowedHeadings: [], brokenLines: [] };
  for (const match of source.matchAll(ODD_CHAR_RE)) issues.oddChars.push(sampleAround(source, match.index));
  for (const match of source.matchAll(MOJIBAKE_RE)) issues.mojibake.push(sampleAround(source, match.index));
  for (const match of source.matchAll(REPEAT_RE)) issues.repeats.push(clip(match[0], 30));
  const lines = source.split(/\r?\n/);
  let shortRun = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 12 && !SENTENCE_END_RE.test(trimmed)) {
      shortRun += 1;
      if (shortRun === 3) issues.brokenLines.push(clip(trimmed, 30));
      continue;
    }
    shortRun = 0;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 30 && SWALLOWED_HEAD_RE.test(trimmed)) issues.swallowedHeadings.push(clip(trimmed, 70));
  }
  const score = issues.oddChars.length * 2 + issues.mojibake.length * 2 + issues.repeats.length
    + issues.swallowedHeadings.length * 2 + issues.brokenLines.length;
  return { score, issues };
}

export function describeIssues(scan) {
  const parts = [];
  const labels = {
    oddChars: "怪字符",
    mojibake: "乱码片段",
    repeats: "重复字",
    swallowedHeadings: "疑似吞标题",
    brokenLines: "疑似断行",
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = scan?.issues?.[key];
    const count = Array.isArray(value) ? value.length : Number(value) || 0;
    if (count) parts.push(`${label} ${count}`);
  }
  return parts.join(" · ") || "没有发现可疑内容";
}

// 整本体检:逐章评分,返回可疑章节(按可疑度排序)与合计。
export function scanChapterIssues(chapters = []) {
  const rows = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index] || {};
    const scan = scanTextIssues(chapter.text || "");
    if (scan.score > 0) rows.push({ index, title: String(chapter.title || ""), score: scan.score, scan });
  }
  const totals = {};
  for (const row of rows) {
    for (const [key, list] of Object.entries(row.scan.issues)) totals[key] = (totals[key] || 0) + list.length;
  }
  return { rows: rows.sort((a, b) => b.score - a.score), totals, suspects: rows.length };
}

// ── ② 清理用的切块 / 护栏 / 对比 ───────────────────────────────────────

// 段落:空行分隔;没有空行的(中文 TXT 一行一段)按行。
export function splitParagraphs(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];
  const blocks = source.split(/\n{2,}/);
  if (blocks.length > 1) return blocks.map((block) => block.trim()).filter(Boolean);
  return source.split("\n").map((line) => line.trim()).filter(Boolean);
}

// 按 ~4000 字切块(不切碎段落;单段超长时按句号兜底)。
export function splitCleanupBlocks(text, { size = 4000 } = {}) {
  const paragraphs = splitParagraphs(text);
  const blocks = [];
  let current = [];
  let length = 0;
  const flush = () => {
    if (current.length) blocks.push(current.join("\n\n"));
    current = [];
    length = 0;
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush();
      const sentences = paragraph.split(/(?<=[。！？!?])/);
      let chunk = "";
      for (const sentence of sentences) {
        if (chunk && chunk.length + sentence.length > size) {
          blocks.push(chunk);
          chunk = "";
        }
        chunk += sentence;
      }
      if (chunk) blocks.push(chunk);
      continue;
    }
    if (length && length + paragraph.length > size) flush();
    current.push(paragraph);
    length += paragraph.length + 2;
  }
  flush();
  return blocks;
}

function bigrams(text) {
  const value = String(text ?? "").replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i + 1 < value.length; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

// 二元组 Dice 相似度:改写会明显掉下来(0.9 是「只修错字」的经验线)。
export function bigramSimilarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return (2 * common) / (left.size + right.size);
}

// 四道护栏:长度 ±10%、段落数 ±1、整体相似度(长块 ≥ 0.9 / 短块 ≥ 0.6)、长段落不被整段改写。
// 阈值随长度放宽:几十字的短块里改两个错字,相似度天然就低,不该被当成改写。
export function guardCleanupBlock(input, output) {
  const before = String(input ?? "");
  const after = String(output ?? "");
  if (!after.trim()) return { ok: false, reason: "返回为空" };
  const ratio = after.length / Math.max(1, before.length);
  if (ratio < 0.9 || ratio > 1.1) return { ok: false, reason: `长度变化过大(${Math.round(ratio * 100)}%)` };
  const left = splitParagraphs(before);
  const right = splitParagraphs(after);
  if (Math.abs(left.length - right.length) > 1) return { ok: false, reason: "段落数变化过大" };
  const similarity = bigramSimilarity(before, after);
  const limit = before.length >= 400 ? 0.9 : 0.6;
  if (similarity < limit) return { ok: false, reason: `改动过大(相似度 ${similarity.toFixed(2)})` };
  const pairs = Math.min(left.length, right.length);
  for (let i = 0; i < pairs; i += 1) {
    // 短段落(几十字)不判:改一个错字就掉到 0.5 以下,判不准。
    if (left[i].length < 80) continue;
    if (bigramSimilarity(left[i], right[i]) < 0.5) return { ok: false, reason: "有一段被整段改写" };
  }
  return { ok: true, similarity };
}

// 段落级对比:对齐两边的段落,只留下改动过的那几处(前后各裁掉相同的部分,突出中间)。
export function diffParagraphs(before, after, { max = 40 } = {}) {
  const left = splitParagraphs(before);
  const right = splitParagraphs(after);
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (i + 1 < left.length && j < right.length && left[i + 1] === right[j]) {
      changes.push({ kind: "removed", before: left[i], after: "" });
      i += 1;
      continue;
    }
    if (i < left.length && j + 1 < right.length && left[i] === right[j + 1]) {
      changes.push({ kind: "added", before: "", after: right[j] });
      j += 1;
      continue;
    }
    const a = left[i] ?? "";
    const b = right[j] ?? "";
    changes.push({ kind: "changed", before: a, after: b, ...trimCommon(a, b) });
    i += 1;
    j += 1;
  }
  return { changes: changes.slice(0, max), total: changes.length };
}

// 裁掉共同前缀/后缀,只留中间真正不同的部分(给对比视图用)。
function trimCommon(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return {
    prefix: a.slice(0, start).slice(-20),
    suffix: end ? a.slice(a.length - end).slice(0, 20) : "",
    before: a.slice(start, a.length - end).slice(0, 120),
    after: b.slice(start, b.length - end).slice(0, 120),
  };
}
