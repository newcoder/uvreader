import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";

import { configureHost, installDomExtensions } from "../src/index.js";

export function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  installDomExtensions(dom.window);
  return dom;
}

export function setupHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-shim-"));
  const vaultRoot = path.join(root, "library");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  configureHost({
    fs,
    path,
    os,
    vaultRoot,
    dataRoot,
    vaultName: "Test Vault",
    isMobile: false,
    fetchImpl: null,
    iconResolver: null,
    renderMarkdown: null,
    secrets: null,
  });
  return {
    root,
    vaultRoot,
    dataRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
