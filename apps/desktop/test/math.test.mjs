import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { looksLikeMath, mathSegments, renderMathIn } from "../src/renderer/math.js";

function makeElement(html) {
  const { window } = new JSDOM(`<div id="root">${html}</div>`);
  // KaTeX's auto-render creates its fragments through the browser globals.
  globalThis.document ??= window.document;
  globalThis.window ??= window;
  return { window, element: window.document.getElementById("root") };
}

test("inline and display LaTeX become typeset math", () => {
  const { element } = makeElement("<p>前面已证 $\\mathrm{Re}(f,g) \\leq \\frac{1}{2}(|f|^2+|g|^2)$。这是不等式。</p>");
  renderMathIn(element);
  const math = element.querySelector("p .katex math, p math");
  assert.ok(math, "the formula renders as math");
  assert.equal(element.querySelector("p .katex-display"), null, "an inline formula stays inline");

  const display = makeElement("<p>$$|f-g|^2 = |f|^2+|g|^2-2\\mathrm{Re}(f,g) \\geq 0$$</p>");
  renderMathIn(display.element);
  assert.ok(display.element.querySelector(".katex-display math"), "a display formula is centred");
});

test("code blocks keep their dollars and plain text is untouched", () => {
  const { element } = makeElement("<pre><code>const price = $5; // $x$</code></pre><p>no math here</p>");
  renderMathIn(element);
  assert.equal(element.querySelector("math"), null);
  assert.equal(element.querySelector("code").textContent, "const price = $5; // $x$");

  const plain = makeElement("<p>普通文字，没有公式。</p>");
  const before = plain.element.innerHTML;
  renderMathIn(plain.element);
  assert.equal(plain.element.innerHTML, before);
});

test("dollars around prices or prose are not math", () => {
  assert.equal(looksLikeMath("5 到 "), false, "CJK between dollars is a price range");
  assert.equal(looksLikeMath("5 USD"), false);
  assert.equal(looksLikeMath("hello world"), false);
  assert.equal(looksLikeMath("x"), true);
  assert.equal(looksLikeMath("n+1"), true);
  assert.equal(looksLikeMath("\\mathrm{Re}(f,g) \\leq \\frac{1}{2}"), true);
  assert.equal(looksLikeMath("\\text{中文}"), true, "an explicit wrapper may contain CJK");
  assert.equal(looksLikeMath("a $ b"), false);

  const { element } = makeElement("<p>价格 $5 到 $10 之间，其中 $x$ 表示数量。</p>");
  renderMathIn(element);
  assert.equal(element.querySelectorAll("math").length, 1, "only the variable typesets");
  assert.match(element.textContent, /\$5 到 \$10/);
  assert.match(element.textContent, /其中 x+ 表示数量/, "the variable still typesets");
});

test("a broken formula stays readable instead of throwing", () => {
  const { element } = makeElement("<p>未闭合的 $\\frac{1}{2 收尾</p>");
  assert.doesNotThrow(() => renderMathIn(element));
  assert.equal(element.querySelector("math"), null);
  assert.match(element.textContent, /\\frac\{1\}\{2/);
  assert.doesNotThrow(() => renderMathIn(null));
});
