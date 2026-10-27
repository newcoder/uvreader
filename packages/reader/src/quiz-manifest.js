// Contract for self-contained quiz pages. The HTML owns the paper layout and
// surrounding prose; this manifest owns the structured question state used by
// the browser runtime, the UV Reader host and the wrong-answer store.

export const QUIZ_MANIFEST_SCHEMA = "uvreader.quiz-page/v1";

const QUESTION_TYPES = new Set([
  "choice",
  "multi",
  "true_false",
  "blank",
  "short",
  "program",
  "coding",
]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

export function quizManifestScript(manifest) {
  const json = JSON.stringify(manifest)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" id="quiz-manifest">${json}</script>`;
}

export function extractQuizManifest(html) {
  const source = String(html || "");
  const tags = source.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  for (const tag of tags) {
    const open = /^<script\b([^>]*)>/i.exec(tag);
    if (!open) continue;
    const attrs = open[1] || "";
    if (!/\bid\s*=\s*(["'])quiz-manifest\1/i.test(attrs)) continue;
    const inner = tag.replace(/^<script\b[^>]*>/i, "").replace(/<\/script\s*>$/i, "").trim();
    try {
      return JSON.parse(inner);
    } catch {
      return null;
    }
  }
  return null;
}

function htmlWithoutManifest(html) {
  return String(html || "").replace(
    /<script\b[^>]*\bid\s*=\s*(["'])quiz-manifest\1[^>]*>[\s\S]*?<\/script\s*>/gi,
    "",
  );
}

export function quizIdCounts(html) {
  const counts = new Map();
  const source = htmlWithoutManifest(html);
  const re = /\bdata-quiz-id\s*=\s*(["'])([^"']+)\1/gi;
  let match;
  while ((match = re.exec(source))) {
    const id = text(match[2]);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function normalizedText(value) {
  return String(value == null ? "" : value)
    .replace(/_{3,}|（\s*）|\(\s*\)/g, "")
    .replace(/[_\^]/g, "")
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (ch) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(ch)))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (ch) => String("⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(ch)))
    .replace(/\s+/g, "")
    .trim();
}

function stemNorm(value) {
  return normalizedText(value)
    .replace(/^\d{1,4}[.、．)）]/, "")
    .replace(/[（(]?[A-H]{1,8}[）)]?$/, "");
}

function looseText(value) {
  return normalizedText(value).normalize("NFKC")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function sameText(actual, expected) {
  if (actual === expected || actual.includes(expected) || expected.includes(actual)) return true;
  const a = looseText(actual);
  const b = looseText(expected);
  return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
}

function textSimilarity(actual, expected) {
  if (actual === expected) return 1;
  if (!actual || !expected) return 0;
  const grams = (value) => {
    const set = new Set();
    for (let index = 0; index + 1 < value.length; index += 1) set.add(value.slice(index, index + 2));
    return set;
  };
  const left = grams(actual);
  const right = grams(expected);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function stemMatches(actual, expected) {
  if (sameText(actual, expected)) return true;
  const min = Math.min(actual.length, expected.length);
  if (min < 12) return textSimilarity(actual, expected) >= 0.7;
  let prefix = 0;
  while (prefix < min && actual[prefix] === expected[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < min && actual[actual.length - 1 - suffix] === expected[expected.length - 1 - suffix]) suffix += 1;
  if (prefix / min >= 0.85 || suffix / min >= 0.85) return true;
  // AI pages often differ in whitespace, numbering, table wording or a
  // duplicated shared stem. Require substantial overlap, not exact text.
  if (textSimilarity(looseText(actual), looseText(expected)) >= 0.9) return true;
  return textSimilarity(actual, expected) >= 0.62;
}

// Keep the answer card beside the paper on desktop. Some generated pages hide
// the aside below 1100px and leave only the paper, which reads as a bottom or
// missing navigation bar in the reader's narrower iframe.
export function quizLayoutStyle() {
  return `<style data-qbr-quiz-layout>
@media (min-width: 700px) {
  .layout { display: grid !important; grid-template-columns: minmax(0, 1fr) 290px !important; align-items: start !important; }
  .layout > main, .layout > #paper { min-width: 0 !important; }
  .layout > aside, .layout > aside#answer-sheet, .layout > aside#answerCard,
  .layout > .answer-sheet, .layout > .answer-card {
    display: block !important; grid-column: 2 !important; position: sticky !important;
    top: 76px !important; max-height: calc(100vh - 96px) !important; overflow: auto !important;
  }
}
</style>`;
}

// Content-level check for hosts that already have a parsed browser document.
// Structural validation (without a DOM) happens in validateQuizManifest.
export function quizManifestGuardScript() {
  return String.raw`<script data-quiz-manifest-guard>(function(){
    var source = document.getElementById('quiz-manifest');
    if (!source) return;
    var manifest;
    try { manifest = JSON.parse(source.textContent || ''); }
    catch (error) { manifest = null; }
    function norm(value) {
      return String(value == null ? '' : value)
        .replace(/_{3,}|（\s*）|\(\s*\)/g, '')
        .replace(/[_\^]/g, '')
        .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, function(ch){ return String('₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)); })
        .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, function(ch){ return String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(ch)); })
        .replace(/\s+/g, '')
        .trim();
    }
    function htmlText(html) {
      var template = document.createElement('template');
      template.innerHTML = String(html || '');
      return template.content ? template.content.textContent : template.textContent;
    }
    function stemText(node) {
      var clone = node.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('.options,.opts,.option,[data-quiz-options],.solution,.analysis,.q-explain,.answer,[data-source="generated"]'), function(item){ item.remove(); });
      return clone.textContent;
    }
    function stemNorm(value) {
      return norm(value)
        .replace(/^\d{1,4}[.、．)）]/, '')
        .replace(/[（(]?[A-H]{1,8}[）)]?$/, '');
    }
    // MathML text and the model's LaTeX/plain-text manifest use different
    // punctuation for the same value ("1/2" vs "12", "E1/h" vs "E1h").
    function loose(value) {
      return norm(value).normalize('NFKC')
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
    }
    function sameText(actual, expected) {
      if (actual === expected || actual.indexOf(expected) >= 0 || expected.indexOf(actual) >= 0) return true;
      var a = loose(actual);
      var b = loose(expected);
      return Boolean(a && b) && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
    }
    function similarity(actual, expected) {
      if (actual === expected) return 1;
      if (!actual || !expected) return 0;
      function grams(value) {
        var set = new Set();
        for (var i = 0; i + 1 < value.length; i += 1) set.add(value.slice(i, i + 2));
        return set;
      }
      var left = grams(actual), right = grams(expected);
      if (!left.size || !right.size) return 0;
      var common = 0;
      left.forEach(function(gram){ if (right.has(gram)) common += 1; });
      return (2 * common) / (left.size + right.size);
    }
    function stemMatches(actual, expected) {
      if (sameText(actual, expected)) return true;
      var min = Math.min(actual.length, expected.length);
      if (min < 12) return similarity(actual, expected) >= 0.7;
      var prefix = 0;
      while (prefix < min && actual[prefix] === expected[prefix]) prefix += 1;
      var suffix = 0;
      while (suffix < min && actual[actual.length - 1 - suffix] === expected[expected.length - 1 - suffix]) suffix += 1;
      if (prefix / min >= 0.85 || suffix / min >= 0.85) return true;
      if (similarity(loose(actual), loose(expected)) >= 0.9) return true;
      return similarity(actual, expected) >= 0.62;
    }
    function fail(errors) {
      var box = document.createElement('div');
      box.setAttribute('data-quiz-manifest-error', '');
      box.style.cssText = 'position:fixed;left:50%;top:12px;z-index:99999;max-width:min(680px,calc(100vw - 32px));transform:translateX(-50%);padding:10px 14px;border:1px solid #bf3b2b;border-radius:8px;background:#fff4f3;color:#8b1e1e;font:13px/1.5 sans-serif;box-shadow:0 8px 24px rgb(0 0 0 / .16)';
      box.textContent = '答题页数据提示：' + errors.slice(0, 3).join('；');
      document.body.appendChild(box);
    }
    if (!manifest || !Array.isArray(manifest.questions)) {
      fail(['quiz-manifest 无法读取']);
      return;
    }
    var errors = [];
    manifest.questions.forEach(function(question){
      var id = String(question.id || '');
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-quiz-id]')).filter(function(node){
        return node.getAttribute('data-quiz-id') === id;
      });
      var card = nodes.filter(function(node){
        return node.classList.contains('q-card') || node.querySelector('[data-quiz-stem],.q-stem');
      })[0] || nodes[0];
      if (!card) { errors.push('题目 ' + id + ' 缺少 HTML 卡片'); return; }
      var stem = card.querySelector('[data-quiz-stem],.q-stem');
      var expectedStem = stemNorm(htmlText(question.stemHtml || question.stemText));
      var actualStem = stem ? stemNorm(stemText(stem)) : '';
      if (stem && !stemMatches(actualStem, expectedStem)) {
        errors.push('题目 ' + id + ' 题干不一致');
      }
      (question.options || []).forEach(function(option){
        var key = String(option.key || '');
        var control = nodes.filter(function(node){ return node.getAttribute('data-value') === key; })[0];
        if (!control) { errors.push('题目 ' + id + ' 选项 ' + key + ' 缺失'); return; }
        var actual = norm(control.querySelector('.opt-text') ? control.querySelector('.opt-text').textContent : control.textContent);
        var expected = norm(htmlText(option.html));
        if (!sameText(actual, expected)) {
          errors.push('题目 ' + id + ' 选项 ' + key + ' 不一致');
        }
      });
      if (question.answer && card.hasAttribute('data-answer')) {
        if (norm(card.getAttribute('data-answer')).toUpperCase() !== norm(question.answer).toUpperCase()) {
          errors.push('题目 ' + id + ' 答案不一致');
        }
      }
    });
    window.__QBR_QUIZ_MANIFEST_CHECK__ = { ok: errors.length === 0, errors: errors };
    if (errors.length) fail(errors);
  })();</script>`;
}

export function validateQuizManifestContent(manifest, document) {
  const errors = [];
  if (!document?.querySelectorAll) return { ok: false, errors: ["a parsed document is required"] };
  if (!manifest?.questions?.length) return { ok: false, errors: ["manifest has no questions"] };
  const htmlText = (html) => {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    return template.content?.textContent || template.textContent || "";
  };
  const loose = (value) => normalizedText(value).normalize("NFKC")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const sameText = (actual, expected) => {
    if (actual === expected || actual.includes(expected) || expected.includes(actual)) return true;
    const a = loose(actual);
    const b = loose(expected);
    return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
  };
  for (const question of manifest.questions) {
    const id = text(question.id);
    const nodes = [...document.querySelectorAll("[data-quiz-id]")].filter((node) => node.getAttribute("data-quiz-id") === id);
    const card = nodes.find((node) => node.matches(".q-card") || node.querySelector("[data-quiz-stem],.q-stem")) || nodes[0];
    if (!card) {
      errors.push(`question ${id} has no HTML card`);
      continue;
    }
    const stem = card.querySelector("[data-quiz-stem],.q-stem");
    if (stem) {
      const clone = stem.cloneNode(true);
      clone.querySelectorAll(".options,.opts,.option,[data-quiz-options],.solution,.analysis,.q-explain,.answer,[data-source=\"generated\"]").forEach((item) => item.remove());
      const actual = stemNorm(clone.textContent);
      const expected = stemNorm(htmlText(question.stemHtml || question.stemText));
      if (!stemMatches(actual, expected)) {
        errors.push(`question ${id} stem text differs from HTML`);
      }
    }
    for (const option of question.options || []) {
      const key = text(option.key);
      const control = nodes.find((node) => node.getAttribute("data-value") === key);
      if (!control) {
        errors.push(`question ${id} option ${key} is missing from HTML`);
        continue;
      }
      const actual = normalizedText(control.querySelector(".opt-text")?.textContent || control.textContent);
      const expected = normalizedText(htmlText(option.html));
      if (!sameText(actual, expected)) {
        errors.push(`question ${id} option ${key} text differs from HTML`);
      }
    }
    if (question.answer && card.hasAttribute("data-answer")) {
      const actual = normalizedText(card.getAttribute("data-answer")).toUpperCase();
      const expected = normalizedText(question.answer).toUpperCase();
      if (actual !== expected) errors.push(`question ${id} answer differs from HTML`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateQuizManifest(manifest, { html = "", checkHtml = false, allowMissingAnswers = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (manifest.schema !== QUIZ_MANIFEST_SCHEMA) {
    errors.push(`schema must be ${QUIZ_MANIFEST_SCHEMA}`);
  }
  if (!Array.isArray(manifest.questions) || !manifest.questions.length) {
    errors.push("questions must be a non-empty array");
    return { ok: false, errors };
  }
  const ids = new Set();
  for (const [index, question] of manifest.questions.entries()) {
    if (!question || typeof question !== "object") {
      errors.push(`question ${index + 1} must be an object`);
      continue;
    }
    const id = text(question.id);
    if (!id) errors.push(`question ${index + 1} has no id`);
    else if (ids.has(id)) errors.push(`duplicate question id: ${id}`);
    else ids.add(id);
    const type = text(question.type);
    if (!QUESTION_TYPES.has(type)) errors.push(`question ${id || index + 1} has invalid type: ${type || "(empty)"}`);
    if (!text(question.stemHtml) && !text(question.stemText)) {
      errors.push(`question ${id || index + 1} has no stem`);
    }
    if ((type === "choice" || type === "multi") && (!Array.isArray(question.options) || question.options.length < 2)) {
      errors.push(`question ${id || index + 1} needs at least two options`);
    }
    if (type !== "short" && type !== "program" && type !== "coding" && !text(question.answer)) {
      const message = `question ${id || index + 1} needs an answer`;
      // An AI-generated paper can still be useful when the model failed to
      // supply one answer for an objective question: the runtime marks that
      // question as ungraded instead of discarding a 1–3 minute task.
      if (allowMissingAnswers) warnings.push(message);
      else errors.push(message);
    }
  }
  if (checkHtml && html) {
    const counts = quizIdCounts(html);
    for (const id of ids) {
      if (!counts.has(id)) errors.push(`question ${id} is missing from HTML`);
    }
    for (const id of counts.keys()) {
      if (!ids.has(id)) errors.push(`HTML contains an unknown question id: ${id}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
