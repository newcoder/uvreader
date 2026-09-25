// The desktop host renders Markdown itself; AI answers and notes arrive with
// LaTeX ($…$, $$…$$), so formulas need typesetting just like in Obsidian.
import renderMathInElement from "katex/contrib/auto-render";

const DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
];

// Skips code/pre by default; a partial formula mid-stream simply stays as text
// until the closing delimiter arrives.
export function renderMathIn(element) {
  if (!element || typeof renderMathInElement !== "function") return;
  const text = element.textContent || "";
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return;
  try {
    renderMathInElement(element, {
      delimiters: DELIMITERS,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
      throwOnError: false,
      strict: false,
      errorColor: "inherit",
      errorCallback: () => {},
    });
  } catch {
    // A half-typed formula mid-stream must never break the message; the raw
    // text stays readable and the next render picks it up once it is closed.
  }
}
