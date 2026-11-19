import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildQuizLlmPrompt, extractQuizLlmHtml, postprocessQuizLlmHtml } from "../src/main/quiz-llm-page.js";
import { cleanTemmlErrors } from "../src/shared/quiz-html.js";
import { extractQuizManifest } from "../../../packages/reader/src/quiz-manifest.js";
import { QUIZ_LLM_PROMPT } from "../../../packages/reader/src/quiz-llm-prompt.js";
import { QUIZ_LLM_PLAIN_PROMPT } from "../../../packages/reader/src/quiz-llm-prompt-plain.js";
import { registerQuizLlmRunner } from "../src/main/workshop-quiz-llm.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("the bundled prompts stay in sync with the prompt documents", () => {
  assert.equal(QUIZ_LLM_PROMPT, fs.readFileSync(new URL("../../../docs/quiz-llm-prompt.txt", import.meta.url), "utf8"));
  assert.equal(QUIZ_LLM_PLAIN_PROMPT, fs.readFileSync(new URL("../../../docs/quiz-llm-plain-prompt.txt", import.meta.url), "utf8"));
  assert.match(QUIZ_LLM_PROMPT, /零、硬约束/);
  assert.match(QUIZ_LLM_PROMPT, /原文零丢失/);
  assert.match(QUIZ_LLM_PROMPT, /重新答题/);
  assert.match(QUIZ_LLM_PROMPT, /答题卡\/导航栏的上部/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /零、硬约束/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /原文零丢失/);
  assert.match(QUIZ_LLM_PROMPT, /几何图形题不得凭空补图/);
  assert.match(QUIZ_LLM_PROMPT, /需结合原图/);
  assert.match(QUIZ_LLM_PROMPT, /答题卡\/题目导航也必须按这些大类分组显示/);
  assert.match(QUIZ_LLM_PROMPT, /不要用数组下标/);
  assert.match(QUIZ_LLM_PROMPT, /题目导航在窄屏和打开 AI 伴学后必须仍然可见/);
  assert.match(QUIZ_LLM_PROMPT, /questions` 只放真正可作答的题目/);
  assert.match(QUIZ_LLM_PROMPT, /input 的 value 与 data-value 相同/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /答题卡\/题目导航也必须按这些大类分组显示/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /input 的 value 与 data-value 相同/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /不要用数组下标/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /题目导航在窄屏和打开 AI 伴学后必须仍然可见/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /普通答题页/);
  assert.match(QUIZ_LLM_PLAIN_PROMPT, /"grading": "ai"/);
  assert.equal(buildQuizLlmPrompt("题目", { plain: true }), QUIZ_LLM_PLAIN_PROMPT.replace("{{MARKDOWN}}", "题目"));
});

test("the LLM page postprocessor converts formulas, formats code and inlines images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-"));
  fs.writeFileSync(path.join(dir, "pic.png"), PNG);
  const html = `<!doctype html><html><body><main id="paper">
<p>公式 $x^2$</p>
<pre>int main() {
cin >> ①;
int x;
}</pre>
<div id="gen" data-source="generated">答案：A</div>
<img src="pic.png" alt="图">
<script>document.getElementById('resultSummary').innerHTML = 'ok';</script>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html, { baseDir: dir });
  assert.match(result.html, /<math/);
  assert.match(result.html, /int main\(\) \{\n    cin &gt;&gt; <span class="code-blank">①<\/span>;/);
  assert.match(result.html, /data:image\/png;base64,/);
  assert.match(result.html, /data-source="generated"[^>]*hidden/);
  assert.match(result.html, /data-llm-generated-hidden/);
  assert.match(result.html, /cover\.remove\(\)/);
  assert.match(result.html, /id="resultSummary"/);
  assert.match(result.html, /data-quiz-ui-enhance/);
  assert.match(result.html, /重新答题/);
  assert.match(result.html, /function hide\(\)/);
  assert.match(result.html, /data-qbr-quiz-layout/);
  assert.ok(result.stats.math >= 1);
  assert.equal(result.stats.imagesInlined, 1);
  assert.equal(result.stats.generatedHidden, 1);
  assert.equal(result.stats.blankSymbols, 1);
});

test("a plain page drops answers and analysis from both HTML and manifest", () => {
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify({
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "测试试卷",
    questions: [{
      id: "q1",
      number: "1.",
      type: "choice",
      stemHtml: "题目",
      options: [{ key: "A", html: "甲" }, { key: "B", html: "乙" }],
      answer: "B",
      analysisHtml: "因为乙正确",
    }],
  })}</script></head><body><main id="paper"><section class="q-card" data-quiz-id="q1"><div data-quiz-stem>题目</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">甲</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">乙</span></button><div class="answer-block" hidden data-answer-for="q1"><div class="answer-line"><strong>正确答案：</strong>B</div><div class="analysis"><strong>答案解析：</strong>因为乙正确</div></div><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值。</p></section></main></body></html>`;
  const result = postprocessQuizLlmHtml(html, { plain: true });
  assert.doesNotMatch(result.html, /因为乙正确/);
  assert.doesNotMatch(result.html, /data-answer=/);
  assert.doesNotMatch(result.html, /"answer":/);
  assert.doesNotMatch(result.html, /analysisHtml/);
  assert.match(result.html, /"grading":"ai"/);
  assert.match(result.html, /data-qbr-grading="ai"/);
  assert.equal(result.stats.manifestGrading, "ai");
  assert.deepEqual(result.stats.manifestWarnings, []);
});

test("a trailing manifest stub cannot override the complete head manifest", () => {
  const full = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "测试试卷",
    questions: [{
      id: "q1",
      number: "1.",
      type: "choice",
      stemHtml: "题目",
      options: [{ key: "A", html: "1" }, { key: "B", html: "2" }],
      answer: "B",
      analysisHtml: "解析",
    }],
  };
  const stub = { schema: "uvreader.quiz-page/v1", paperId: "stub", title: "stub", questions: [{ id: "q1", number: "1.", type: "choice" }] };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(full)}</script></head><body><main id="paper"><section class="q-card" data-quiz-id="q1"><div data-quiz-stem>题目</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button></section><p>这是一段用于验证页面完整性的正文。</p></main></body></html><script type="application/json" id="quiz-manifest">${JSON.stringify(stub)}</script>`;
  const result = postprocessQuizLlmHtml(html);
  assert.equal(result.stats.manifestQuestions, 1);
  assert.deepEqual(result.stats.manifestErrors, []);
  assert.match(result.html, /"stemHtml":"题目"/);
  assert.doesNotMatch(result.html, /"paperId":"stub"/);
});

test("the LLM page postprocessor moves an original analysis left in the question into the solution", () => {
  const html = `<!doctype html><html><body><main id="paper">
<section class="q" id="q6" data-qtype="single">
  <div class="q-head"><span>6. 如图所示，艺术灯悬挂，则（ ）</span></div>
  <div class="options"><label class="opt"><input type="radio">A. 1</label><label class="opt"><input type="radio">B. 2</label></div>
  <p>【详解】AB. 对艺术灯受力分析。</p>
  <p>根据矢量三角形可知，故选 B。</p>
  <div class="solution" data-source="original"><p class="sol-title ans">正确答案</p><p>B</p><p class="sol-title ana">答案解析</p><p>见上文【详解】。</p></div>
</section>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.equal(result.stats.inlineSolutions, 1);
  const question = result.html.slice(result.html.indexOf('class="q"'), result.html.indexOf('class="solution"'));
  const solution = result.html.slice(result.html.indexOf('class="solution"'));
  assert.doesNotMatch(question, /【详解】/, "题干里不能残留解析");
  assert.match(solution, /【详解】对艺术灯|【详解】AB\. 对艺术灯/);
  assert.match(solution, /根据矢量三角形可知/);
  assert.doesNotMatch(solution, /见上文【详解】/, "占位解析已由原文替换");
});

test("a solution already inside its hidden block is left alone", () => {
  const html = `<!doctype html><html><body><main id="paper">
<section class="q" id="q1"><div class="q-head"><span>1. 题目</span></div><div class="solution"><p>【详解】原文解析。</p></div></section>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.equal(result.stats.inlineSolutions, 0);
});

test("the LLM page extractor strips fenced output and surrounding prose", () => {
  assert.match(extractQuizLlmHtml("```html\n<!doctype html><html><body>ok</body></html>\n```"), /^<!doctype html>/);
  assert.match(extractQuizLlmHtml("说明\n<!doctype html><html><body>ok</body></html>"), /<!doctype html>/);
});

test("the LLM page extractor keeps a manifest appended after </html>", () => {
  const page = extractQuizLlmHtml("<!doctype html><html><body>ok</body></html>\n<script id=\"quiz-manifest\">{\"questions\":[]}</script>");
  assert.match(page, /<\/html>/);
  assert.match(page, /id="quiz-manifest"/);
});

test("the LLM page postprocessor restores MathML block layout", () => {
  const html = `<!doctype html><html><head><style>
math[display="block"] { display: block; margin: 12px 0; text-align: center; }
</style></head><body><p><math display="block"><mi>G</mi><mi>e</mi><mo>+</mo><mn>4</mn><mi>F</mi><mi>e</mi><mi>C</mi><msub><mi>l</mi><mn>3</mn></msub></math></p></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  const overrideAt = result.html.indexOf('math[display="block"] { display: block;');
  const guardAt = result.html.indexOf("math, math[display] { display: revert !important;");
  assert.ok(overrideAt >= 0, "the page's own rule is kept");
  assert.ok(guardAt > overrideAt, "the MathML guard comes after the page rule");
});

test("malformed dollar delimiters never leave a red Temml parse error", () => {
  const html = `<!doctype html><html><body><main id="paper">
<p>如图, 在四棱锥 P - ABCD$ 中, $P A \\perp 底面 ABCD</p>
<p>正常公式 $x^2$</p>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.doesNotMatch(result.html, /temml-error/);
  assert.doesNotMatch(result.html, /ParseError/);
  assert.match(result.html, /P - ABCD 中, P A/);
  assert.match(result.html, /<math/);
});

test("the shared cleanup flattens existing Temml error spans", () => {
  const page = `<p><span class="temml-error" style="color:red">P - ABCD$ 中, $P A

ParseError: Can&#x27;t use function &#x27;$&#x27; in math mode</span> 且 PA ⊥ 底面</p>`;
  const cleaned = cleanTemmlErrors(page);
  assert.doesNotMatch(cleaned, /temml-error/);
  assert.doesNotMatch(cleaned, /ParseError/);
  assert.match(cleaned, /P - ABCD 中, P A/);
  assert.match(cleaned, /且 PA ⊥ 底面/);
});

test("existing Temml error spans are flattened to readable text", () => {
  const html = `<!doctype html><html><body><main id="paper">
<p><span class="temml-error" style="color:#b22222">P - ABCD$ 中, $P A

ParseError: Can&#x27;t use function &#x27;$&#x27; in math mode</span> 且 PA ⊥ 底面</p>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.doesNotMatch(result.html, /temml-error/);
  assert.doesNotMatch(result.html, /ParseError/);
  assert.match(result.html, /P - ABCD 中, P A/);
  assert.match(result.html, /且 PA ⊥ 底面/);
});

test("raw OCR LaTeX inside mtext is repaired into readable MathML", () => {
  const html = `<!doctype html><html><body><main id="paper">
<p>钇 <math display="inline"><mtext>90\\ (^{90}39Y)</mtext></math> 玻璃微球</p>
<p><math display="inline"><mtext>^ { 9 0 } 3 9 \\mathrm { Y }</mtext></math></p>
<p><math display="inline"><mtext>\\begin{aligned} 产 \\end{aligned}</mtext></math></p>
</main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.ok(result.stats.mathRepaired >= 2);
  assert.doesNotMatch(result.html, /\\mathrm/);
  assert.doesNotMatch(result.html, /\\begin\{aligned\}/);
  assert.match(result.html, /<msubsup>|<msub>|<msup>/);
  assert.match(result.html, /产/);
});

test("empty manifest entries are repaired from the rendered question cards", () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "测试试卷",
    questions: [
      { id: "q1", number: "1", type: "choice", stemHtml: "", options: [], answer: "A" },
      { id: "q2", number: "2", type: "choice", stemHtml: "", options: [], answer: "B" },
    ],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body><main id="paper">
    <section class="q-card" data-quiz-id="q1"><div data-quiz-stem>第一题题干</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">甲</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">乙</span></button></section>
    <section class="q-card" data-quiz-id="q2"><div data-quiz-stem>第二题题干</div><button data-quiz-id="q2" data-value="A"><span class="opt-text">丙</span></button><button data-quiz-id="q2" data-value="B"><span class="opt-text">丁</span></button></section>
  </main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.equal(result.stats.manifestErrors.length, 0, JSON.stringify(result.stats.manifestErrors));
  assert.ok(result.stats.manifestRepaired >= 4);
  const repaired = extractQuizManifest(result.html);
  assert.match(repaired.questions[0].stemHtml, /第一题题干/);
  assert.equal(repaired.questions[0].options.length, 2);
  assert.equal(repaired.questions[0].options[0].text, "甲");
  assert.match(repaired.questions[1].stemHtml, /第二题题干/);
});

test("option inputs get a native value from data-value", () => {
  const html = `<!doctype html><html><body><main id="paper"><input type="radio" name="q1" data-quiz-id="q1" data-value="A"><input type="radio" name="q1" data-quiz-id="q1" data-value="B" value="on"></main></body></html>`;
  const result = postprocessQuizLlmHtml(html);
  assert.equal(result.stats.optionValues, 2);
  assert.match(result.html, /data-value="A" value="A"/);
  assert.match(result.html, /data-value="B" value="B"/);
});

test("the quiz-llm runner puts an inline analysis marker on its own prompt line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-prompt-"));
  const runners = new Map();
  let prompt = "";
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({
        ok: true,
        markdown: "6. 艺术灯悬挂，则（ ）A. 1 B. 2 C. 3 D. 4【详解】AB. 受力分析。",
        path: path.join(dir, "paper.md"),
      }),
      aiRuntime: {
        stream: async ({ messages }) => {
          prompt = messages[0].content;
          return {
            ok: true,
            answer: "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q6\",\"number\":\"6\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"B\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\" data-quiz-id=\"q6\"><h1>测试试卷</h1><p>题目 6 的说明文字，必须完整保留。</p><p>这是一段用于验证页面完整性的正文，包含足够的文字来模拟真实的模型输出。</p><p>再补一段足够长的内容，确保它超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。这段文字只用于测试，不包含任何实际题目或答案。</p></main></body></html>",
          };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.match(prompt, /D\. 4\n【详解】AB\. 受力分析/);
  assert.doesNotMatch(prompt, /D\. 4【详解】/);
});

test("the quiz-llm runner keeps a page whose objective answer is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-missing-answer-"));
  const runners = new Map();
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => ({
          ok: true,
          answer: "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q1\",\"number\":\"1\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\" data-quiz-id=\"q1\"><h1>测试试卷</h1><div data-quiz-stem>题目</div><p>这是一段用于验证页面完整性的正文，确保它超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p><button data-quiz-id=\"q1\" data-value=\"A\"><span class=\"opt-text\">1</span></button><button data-quiz-id=\"q1\" data-value=\"B\"><span class=\"opt-text\">2</span></button></main></body></html>",
        }),
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.ok(fs.existsSync(result.output));
  assert.match(result.detail, /1 题未提供答案/);
});

test("the quiz-llm runner writes a page when only the stem content differs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-stem-"));
  const runners = new Map();
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => ({
          ok: true,
          answer: "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q1\",\"number\":\"1\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"A\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\"><h1>测试试卷</h1><section class=\"q-card\" data-quiz-id=\"q1\"><div data-quiz-stem>完全不同的题干内容，只会作为内容提示。</div><button data-quiz-id=\"q1\" data-value=\"A\"><span class=\"opt-text\">1</span></button><button data-quiz-id=\"q1\" data-value=\"B\"><span class=\"opt-text\">2</span></button></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p></main></body></html>",
        }),
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.ok(fs.existsSync(result.output));
  assert.match(result.detail, /1 题内容提示/);
});

test("the quiz-llm runner regenerates a page whose manifest has no questions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-manifest-"));
  const runners = new Map();
  let calls = 0;
  const shell = (manifest) => `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body><main id="paper"><h1>测试试卷</h1><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p><p>再补一段足够长的内容，确保自动重试后的结果能够写入产物。</p></main></body></html>`;
  const goodPage = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify({ schema: "uvreader.quiz-page/v1", paperId: "p1", title: "测试试卷", questions: [{ id: "q1", number: "1", type: "choice", stemHtml: "题目", options: [{ key: "A", html: "1" }, { key: "B", html: "2" }], answer: "B", analysisHtml: "解析" }] })}</script></head><body><main id="paper"><h1>测试试卷</h1><section class="q-card" data-quiz-id="q1"><div data-quiz-stem>题目</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p></main></body></html>`;
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => {
          calls += 1;
          return {
            ok: true,
            answer: calls === 1
              ? shell({ schema: "uvreader.quiz-page/v1", paperId: "p1", title: "测试试卷", questions: [] })
              : goodPage,
          };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(calls, 2, "an empty manifest triggers one full regeneration");
  assert.ok(fs.existsSync(result.output));
  assert.match(fs.readFileSync(result.output, "utf8"), /data-quiz-stem/);
});

test("the quiz-llm runner regenerates a page whose manifest entries lack stems or options", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-manifest-structure-"));
  const runners = new Map();
  let calls = 0;
  const malformed = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify({
    schema: "uvreader.quiz-page/v1", paperId: "p1", title: "测试试卷",
    questions: [{ id: "q1", number: "1", type: "choice", stemHtml: "", options: [], answer: "" }],
  })}</script></head><body><main id="paper"><h1>测试试卷</h1><section class="q-card" data-quiz-id="q1"></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p></main></body></html>`;
  const good = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify({
    schema: "uvreader.quiz-page/v1", paperId: "p1", title: "测试试卷",
    questions: [{ id: "q1", number: "1", type: "choice", stemHtml: "题目", options: [{ key: "A", html: "1" }, { key: "B", html: "2" }], answer: "B", analysisHtml: "解析" }],
  })}</script></head><body><main id="paper"><h1>测试试卷</h1><section class="q-card" data-quiz-id="q1"><div data-quiz-stem>题目</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p></main></body></html>`;
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => {
          calls += 1;
          return { ok: true, answer: calls === 1 ? malformed : good };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(calls, 2, "structural manifest errors trigger one targeted regeneration");
  assert.ok(fs.existsSync(result.output));
  assert.match(fs.readFileSync(result.output, "utf8"), /data-quiz-stem>题目/);
});

test("the quiz-llm runner keeps a complete page when manifest regeneration fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-keep-"));
  const runners = new Map();
  let calls = 0;
  const page = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify({ schema: "uvreader.quiz-page/v1", paperId: "p1", title: "测试试卷", questions: [] })}</script></head><body><main id="paper"><h1>测试试卷</h1><section class="q-card" data-quiz-id="q1"><div data-quiz-stem>题目</div><button data-quiz-id="q1" data-value="A"><span class="opt-text">1</span></button><button data-quiz-id="q1" data-value="B"><span class="opt-text">2</span></button></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p></main></body></html>`;
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => {
          calls += 1;
          if (calls > 1) return { ok: false, message: "provider unavailable" };
          return { ok: true, answer: page };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(calls, 2);
  assert.ok(fs.existsSync(result.output));
  assert.match(result.detail, /缺少评分数据/);
  assert.match(fs.readFileSync(result.output, "utf8"), /data-quiz-id="q1"/);
});

test("the quiz-llm runner writes a self-contained page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-run-"));
  fs.writeFileSync(path.join(dir, "pic.png"), PNG);
  const runners = new Map();
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({
        ok: true,
        markdown: "题目 $x^2$\n\n![图](pic.png)",
        path: path.join(dir, "paper.md"),
      }),
      aiRuntime: {
        stream: async () => ({
          ok: true,
          answer: "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q1\",\"number\":\"1\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"B\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\" data-quiz-id=\"q1\"><h1>测试试卷</h1><p>题目 $x^2$ 的说明文字，必须完整保留。</p><p>这是一段用于验证页面完整性的正文。</p><p>再补一段足够长的内容，确保它超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p><img src=\"pic.png\"></main></body></html>",
        }),
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.ok(fs.existsSync(result.output));
  assert.match(result.detail, /提取 \d+ 秒 · AI \d+ 秒/);
  const html = fs.readFileSync(result.output, "utf8");
  assert.match(html, /<math/);
  assert.match(html, /data:image\/png;base64,/);
});

test("the quiz-llm runner writes a plain page without answers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-plain-"));
  const runners = new Map();
  let prompt = "";
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async ({ messages }) => {
          prompt = messages.at(-1).content;
          return {
            ok: true,
            answer: "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q1\",\"number\":\"1\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"B\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\"><h1>测试试卷</h1><section class=\"q-card\" data-quiz-id=\"q1\"><div data-quiz-stem>题目</div><button data-quiz-id=\"q1\" data-value=\"A\"><span class=\"opt-text\">1</span></button><button data-quiz-id=\"q1\" data-value=\"B\"><span class=\"opt-text\">2</span></button><div class=\"solution\">正确答案：B</div></section><p>这是一段用于验证页面完整性的正文，确保整页超过应用端的最小完整性阈值。</p></main></body></html>",
          };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.普通答题页.html", plain: true, config: { id: "p", base: "http://x", model: "m" } },
    report: () => {},
    signal: new AbortController().signal,
  });
  assert.match(prompt, /普通答题页生成器/);
  assert.match(result.detail, /普通答题页/);
  const html = fs.readFileSync(result.output, "utf8");
  assert.match(html, /"grading":"ai"/);
  assert.doesNotMatch(html, /"answer":/);
  assert.doesNotMatch(html, /正确答案：B/);
});

test("an incomplete AI page is retried once automatically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-quiz-llm-retry-"));
  const runners = new Map();
  const reports = [];
  const logs = [];
  let calls = 0;
  const complete = "<!doctype html><html><head><script type=\"application/json\" id=\"quiz-manifest\">{\"schema\":\"uvreader.quiz-page/v1\",\"paperId\":\"p1\",\"title\":\"测试试卷\",\"questions\":[{\"id\":\"q1\",\"number\":\"1\",\"type\":\"choice\",\"stemHtml\":\"题目\",\"options\":[{\"key\":\"A\",\"html\":\"1\"},{\"key\":\"B\",\"html\":\"2\"}],\"answer\":\"B\",\"analysisHtml\":\"解析\"}]}</script></head><body><main id=\"paper\" data-quiz-id=\"q1\"><h1>测试试卷</h1><p>这是一段用于验证页面完整性的正文，确保它超过应用端的最小完整性阈值。</p><p>再补一段足够长的内容，模拟真实模型返回的完整页面。</p></main></body></html>";
  registerQuizLlmRunner(
    { register: (kind, runner) => runners.set(kind, runner) },
    {
      vaultRoot: dir,
      log: (...args) => logs.push(args.join(" ")),
      extractMarkdown: async () => ({ ok: true, markdown: "1. 题目", path: path.join(dir, "paper.md") }),
      aiRuntime: {
        stream: async () => {
          calls += 1;
          return calls === 1
            ? { ok: true, answer: "<!doctype html><html><body><main>被截断", stopReason: "length" }
            : { ok: true, answer: complete, stopReason: "stop" };
        },
        abort: () => {},
      },
    },
  );
  fs.writeFileSync(path.join(dir, "paper.pdf"), "x");
  const result = await runners.get("quiz-llm-export")({
    payload: { source: "paper.pdf", out: "paper.AI.html", config: { id: "p", base: "http://x", model: "m" } },
    report: (row) => reports.push(row),
    signal: new AbortController().signal,
  });
  assert.equal(calls, 2, "the runner retries once after an incomplete page");
  assert.ok(fs.existsSync(result.output));
  assert.match(reports.map((row) => row.label).join(" "), /自动重试/);
  assert.ok(logs.some((line) => /incomplete page/.test(line)));
});
