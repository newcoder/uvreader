import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { watchQuietUi } from "../packages/reader/src/quiet-ui.js";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("quiet plugin controls preserve accessible names without muting host tooltips", async () => {
  const { document } = new JSDOM('<button id="host" aria-label="Host action" title="Host tip"></button><div class="qiaomu-reader-test"><button id="ours" aria-label="Send" title="Send"></button></div>').window;
  const stop = watchQuietUi(document), button = document.getElementById("ours");
  await settle();
  assert.equal(button.hasAttribute("aria-label"), false);
  assert.equal(button.hasAttribute("title"), false);
  assert.equal(document.getElementById(button.getAttribute("aria-labelledby")).textContent, "Send");
  assert.equal(document.getElementById("host").getAttribute("title"), "Host tip");
  stop();
  assert.equal(button.getAttribute("aria-label"), "Send");
  assert.equal(document.querySelectorAll(".qiaomu-reader-a11y-label").length, 0);
});

test("send/stop accessible labels update without growing hidden DOM", async () => {
  const { document } = new JSDOM('<div class="qiaomu-reader-test"><button aria-label="Send"></button></div>').window;
  const stop = watchQuietUi(document), button = document.querySelector("button");
  const id = button.getAttribute("aria-labelledby");
  for (const label of ["Stop", "Send", "Stop"]) {
    button.setAttribute("aria-label", label); await settle();
    assert.equal(document.getElementById(id).textContent, label);
    assert.equal(document.querySelectorAll(".qiaomu-reader-a11y-label").length, 1);
  }
  button.remove(); await settle();
  assert.equal(document.getElementById(id), null);
  stop();
});

test("new controls and text inputs get quiet labels, existing semantic labels and explicit exceptions survive", async () => {
  const { document } = new JSDOM('<div class="qiaomu-reader-test"><span id="name">Model</span><input aria-labelledby="name" aria-label="Model"><button data-qbr-tooltip="essential" aria-label="Important"></button></div>').window;
  const stop = watchQuietUi(document);
  const input = document.createElement("input"); input.setAttribute("aria-label", "Search");
  document.querySelector("div").append(input); await settle();
  assert.equal(document.getElementById(input.getAttribute("aria-labelledby")).textContent, "Search");
  assert.equal(document.querySelector("input").getAttribute("aria-labelledby"), "name");
  assert.equal(document.querySelector("button").getAttribute("aria-label"), "Important");
  stop();
});
