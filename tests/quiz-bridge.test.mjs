import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const source = fs.readFileSync(new URL("../apps/desktop/src/renderer/quiz-view.js", import.meta.url), "utf8");

function bridgeScript() {
  const start = source.indexOf("function bridgeScript()");
  const end = source.indexOf("export function withHostBridge");
  const factory = source.slice(start, end);
  return vm.runInNewContext(`${factory}\nbridgeScript()`, {});
}

test("the quiz host bridge reads AI-page option controls and submits their answers", async () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "Demo",
    questions: [{
      id: "q1",
      number: "1",
      type: "choice",
      stemHtml: "题目",
      options: [{ key: "A", html: "1" }, { key: "B", html: "2" }],
      answer: "A",
    }],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>
    <main id="paper"><section class="question" data-quiz-id="q1">
      <div data-quiz-stem>题目</div>
      <label class="option" data-quiz-id="q1" data-value="A"><input type="radio" name="q1" value="A"><span class="opt-text">1</span></label>
      <label class="option" data-quiz-id="q1" data-value="B"><input type="radio" name="q1" value="B"><span class="opt-text">2</span></label>
    </section></main>
    <button id="submit">交卷</button>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const messages = [];
  window.parent.postMessage = (data) => messages.push(data);
  window.eval(bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>\s*$/, ""));

  const option = window.document.querySelector('.option[data-value="A"]');
  option.querySelector("input").checked = true;
  option.click();
  window.document.getElementById("submit").click();
  await new Promise((resolve) => setTimeout(resolve, 220));

  assert.ok(messages.some((message) => message.type === "answer" && message.id === "q1" && message.value === "A"));
  const submitted = messages.find((message) => message.type === "submit");
  assert.ok(submitted);
  assert.equal(submitted.answers.q1, "A");
  window.close();
});
