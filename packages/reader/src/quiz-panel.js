// 答题页(侧栏):只吃 `bankForAnswering()` 的白名单视图。
//
// Rendering is plain DOM so the panel works in Obsidian and the desktop shell
// alike; Markdown (stems with formulas/images) is rendered through the injected
// `renderText` hook, which the reader already has.
import { isAnswered } from "./quiz-attempt.js";

const TYPE_LABELS = {
  single_choice: "单选",
  multiple_choice: "多选",
  true_false: "判断",
  fill_blank: "填空",
  short_answer: "简答",
  program: "程序",
  calculation: "计算",
  proof: "证明",
  unknown: "题目",
};

const STATUS_TEXT = {
  correct: "正确",
  partial: "部分正确",
  wrong: "错误",
  ungraded: "待判",
  unavailable: "无参考答案",
  unanswered: "未答",
};

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function answeredCount(bank, attempt) {
  return (bank?.questions || []).filter((question) => isAnswered(attempt, question)).length;
}

function answerOf(attempt, question) {
  return (attempt?.answers || {})[question.id];
}

function applyChoice(attempt, question, label) {
  const current = answerOf(attempt, question);
  if (question.type === "multiple_choice") {
    const list = Array.isArray(current) ? [...current] : [];
    const index = list.indexOf(label);
    if (index >= 0) list.splice(index, 1);
    else list.push(label);
    return list.sort();
  }
  return current === label ? "" : label;
}

export function renderQuizPanel(container, options = {}) {
  const {
    bank,
    results = null,
    judgements = null,
    judging = false,
    judgeProgress = null,
    judgeError = "",
    onChange = () => {},
    onSubmit = () => {},
    onClose = null,
    renderText = (node, text) => { node.textContent = String(text || ""); },
  } = options;
  let attempt = options.attempt;
  const doc = container.ownerDocument;
  const submitted = Boolean(attempt?.submittedAt);
  container.replaceChildren();

  const head = el(doc, "div", "qbr-panel-head");
  head.appendChild(el(doc, "div", "qbr-panel-title", "答题"));
  const actions = el(doc, "div", "qbr-panel-actions");
  const progress = el(doc, "span", "qiaomu-reader-quiz-progress", "");
  actions.appendChild(progress);
  if (onClose) {
    const close = el(doc, "button", "qiaomu-reader-quiz-close", "关闭");
    close.type = "button";
    close.addEventListener("click", () => onClose());
    actions.appendChild(close);
  }
  head.appendChild(actions);
  container.appendChild(head);

  const file = String(bank?.source?.file || "").trim();
  if (file) container.appendChild(el(doc, "div", "qiaomu-reader-quiz-source", file));

  const list = el(doc, "div", "qiaomu-reader-quiz-list");
  container.appendChild(list);
  const cards = new Map();

  const syncProgress = () => {
    if (judging) {
      const done = judgeProgress?.done ?? 0;
      const total = judgeProgress?.total ?? 0;
      progress.textContent = total ? `AI 判题中 ${done} / ${total}` : "AI 判题中…";
      return;
    }
    const total = bank?.questions?.length || 0;
    const done = answeredCount(bank, attempt);
    progress.textContent = `已答 ${done} / ${total}`;
  };

  const syncCard = (question) => {
    const card = cards.get(question.id);
    if (!card) return;
    const value = answerOf(attempt, question);
    for (const button of card.querySelectorAll("[data-option]")) {
      const label = button.getAttribute("data-option");
      const active = Array.isArray(value) ? value.includes(label) : value === label;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (submitted) {
      const judged = judgements?.[question.id];
      const result = results?.items?.find((item) => item.id === question.id);
      const status = judged?.status || result?.status;
      const badge = card.querySelector(".qiaomu-reader-quiz-badge");
      if (badge && status) {
        badge.textContent = STATUS_TEXT[status] || "";
        badge.className = `qiaomu-reader-quiz-badge is-${status}`;
        if (judged?.source === "ai") badge.textContent = `${badge.textContent}（AI）`;
      }
    }
  };

  for (const [index, question] of (bank?.questions || []).entries()) {
    const card = el(doc, "section", "qiaomu-reader-quiz-card");
    card.setAttribute("data-qid", question.id);

    const top = el(doc, "div", "qiaomu-reader-quiz-card-head");
    top.appendChild(el(doc, "span", "qiaomu-reader-quiz-number", `第 ${index + 1} 题`));
    top.appendChild(el(doc, "span", "qiaomu-reader-quiz-type", TYPE_LABELS[question.type] || "题目"));
    const badge = el(doc, "span", "qiaomu-reader-quiz-badge", "");
    top.appendChild(badge);
    card.appendChild(top);

    const stem = el(doc, "div", "qiaomu-reader-quiz-stem");
    renderText(stem, question.stem || "");
    card.appendChild(stem);

    const answer = answerOf(attempt, question);
    if (question.type === "single_choice" || question.type === "multiple_choice") {
      const options = el(doc, "div", "qiaomu-reader-quiz-options");
      for (const option of question.options || []) {
        const button = el(doc, "button", "qiaomu-reader-quiz-option");
        button.type = "button";
        button.setAttribute("data-option", option.label);
        button.appendChild(el(doc, "span", "qiaomu-reader-quiz-option-label", `${option.label}.`));
        const text = el(doc, "span", "qiaomu-reader-quiz-option-text");
        renderText(text, option.text || "");
        button.appendChild(text);
        const active = Array.isArray(answer) ? answer.includes(option.label) : answer === option.label;
        button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
        button.disabled = submitted;
        button.addEventListener("click", () => {
          if (submitted) return;
          attempt = { ...attempt, answers: { ...(attempt.answers || {}) } };
          const next = applyChoice(attempt, question, option.label);
          if (next === "" || (Array.isArray(next) && !next.length)) delete attempt.answers[question.id];
          else attempt.answers[question.id] = next;
          syncCard(question);
          syncProgress();
          onChange(attempt);
        });
        options.appendChild(button);
      }
      card.appendChild(options);
    } else if (question.type === "true_false") {
      const options = el(doc, "div", "qiaomu-reader-quiz-options");
      for (const [value, text] of [["T", "对"], ["F", "错"]]) {
        const button = el(doc, "button", "qiaomu-reader-quiz-option", text);
        button.type = "button";
        button.setAttribute("data-option", value);
        const active = answer === value;
        button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
        button.disabled = submitted;
        button.addEventListener("click", () => {
          if (submitted) return;
          attempt = { ...attempt, answers: { ...(attempt.answers || {}) } };
          if (attempt.answers[question.id] === value) delete attempt.answers[question.id];
          else attempt.answers[question.id] = value;
          syncCard(question);
          syncProgress();
          onChange(attempt);
        });
        options.appendChild(button);
      }
      card.appendChild(options);
    } else {
      const input = el(doc, "textarea", "qiaomu-reader-quiz-input");
      input.rows = 3;
      input.value = typeof answer === "string" ? answer : "";
      input.placeholder = "在这里作答";
      input.disabled = submitted;
      input.addEventListener("input", () => {
        attempt = { ...attempt, answers: { ...(attempt.answers || {}) } };
        if (input.value.trim()) attempt.answers[question.id] = input.value;
        else delete attempt.answers[question.id];
        syncProgress();
        onChange(attempt);
      });
      card.appendChild(input);
    }

    const judged = judgements?.[question.id];
    if (judged) {
      const box = el(doc, "div", "qiaomu-reader-quiz-analysis");
      if (judged.answer && judged.status !== "correct") {
        box.appendChild(el(doc, "div", "qiaomu-reader-quiz-expected", `参考答案：${judged.answer}`));
      }
      if (judged.analysis) {
        const text = el(doc, "div", "qiaomu-reader-quiz-analysis-text");
        renderText(text, judged.analysis);
        box.appendChild(text);
      }
      if (box.childNodes.length) card.appendChild(box);
    }

    list.appendChild(card);
    cards.set(question.id, card);
    syncCard(question);
  }

  const footer = el(doc, "div", "qiaomu-reader-quiz-footer");
  if (submitted) {
    const summary = el(doc, "div", "qiaomu-reader-quiz-summary");
    const counts = { correct: 0, partial: 0, wrong: 0, unanswered: 0 };
    for (const question of bank?.questions || []) {
      const judged = judgements?.[question.id];
      const result = results?.items?.find((item) => item.id === question.id);
      const status = judged?.status || result?.status;
      if (status && status in counts) counts[status] += 1;
    }
    const parts = [`答对 ${counts.correct}`];
    if (counts.partial) parts.push(`部分正确 ${counts.partial}`);
    parts.push(`答错 ${counts.wrong}`);
    if (counts.unanswered) parts.push(`未答 ${counts.unanswered}`);
    summary.textContent = parts.join(" · ");
    if (judging) summary.textContent = "AI 判题中…";
    if (judgeError) summary.textContent = `${summary.textContent} · ${judgeError}`;
    footer.appendChild(summary);
    if (!judging) {
      const again = el(doc, "button", "mod-cta", "重新作答");
      again.type = "button";
      again.addEventListener("click", () => {
        const next = { ...attempt, answers: {}, judgements: {}, submittedAt: null };
        onChange(next);
        renderQuizPanel(container, { ...options, attempt: next, results: null, judgements: {}, judging: false, judgeError: "" });
      });
      footer.appendChild(again);
    }
  } else {
    const hint = el(doc, "div", "qiaomu-reader-quiz-hint", "");
    footer.appendChild(hint);
    const submit = el(doc, "button", "mod-cta", "提交");
    submit.type = "button";
    let warned = false;
    submit.addEventListener("click", () => {
      const total = bank?.questions?.length || 0;
      const done = answeredCount(bank, attempt);
      if (!warned && done < total) {
        warned = true;
        hint.textContent = `还有 ${total - done} 题没答,再点一次提交`;
        return;
      }
      onSubmit({ ...attempt, submittedAt: new Date().toISOString() });
    });
    footer.appendChild(submit);
  }
  container.appendChild(footer);
  syncProgress();
}
