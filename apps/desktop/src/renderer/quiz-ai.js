// Pure helpers for the quiz study companion: decide which question a
// quick action refers to when the user has selected text, left a draft, or
// only scrolled the paper.

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, "")
    .trim();
}

function questionBody(question) {
  const parts = [question?.stemHtml, question?.stemText];
  for (const option of question?.options || []) parts.push(option?.html, option?.text);
  parts.push(question?.analysisHtml, question?.analysisText);
  return stripHtml(parts.filter(Boolean).join(" "));
}

// Map a selection or draft back to the question that contains it. Stem
// matches win over option/analysis matches because option text repeats.
export function quizQuestionIdForText(manifest, text) {
  const needle = stripHtml(text);
  if (needle.length < 4) return "";
  const questions = Array.isArray(manifest?.questions) ? manifest.questions : [];
  const candidates = [needle];
  for (const part of needle.split(/[：:，,。;；!?！？\n\r]+/u)) {
    const value = part.trim();
    if (value.length >= 6 && !candidates.includes(value)) candidates.push(value);
  }
  for (const candidate of candidates) {
    for (const question of questions) {
      const stem = stripHtml([question?.stemHtml, question?.stemText].filter(Boolean).join(" "));
      if (stem && (stem.includes(candidate) || candidate.includes(stem))) return question.id;
    }
  }
  for (const candidate of candidates) {
    for (const question of questions) {
      const body = questionBody(question);
      if (body && (body.includes(candidate) || candidate.includes(body))) return question.id;
    }
  }
  return "";
}

export function quizCurrentQuestionId({
  manifest,
  selectionId = "",
  selectionText = "",
  visibleId = "",
  activeId = "",
  inputText = "",
  injectedText = "",
  injectedId = "",
} = {}) {
  const questions = Array.isArray(manifest?.questions) ? manifest.questions : [];
  const ids = new Set(questions.map((question) => question?.id).filter(Boolean));
  const has = (id) => Boolean(id && ids.has(id));
  const text = String(inputText || "");
  // The composer is authoritative. If it contains a question's text (a pasted
  // stem, an injected selection, or a draft), use that question even when the
  // viewport is still showing the previous one.
  if (text.trim()) {
    if (injectedText && text.includes(injectedText) && has(injectedId)) return injectedId;
    const fromInput = quizQuestionIdForText(manifest, text);
    if (fromInput) return fromInput;
    if (has(selectionId)) return selectionId;
    const fromSelection = quizQuestionIdForText(manifest, selectionText);
    if (fromSelection) return fromSelection;
  }
  // An empty composer means "where am I reading": the bridge returns the first
  // fully visible question, then the first intersecting one.
  if (has(visibleId)) return visibleId;
  if (has(activeId)) return activeId;
  if (has(selectionId)) return selectionId;
  const fromSelection = quizQuestionIdForText(manifest, selectionText);
  if (fromSelection) return fromSelection;
  return questions[0]?.id ? String(questions[0].id) : "";
}

export function quizAnalyzePrompt(question) {
  const number = String(question?.number || "").trim().replace(/[.．、。)\s]+$/u, "");
  const label = /^[0-9]+(?:[-–—][0-9]+)?$/.test(number)
    ? `（第 ${number} 题）`
    : number ? `（${number}）` : "";
  return `请解析当前题${label}。`;
}
