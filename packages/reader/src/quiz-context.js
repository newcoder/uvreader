// Build the AI context for a quiz page from its structured manifest. The
// whole paper is included so a follow-up such as "explain question 7" works
// even when the user is currently looking at question 16.
function plainHtml(value) {
  return String(value == null ? "" : value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function typeLabel(type) {
  return {
    choice: "选择题",
    multi: "多选题",
    true_false: "判断题",
    blank: "填空题",
    short: "简答题",
    program: "程序题",
    coding: "编程题",
  }[type] || type || "题目";
}

export function buildQuizAiContext(manifest = {}, { currentId = "", submitted = false, answers = {} } = {}) {
  const questions = Array.isArray(manifest.questions) ? manifest.questions : [];
  const lines = [
    `答题页：${manifest.title || "未命名试卷"}`,
    `题量：${questions.length} 题`,
    currentId ? `当前查看：${currentId}` : "",
    "下面是整份试卷的结构化内容；用户可能询问其中任意题号。",
    "",
  ].filter((line) => line !== "");
  for (const question of questions) {
    const marker = question.id === currentId ? "（当前题）" : "";
    lines.push(`【第 ${question.number || question.id} 题${marker}】${typeLabel(question.type)}`);
    lines.push(`题干：${plainHtml(question.stemHtml || question.stemText)}`);
    if (Array.isArray(question.options) && question.options.length) {
      lines.push("选项：");
      for (const option of question.options) {
        lines.push(`${option.key || ""}. ${plainHtml(option.html || option.text)}`);
      }
    }
    const userAnswer = answers[question.id];
    if (userAnswer != null && String(userAnswer).trim()) lines.push(`用户答案：${plainHtml(userAnswer)}`);
    if (submitted && question.answer) lines.push(`正确答案：${plainHtml(question.answer)}`);
    if (submitted && question.analysisHtml) lines.push(`解析：${plainHtml(question.analysisHtml)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
