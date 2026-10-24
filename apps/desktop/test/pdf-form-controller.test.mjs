import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createPdfFormController } from "../../../packages/reader/src/pdf-form.js";

test("the in-reader form layer fills a field and sends it to the desktop bridge", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const area = doc.createElement("div");
  const flow = doc.createElement("div");
  const holder = doc.createElement("div");
  holder.setAttribute("data-pdf-page-no", "1");
  const surface = doc.createElement("div");
  surface.className = "qiaomu-reader-pdf-page-surface";
  holder.appendChild(surface);
  flow.appendChild(holder);
  area.appendChild(flow);
  doc.body.appendChild(area);

  const calls = [];
  const bridge = {
    inspect: async () => ({
      ok: true,
      fields: [{
        id: "p1:571",
        xref: 571,
        page: 1,
        kind: "text",
        name: "name",
        value: "before",
        readOnly: false,
        maxLength: 20,
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.05,
      }],
      pages: [{ page: 1, width: 600, height: 800 }],
    }),
    save: async (payload) => {
      calls.push(payload);
      return { ok: true, output: "/tmp/signed.pdf" };
    },
  };
  const savedSignatures = [
    { id: "saved-a", dataUrl: "data:image/png;base64,AAA", naturalWidth: 120, naturalHeight: 40 },
    { id: "saved-b", dataUrl: "data:image/png;base64,BBB", naturalWidth: 120, naturalHeight: 40 },
  ];
  let saveAllCount = 0;
  let picker = null;
  const view = {
    file: { extension: "pdf", path: "/tmp/form.pdf" },
    plugin: {
      settings: { pdfSignatures: savedSignatures.slice() },
      saveAll: async () => { saveAllCount += 1; },
    },
    areaEl: area,
    pager: { flow },
  };
  const notices = [];
  const controller = createPdfFormController({
    view,
    bridge,
    translate: (key, value) => key.replace("{0}", value ?? ""),
    notify: (message) => notices.push(message),
    onChange: () => {},
    openSignaturePicker: (options) => { picker = options; return true; },
  });

  controller.setFile(view.file);
  await controller.open();
  const input = surface.querySelector("input");
  assert.ok(input);
  assert.equal(input.value, "before");
  input.value = "after";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  await controller.pickSignature();
  assert.equal(picker.signatures.length, 2, "saved signatures are offered in the picker");
  picker.onPick(savedSignatures[1]);
  assert.equal(controller.pendingSignature.dataUrl, savedSignatures[1].dataUrl);
  controller.pendingSignature = null;
  area.classList.remove("qiaomu-reader-pdf-form-signing");
  controller._rememberSignature({
    id: "saved-c",
    dataUrl: "data:image/png;base64,CCC",
    naturalWidth: 90,
    naturalHeight: 30,
  });
  assert.equal(view.plugin.settings.pdfSignatures.length, 3);
  assert.equal(saveAllCount, 1);

  await controller.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/tmp/form.pdf");
  assert.deepEqual(calls[0].values, [{ xref: 571, value: "after" }]);
  assert.match(notices.at(-1), /saved-0-2/);
  assert.equal(controller.isActive, true, "an unsigned save leaves the form editable");
  assert.equal(controller.isLocked, false);
  assert.ok(surface.querySelector(".qiaomu-reader-pdf-form-layer"));

  controller.signatures.push({
    id: "sig1",
    page: 1,
    left: 0.1,
    top: 0.1,
    width: 0.2,
    height: 0.1,
    dataUrl: "data:image/png;base64,AAAA",
  });
  await controller.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].signatures.length, 1);
  assert.match(notices.at(-1), /signed-copy-saved-0/);
  assert.equal(controller.isActive, false, "a signed save closes the form");
  assert.equal(controller.isLocked, true, "a signed save locks the form");
  assert.equal(controller.available, false);
  assert.equal(surface.querySelector(".qiaomu-reader-pdf-form-layer"), null);
});
