import assert from "node:assert/strict";
import test from "node:test";

import { renderMathInHtml } from "../src/main/html-math.js";

test("content extraction HTML renders inline and display LaTeX as MathML", () => {
  const input = [
    "<!doctype html><html><head><title>$x$</title></head><body>",
    "<p>System $\\mathcal { M } _ { \\mathrm { w o r k } } ^ { t }$ is the working memory.</p>",
    "<p>$$\\frac{a}{b}$$</p>",
    "</body></html>",
  ].join("");
  const html = renderMathInHtml(input);
  assert.match(html, /<title>\$x\$<\/title>/, "the title stays plain text");
  assert.doesNotMatch(html, /\$\\mathcal/);
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, /<math[\s>]/);
  assert.match(html, /<mfrac[\s>]/);
  assert.match(html, /is the working memory/);
});

test("content extraction HTML also renders formula scripts and leaves code alone", () => {
  const input = [
    "<p>before</p>",
    '<script type="math/tex">x^2</script>',
    '<p><code>$not_math$</code> and $$\\frac{1}{2}$$</p>',
    "<pre>$$code$$</pre>",
  ].join("");
  const html = renderMathInHtml(input);
  assert.doesNotMatch(html, /<script type="math\/tex"/);
  assert.match(html, /<msup[\s>]/);
  assert.match(html, /<code>\$not_math\$<\/code>/);
  assert.match(html, /<pre>\$\$code\$\$<\/pre>/);
});

test("plain HTML and currency-like text survive unchanged", () => {
  const input = "<p>It costs $5 and $10 today.</p>";
  assert.equal(renderMathInHtml(input), input);
});
