import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/renderer/polish-view.js", import.meta.url), "utf8");
const viewsSource = fs.readFileSync(new URL("../src/renderer/views.js", import.meta.url), "utf8");

test("the polish cover picker selects image mode and repairs the old template state", () => {
  const pickBlock = source.slice(
    source.indexOf("pick.addEventListener"),
    source.indexOf('form.createDiv({ cls: "qbr-polish-info-note", text: "封面会在下一次'),
  );
  assert.match(pickBlock, /coverMode\.value = "image"/, "choosing an image must switch the cover mode");
  assert.match(source, /legacyImageCover \? "image" : savedCoverMode/, "an old template+image manifest opens in image mode");
  assert.match(source, /coverModeExplicit: coverModeTouched/, "an intentional switch back to template must be sent to the main process");
});

test("the book-build payload only sends an image path in image mode", () => {
  assert.match(
    viewsSource,
    /imagePath: state\.coverMode === "image" \? state\.coverImage : ""/,
    "template/auto builds must not store a stale image path",
  );
});
