import assert from "node:assert/strict";
import test from "node:test";

import { setupDom } from "./helpers.mjs";

setupDom();

test("createEl applies classes, text, attributes and callbacks", () => {
  const host = document.createElement("div");
  const el = host.createEl("button", { cls: "one two", text: "Open", attr: { "aria-label": "open book" } }, (node) => {
    node.dataset.ready = "yes";
  });
  assert.equal(el.tagName, "BUTTON");
  assert.equal(el.className, "one two");
  assert.equal(el.textContent, "Open");
  assert.equal(el.getAttribute("aria-label"), "open book");
  assert.equal(el.dataset.ready, "yes");
  assert.equal(host.firstChild, el);
});

test("createDiv and createSpan accept string or object options", () => {
  const host = document.createElement("div");
  const div = host.createDiv("plain");
  const span = host.createSpan({ text: "hello" });
  assert.equal(div.className, "plain");
  assert.equal(span.tagName, "SPAN");
  assert.equal(span.getText(), "hello");
});

test("class, text and attribute helpers round-trip", () => {
  const el = document.createElement("div");
  el.addClass("a b");
  el.toggleClass("c", true);
  assert.equal(el.hasClass("a"), true);
  assert.equal(el.hasClass("c"), true);
  el.removeClass("a");
  assert.equal(el.hasClass("a"), false);
  el.setText(0);
  assert.equal(el.getText(), "0");
  el.appendText("!");
  assert.equal(el.getText(), "0!");
  el.setAttr("data-x", 5);
  assert.equal(el.getAttribute("data-x"), "5");
  el.setAttrs({ "data-y": "z" });
  assert.equal(el.getAttribute("data-y"), "z");
  el.setAttr("data-x", null);
  assert.equal(el.hasAttribute("data-x"), false);
  el.setCssProps({ "--qbr-test": "3" });
  assert.equal(el.style.getPropertyValue("--qbr-test"), "3");
});

test("empty, find and detach operate on the subtree", () => {
  const host = document.createElement("div");
  const child = host.createDiv("child");
  child.createSpan({ text: "x" });
  assert.equal(host.find(".child"), child);
  assert.equal(host.findAll("span").length, 1);
  host.empty();
  assert.equal(host.childNodes.length, 0);
  const detached = document.createElement("div");
  document.body.appendChild(detached);
  detached.detach();
  assert.equal(detached.isConnected, false);
});
