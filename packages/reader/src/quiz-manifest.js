// Contract for self-contained quiz pages. The HTML owns the paper layout and
// surrounding prose; this manifest owns the structured question state used by
// the browser runtime, the UV Reader host and the wrong-answer store.

export const QUIZ_MANIFEST_SCHEMA = "uvreader.quiz-page/v1";

// Generated manifests keep the model's LaTeX while the page has already been
// rewritten to MathML. Comparing the two as plain text therefore needs to
// spell out the commands that survive as letters (Greek letters and function
// names); layout commands and symbols can simply disappear.
const LATEX_TEXT = Object.freeze({
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc",
  arcsin: "arcsin", arccos: "arccos", arctan: "arctan",
  sinh: "sinh", cosh: "cosh", tanh: "tanh",
  log: "log", ln: "ln", lg: "lg", lim: "lim", max: "max", min: "min",
  exp: "exp", det: "det", gcd: "gcd",
  infty: "∞", in: "∈", notin: "∉", ni: "∋",
  times: "×", cdot: "⋅", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥",
  geq: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼",
  cong: "≅", propto: "∝", angle: "∠", triangle: "△",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
  leftrightarrow: "↔",
  left: "", right: "", frac: "", sqrt: "", mathrm: "", mathbf: "", mathit: "",
  mathbb: "", mathcal: "", mathsf: "", text: "", textrm: "", operatorname: "",
  displaystyle: "", textstyle: "", scriptstyle: "", begin: "", end: "",
  quad: "", qquad: "", hspace: "", vspace: "", overline: "", underline: "",
  vec: "", overrightarrow: "", overleftarrow: "", bar: "", hat: "", widehat: "",
  ldots: "", cdots: "", dots: "", prime: "", circ: "", degree: "",
});

const HTML_ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
});

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

const STEM_EXCLUDED_CLASS = /(?:^|\s)(?:options?|opts?|option|solution|analysis|q-explain|answer)(?:\s|$)/i;

function decodeHtmlEntities(value) {
  return String(value == null ? "" : value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const number = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : full;
    }
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : full;
  });
}

// A manifest may contain a second layer of escaping ("&lt;sub&gt;") because
// the model wrote HTML inside a JSON string. Decode it, then drop tag-like
// fragments so escaped and real markup compare the same.
function plainText(value) {
  return decodeHtmlEntities(decodeHtmlEntities(value).replace(/<[a-zA-Z/][^>]*>/g, ""));
}

function latexText(value) {
  return plainText(value)
    // MathML's mroot text is base then index, while LaTeX puts [index] first.
    .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, "$2$1")
    .replace(/\\([a-zA-Z]+)\s*/g, (full, name) => (
      Object.prototype.hasOwnProperty.call(LATEX_TEXT, name) ? LATEX_TEXT[name] : ""
    ));
}

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

// A plain answer page must not leak the correct answers through its manifest:
// the host grades it with AI after submission. Keep the question structure,
// drop every answer/analysis field even if the model ignored the prompt.
export function plainQuizManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manifest;
  const copy = JSON.parse(JSON.stringify(manifest));
  copy.grading = "ai";
  copy.questions = (Array.isArray(copy.questions) ? copy.questions : []).map((question) => {
    if (!question || typeof question !== "object") return question;
    delete question.answer;
    delete question.analysisHtml;
    delete question.referenceHtml;
    return question;
  });
  return copy;
}

function manifestCompleteness(manifest) {
  const questions = Array.isArray(manifest?.questions) ? manifest.questions : [];
  let score = 0;
  for (const question of questions) {
    if (!question || typeof question !== "object" || Array.isArray(question)) continue;
    if (text(question.id)) score += 1;
    if (text(question.stemHtml) || text(question.stemText)) score += 10;
    if (Array.isArray(question.options) && question.options.length >= 2) score += 4;
    if (text(question.answer)) score += 2;
    if (text(question.analysisHtml)) score += 1;
  }
  return score;
}

export function extractQuizManifest(html) {
  const source = String(html || "");
  const tags = source.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  let fallback = null;
  let best = null;
  let bestScore = -1;
  for (const tag of tags) {
    const open = /^<script\b([^>]*)>/i.exec(tag);
    if (!open) continue;
    const attrs = open[1] || "";
    if (!/\bid\s*=\s*(["'])quiz-manifest\1/i.test(attrs)) continue;
    const inner = tag.replace(/^<script\b[^>]*>/i, "").replace(/<\/script\s*>$/i, "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!Array.isArray(parsed.questions) && parsed.questions && typeof parsed.questions === "object") {
      parsed.questions = Object.values(parsed.questions);
    }
    fallback = parsed;
    const score = manifestCompleteness(parsed);
    // Prefer the most complete manifest anywhere in the page. Models sometimes
    // append a trailing stub after a full head manifest; "last non-empty"
    // would pick the stub and reject an otherwise valid page.
    if (score >= bestScore) {
      best = parsed;
      bestScore = score;
    }
  }
  return best || fallback;
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

function tagAt(html, start) {
  if (html[start] !== "<") return null;
  let quote = "";
  let index = start + 1;
  for (; index < html.length; index += 1) {
    const ch = html[index];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") break;
  }
  if (index >= html.length) return null;
  const raw = html.slice(start + 1, index).trim();
  if (!raw || raw[0] === "!" || raw[0] === "?") {
    return { end: index + 1, name: "", closing: false, selfClosing: true, attrs: "" };
  }
  const closing = raw[0] === "/";
  const body = closing ? raw.slice(1).trimStart() : raw;
  const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(body);
  if (!nameMatch) {
    return { end: index + 1, name: "", closing: false, selfClosing: true, attrs: "" };
  }
  return {
    end: index + 1,
    name: nameMatch[1].toLowerCase(),
    closing,
    selfClosing: /\/\s*$/.test(body),
    attrs: body.slice(nameMatch[0].length),
  };
}

function attrValue(attrs, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${safe}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function hasAttr(attrs, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${safe}(?:\\s*=|\\s|$)`, "i").test(attrs);
}

function elementEnd(html, open) {
  if (open.selfClosing || VOID_TAGS.has(open.name)) return { innerEnd: open.end, end: open.end };
  let depth = 1;
  let index = open.end;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) return null;
    const tag = tagAt(html, next);
    if (!tag) { index = next + 1; continue; }
    if (tag.name === open.name) {
      if (tag.closing) depth -= 1;
      else if (!tag.selfClosing) depth += 1;
      if (depth === 0) return { innerEnd: next, end: tag.end };
    }
    index = tag.end;
  }
  return null;
}

function stripExcludedBlocks(html) {
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) break;
    const tag = tagAt(html, next);
    if (!tag) { index = next + 1; continue; }
    if (!tag.closing && tag.name) {
      const classes = attrValue(tag.attrs, "class");
      const source = attrValue(tag.attrs, "data-source");
      if (STEM_EXCLUDED_CLASS.test(classes) || /(?:^|\s)generated(?:\s|$)/i.test(source)) {
        const end = elementEnd(html, tag);
        if (end) {
          output += html.slice(cursor, next);
          cursor = end.end;
          index = end.end;
          continue;
        }
      }
    }
    index = tag.end;
  }
  output += html.slice(cursor);
  return output;
}

// Host-side counterpart to the browser guard: locate each question's stem
// without a DOM so the task runner can reject a page before writing it.
export function quizStemTexts(html) {
  const source = htmlWithoutManifest(html);
  const lower = source.toLowerCase();
  const stack = [];
  const stems = new Map();
  let index = 0;
  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) break;
    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    const tag = tagAt(source, next);
    if (!tag || !tag.name) { index = next + 1; continue; }
    if (!tag.closing && (tag.name === "script" || tag.name === "style" || tag.name === "textarea" || tag.name === "title")) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      if (close < 0) break;
      const closeEnd = source.indexOf(">", close);
      index = closeEnd < 0 ? source.length : closeEnd + 1;
      continue;
    }
    if (tag.closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === tag.name) { stack.length = i; break; }
      }
      index = tag.end;
      continue;
    }
    let owner = attrValue(tag.attrs, "data-quiz-id");
    if (!owner) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].id) { owner = stack[i].id; break; }
      }
    }
    const classes = attrValue(tag.attrs, "class");
    const isStem = hasAttr(tag.attrs, "data-quiz-stem") || /(?:^|\s)q-stem(?:\s|$)/i.test(classes);
    if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) stack.push({ name: tag.name, id: owner || "" });
    if (isStem && owner && !stems.has(owner)) {
      const end = elementEnd(source, tag);
      if (end) stems.set(owner, plainText(stripExcludedBlocks(source.slice(tag.end, end.innerEnd))));
    }
    index = tag.end;
  }
  return stems;
}

function optionHtmlFor(inner) {
  const match = /<([a-z][\w:-]*)\b[^>]*\bclass\s*=\s*(["'])([^"']*\bopt-text\b[^"']*)\2[^>]*>([\s\S]*?)<\/\1>/i.exec(inner);
  return match ? match[4] : inner;
}

// Recover per-question material from the rendered cards. Models occasionally
// leave a manifest entry empty even though the page itself contains the stem
// and option buttons; filling those fields is safer than discarding a complete
// page or re-running a multi-minute generation.
export function quizQuestionParts(html) {
  const source = htmlWithoutManifest(html);
  const lower = source.toLowerCase();
  const stack = [];
  const parts = new Map();
  const partFor = (id) => {
    if (!parts.has(id)) parts.set(id, { stemHtml: "", stemText: "", options: [], type: "", answer: "" });
    return parts.get(id);
  };
  let index = 0;
  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) break;
    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    const tag = tagAt(source, next);
    if (!tag || !tag.name) { index = next + 1; continue; }
    if (!tag.closing && (tag.name === "script" || tag.name === "style" || tag.name === "textarea" || tag.name === "title")) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      if (close < 0) break;
      const closeEnd = source.indexOf(">", close);
      index = closeEnd < 0 ? source.length : closeEnd + 1;
      continue;
    }
    if (tag.closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === tag.name) { stack.length = i; break; }
      }
      index = tag.end;
      continue;
    }
    let owner = attrValue(tag.attrs, "data-quiz-id");
    if (!owner) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].id) { owner = stack[i].id; break; }
      }
    }
    const classes = attrValue(tag.attrs, "class");
    if (owner) {
      const part = partFor(owner);
      const type = attrValue(tag.attrs, "data-type");
      if (type && QUESTION_TYPES.has(type)) part.type = type;
      const answer = attrValue(tag.attrs, "data-answer");
      if (answer) part.answer = answer;
    }
    const isStem = hasAttr(tag.attrs, "data-quiz-stem") || /(?:^|\s)q-stem(?:\s|$)/i.test(classes);
    if (isStem && owner) {
      const end = elementEnd(source, tag);
      if (end) {
        const inner = stripExcludedBlocks(source.slice(tag.end, end.innerEnd));
        const part = partFor(owner);
        if (!part.stemHtml) part.stemHtml = inner.trim();
        if (!part.stemText) part.stemText = plainText(inner);
      }
    }
    const key = attrValue(tag.attrs, "data-value");
    if (key && owner) {
      const end = elementEnd(source, tag);
      if (end) {
        const inner = source.slice(tag.end, end.innerEnd);
        const content = optionHtmlFor(inner);
        const plain = plainText(content);
        const part = partFor(owner);
        if (plain && !part.options.some((option) => option.key === key)) {
          part.options.push({ key, html: content.trim(), text: plain });
        }
      }
    }
    if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) stack.push({ name: tag.name, id: owner || "" });
    index = tag.end;
  }
  for (const part of parts.values()) {
    if (!part.type) part.type = part.options.length >= 2 ? "choice" : "short";
  }
  return parts;
}

export function repairQuizManifestFromHtml(manifest, html) {
  const parts = quizQuestionParts(html);
  let repaired = 0;
  for (const question of Array.isArray(manifest?.questions) ? manifest.questions : []) {
    const part = parts.get(text(question?.id));
    if (!part) continue;
    const hasStem = text(question.stemHtml) || text(question.stemText);
    if (!hasStem && (part.stemHtml || part.stemText)) {
      if (part.stemHtml) question.stemHtml = part.stemHtml;
      else question.stemText = part.stemText;
      repaired += 1;
    }
    const type = text(question.type);
    if ((type === "choice" || type === "multi")
      && (!Array.isArray(question.options) || question.options.length < 2)
      && part.options.length >= 2) {
      question.options = part.options;
      repaired += 1;
    }
    if (!QUESTION_TYPES.has(type) && part.type) {
      question.type = part.type;
      repaired += 1;
    }
    if (!text(question.answer) && part.answer) {
      question.answer = part.answer;
      repaired += 1;
    }
  }
  return { repaired, questions: parts.size };
}

function normalizedText(value) {
  return plainText(value)
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
  return latexText(value).normalize("NFKC")
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
/* Generated pages often add math[display="block"]{display:block}. That
   replaces the UA's "block math" display, so every <mi>/<mo>/<mn> becomes
   its own block and the equation renders one character per line. Revert the
   display value to restore MathML layout while keeping the page's margin
   and text-align rules. */
math, math[display] { display: revert !important; }
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
    var latexWords = ${JSON.stringify(LATEX_TEXT)};
    var entities = ${JSON.stringify(HTML_ENTITIES)};
    function decode(value) {
      return String(value == null ? '' : value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function(full, code){
        if (code.charAt(0) === '#') {
          var hex = code.charAt(1).toLowerCase() === 'x';
          var number = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
          try { return isFinite(number) ? String.fromCodePoint(number) : full; } catch (error) { return full; }
        }
        var key = code.toLowerCase();
        return Object.prototype.hasOwnProperty.call(entities, key) ? entities[key] : full;
      });
    }
    function plain(value) {
      return decode(decode(value).replace(/<[a-zA-Z\/][^>]*>/g, ''));
    }
    function latex(value) {
      return plain(value)
        .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, '$2$1')
        .replace(/\\([a-zA-Z]+)\s*/g, function(full, name){
          return Object.prototype.hasOwnProperty.call(latexWords, name) ? latexWords[name] : '';
        });
    }
    function norm(value) {
      return plain(value)
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
      return latex(value).normalize('NFKC')
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

export function validateQuizManifest(manifest, { html = "", checkHtml = false, checkContent = false, allowMissingAnswers = false, requireAnswers = true } = {}) {
  const errors = [];
  const warnings = [];
  const contentErrors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"], warnings, contentErrors };
  }
  if (manifest.schema !== QUIZ_MANIFEST_SCHEMA) {
    errors.push(`schema must be ${QUIZ_MANIFEST_SCHEMA}`);
  }
  if (!Array.isArray(manifest.questions) || !manifest.questions.length) {
    errors.push("questions must be a non-empty array");
    return { ok: false, errors, warnings, contentErrors };
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
      // A plain page expects no answers at all, so it should not warn either.
      if (allowMissingAnswers) {
        if (requireAnswers) warnings.push(message);
      } else {
        errors.push(message);
      }
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
    if (checkContent) {
      const stems = quizStemTexts(html);
      for (const question of manifest.questions) {
        const id = text(question?.id);
        const actualText = stems.get(id);
        if (actualText == null) continue;
        const actual = stemNorm(actualText);
        const expected = stemNorm(question.stemHtml || question.stemText || "");
        if (!stemMatches(actual, expected)) {
          contentErrors.push(`question ${id} stem text differs from HTML`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, contentErrors };
}
