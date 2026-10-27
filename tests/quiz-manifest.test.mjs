import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { extractQuizManifest, quizManifestGuardScript, quizManifestScript, validateQuizManifest } from "../packages/reader/src/quiz-manifest.js";

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

test("manifest script content cannot break out of its script tag", () => {
  const script = quizManifestScript({
    ...manifest,
    questions: [{ ...manifest.questions[0], stemHtml: "</script><p>still data</p>" }],
  });
  assert.doesNotMatch(script, /<\/script><p>/);
  assert.match(script, /\\u003c\/script>/);
});
