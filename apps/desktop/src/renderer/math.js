// The desktop host renders Markdown itself; AI answers and notes arrive with
// LaTeX ($…$, $$…$$), so formulas need typesetting just like in Obsidian.
//
// A hand-rolled scanner instead of KaTeX's auto-render: dollars around prices
// or CJK prose must stay text ("价格 $5 到 $10"), which auto-render cannot
// express. Code, existing math and embedded tags are never touched.
import katex from "katex";

const SKIP_SELECTOR = "pre, code, script, noscript, style, textarea, option, math, .katex";
const MATH_PATTERN = /\$\$([\s\S]{1,2000}?)\$\$|\\\[([\s\S]{1,2000}?)\\\]|\\\(([\s\S]{1,500}?)\\\)|\$([^$\n]{1,300}?)\$/g;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATEX = /\\[a-zA-Z]+|[\^_{}=<>+\-*/]/;

export function looksLikeMath(tex) {
  const value = String(tex ?? "").trim();
  if (!value || value.length > 300 || value.includes("$")) return false;
  const cjk = CJK.test(value);
  const latex = LATEX.test(value);
  // CJK is only allowed inside an explicit wrapper the model wrote.
  if (cjk && !/\\[a-zA-Z]*(?:text|mathrm|operatorname)/.test(value)) return false;
  if (latex) return true;
  // A bare formula is a single symbol ("$x$", "$n$"), not a word or a price.
  return /^[a-zA-Z]$/.test(value);
}

export function mathSegments(text) {
  const segments = [];
  MATH_PATTERN.lastIndex = 0;
  let match;
  while ((match = MATH_PATTERN.exec(String(text ?? "")))) {
    const display = match[1] ?? match[2];
    const inline = match[3] ?? match[4];
    const tex = display ?? inline;
    if (tex === undefined) continue;
    const isDisplay = display !== undefined;
    if (!isDisplay && !looksLikeMath(tex)) continue;
    segments.push({ index: match.index, raw: match[0], tex, display: isDisplay });
  }
  return segments;
}

export function renderMathIn(element) {
  if (!element?.ownerDocument) return;
  const text = element.textContent || "";
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return;
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, 4);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest(SKIP_SELECTOR)) continue;
    const source = node.nodeValue || "";
    const segments = mathSegments(source);
    if (!segments.length) continue;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const segment of segments) {
      if (segment.index > cursor) fragment.append(source.slice(cursor, segment.index));
      const span = doc.createElement("span");
      try {
        katex.render(segment.tex, span, {
          displayMode: segment.display,
          throwOnError: false,
          strict: false,
          errorColor: "inherit",
        });
        fragment.append(span);
      } catch {
        // A half-typed formula mid-stream stays readable and is retried on the
        // next render once its closing delimiter arrives.
        fragment.append(segment.raw);
      }
      cursor = segment.index + segment.raw.length;
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    node.replaceWith(fragment);
  }
}
