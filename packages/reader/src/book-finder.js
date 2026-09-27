// 搜书助手（Book Finder）: the prompt that turns a fuzzy reading need into a
// concrete book list the sources can be searched for. Kept in Chinese — it is
// model input, not UI copy — while the model writes `reason` in the reader's
// language. Pure module: prompt text, message builder and reply parser.
export const BOOK_FINDER_MAX = 8;

export const BOOK_FINDER_SYSTEM_PROMPT = `# 搜书助手（Book Finder）

## 名称
搜书助手（Book Finder）

## 触发场景
- 「推荐几本 XX 的书」
- 「我想读 XX，有什么版本推荐」
- 「帮我找 XX 主题的书」
- 「整理成书籍列表：{书名，作者，出版社}」

## 核心目标
把读者模糊的阅读需求，变成一份可以直接拿去书籍来源查找的短书单。

## 工作方式
1. 先判断读者要的是「某一本具体的书」，还是「某个主题 / 作者 / 体裁」；专指一本书时只返回那一本。
2. 选书要具体、真实、可查：优先公认的经典与常见版本，不选生僻到可能不存在的书。
3. 每条给出书名、作者、出版社；不确定的字段留空字符串，不编造。
4. 默认 8 本；读者明确要更多时最多 12 本。
5. 同一本书只出现一次（按书名 + 作者去重）。

## 输出格式
只输出一个 JSON 对象，不要 Markdown、不要解释：
{"books":[{"title":"书名","author":"作者","publisher":"出版社","reason":"一句话推荐理由"}]}
- reason 用读者提问时使用的语言，一句话，30 字以内，说明这本书为什么值得读；
- 读者用中文提问就用中文，用英文提问就用英文；
- 需求无法理解、给不出书单时输出 {"books":[]}。`;

function cleanField(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function buildBookFinderMessages(input, { max = BOOK_FINDER_MAX, language = "" } = {}) {
  const text = String(input ?? "").trim();
  if (!text) return [];
  const limit = Math.max(1, Math.min(12, Math.round(Number(max)) || BOOK_FINDER_MAX));
  const hint = language ? `界面语言：${language}。` : "";
  return [
    { role: "system", content: BOOK_FINDER_SYSTEM_PROMPT },
    { role: "user", content: `读者需求：${text}\n最多返回 ${limit} 本。${hint}` },
  ];
}

// Model replies arrive with fences or a stray sentence now and then; take the
// outermost JSON object, validate each entry and never throw on bad input.
export function parseBookFinderReply(text, { max = BOOK_FINDER_MAX } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let payload = null;
  try { payload = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  const list = Array.isArray(payload?.books) ? payload.books : [];
  const limit = Math.max(1, Math.min(12, Math.round(Number(max)) || BOOK_FINDER_MAX));
  const seen = new Set();
  const books = [];
  for (const item of list) {
    const title = cleanField(item?.title, 200);
    if (!title) continue;
    const author = cleanField(item?.author, 120);
    const key = `${title}\u0000${author}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    books.push({ title, author, publisher: cleanField(item?.publisher, 120), reason: cleanField(item?.reason, 200) });
    if (books.length >= limit) break;
  }
  return books;
}
