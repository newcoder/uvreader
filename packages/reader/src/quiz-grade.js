// Local grading used by the Quiz View host. Keep this independent from the
// HTML runtime so persisted scores and the page's visible score cannot drift.
import { quizQuestionKey } from "./quiz-store.js";

function plain(value) {
  return String(value == null ? "" : value).replace(/\s+/g, "").trim();
}

function choice(value) {
  return String(value == null ? "" : value).toUpperCase().replace(/[^A-H]/g, "").split("").sort().join("");
}

function truth(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (["t", "true", "对", "正确", "√", "y", "yes", "1"].includes(text)) return "T";
  if (["f", "false", "错", "错误", "×", "x", "n", "no", "0"].includes(text)) return "F";
  return text;
}

export function gradeQuizAttempt({ manifest = {}, answers = {}, questionKeys = null } = {}) {
  const byQuestion = {};
  const details = [];
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let ungraded = 0;
  for (const question of manifest.questions || []) {
    const key = questionKeys?.[question.id] || quizQuestionKey(question);
    const raw = answers[question.id];
    const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
    const got = plain(value);
    const expected = plain(question.answer);
    let state = "reference";
    if (question.type === "short" || question.type === "program" || question.type === "coding" || !expected) {
      ungraded += 1;
    } else if (!got) {
      state = "unanswered";
      unanswered += 1;
    } else if (question.type === "choice" || question.type === "multi") {
      const ok = choice(got) === choice(expected);
      state = ok ? "correct" : "wrong";
      if (ok) correct += 1; else wrong += 1;
    } else if (question.type === "true_false") {
      const ok = truth(got) === truth(expected);
      state = ok ? "correct" : "wrong";
      if (ok) correct += 1; else wrong += 1;
    } else {
      const ok = plain(got) === plain(expected);
      state = ok ? "correct" : "wrong";
      if (ok) correct += 1; else wrong += 1;
    }
    byQuestion[key] = { value: String(value == null ? "" : value), state };
    details.push({ id: question.id, questionKey: key, state, expected: question.answer || "" });
  }
  const gradedTotal = correct + wrong + unanswered;
  return {
    answers: byQuestion,
    details,
    summary: {
      total: (manifest.questions || []).length,
      correct,
      wrong,
      unanswered,
      ungraded,
      score: gradedTotal ? Math.round((correct / gradedTotal) * 100) : 0,
      gradedTotal,
    },
  };
}
