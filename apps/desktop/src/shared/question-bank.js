// 题库：把「提取出来的 Markdown」解析成 `uvreader.question-bank/v1`。
//
// 契约来自 pdf_tool 的 `model/bank.py`(2026-10-14 与 reader 对齐的那份):
//   { schema, source{file,pages,engine,extracted_at}, questions[], stats{questions,by_type} }
//   questions[i] = { id, number, type, stem, options[{label,text}], answer, analysis, images[{src,role}], source{page} }
// 这里**只用规则**(题号 / 选项 / 答案 / 解析 / 小节标题 / 填空下划线 / 判断题),不依赖模型:
// 模型只该做「规则认不出的那几题」的补漏,不该替代确定性解析。
//
// 设计约束:
// - 只认「像题」的结构,认不全就少给题 + 出 warning —— 不猜答案、不编解析;
// - 选项标签归一成 A–H;答案原样保留(多选保留 "ABD");
// - 图片按 Markdown 链接提取:题干 role=stem、选项 role=option、解析 role=figure。

export const QUESTION_BANK_SCHEMA = "uvreader.question-bank/v1";

const TYPES = new Set(["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "program", "calculation", "proof", "unknown"]);
const LABELS = "ABCDEFGH";

const QUESTION_START = /^\s*(?:第\s*)?(\d{1,3})\s*[.、．)）]\s*(.*)$/;
const OPTION_LINE = /^\s*([A-H])\s*[.、．)）]\s*(.*)$/;
// 卷面元数据行(试题编号 / 试题类型 / 难度 / 考点 …):不是题干、不是选项、也不是答案。
// 编辑过的试卷常在每题右上角带这些行 —— 绝不能折行续接进选项 D(实测 25 道选择题全中招)。
const META_LINE = /^\s*(?:试题)?\s*(编号|类型|题型|难度|知识点|考点|来源|分值|分数)\s*[:：]\s*(.*)$/;
const ANSWER_LINE = /^\s*(?:【\s*(?:参考|标准|正确)?\s*答案\s*】|(?:参考|标准|正确)?\s*答案\s*[:：]?)\s*(.*)$/;
const ANALYSIS_LINE = /^\s*(?:【\s*(?:试题)?\s*(?:解析|详解|分析)\s*】|(?:试题)?\s*(?:解析|详解|分析)\s*[:：])\s*(.*)$/;
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const BLANK_RE = /_{2,}|（\s{2,}）|﹍{2,}/;

function imagesIn(text, role) {
  const out = [];
  for (const match of String(text || "").matchAll(IMAGE_RE)) out.push({ src: match[1], role });
  return out;
}

function stripImages(text) {
  return String(text || "").replace(IMAGE_RE, "").replace(/[ \t]+$/gm, "").trim();
}

// 提取器偶尔会把内容包进 <details>/<summary>(DocVortex 的折叠块):标签本身是噪音,里面的文字要留。
// 还会留下图片占位文字(image content / IMG_2)—— 图已经单独存进 images,这些行没有信息量。
function stripFoldTags(text) {
  return String(text || "")
    .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, "")
    .split("\n")
    .filter((line) => !/^\s*(?:image content|IMG_\d+)\s*$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 答案区里跟在答案后面的卷面信息,不属于答案本身。
const ANSWER_META_LINE = /^\s*(?:试题)?难度\s*[:：]|^\s*参考答案\s*[:：]/;

function normalizeAnswer(raw) {
  const text = String(raw || "").trim();
  return text.replace(/^[（(【\[]|[）)】\]]$/g, "").trim();
}

function answerLetters(answer) {
  const compact = normalizeAnswer(answer).toUpperCase().replace(/[^A-H]/g, "");
  return compact.length >= 1 && compact.length <= LABELS.length ? compact : "";
}

function typeFromSection(title) {
  return mapTypeLabel(title);
}

// 卷面自己的题型标签(单选题 / 判断题 / 编程题 …)→ 契约里的 type。
function mapTypeLabel(raw) {
  const text = String(raw || "");
  if (/多选|多项/.test(text)) return "multiple_choice";
  if (/单选|单项|选择/.test(text)) return "single_choice";
  if (/判断/.test(text)) return "true_false";
  if (/填空/.test(text)) return "fill_blank";
  if (/编程|程序|代码/.test(text)) return "program";
  if (/计算/.test(text)) return "calculation";
  if (/证明/.test(text)) return "proof";
  if (/简答|问答|解答|论述/.test(text)) return "short_answer";
  return "";
}

// 一行里可能并排多个选项("A. 甲  B. 乙  C. 丙")——按字母标记切开。
function splitInlineOptions(text) {
  const value = String(text || "");
  const parts = value.split(/\s+(?=[A-H]\s*[.、．)）])/);
  return parts.length > 1 ? parts : [value];
}

// 跨页标记会粘在题干/选项末尾(合并稿里的 `<!--page:2-->`),不属于题面。
function stripPageMarkers(text) {
  return String(text || "").replace(/<!--\s*page:\s*\d+\s*-->/gi, "");
}

// 选项和题干挤在同一行(如 "…（ ）。 A. 6 B. 10 C. 15"):从第一个 A. 切开。
// 至少 3 个选项才认,避免把正文里的 "A." 当成选项。
function inlineOptionsInStem(line) {
  const value = String(line || "");
  // A 前面可能没有空格(CSP2019 q10:"（）。A. 27 B. 33 …"),允许 ) 。 ; 紧贴。
  const match = /(^|[\s）)。；;])(A\s*[.、．)）]\s+\S)/.exec(value);
  if (!match) return null;
  const startIndex = match.index + match[1].length;
  const head = value.slice(0, startIndex).trimEnd();
  const parts = splitInlineOptions(value.slice(startIndex).trim());
  const options = [];
  for (const part of parts) {
    const inline = OPTION_LINE.exec(part.trim());
    if (!inline) return null;
    options.push({ label: inline[1], text: (inline[2] || "").trim() });
  }
  return options.length >= 3 ? { head, options } : null;
}

// 题干的一行:顺手拆出并排的选项(题号那一行和后续行都走这里)。
function appendStem(question, text) {
  const value = String(text || "");
  const inline = question.options.length === 0 ? inlineOptionsInStem(value) : null;
  if (!inline) {
    question.stem += `\n${value}`;
    return;
  }
  if (inline.head) question.stem += `\n${inline.head}`;
  question.options.push(...inline.options);
}

/**
 * Markdown → { bank, warnings }。
 * @param {string} markdown 提取产物(或任何排版规整的 Markdown/纯文本)
 * @param {{file?: string, engine?: string, extractedAt?: string}} source
 */
export function bankFromMarkdown(markdown, source = {}) {
  const warnings = [];
  const questions = [];
  let sectionType = "";
  let current = null;
  let mode = "stem"; // stem | answer | analysis
  let answerSection = false;

  const pushCurrent = () => {
    if (!current) return;
    const stem = stripPageMarkers(stripImages(current.stem)).trim();
    if (!stem) {
      warnings.push(`第 ${current.number} 题没有题干,已丢弃`);
      current = null;
      return;
    }
    const options = current.options;
    let type = current.metaType || sectionType;
    if (!type) {
      if (options.length) type = answerLetters(current.answer).length > 1 ? "multiple_choice" : "single_choice";
      else if (BLANK_RE.test(stem)) type = "fill_blank";
      else if (/^(对|错|正确|错误|√|×|T|F)$/i.test(normalizeAnswer(current.answer))) type = "true_false";
      else type = "short_answer";
    }
    if (type === "single_choice" && options.length && answerLetters(current.answer).length > 1) type = "multiple_choice";
    const typeFinal = TYPES.has(type) ? type : "unknown";
    if ((typeFinal === "single_choice" || typeFinal === "multiple_choice") && options.length < 2) {
      warnings.push(`第 ${current.number} 题像选择题但只找到 ${options.length} 个选项`);
    }
    const images = [
      ...imagesIn(current.stem, "stem"),
      ...options.flatMap((option) => imagesIn(option.text, "option")),
      ...imagesIn(current.analysis, "figure"),
    ];
    // 契约:题干/选项/解析文本里的内联图片链接**保留原样**(图片位置就是语义的一部分 ——
    // 实测 q37 六张图之间夹着「要求(1)(2)(3)」),images[] 只是按 role 汇总,供界面做缩略图。
    // id 必须唯一:契约规定 `q1..qN(文档顺序)`,**不能**用卷面题号 ——
    // 实测 CSP2019 前半 1–15,后面的「阅读程序」又从 1 开始编号,用题号当 id 直接重复。
    // `number` 保留卷面原题号(可能重复),id 只按出现顺序。
    const item = {
      id: `q${questions.length + 1}`,
      number: current.number,
      type: typeFinal,
      stem: stripPageMarkers(stripFoldTags(current.stem)).trim(),
    };
    if (options.length) {
      item.options = options.map((option) => ({ label: option.label, text: stripPageMarkers(stripFoldTags(option.text)).trim() }));
    }
    item.answer = normalizeAnswer(current.answer);
    item.analysis = stripPageMarkers(stripFoldTags(current.analysis)).trim();
    // 卷面编号:bank 里没有专门的字段,用 pdf_tool question_schema 的同名字段挂在 metadata 上(加字段、不改合同)。
    if (current.sourceId) item.metadata = { source_id: String(current.sourceId) };
    if (images.length) item.images = images;
    if (current.page) item.source = { page: current.page };
    questions.push(item);
    current = null;
  };

  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 标题:可能是题型小节,也可能是「参考答案」整段。
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const anyHeading = heading || null;
    if (anyHeading) {
      const title = anyHeading[1].trim();
      if (/^(参考答案|答案与解析|答案|解析)/.test(title)) {
        pushCurrent();
        answerSection = true;
        sectionType = "";
        mode = "answer";
        continue;
      }
      const section = typeFromSection(title);
      if (section) {
        pushCurrent();
        answerSection = false;
        sectionType = section;
        mode = "stem";
        continue;
      }
      // 其他标题:还给当前题当题干的一部分(题组说明)。
      if (current && !answerSection) current.stem += `\n\n${title}`;
      continue;
    }
    // 非标题的纯小节行:「一、选择题(每题 2 分)」
    const bareSection = /^[一二三四五六七八九十]+\s*[、.．]\s*(.*)$/.exec(trimmed);
    if (bareSection && typeFromSection(bareSection[1])) {
      pushCurrent();
      answerSection = false;
      sectionType = typeFromSection(bareSection[1]);
      mode = "stem";
      continue;
    }
    if (/^(参考答案|答案与解析|答案|解析)$/.test(trimmed)) {
      pushCurrent();
      answerSection = true;
      sectionType = "";
      mode = "answer";
      continue;
    }

    const start = QUESTION_START.exec(trimmed);
    if (start) {
      // 答案区里的「1. B」是答案条目,不是新题。
      if (answerSection) {
        const target = questions.find((item) => item.number === start[1] && !item.answer);
        if (target) {
          const rest = start[2] || "";
          const [answerPart, ...analysisParts] = splitAnswerAnalysis(rest);
          target.answer = normalizeAnswer(answerPart);
          if (analysisParts.length) target.analysis = analysisParts.join(" ").trim();
          continue;
        }
        // 找不到对应题号(或已有答案):继续往下走,当说明文字。
      } else {
        pushCurrent();
        current = {
          id: "",
          number: start[1],
          type: "",
          stem: "",
          options: [],
          answer: "",
          analysis: "",
          page: 0,
          metaType: "",
          sourceId: "",
        };
        appendStem(current, start[2] || "");
        mode = "stem";
        continue;
      }
    }

    if (!current) {
      // 题号之前的内容(卷头 / 说明):忽略,但答案区之前的标题可能有用,不报错。
      continue;
    }

    const answerMatch = ANSWER_LINE.exec(trimmed);
    if (answerMatch) {
      mode = "answer";
      current.answer = answerMatch[1] || "";
      continue;
    }
    const analysisMatch = ANALYSIS_LINE.exec(trimmed);
    if (analysisMatch) {
      mode = "analysis";
      current.analysis = analysisMatch[1] || "";
      continue;
    }

    const meta = META_LINE.exec(trimmed);
    if (meta) {
      const key = meta[1];
      const value = String(meta[2] || "").trim();
      if (key === "编号" && value) current.sourceId = value;
      else if ((key === "类型" || key === "题型") && value) current.metaType = mapTypeLabel(value);
      // 难度 / 考点 / 来源 / 分值:bank 里没有对应字段,丢掉即可 —— 但绝不能粘进选项或题干。
      continue;
    }

    const optionMatch = OPTION_LINE.exec(trimmed);
    if (optionMatch && mode !== "analysis" && current.options.length < LABELS.length) {
      const label = optionMatch[1];
      const text = optionMatch[2] || "";
      // 同一行并排多个选项
      for (const part of splitInlineOptions(text)) {
        const inline = OPTION_LINE.exec(part);
        if (inline) {
          current.options.push({ label: inline[1], text: (inline[2] || "").trim() });
        } else {
          current.options.push({ label, text: part.trim() });
        }
      }
      continue;
    }

    if (mode === "answer") {
      if (META_LINE.test(trimmed) || ANSWER_META_LINE.test(trimmed)) continue; // 难度 / 编号 / 重复的参考答案:不属于答案
      current.answer += `\n${trimmed}`;
    } else if (mode === "analysis") current.analysis += `\n${trimmed}`;
    else if (current.options.length && !/^[A-H]/.test(current.options.at(-1)?.text || "")) {
      // 选项被折行:接到最后一个选项上(比接到题干更常见)。
      const last = current.options.at(-1);
      if (last && !OPTION_LINE.test(trimmed)) last.text += `\n${trimmed}`;
      else current.stem += `\n${trimmed}`;
    } else {
      // 选项和题干挤在同一行(q8/q10/q14):"...（ ）。 A. 6 B. 10 C. 15"
      appendStem(current, trimmed);
    }
  }
  pushCurrent();

  if (!questions.length) warnings.push("没有识别出题目(题号写法可能是「1、」「第 1 题」之外的格式)");
  const byType = {};
  for (const question of questions) byType[question.type] = (byType[question.type] || 0) + 1;
  return {
    bank: {
      schema: QUESTION_BANK_SCHEMA,
      source: {
        file: String(source.file || ""),
        pages: null,
        engine: String(source.engine || "rules"),
        extracted_at: String(source.extractedAt || new Date().toISOString()),
      },
      questions,
      stats: { questions: questions.length, by_type: byType },
    },
    warnings,
  };
}

function splitAnswerAnalysis(text) {
  const value = String(text || "");
  const match = /^(.*?)(?:\s*(?:解析|详解)[:：]\s*)([\s\S]*)$/.exec(value);
  if (match) return [match[1], match[2]];
  return [value];
}

/** 题库 → 可读 Markdown（同一份内容两种产物）。 */
export function bankToMarkdown(bank) {
  const lines = [];
  if (bank?.source?.file) lines.push(`> 来源：${bank.source.file}`, "");
  for (const question of bank?.questions || []) {
    // 题干原样输出:内联图片链接保持在原来的位置(q37 的图夹在「要求(1)(2)(3)」之间)。
    lines.push(`### ${question.number}. ${firstLine(question.stem)}`, "");
    const rest = question.stem.split("\n").slice(1).join("\n").trim();
    if (rest) lines.push(rest, "");
    for (const option of question.options || []) lines.push(`- **${option.label}.** ${option.text.replace(/\n/g, " ")}`);
    if ((question.options || []).length) lines.push("");
    if (question.answer) lines.push(`> **答案**：${question.answer}`);
    if (question.analysis) lines.push(">", `> **解析**：${question.analysis.replace(/\n/g, "\n> ")}`);
    lines.push("");
  }
  const stats = bank?.stats;
  if (stats) lines.push(`---`, `共 ${stats.questions} 题（${Object.entries(stats.by_type || {}).map(([type, count]) => `${type} ${count}`).join(" · ") || "无"}）`);
  return lines.join("\n").trimEnd() + "\n";
}

function firstLine(text) {
  return String(text || "").split("\n")[0].trim();
}

/**
 * 答题视图:只保留「做题需要」的字段。
 *
 * **答案/解析绝不能出现在答题页** —— 这里用**白名单**而不是 delete answer/analysis:
 * 以后题库加了新字段,也不会一不小心把答案带进界面。判题时才读完整 bank。
 */
export function questionForAnswering(question) {
  const view = {
    id: String(question?.id || ""),
    number: String(question?.number || ""),
    type: String(question?.type || "unknown"),
    stem: String(question?.stem || ""),
  };
  if (Array.isArray(question?.options) && question.options.length) {
    view.options = question.options.map((option) => ({ label: String(option.label || ""), text: String(option.text || "") }));
  }
  if (Array.isArray(question?.images) && question.images.length) {
    view.images = question.images.map((image) => ({ src: String(image.src || ""), role: String(image.role || "") }));
  }
  return view;
}

/** 整份题库的答题视图(不含答案 / 解析,连字段都没有)。 */
export function bankForAnswering(bank) {
  const questions = (bank?.questions || []).map(questionForAnswering);
  return {
    schema: QUESTION_BANK_SCHEMA,
    source: { file: String(bank?.source?.file || ""), engine: String(bank?.source?.engine || "") },
    questions,
    stats: { questions: questions.length },
  };
}

/** 结构校验：拿到外来的题库(比如模型/别的工具产出)时先过一遍，别把坏数据写盘。 */
export function validateBank(bank) {
  const issues = [];
  if (bank?.schema !== QUESTION_BANK_SCHEMA) issues.push(`schema 应为 ${QUESTION_BANK_SCHEMA}`);
  if (!Array.isArray(bank?.questions) || !bank.questions.length) issues.push("没有题目");
  const seen = new Set();
  for (const [index, question] of (bank?.questions || []).entries()) {
    const where = `第 ${index + 1} 题`;
    if (!question?.id) issues.push(`${where}: 缺 id`);
    else if (seen.has(question.id)) issues.push(`${where}: id 重复(${question.id})`);
    else seen.add(question.id);
    if (!String(question?.stem || "").trim()) issues.push(`${where}: 缺题干`);
    if (!TYPES.has(String(question?.type || ""))) issues.push(`${where}: 未知题型 ${question?.type}`);
    for (const option of question?.options || []) {
      if (!LABELS.includes(String(option.label || ""))) issues.push(`${where}: 选项标签不是 A–H(${option.label})`);
      if (!String(option.text || "").trim()) issues.push(`${where}: 选项 ${option.label} 是空的`);
    }
  }
  return issues;
}
