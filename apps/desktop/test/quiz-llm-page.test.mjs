import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractQuizLlmHtml, postprocessQuizLlmHtml } from "../src/main/quiz-llm-page.js";
import { QUIZ_LLM_PROMPT } from "../../../packages/reader/src/quiz-llm-prompt.js";
import { registerQuizLlmRunner } from "../src/main/workshop-quiz-llm.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("the bundled prompt stays in sync with the prompt document", () => {
  assert.equal(QUIZ_LLM_PROMPT, fs.readFileSync(new URL("../../../docs/quiz-llm-prompt.txt", import.meta.url), "utf8"));
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
  assert.ok(result.stats.math >= 1);
  assert.equal(result.stats.imagesInlined, 1);
  assert.equal(result.stats.generatedHidden, 1);
  assert.equal(result.stats.blankSymbols, 1);
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
            answer: "<!doctype html><html><body><main id=\"paper\"><h1>测试试卷</h1><p>题目 6 的说明文字，必须完整保留。</p><p>这是一段用于验证页面完整性的正文，包含足够的文字来模拟真实的模型输出。</p><p>再补一段足够长的内容，确保它超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。这段文字只用于测试，不包含任何实际题目或答案。</p></main></body></html>",
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
          answer: "<!doctype html><html><body><main id=\"paper\"><h1>测试试卷</h1><p>题目 $x^2$ 的说明文字，必须完整保留。</p><p>这是一段用于验证页面完整性的正文。</p><p>再补一段足够长的内容，确保它超过应用端的最小完整性阈值，模拟真实模型返回的完整页面。</p><img src=\"pic.png\"></main></body></html>",
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
  const html = fs.readFileSync(result.output, "utf8");
  assert.match(html, /<math/);
  assert.match(html, /data:image\/png;base64,/);
});
