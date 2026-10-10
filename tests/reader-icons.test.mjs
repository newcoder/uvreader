import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../packages/host-shim/src/index.js";
import { ensureSvgNamespace, iconLabel, parseSvgRoot, setIconProvider, svgIcon } from "../packages/reader/src/reader-icons.js";

test("svgIcon renders the inline icon table and clears the host first", () => {
  const { window } = new JSDOM("<div><span>stale</span></div>");
  installDomExtensions(window);
  const host = window.document.querySelector("div");
  svgIcon(host, "arrow-left");
  assert.equal(host.querySelectorAll("svg").length, 1);
  assert.equal(host.textContent, "", "the previous content is replaced");
  svgIcon(host, "not-an-icon");
  assert.equal(host.querySelectorAll("svg").length, 0, "unknown names render nothing");
});

test("iconLabel pairs the icon with a visible text label", () => {
  const { window } = new JSDOM("<button></button>");
  installDomExtensions(window);
  const host = window.document.querySelector("button");
  iconLabel(host, "close", "关闭");
  assert.equal(host.querySelectorAll("svg").length, 1);
  assert.equal(host.textContent, "关闭");
});

test("a host icon provider replaces mapped icons and unmapped ones keep the table", () => {
  const { window } = new JSDOM("<button></button>");
  installDomExtensions(window);
  const host = window.document.querySelector("button");
  setIconProvider((name) => (name === "back" ? '<svg class="raster"></svg>' : ""));
  try {
    svgIcon(host, "back");
    assert.equal(host.querySelectorAll("svg.raster").length, 1, "the host artwork wins");
    svgIcon(host, "search");
    assert.equal(host.querySelectorAll("svg.raster").length, 0);
    assert.equal(host.querySelectorAll("svg").length, 1, "unmapped names fall back to the inline table");
  } finally {
    setIconProvider(null);
  }
  svgIcon(host, "back");
  assert.equal(host.querySelectorAll("svg.raster").length, 0, "clearing the provider restores the table");
});

test("ensureSvgNamespace and parseSvgRoot guard malformed markup", () => {
  const { window } = new JSDOM("<div></div>");
  installDomExtensions(window);
  assert.match(ensureSvgNamespace("<svg></svg>"), /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(ensureSvgNamespace('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(ensureSvgNamespace(""), "");
  assert.equal(parseSvgRoot("<svg", window), null, "a parse error yields no root");
});
