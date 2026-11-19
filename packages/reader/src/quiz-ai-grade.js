// AI grading for plain answer pages. The page carries no answers; after the
// reader submits, the host asks the model to judge each question and returns a
// store-compatible attempt summary plus per-question feedback.
import { quizQuestionKey } from "./quiz-store.js";

const MAX_STEM = 6000;
const MAX_OPTION = 1200;
const MAX_ANSWER = 6000;
const MAX_FEEDBACK = 2000;
const MAX_REFERENCE = 6000;

const STATES = new Set(["correct", "wrong", "unanswered", "reference"]);

function decodeEntities(value) {
  return String(value == null ? "" : value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const number = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : full;
    }
    const key = code.toLowerCase();
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[key] ?? full;
  });
}

function plainText(value) {
  return decodeEntities(String(value == null ? "" : value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function clipped(value, limit) {
  return plainText(value).slice(0, limit);
}

function answerValue(answers, id) {
  const raw = answers?.[id];
  const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
  return String(value == null ? "" : value);
}

function normalizeState(value) {
  const state = String(value || "").trim().toLowerCase();
  return STATES.has(state) ? state : "reference";
}

function parseReplyJson(text) {
  let value = String(text || "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  if (fence) value = fence[1].trim();
  const candidates = [];
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(value.slice(objectStart, objectEnd + 1));
  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(value.slice(arrayStart, arrayEnd + 1));
  candidates.push(value);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

export function buildQuizAiGradeMessages({ manifest = {}, answers = {} } = {}) {
  const questions = (manifest.questions || []).map((question) => ({
    id: String(question.id || ""),
    number: String(question.number || ""),
    type: String(question.type || ""),
    stem: clipped(question.stemHtml || question.stemText || "", MAX_STEM),
    options: (Array.isArray(question.options) ? question.options : []).map((option) => ({
      key: String(option.key || ""),
      text: clipped(option.html || option.text || "", MAX_OPTION),
    })),
    userAnswer: answerValue(answers, question.id).slice(0, MAX_ANSWER),
  }));
  const system = [
    "你是试卷判分器。根据题目、选项和考生作答，判断每道题。",
    "只输出 JSON，不要 Markdown 代码围栏，不要在 JSON 之外写解释。",
    '输出格式：{"results":[{"id":"q1","state":"correct"|"wrong"|"unanswered"|"reference","feedback":"简短判断依据","referenceAnswer":"标准答案或参考步骤"}]}',
    "规则：",
    "1. id 必须与输入一致，results 必须覆盖所有题目。",
    "2. userAnswer 是考生作答；它为空时 state 用 unanswered。",
    "3. 选择题、多选题按选项集合判断，顺序无关；判断题统一按对/错判断；填空题允许等价写法。",
    "4. 简答、计算、编程题：能确定对错时用 correct/wrong；无法确定时用 reference，并给出参考答案和关键步骤。",
    "5. feedback 要简短、具体；referenceAnswer 没有内容时留空字符串。",
    "6. 不要编造题目、改写题干或新增题目。",
  ].join("\n");
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({
        title: String(manifest.title || ""),
        questions,
      }, null, 2),
    },
  ];
}

export function parseQuizAiGradeReply(reply, { manifest = {}, answers = {}, questionKeys = null } = {}) {
  const parsed = parseReplyJson(reply);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.results)
      ? parsed.results
      : null;
  if (!list) throw new Error("AI 判分结果无法解析，请重试");

  const byId = new Map();
  for (const item of list) {
    const id = String(item?.id || "").trim();
    if (id && !byId.has(id)) byId.set(id, item);
  }
  if (!byId.size) throw new Error("AI 判分结果没有题目，请重试");

  const details = [];
  const gradedAnswers = {};
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let ungraded = 0;
  const questions = Array.isArray(manifest.questions) ? manifest.questions : [];
  for (const question of questions) {
    const id = String(question?.id || "");
    const value = answerValue(answers, id);
    const item = byId.get(id);
    let state = normalizeState(item?.state);
    if (!value.trim()) state = "unanswered";
    else if (!item) state = "reference";
    if (state === "correct") correct += 1;
    else if (state === "wrong") wrong += 1;
    else if (state === "unanswered") unanswered += 1;
    else ungraded += 1;
    const key = questionKeys?.[id] || quizQuestionKey(question);
    gradedAnswers[key] = { value, state };
    details.push({
      id,
      number: String(question?.number || ""),
      state,
      feedback: String(item?.feedback || (item ? "" : "AI 未返回这道题的判分结果")).slice(0, MAX_FEEDBACK),
      referenceAnswer: String(item?.referenceAnswer || "").slice(0, MAX_REFERENCE),
    });
  }
  const gradedTotal = correct + wrong + unanswered;
  return {
    answers: gradedAnswers,
    details,
    summary: {
      total: questions.length,
      correct,
      wrong,
      unanswered,
      ungraded,
      gradedTotal,
      score: gradedTotal ? Math.round((correct / gradedTotal) * 100) : 0,
      ai: true,
    },
  };
}
