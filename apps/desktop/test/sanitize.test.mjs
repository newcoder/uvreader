import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { isBlockedHref, sanitizeHtml } from "../src/renderer/sanitize.js";

const { window } = new JSDOM("<!doctype html><body></body>");
const { document } = window;

function clean(html) {
  return sanitizeHtml(document, html);
}

test("active content elements are dropped", () => {
  const html = clean('<p>text</p><script>alert(1)</script><iframe src="x"></iframe><object data="x"></object><embed src="x"><meta http-equiv="refresh" content="0;url=http://x"><base href="http://x/"><form action="http://x"><input></form>');
  assert.match(html, /<p>text<\/p>/);
  assert.doesNotMatch(html, /script|iframe|object|embed|meta|base|form|input/i);
});

test("event handler attributes are removed everywhere", () => {
  const html = clean('<p onclick="steal()">a</p><img src="x.png" onerror="steal()"><svg onload="steal()"></svg>');
  assert.doesNotMatch(html, /onclick|onerror|onload/i);
});

test("javascript and control-character-split schemes are removed", () => {
  assert.doesNotMatch(clean('<a href="javascript:alert(1)">x</a>'), /javascript:/i);
  assert.doesNotMatch(clean('<a href="java\tscript:alert(1)">x</a>'), /script:/i);
  assert.doesNotMatch(clean('<a href="JaVaScRiPt:alert(1)">x</a>'), /href/i);
  assert.doesNotMatch(clean('<a href="vbscript:msgbox(1)">x</a>'), /vbscript:/i);
});

test("link schemes are allowlisted and relative links survive", () => {
  const html = clean('<a href="https://example.com/a">h</a><a href="#anchor">a</a><a href="notes/b.md">n</a><a href="mailto:me@example.com">m</a><a href="file:///C:/secret">f</a><a href="data:text/html,<b>x</b>">d</a>');
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /href="#anchor"/);
  assert.match(html, /href="notes\/b\.md"/);
  assert.match(html, /href="mailto:me@example\.com"/);
  assert.doesNotMatch(html, /href="file:/i);
  assert.doesNotMatch(html, /href="data:/i);
});

test("images keep safe sources and drop inline documents", () => {
  const html = clean('<img src="https://example.com/a.png"><img src="file:///C:/cover.png"><img src="data:image/png;base64,QUJD"><img src="data:text/html;base64,PGI+"><img src="javascript:alert(1)">');
  assert.match(html, /src="https:\/\/example\.com\/a\.png"/);
  assert.match(html, /src="file:\/\/\/C:\/cover\.png"/);
  assert.match(html, /src="data:image\/png;base64,QUJD"/);
  assert.doesNotMatch(html, /data:text\/html/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test("srcdoc, srcset, ping and form actions are stripped", () => {
  const html = clean('<a href="https://example.com" ping="https://track.example/p" action="post" formaction="post">x</a><img src="a.png" srcset="b.png 2x">');
  assert.doesNotMatch(html, /ping|action|formaction|srcset/i);
});

test("isBlockedHref flags executable schemes only", () => {
  assert.equal(isBlockedHref("javascript:alert(1)"), true);
  assert.equal(isBlockedHref("java\tscript:alert(1)"), true);
  assert.equal(isBlockedHref("data:text/html,x"), true);
  assert.equal(isBlockedHref("file:///C:/x"), true);
  assert.equal(isBlockedHref("https://example.com"), false);
  assert.equal(isBlockedHref("mailto:me@example.com"), false);
  assert.equal(isBlockedHref("./notes/a.md"), false);
  assert.equal(isBlockedHref("#anchor"), false);
});
