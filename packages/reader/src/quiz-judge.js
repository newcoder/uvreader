// Q3: judge and explain every answered question with the model.
//
// The paper may ship no standard answers at all, so the prompt asks the model
// to solve the question itself in that case and produce an explanation either
// way. Objective questions that do have a standard answer keep the
// deterministic verdict; the model analysis is still attached.
const JSON_RULES = "只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏。";

const TYPE_NAMES = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  true_false: "判断题",
  fill_blank: "填空题",
  short_answer: "简答题",
  program: "程序题",
  calculation: "计算题",
  proof: "证明题",
  unknown: "题目",
};

function optionLines(question) {
  return (question?.options || [])
    .map((option) => `${option.label}. ${option.text}`)
    .join("\n");
}

export function buildSolveMessages(question, { context = "", section = "", knownAnswer = "" } = {}) {
  const parts = [
    `题型：${TYPE_NAMES[question?.type] || "题目"}`,
  ];
  if (section) parts.push(`小节：${section}`);
  parts.push("", "题目：", String(question?.stem || "").trim());
  const options = optionLines(question);
  if (options) parts.push("", "选项：", options);
  if (context) parts.push("", "相关程序/材料：", String(context).trim());
  if (knownAnswer) parts.push("", "已知答案（以此为准）：", String(knownAnswer).trim());
  return [
    {
      role: "system",
      content: `你是 CCF CSP 试卷的解题老师，负责给出正确答案和解析。${JSON_RULES}`,
    },
    {
      role: "user",
      content: [
        ...parts,
        "",
        "要求：",
        "1. 自己解题；选择题只给字母（多选按字母顺序），判断题给“对”或“错”，填空题给要填的内容，简答/程序题给参考答案要点。",
        "2. 解析不超过 200 字，说明关键步骤。",
        "3. JSON 字段：answer（答案）、analysis（解析）。",
        "4. 原文没有的信息不要编造；不确定时 answer 留空，并在 analysis 里说明。",
      ].join("\n"),
    },
  ];
}

export function normalizeSolve(raw) {
  if (!raw || typeof raw !== "object") return null;
  const answer = String(raw.answer ?? "").trim();
  const analysis = String(raw.analysis ?? "").trim();
  if (!answer && !analysis) return null;
  return { answer, analysis };
}

// 题目边界识别:只输出「真正题干的起始行号」,不生成正文。
export function buildStructureMessages({ numbered = "", candidates = [] } = {}) {
  return [
    {
      role: "system",
      content: `你是试卷结构分析器，负责找出每道题的起始行。${JSON_RULES}`,
    },
    {
      role: "user",
      content: [
        "下面是带行号的试卷 Markdown。请找出所有**真正题干的起始行**。",
        "注意：",
        "1) 伪代码、算法步骤、代码行即使以数字开头也不是题目；",
        "2) 选项行（A. / B. / C. / D.）不是题目；",
        "3) 小节标题、页眉页脚、答案/解析不是题目；",
        "4) 只返回输入里存在的行号，不要编造。",
        "",
        `候选题号行（规则识别，可能有误）: ${candidates.join(", ") || "(无)"}`,
        "",
        "带行号的原文:",
        numbered,
        "",
        'JSON 字段：starts（题目起始行号数组）。示例：{"starts":[40,57,71]}',
      ].join("\n"),
    },
  ];
}

export function parseStructureStarts(text, { maxLine = 0, candidates = [] } = {}) {
  const raw = parseJudgeJson(text);
  const list = Array.isArray(raw?.starts) ? raw.starts : Array.isArray(raw) ? raw : [];
  const allowed = new Set((candidates || []).map(Number));
  const starts = [];
  for (const value of list) {
    const line = Number(value);
    if (!Number.isInteger(line) || line < 1 || (maxLine && line > maxLine)) continue;
    if (allowed.size && !allowed.has(line)) continue;
    if (!starts.includes(line)) starts.push(line);
  }
  return starts.sort((a, b) => a - b);
}

export function parseJudgeJson(text) {
  let value = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!value) return null;
  value = value.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, index + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
