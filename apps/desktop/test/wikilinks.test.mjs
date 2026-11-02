import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { decorateWikilinks } from "../src/renderer/wikilinks.js";

test("wikilinks become internal note links while code and anchors stay untouched", () => {
  const { window } = new JSDOM(`<div id="root">
    <p>See [[Standalone note]] and [[Another|alias]] and [[Book#Chapter 2|chapter]].</p>
    <p><code>[[not-a-link]]</code></p>
    <p><a href="https://example.com">[[also-not]]</a></p>
    <p>![[image.png]]</p>
  </div>`);
  const root = window.document.querySelector("#root");
  assert.equal(decorateWikilinks(root), 1);
  const links = [...root.querySelectorAll("a.qbr-wikilink")];
  assert.deepEqual(links.map((link) => link.textContent), ["Standalone note", "alias", "chapter"]);
  assert.deepEqual(links.map((link) => link.getAttribute("data-wikilink")), ["Standalone note", "Another", "Book"]);
  assert.equal(links[2].getAttribute("data-fragment"), "Chapter 2");
  assert.match(root.querySelector("code")?.textContent || "", /\[\[not-a-link\]\]/);
  assert.match(root.querySelector("p a[href='https://example.com']")?.textContent || "", /\[\[also-not\]\]/);
  assert.match(root.textContent, /!\[\[image\.png\]\]/);
});
