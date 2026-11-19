import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const source = fs.readFileSync(new URL("../apps/desktop/src/renderer/quiz-view.js", import.meta.url), "utf8");

function bridgeScript() {
  const repairStart = source.indexOf("const LEGACY_MATH_REPAIR");
  const start = repairStart >= 0 ? repairStart : source.indexOf("function bridgeScript()");
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

test("the quiz host bridge prefers the first fully visible question over a partial previous one", async () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "Demo",
    questions: [
      { id: "q1", number: "1", type: "short", stemHtml: "第一题" },
      { id: "q2", number: "2", type: "short", stemHtml: "第二题" },
      { id: "q3", number: "3", type: "short", stemHtml: "第三题" },
    ],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>
    <main id="paper">
      <section class="q" data-quiz-id="q1"><div data-quiz-stem>第一题</div></section>
      <section class="q" data-quiz-id="q2"><div data-quiz-stem>第二题</div></section>
      <section class="q" data-quiz-id="q3"><div data-quiz-stem>第三题</div></section>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  const messages = [];
  window.parent.postMessage = (data) => messages.push(data);
  window.eval(bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>\s*$/, ""));
  const cards = window.document.querySelectorAll(".q");
  cards[0].getBoundingClientRect = () => ({ top: -80, bottom: 120, height: 200, left: 0, right: 100, width: 100 });
  cards[1].getBoundingClientRect = () => ({ top: 160, bottom: 400, height: 240, left: 0, right: 100, width: 100 });
  cards[2].getBoundingClientRect = () => ({ top: 800, bottom: 1040, height: 240, left: 0, right: 100, width: 100 });

  window.dispatchEvent(new window.MessageEvent("message", {
    source: window,
    data: { source: "qbr-quiz-host", type: "visible-question", requestId: "r2" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = messages.find((message) => message.type === "visible-question" && message.requestId === "r2");
  assert.equal(reply?.id, "q2");
  window.close();
});

test("the quiz host bridge uses the question starting in the viewport when no card is fully visible", async () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "Demo",
    questions: [
      { id: "q1", number: "1", type: "short", stemHtml: "第一题" },
      { id: "q2", number: "2", type: "short", stemHtml: "第二题" },
      { id: "q3", number: "3", type: "short", stemHtml: "第三题" },
    ],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>
    <main id="paper">
      <section class="q" data-quiz-id="q1"><div data-quiz-stem>第一题</div></section>
      <section class="q" data-quiz-id="q2"><div data-quiz-stem>第二题</div></section>
      <section class="q" data-quiz-id="q3"><div data-quiz-stem>第三题</div></section>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  const messages = [];
  window.parent.postMessage = (data) => messages.push(data);
  window.eval(bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>\s*$/, ""));
  const cards = window.document.querySelectorAll(".q");
  cards[0].getBoundingClientRect = () => ({ top: -40, bottom: 100, height: 140, left: 0, right: 100, width: 100 });
  cards[1].getBoundingClientRect = () => ({ top: 120, bottom: 1000, height: 880, left: 0, right: 100, width: 100 });
  cards[2].getBoundingClientRect = () => ({ top: 1100, bottom: 1340, height: 240, left: 0, right: 100, width: 100 });

  window.dispatchEvent(new window.MessageEvent("message", {
    source: window,
    data: { source: "qbr-quiz-host", type: "visible-question", requestId: "r3" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = messages.find((message) => message.type === "visible-question" && message.requestId === "r3");
  assert.equal(reply?.id, "q2");
  window.close();
});

test("the quiz host bridge gives option inputs a native value from data-value", () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "Demo",
    questions: [{ id: "q1", number: "1", type: "choice", stemHtml: "第一题", options: [{ key: "A", html: "甲" }, { key: "B", html: "乙" }] }],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>
    <section class="q" data-quiz-id="q1"><div data-quiz-stem>第一题</div>
      <input type="radio" name="q1" data-quiz-id="q1" data-value="A">
      <input type="radio" name="q1" data-quiz-id="q1" data-value="B">
    </section>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>\s*$/, ""));
  const inputs = dom.window.document.querySelectorAll("input[data-value]");
  assert.equal(inputs[0].value, "A");
  assert.equal(inputs[1].value, "B");
  dom.window.close();
});

test("the quiz host bridge reports the first question visible in the viewport", async () => {
  const manifest = {
    schema: "uvreader.quiz-page/v1",
    paperId: "p1",
    title: "Demo",
    questions: [
      { id: "q1", number: "1", type: "short", stemHtml: "第一题" },
      { id: "q2", number: "2", type: "short", stemHtml: "第二题" },
    ],
  };
  const html = `<!doctype html><html><head><script type="application/json" id="quiz-manifest">${JSON.stringify(manifest)}</script></head><body>
    <main id="paper">
      <section class="q" data-quiz-id="q1"><div data-quiz-stem>第一题</div></section>
      <section class="q" data-quiz-id="q2"><div data-quiz-stem>第二题</div></section>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  const messages = [];
  window.parent.postMessage = (data) => messages.push(data);
  window.eval(bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>\s*$/, ""));
  const cards = window.document.querySelectorAll(".q");
  cards[0].getBoundingClientRect = () => ({ top: -900, bottom: -700, height: 200, left: 0, right: 100, width: 100 });
  cards[1].getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200, left: 0, right: 100, width: 100 });

  window.dispatchEvent(new window.MessageEvent("message", {
    source: window,
    data: { source: "qbr-quiz-host", type: "visible-question", requestId: "r1" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = messages.find((message) => message.type === "visible-question" && message.requestId === "r1");
  assert.equal(reply?.id, "q2");
  window.close();
});
