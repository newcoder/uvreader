import assert from "node:assert/strict";
import test from "node:test";

import { DOCVORTEX_FORMATS, DOCVORTEX_INPUTS, WORKSHOP_PICK_EXTENSIONS, docvortexFormatExt } from "../src/shared/workshop-formats.js";

test("the pick dialog offers Office/ODF/OFD/text/image documents", () => {
  for (const ext of ["docx", "pptx", "xlsx", "odt", "ods", "odp", "ofd", "epub", "pdf", "txt", "md", "png"]) {
    assert.ok(WORKSHOP_PICK_EXTENSIONS.includes(ext), `${ext} should be pickable`);
  }
  assert.equal(new Set(WORKSHOP_PICK_EXTENSIONS).size, WORKSHOP_PICK_EXTENSIONS.length, "no duplicates");
});

test("format conversion keeps layout-preserving targets only", () => {
  const ids = DOCVORTEX_FORMATS.map((format) => format.id);
  assert.ok(ids.includes("epub") && ids.includes("docx") && ids.includes("pdf"));
  assert.ok(!ids.includes("structured_content"), "JSON belongs to 内容提取");
  assert.equal(docvortexFormatExt("markdown"), "md");
  assert.equal(docvortexFormatExt("structured_content"), "structured_content", "unknown ids fall back to the raw value");
  assert.ok(DOCVORTEX_INPUTS.includes("ofd"));
});
