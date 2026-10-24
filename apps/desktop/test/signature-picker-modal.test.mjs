import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installDomExtensions } from "../../../packages/host-shim/src/index.js";
import { createSignaturePickerModal } from "../../../packages/reader/src/signature-picker-modal.js";

test("the signature picker shows saved signature images and picks one", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  installDomExtensions(dom.window);
  const app = { doc: dom.window.document };
  class Modal {
    constructor(owner) {
      this.app = owner;
      this.modalEl = this.app.doc.createElement("div");
      this.contentEl = this.app.doc.createElement("div");
      this.modalEl.appendChild(this.contentEl);
    }
    open() { this.onOpen(); }
    close() { this.closed = true; }
  }
  const Picker = createSignaturePickerModal({
    Modal,
    qiaomuReaderTranslate: (key) => key,
  });
  let picked = null;
  let imported = false;
  const modal = new Picker(app, {
    signatures: [
      { id: "a", dataUrl: "data:image/png;base64,AAA", naturalWidth: 100, naturalHeight: 40 },
      { id: "b", dataUrl: "data:image/png;base64,BBB", naturalWidth: 80, naturalHeight: 30 },
    ],
    onPick: (signature) => { picked = signature; },
    onImport: () => { imported = true; },
  });
  modal.open();

  const images = [...modal.contentEl.querySelectorAll(".qiaomu-reader-signature-choice img")];
  assert.equal(images.length, 2);
  assert.match(images[0].getAttribute("src"), /base64,AAA/);
  modal.contentEl.querySelectorAll(".qiaomu-reader-signature-choice")[1].click();
  assert.equal(picked.id, "b");
  assert.equal(modal.closed, true);

  modal.onOpen();
  modal.contentEl.querySelector(".qiaomu-reader-signature-import").click();
  assert.equal(imported, true);
  dom.window.close();
});

test("the signature picker explains an empty library", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  installDomExtensions(dom.window);
  class Modal {
    constructor(owner) {
      this.app = owner;
      this.modalEl = this.app.doc.createElement("div");
      this.contentEl = this.app.doc.createElement("div");
      this.modalEl.appendChild(this.contentEl);
    }
    open() { this.onOpen(); }
    close() { this.closed = true; }
  }
  const Picker = createSignaturePickerModal({
    Modal,
    qiaomuReaderTranslate: (key) => key,
  });
  const modal = new Picker({ doc: dom.window.document }, { signatures: [] });
  modal.open();
  assert.match(modal.contentEl.textContent, /no-saved-signatures/);
  assert.ok(modal.contentEl.querySelector(".qiaomu-reader-signature-import"));
  dom.window.close();
});
