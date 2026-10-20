// 答题页(停靠侧栏):只吃 `bankForAnswering()` 的白名单视图。
//
// Layout follows docs/quiz template: paper head, answer-card grid, question
// cards with option rows, and a result panel after submitting. Rendering is
// plain DOM so it works in Obsidian and the desktop shell alike; Markdown
// (stems with formulas/images) goes through the injected `renderText` hook.
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

const TYPE_ORDER = ["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "program", "calculation", "proof", "unknown"];

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

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function statusOf(question, { results, judgements, submitted, attempt }) {
  if (!submitted) return isAnswered(attempt, question) ? "done" : "";
  const judged = judgements?.[question.id];
  const result = results?.items?.find((item) => item.id === question.id);
  return judged?.status || result?.status || "";
}

function mapClass(status) {
  if (status === "correct") return "is-correct";
  if (status === "partial") return "is-partial";
  if (status === "wrong") return "is-wrong";
  if (status === "unanswered") return "is-skip";
  if (status === "done") return "is-done";
  return "";
}

// 题库里的图片链接是相对**源文件**的(`<源名>.assets/…`):答题页要把它们换成
// 宿主能直接加载的地址(桌面壳读成 data URL,Obsidian 用 vault 资源路径)。
export async function hydrateQuizImages(bank, resolve) {
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const cache = new Map();
  const rewrite = async (text) => {
    const value = String(text || "");
    const sources = [...value.matchAll(pattern)].map((match) => match[2]);
    if (!sources.length) return value;
    let out = value;
    for (const src of sources) {
      if (/^(?:data:|https?:|file:|app:|\/\/)/i.test(src)) continue;
      if (!cache.has(src)) cache.set(src, await Promise.resolve(resolve(src)).catch(() => ""));
      const resolved = cache.get(src);
      if (resolved) out = out.split(`](${src})`).join(`](${resolved})`);
    }
    return out;
  };
  const questions = [];
  for (const question of bank?.questions || []) {
    const next = { ...question, stem: await rewrite(question.stem) };
    if (Array.isArray(question.options)) {
      next.options = await Promise.all(question.options.map(async (option) => ({ ...option, text: await rewrite(option.text) })));
    }
    questions.push(next);
  }
  return { ...bank, questions };
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
  container.classList.add("qiaomu-reader-quiz-root");

  const questions = bank?.questions || [];
  const total = questions.length;
  const done = answeredCount(bank, attempt);

  // ---- 顶部 ----
  const head = el(doc, "div", "qiaomu-reader-quiz-head");
  const headText = el(doc, "div", "qiaomu-reader-quiz-headtext");
  headText.appendChild(el(doc, "div", "qiaomu-reader-quiz-kicker", "在线答题"));
  headText.appendChild(el(doc, "div", "qiaomu-reader-quiz-title", String(bank?.source?.file || "试卷")));
  head.appendChild(headText);
  const actions = el(doc, "div", "qiaomu-reader-quiz-head-actions");
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

  const meta = el(doc, "div", "qiaomu-reader-quiz-meta");
  const typeCount = {};
  for (const question of questions) typeCount[question.type] = (typeCount[question.type] || 0) + 1;
  meta.textContent = [
    `${total} 题`,
    ...TYPE_ORDER.filter((type) => typeCount[type]).map((type) => `${TYPE_LABELS[type]} ${typeCount[type]}`),
  ].join(" · ");
  container.appendChild(meta);

  // ---- 结果面板 ----
  const counts = { correct: 0, partial: 0, wrong: 0, unanswered: 0, pending: 0 };
  for (const question of questions) {
    const status = submitted ? statusOf(question, { results, judgements, submitted, attempt }) : "";
    if (status in counts) counts[status] += 1;
    else if (status === "ungraded" || status === "unavailable") counts.pending += 1;
  }
  if (submitted) {
    const graded = counts.correct + counts.partial + counts.wrong;
    const percent = graded ? Math.round(((counts.correct + counts.partial * 0.5) / graded) * 100) : 0;
    const panel = el(doc, "section", "qiaomu-reader-quiz-result");
    const ring = el(doc, "div", "qiaomu-reader-quiz-ring");
    ring.style.setProperty("--p", String(percent));
    const inner = el(doc, "div", "qiaomu-reader-quiz-ring-inner");
    inner.appendChild(el(doc, "b", "", String(percent)));
    inner.appendChild(el(doc, "span", "", "分"));
    ring.appendChild(inner);
    panel.appendChild(ring);
    const stats = el(doc, "div", "qiaomu-reader-quiz-stats");
    const stat = (label, value, cls) => {
      const box = el(doc, "div", `qiaomu-reader-quiz-stat ${cls || ""}`);
      box.appendChild(el(doc, "b", "", String(value)));
      box.appendChild(el(doc, "span", "", label));
      stats.appendChild(box);
    };
    stat("答对", counts.correct, "is-ok");
    stat("答错", counts.wrong + counts.unanswered, "is-bad");
    stat("部分正确", counts.partial);
    stat("正确率", graded ? `${percent}%` : "—");
    const elapsed = attempt.startedAt && attempt.submittedAt
      ? Date.parse(attempt.submittedAt) - Date.parse(attempt.startedAt)
      : 0;
    stat("用时", elapsed > 0 ? formatDuration(elapsed) : "—");
    panel.appendChild(stats);
    container.appendChild(panel);
  }

  // ---- 答题卡 ----
  const cardmap = el(doc, "section", "qiaomu-reader-quiz-cardmap");
  const mapTop = el(doc, "div", "qiaomu-reader-quiz-cardmap-head");
  mapTop.appendChild(el(doc, "h3", "", "答题卡"));
  mapTop.appendChild(el(doc, "span", "qiaomu-reader-quiz-cardmap-count", `${done} / ${total} 已作答`));
  cardmap.appendChild(mapTop);
  const bar = el(doc, "div", "qiaomu-reader-quiz-bar");
  const fill = el(doc, "i", "");
  fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  bar.appendChild(fill);
  cardmap.appendChild(bar);

  const mapButtons = new Map();
  const groups = new Map();
  for (const [index, question] of questions.entries()) {
    const type = TYPE_LABELS[question.type] ? question.type : "unknown";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ question, index });
  }
  for (const type of TYPE_ORDER) {
    const entries = groups.get(type);
    if (!entries?.length) continue;
    const group = el(doc, "div", "qiaomu-reader-quiz-mapgroup");
    group.appendChild(el(doc, "div", "qiaomu-reader-quiz-mapgroup-title", TYPE_LABELS[type]));
    const grid = el(doc, "div", "qiaomu-reader-quiz-grid");
    for (const { question, index } of entries) {
      const button = el(doc, "button", "qiaomu-reader-quiz-mapbtn", String(index + 1));
      button.type = "button";
      button.setAttribute("data-map", question.id);
      button.addEventListener("click", () => {
        const card = container.querySelector(`[data-qid="${question.id}"]`);
        card?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
      grid.appendChild(button);
      mapButtons.set(question.id, button);
    }
    group.appendChild(grid);
    cardmap.appendChild(group);
  }
  const legend = el(doc, "div", "qiaomu-reader-quiz-legend");
  for (const [cls, label] of [["is-done", "已作答"], ["is-correct", "答对"], ["is-wrong", "答错"], ["is-skip", "未答"]]) {
    const item = el(doc, "span", "");
    item.appendChild(el(doc, "i", cls));
    item.appendChild(el(doc, "span", "", label));
    legend.appendChild(item);
  }
  cardmap.appendChild(legend);
  container.appendChild(cardmap);

  const list = el(doc, "div", "qiaomu-reader-quiz-list");
  container.appendChild(list);
  const cards = new Map();

  const syncMap = (question) => {
    const button = mapButtons.get(question.id);
    if (!button) return;
    const status = submitted
      ? statusOf(question, { results, judgements, submitted, attempt })
      : (isAnswered(attempt, question) ? "done" : "");
    button.className = `qiaomu-reader-quiz-mapbtn ${mapClass(status)}`.trim();
  };

  const syncProgress = () => {
    if (judging) {
      const shown = judgeProgress?.done ?? 0;
      const all = judgeProgress?.total ?? 0;
      progress.textContent = all ? `AI 判题中 ${shown} / ${all}` : "AI 判题中…";
      return;
    }
    if (!submitted) {
      progress.textContent = `已答 ${answeredCount(bank, attempt)} / ${total}`;
      return;
    }
    const graded = counts.correct + counts.partial + counts.wrong;
    progress.textContent = graded ? `正确率 ${graded ? Math.round(((counts.correct + counts.partial * 0.5) / graded) * 100) : 0}%` : "已交卷";
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
      card.classList.toggle("is-correct", status === "correct");
      card.classList.toggle("is-wrong", status === "wrong" || status === "partial");
    }
    syncMap(question);
  };

  for (const [index, question] of questions.entries()) {
    const card = el(doc, "section", "qiaomu-reader-quiz-card");
    card.setAttribute("data-qid", question.id);

    const top = el(doc, "div", "qiaomu-reader-quiz-card-head");
    top.appendChild(el(doc, "span", "qiaomu-reader-quiz-number", String(index + 1)));
    top.appendChild(el(doc, "span", "qiaomu-reader-quiz-type", TYPE_LABELS[question.type] || "题目"));
    const badge = el(doc, "span", "qiaomu-reader-quiz-badge", "");
    top.appendChild(badge);
    card.appendChild(top);

    const stem = el(doc, "div", "qiaomu-reader-quiz-stem");
    renderText(stem, question.stem || "");
    card.appendChild(stem);

    const answer = answerOf(attempt, question);
    if (question.type === "single_choice" || question.type === "multiple_choice") {
      if (!(question.options || []).length) {
        card.appendChild(el(doc, "div", "qiaomu-reader-quiz-note", "这道题没有提取到选项，可在原始试卷里核对。"));
      } else {
        const optWrap = el(doc, "div", "qiaomu-reader-quiz-options");
        for (const option of question.options || []) {
          const button = el(doc, "button", "qiaomu-reader-quiz-option");
          button.type = "button";
          button.setAttribute("data-option", option.label);
          button.appendChild(el(doc, "span", "qiaomu-reader-quiz-option-label", option.label));
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
          optWrap.appendChild(button);
        }
        card.appendChild(optWrap);
      }
    } else if (question.type === "true_false") {
      const optWrap = el(doc, "div", "qiaomu-reader-quiz-options is-truefalse");
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
        optWrap.appendChild(button);
      }
      card.appendChild(optWrap);
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

  // ---- 底部 ----
  const footer = el(doc, "div", "qiaomu-reader-quiz-footer");
  if (submitted) {
    const summary = el(doc, "div", "qiaomu-reader-quiz-summary");
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
      const answered = answeredCount(bank, attempt);
      if (!warned && answered < total) {
        warned = true;
        hint.textContent = `还有 ${total - answered} 题没答,再点一次提交`;
        return;
      }
      onSubmit({ ...attempt, submittedAt: new Date().toISOString() });
    });
    footer.appendChild(submit);
  }
  container.appendChild(footer);
  syncProgress();
}
