// AI 分章建议的规则层(纯函数,主进程与渲染层共用):
// 本地抽「像标题的行」→ 模型只归纳**规则**(封闭集合,不给正则)→ 本地套回全书并验证。
// 套用与验证都在这里:模型返回的任何东西都当不可信输入,坏规则过不了闸就退回原样。

// 中文数字 → 数字(章节号范围;认不出返回 0)。
const CN_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

export function chineseNumber(value) {
  const text = String(value || "");
  if (!text || !/[零〇一二三四五六七八九十百千]/.test(text)) return 0;
  if (!/[十百千]/.test(text)) return text.length === 1 ? (CN_DIGITS[text] ?? 0) : 0;
  let total = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch === "百") { total += (digit || 1) * 100; digit = 0; }
    else if (ch === "千") { total += (digit || 1) * 1000; digit = 0; }
    else if (ch === "十") { total += (digit || 1) * 10; digit = 0; }
    else if (ch in CN_DIGITS) digit = CN_DIGITS[ch];
    else return 0;
  }
  return total + digit;
}

export function parseChapterNumber(raw) {
  const text = String(raw || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return chineseNumber(text);
}

function sampleEvenly(list, max) {
  if (list.length <= max) return list;
  const stride = Math.ceil(list.length / max);
  const out = [];
  for (let i = 0; i < list.length && out.length < max; i += stride) out.push(list[i]);
  return out;
}

// ① 候选行:整行 ≤ 40 字、独立成段、不以句末标点结尾 —— 像标题的样子(不判断内容,交给模型)。
export function collectChapterCandidates(text, { max = 400, scan = 20000, maxLength = 40 } = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const all = [];
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.length > maxLength) continue;
    if (/[。！？!?；;，,、]$/.test(trimmed)) continue;               // 句末标点:是正文
    if (/^(?:[-=*#~_—·]{3,}|第?\s*\d+\s*页(?:\D.*)?)$/.test(trimmed)) continue; // 分隔线 / 页码
    const prevBlank = index === 0 || !lines[index - 1].trim();
    const nextBlank = index === lines.length - 1 || !lines[index + 1].trim();
    if (!prevBlank && !nextBlank) continue;                          // 夹在正文里
    total += 1;
    if (all.length < scan) all.push({ no: index + 1, text: trimmed });
  }
  return { lines: sampleEvenly(all, max), total, truncated: total > max };
}

const RULE_KINDS = new Set(["numbered", "prefixed"]);
const NUMBER_STYLES = new Set(["arabic", "chinese", "padded"]);

// ② 规则白名单:字段与长度都收紧(模型输出不可信);形不成规则的返回 null。
export function normalizeChapterRule(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const kind = String(data.kind || "").trim();
  if (!RULE_KINDS.has(kind)) return null;
  const text = (value, max) => String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, max);
  const rule = {
    kind,
    number: NUMBER_STYLES.has(String(data.number || "")) ? String(data.number) : "arabic",
    prefix: text(data.prefix, 8),
    suffix: text(data.suffix, 8),
    separator: text(data.separator, 4),
    note: text(data.note, 120),
  };
  if (kind === "prefixed" && !rule.prefix && !rule.suffix) return null;
  if (rule.separator && rule.separator.length > 2) rule.separator = "";
  return rule;
}

export function describeChapterRule(raw) {
  const rule = normalizeChapterRule(raw);
  if (!rule) return "";
  const number = { arabic: "数字", chinese: "中文数字", padded: "补零数字" }[rule.number] || "数字";
  const shape = rule.kind === "prefixed"
    ? `「${rule.prefix || "·"}」+ ${number} + 「${rule.suffix || "·"}」`
    : `${number} + 分隔符「${rule.separator || "空格"}」`;
  return `${shape} + 标题`;
}

function rulePattern(rule) {
  const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const number = "(\\d{1,6}|[零〇一二三四五六七八九十百千]{1,8})";
  const separator = rule.separator ? escape(rule.separator) : "[\\s.、．:：)）\\]]*";
  if (rule.kind === "prefixed") {
    return new RegExp(`^${escape(rule.prefix)}\\s*${number}\\s*${escape(rule.suffix)}\\s*${separator}\\s*(\\S.*)$`);
  }
  return new RegExp(`^${number}\\s*${separator}\\s*(\\S.*)$`);
}

// ③ 套用 + 验证:条数 ≥ 2、编号递增(都带编号时)、相邻至少隔 120 字(列表排除)。
// 每行单独跑正则(行短),不吃整篇文本,坏规则也不会拖住。
export function applyChapterRule(text, rawRule) {
  const rule = normalizeChapterRule(rawRule);
  if (!rule) return { error: "规则不可用" };
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const pattern = rulePattern(rule);
  const matched = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const hit = trimmed ? pattern.exec(trimmed) : null;
    if (hit) matched.push({ index, offset, number: parseChapterNumber(hit[1]), title: trimmed.slice(0, 120) });
    offset += lines[index].length + 1;
  }
  if (matched.length < 2) return { error: `只认出 ${matched.length} 个标题,太少` };
  const numbers = matched.map((item) => item.number);
  if (numbers.every((value) => value > 0)) {
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] <= numbers[i - 1]) return { error: "编号不是递增的(像正文里的编号)" };
      if (numbers[i] - numbers[i - 1] > 5) return { error: "编号跳号太多(像正文里的编号)" };
    }
  }
  for (let i = 1; i < matched.length; i += 1) {
    if (matched[i].offset - matched[i - 1].offset < 120) return { error: "标题挨得太近(像列表)" };
  }
  const headings = new Set(matched.map((item) => item.index));
  const chapters = [];
  let current = { title: "", lines: [] };
  const push = () => {
    const body = current.lines.join("\n").trim();
    if (body) chapters.push({ title: current.title || `第 ${chapters.length + 1} 节`, body });
    current = { title: "", lines: [] };
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (headings.has(index)) {
      push();
      current.title = lines[index].trim().slice(0, 120);
      continue;
    }
    current.lines.push(lines[index]);
  }
  push();
  if (chapters.length < 2) return { error: "按这个规则切不出章节" };
  return {
    chapters,
    count: chapters.length,
    first: chapters.slice(0, 5).map((chapter) => chapter.title),
    last: chapters.slice(-3).map((chapter) => chapter.title),
  };
}
