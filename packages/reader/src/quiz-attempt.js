// Quiz attempts: the data the answering page is allowed to keep.
//
// The answering view only ever receives `bankForAnswering()` (no answer or
// analysis fields). The complete bank stays with the caller, which is why
// grading takes it separately: the attempt itself never stores answers.
export const QUIZ_ATTEMPT_SCHEMA = "uvreader.quiz-attempt/v1";

// 参考答案在完整 bank 里可能是 "A"、"A、C"、"对"、"True" 等写法。
function normalizeAnswer(raw) {
  return String(raw ?? "")
    .replace(/答案[:：]?/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// 答题页只拿白名单视图(契约与 `apps/desktop/src/shared/question-bank.js` 的
// `bankForAnswering` 相同;reader 包不能反向依赖 apps,所以保留这一份,
// 两侧各有断言,字段变化时一起改)。
export function answeringQuestion(question) {
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

export function answeringBank(bank) {
  const questions = (bank?.questions || []).map(answeringQuestion);
  return {
    schema: String(bank?.schema || ""),
    source: { file: String(bank?.source?.file || ""), engine: String(bank?.source?.engine || "") },
    questions,
    stats: { questions: questions.length },
  };
}

export function createAttempt(bank, { now = Date.now } = {}) {
  return {
    schema: QUIZ_ATTEMPT_SCHEMA,
    bank: {
      file: String(bank?.source?.file || ""),
      schema: String(bank?.schema || ""),
    },
    answers: {},
    startedAt: new Date(now()).toISOString(),
    submittedAt: null,
  };
}

// Answers are keyed by question id: a label for single choice, a label array
// for multiple choice, "T"/"F" for true/false, a string for fill/short answer.
export function setAnswer(attempt, questionId, value) {
  const answers = { ...(attempt.answers || {}) };
  const empty = value == null
    || value === ""
    || (Array.isArray(value) && value.length === 0);
  if (empty) delete answers[questionId];
  else answers[questionId] = value;
  return { ...attempt, answers };
}

function letters(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-H]/g, "")
    .split("")
    .filter((letter, index, list) => list.indexOf(letter) === index)
    .sort();
}

function truth(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["t", "true", "对", "正确", "√", "y", "yes", "1"].includes(text)) return "T";
  if (["f", "false", "错", "错误", "×", "x", "n", "no", "0"].includes(text)) return "F";
  return "";
}

export function isAnswered(attempt, question) {
  const value = (attempt?.answers || {})[question?.id];
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== "";
}

// Deterministic grading for objective questions. Everything else is left for
// the AI pass (Q3); the panel shows it as 待判 instead of inventing a verdict.
export function gradeQuestion(question, answer) {
  const type = String(question?.type || "");
  const expected = normalizeAnswer(question?.answer);
  if (type === "single_choice" || type === "multiple_choice") {
    if (!expected) return { status: "unavailable" };
    const want = letters(expected);
    const got = letters(Array.isArray(answer) ? answer.join("") : answer);
    if (!got.length) return { status: "unanswered", expected: want.join("") };
    const correct = want.length === got.length && want.every((letter, index) => letter === got[index]);
    return { status: correct ? "correct" : "wrong", expected: want.join("") };
  }
  if (type === "true_false") {
    const want = truth(expected);
    if (!want) return { status: "unavailable" };
    const got = truth(answer);
    if (!got) return { status: "unanswered", expected: want };
    return { status: got === want ? "correct" : "wrong", expected: want };
  }
  return { status: "ungraded" };
}

export function gradeAttempt(bank, attempt) {
  const items = [];
  let correct = 0;
  let wrong = 0;
  let graded = 0;
  let pending = 0;
  for (const question of bank?.questions || []) {
    const result = gradeQuestion(question, (attempt?.answers || {})[question.id]);
    const item = { id: question.id, number: question.number, type: question.type, ...result };
    items.push(item);
    if (result.status === "correct") {
      correct += 1;
      graded += 1;
    } else if (result.status === "wrong") {
      wrong += 1;
      graded += 1;
    } else if (result.status === "ungraded") pending += 1;
  }
  return { items, correct, wrong, graded, pending, total: items.length };
}
