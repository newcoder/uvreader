import assert from "node:assert/strict";
import test from "node:test";

import { iconResolver, rasterIconMarkup } from "../src/renderer/icons.js";

test("toolbar names resolve to the sliced raster masks", () => {
  const markup = rasterIconMarkup("sparkles");
  assert.match(markup, /class="svg-icon qbr-raster-icon qbr-icon-ai-chat"/);
  assert.doesNotMatch(markup, /<path/, "the raster icon carries no inline geometry");
  assert.match(iconResolver("arrow-left"), /qbr-icon-back/);
  assert.match(iconResolver("zoom-in"), /qbr-icon-zoom-in/);
  assert.match(iconResolver("chevron-right"), /qbr-icon-next-page/);
});

test("every mapped name has a sliced counterpart", () => {
  for (const name of [
    "arrow-left", "home", "search", "zoom-out", "zoom-in", "chevron-left", "chevron-right",
    "sparkles", "wand-sparkles", "maximize", "message-square", "message", "comment", "file-text", "note",
    "reading-note", "list", "library", "qiaomu-library",
  ]) {
    assert.match(rasterIconMarkup(name), /qbr-raster-icon/, name);
  }
});

test("unmapped names keep the inline SVG table", () => {
  assert.equal(rasterIconMarkup("sliders"), "");
  const svg = iconResolver("sliders");
  assert.match(svg, /<line/, "the fallback draws its own geometry");
  assert.doesNotMatch(svg, /qbr-raster-icon/);
  assert.match(iconResolver("not-a-real-icon"), /M12 7v14/, "unknown names fall back to the book glyph");
});
