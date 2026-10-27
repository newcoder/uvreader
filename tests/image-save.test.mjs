import assert from "node:assert/strict";
import test from "node:test";

import { imageSavePayload, saveImageFromSource } from "../packages/reader/src/image-save.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("a data-URL image is passed to the save bridge with its name and MIME type", async () => {
  const received = [];
  const result = await saveImageFromSource(`data:image/png;base64,${PNG}`, {
    name: "截图 10-26 12.30.00.png",
    bridge: {
      save: async (payload) => {
        received.push(payload);
        return { ok: true, path: "C:/Users/me/Pictures/截图.png" };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].data, PNG);
  assert.equal(received[0].mimeType, "image/png");
  assert.equal(received[0].name, "截图 10-26 12.30.00.png");
});

test("a source without the desktop bridge fails with a clear message", async () => {
  await assert.rejects(
    () => saveImageFromSource(`data:image/png;base64,${PNG}`, { name: "pic.png" }),
    /桌面应用/,
  );
});

test("the payload keeps PNG bytes and rejects empty images", async () => {
  const payload = await imageSavePayload(`data:image/png;base64,${PNG}`, { name: "pic" });
  assert.equal(payload.data, PNG);
  await assert.rejects(() => imageSavePayload("", { name: "pic" }), /没有可保存/);
});
