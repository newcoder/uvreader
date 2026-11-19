import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { extractQuizManifest, plainQuizManifest, quizLayoutStyle, quizManifestGuardScript, quizManifestScript, validateQuizManifest, validateQuizManifestContent } from "../packages/reader/src/quiz-manifest.js";

const manifest = {
  schema: "uvreader.quiz-page/v1",
  paperId: "paper-1",
  title: "Demo",
  questions: [{
    id: "q1",
    number: "1",
    type: "choice",
    stemHtml: "<p>1+1=?</p>",
    options: [{ key: "A", html: "1" }, { key: "B", html: "2" }],
    answer: "B",
    analysisHtml: "<p>1+1=2</p>",
  }],
};

test("quiz manifests round-trip through an HTML script and validate against data ids", () => {
  const html = `<html><head>${quizManifestScript(manifest)}</head><body>
    <section class="q-card" data-quiz-id="q1">
      <button data-quiz-id="q1" data-value="A">A</button>
      <button data-quiz-id="q1" data-value="B">B</button>
    </section></body></html>`;
  const parsed = extractQuizManifest(html);
  assert.deepEqual(parsed, manifest);
  assert.equal(validateQuizManifest(parsed, { html, checkHtml: true }).ok, true);
});

test("quiz manifest validation rejects duplicate ids, missing answers and missing HTML cards", () => {
  const bad = {
    ...manifest,
    questions: [
      manifest.questions[0],
      { ...manifest.questions[0], answer: "" },
    ],
  };
  const result = validateQuizManifest(bad, { html: "<main></main>", checkHtml: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate question id")));
  assert.ok(result.errors.some((error) => error.includes("needs an answer")));
  assert.ok(result.errors.some((error) => error.includes("missing from HTML")));
});

test("AI-generated pages can keep an objective question without an answer as ungraded", () => {
  const noAnswer = {
    ...manifest,
    questions: [{ ...manifest.questions[0], answer: "" }],
  };
  const result = validateQuizManifest(noAnswer, { allowMissingAnswers: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes("needs an answer")));
});

test("the browser guard accepts matching content and rejects a stem mismatch", () => {
  const page = (manifestText, stem = "1+1=?") => `<html><head>${quizManifestScript(manifestText)}</head><body>
    <section class="q-card" data-quiz-id="q1">
      <div data-quiz-stem>${stem}</div>
      <button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button>
      <button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button>
    </section>
    <button id="submit">交卷</button>
    ${quizManifestGuardScript()}
  </body></html>`;
  const good = new JSDOM(page(manifest), { runScripts: "dangerously" });
  assert.equal(good.window.__QBR_QUIZ_MANIFEST_CHECK__.ok, true);
  assert.equal(good.window.document.querySelector("[data-quiz-manifest-error]"), null);
  good.window.close();

  const bad = new JSDOM(page(manifest, "完全不同的题干"), { runScripts: "dangerously" });
  assert.equal(bad.window.__QBR_QUIZ_MANIFEST_CHECK__.ok, false);
  assert.ok(bad.window.document.querySelector("[data-quiz-manifest-error]"));
  assert.equal(bad.window.document.getElementById("submit").disabled, false, "content warnings do not block the quiz");
  bad.window.close();
});

test("the browser guard treats a plain fraction manifest as equal to rendered MathML", () => {
  const fractionManifest = {
    ...manifest,
    questions: [{
      ...manifest.questions[0],
      options: [
        { key: "A", html: "1/2" },
        { key: "B", html: "1/4" },
      ],
    }],
  };
  const page = `<html><head>${quizManifestScript(fractionManifest)}</head><body>
    <section class="q-card" data-quiz-id="q1">
      <div data-quiz-stem>1+1=?</div>
      <button data-quiz-id="q1" data-value="A"><span class="opt-text"><math><mfrac><mn>1</mn><mn>2</mn></mfrac></math></span></button>
      <button data-quiz-id="q1" data-value="B"><span class="opt-text"><math><mfrac><mn>1</mn><mn>4</mn></mfrac></math></span></button>
    </section>
    ${quizManifestGuardScript()}
  </body></html>`;
  const dom = new JSDOM(page, { runScripts: "dangerously" });
  assert.equal(dom.window.__QBR_QUIZ_MANIFEST_CHECK__.ok, true);
  assert.equal(dom.window.document.querySelector("[data-quiz-manifest-error]"), null);
  dom.window.close();
});

test("the browser guard treats LaTeX manifests and rendered MathML as the same stem", () => {
  const latexManifest = {
    ...manifest,
    questions: [
      {
        id: "q5",
        number: "5",
        type: "choice",
        stemHtml: "已知 {a&lt;sub&gt;n&lt;/sub&gt;} 是公差不为零的等差数列, $a_1=-2$，若 $a_3,a_4,a_6$ 成等比数列,则 $a_{10}=$ ( )",
        options: [{ key: "A", html: "-20" }, { key: "B", html: "-18" }],
        answer: "A",
      },
      {
        id: "q8",
        number: "8",
        type: "choice",
        stemHtml: "设函数 $f\\left(x\\right)=\\sin\\omega x+\\cos\\omega x$ (ω &gt; 0), 若 $f\\left(x+\\pi\\right)=f\\left(x\\right)$ 恒成立, 且f (x) 在 $\\left[0,\\frac{\\pi}{4}\\right]$ 上存在零点, 则ω 的最小值为 ( )",
        options: [{ key: "A", html: "8" }, { key: "B", html: "6" }],
        answer: "A",
      },
      {
        id: "q13",
        number: "13",
        type: "blank",
        stemHtml: "已知 α, β ∈ [0, 2π], 且 $\\sin(\\alpha+\\beta)=\\sin(\\alpha-\\beta),\\cos(\\alpha+\\beta)\\neq\\cos(\\alpha-\\beta)$，写出满足条件的一组 $\\alpha,\\beta$ 的值：α =，β =",
        answer: "α=0, β=π",
      },
    ],
  };
  const page = `<html><head>${quizManifestScript(latexManifest)}</head><body>
    <section class="q-card" data-quiz-id="q5">
      <div data-quiz-stem>已知 {a<sub>n</sub>} 是公差不为零的等差数列, <math><msub><mi>a</mi><mn>1</mn></msub><mo>=</mo><mo>−</mo><mn>2</mn></math>，若 <math><msub><mi>a</mi><mn>3</mn></msub><mo>,</mo><msub><mi>a</mi><mn>4</mn></msub><mo>,</mo><msub><mi>a</mi><mn>6</mn></msub></math> 成等比数列,则 <math><msub><mi>a</mi><mn>10</mn></msub><mo>=</mo></math> ( )</div>
      <button data-quiz-id="q5" data-value="A"><span class="opt-text">-20</span></button>
      <button data-quiz-id="q5" data-value="B"><span class="opt-text">-18</span></button>
    </section>
    <section class="q-card" data-quiz-id="q8">
      <div data-quiz-stem>设函数 <math><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo><mi>sin</mi><mi>ω</mi><mi>x</mi><mo>+</mo><mi>cos</mi><mi>ω</mi><mi>x</mi></math> (ω &gt; 0), 若 <math><mi>f</mi><mo>(</mo><mi>x</mi><mo>+</mo><mi>π</mi><mo>)</mo><mo>=</mo><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo></math> 恒成立, 且f (x) 在 <math><mo>[</mo><mn>0</mn><mo>,</mo><mfrac><mi>π</mi><mn>4</mn></mfrac><mo>]</mo></math> 上存在零点, 则ω 的最小值为 ( )</div>
      <button data-quiz-id="q8" data-value="A"><span class="opt-text">8</span></button>
      <button data-quiz-id="q8" data-value="B"><span class="opt-text">6</span></button>
    </section>
    <section class="q-card" data-quiz-id="q13">
      <div data-quiz-stem>已知 α, β ∈ [0, 2π], 且 <math><mi>sin</mi><mo>(</mo><mi>α</mi><mo>+</mo><mi>β</mi><mo>)</mo><mo>=</mo><mi>sin</mi><mo>(</mo><mi>α</mi><mo>−</mo><mi>β</mi><mo>)</mo><mo>,</mo><mi>cos</mi><mo>(</mo><mi>α</mi><mo>+</mo><mi>β</mi><mo>)</mo><mo>≠</mo><mi>cos</mi><mo>(</mo><mi>α</mi><mo>−</mo><mi>β</mi><mo>)</mo></math>，写出满足条件的一组 <math><mi>α</mi><mo>,</mo><mi>β</mi></math> 的值：α =，β =</div>
    </section>
    ${quizManifestGuardScript()}
  </body></html>`;
  const dom = new JSDOM(page, { runScripts: "dangerously" });
  assert.equal(dom.window.__QBR_QUIZ_MANIFEST_CHECK__.ok, true);
  assert.deepEqual(Array.from(dom.window.__QBR_QUIZ_MANIFEST_CHECK__.errors), []);
  assert.equal(dom.window.document.querySelector("[data-quiz-manifest-error]"), null);
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    assert.deepEqual(validateQuizManifestContent(latexManifest, dom.window.document), { ok: true, errors: [] });
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("manifest content validation compares LaTeX stems without a DOM", () => {
  const latexManifest = {
    ...manifest,
    questions: [{
      id: "q1",
      number: "1",
      type: "choice",
      stemHtml: "已知 {a&lt;sub&gt;n&lt;/sub&gt;} 且 $f\\left(x\\right)=\\sin\\omega x$ ( )",
      options: [{ key: "A", html: "1" }, { key: "B", html: "2" }],
      answer: "A",
    }],
  };
  const page = `<html><head>${quizManifestScript(latexManifest)}</head><body>
    <section class="q-card" data-quiz-id="q1">
      <div data-quiz-stem>已知 {a<sub>n</sub>} 且 <math><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo><mi>sin</mi><mi>ω</mi><mi>x</mi></math> ( )</div>
      <button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button>
      <button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button>
    </section></body></html>`;
  assert.equal(validateQuizManifest(latexManifest, { html: page, checkHtml: true, checkContent: true }).ok, true);
  const badPage = page.replace("已知 {a<sub>n</sub>}", "完全不同的题干");
  const bad = validateQuizManifest(latexManifest, { html: badPage, checkHtml: true, checkContent: true });
  assert.equal(bad.ok, true, "structural validation still passes");
  assert.ok(bad.contentErrors.some((error) => error.includes("question q1 stem text differs from HTML")));
});

test("plain manifests keep questions but drop every answer field", () => {
  const page = plainQuizManifest({
    ...manifest,
    questions: [{
      ...manifest.questions[0],
      answer: "B",
      analysisHtml: "解析",
      referenceHtml: "参考",
    }],
  });
  assert.equal(page.grading, "ai");
  assert.equal("answer" in page.questions[0], false);
  assert.equal("analysisHtml" in page.questions[0], false);
  assert.equal("referenceHtml" in page.questions[0], false);
  const validation = validateQuizManifest(page, { allowMissingAnswers: true, requireAnswers: false });
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.warnings, []);
});

test("manifest extraction prefers a complete head copy over a trailing stub", () => {
  const stub = {
    ...manifest,
    questions: [
      { id: "q1", number: "1", type: "choice" },
      { id: "q2", number: "2", type: "choice" },
    ],
  };
  const page = `<html><head>${quizManifestScript(manifest)}</head><body></body></html>${quizManifestScript(stub)}`;
  const parsed = extractQuizManifest(page);
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].stemHtml, manifest.questions[0].stemHtml);
  assert.equal(parsed.questions[0].options.length, 2);
});

test("manifest extraction prefers a later filled copy and accepts object question maps", () => {
  const filled = {
    ...manifest,
    questions: [
      manifest.questions[0],
      { ...manifest.questions[0], id: "q2", number: "2" },
    ],
  };
  const empty = { ...manifest, questions: [] };
  const page = `<html><head>${quizManifestScript(empty)}${quizManifestScript(filled)}</head><body></body></html>`;
  assert.equal(extractQuizManifest(page)?.questions?.length, 2);
  const mapped = { ...manifest, questions: { q1: manifest.questions[0] } };
  const mappedPage = `<html><head>${quizManifestScript(mapped)}</head></html>`;
  assert.equal(extractQuizManifest(mappedPage)?.questions?.length, 1);
});

test("manifest script content cannot break out of its script tag", () => {
  const script = quizManifestScript({
    ...manifest,
    questions: [{ ...manifest.questions[0], stemHtml: "</script><p>still data</p>" }],
  });
  assert.doesNotMatch(script, /<\/script><p>/);
  assert.match(script, /\\u003c\/script>/);
});

test("the quiz layout style restores MathML display after page-level overrides", () => {
  const css = quizLayoutStyle();
  // Some generated pages set math[display="block"] { display:block }, which
  // makes every MathML token its own block (one character per line).
  assert.match(css, /math, math\[display\]\s*\{\s*display:\s*revert\s*!important/);
});
