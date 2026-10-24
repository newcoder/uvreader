import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createPdfFormController } from "../../../packages/reader/src/pdf-form.js";

test("comb fields render one cell per allowed character", async () => {
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

  let saved = null;
  const bridge = {
    inspect: async () => ({
      ok: true,
      fields: [{
        id: "p1:700",
        xref: 700,
        page: 1,
        kind: "text",
        comb: true,
        name: "member",
        value: "AB",
        readOnly: false,
        maxLength: 4,
        left: 0.1,
        top: 0.2,
        width: 0.4,
        height: 0.05,
      }],
      pages: [{ page: 1, width: 600, height: 800 }],
    }),
    save: async (payload) => { saved = payload; return { ok: true, output: "/tmp/signed.pdf" }; },
  };
  const view = {
    file: { extension: "pdf", path: "/tmp/form.pdf" },
    plugin: { settings: {} },
    areaEl: area,
    pager: { flow },
  };
  const controller = createPdfFormController({
    view,
    bridge,
    translate: (key) => key,
    notify: () => {},
    onChange: () => {},
  });
  controller.setFile(view.file);
  await controller.open();
  const cells = [...surface.querySelectorAll(".qiaomu-reader-pdf-comb-cell")];
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map((cell) => cell.value), ["A", "B", "", ""]);
  cells[2].value = "C";
  cells[2].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await controller.save();
  assert.deepEqual(saved.values, [{ xref: 700, value: "ABC" }]);
});
