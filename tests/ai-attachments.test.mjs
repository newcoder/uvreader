import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_IMAGE_MAX_EDGE,
  MAX_AI_ATTACHMENTS,
  aiAttachmentBlocks,
  aiAttachmentFileName,
  aiAttachmentPath,
  aiImageMime,
  attachmentId,
  blobFromBase64,
  bytesLabel,
  hydrateAiAttachments,
  imageAttachmentFromBlob,
  intakeAiFiles,
  normalizeAiAttachments,
  scaleSize,
  stripAttachmentData,
} from "../packages/reader/src/ai-attachments.js";

const IMAGE = {
  id: "att-1",
  kind: "image",
  name: "figure.png",
  mimeType: "image/png",
  bytes: 1234,
  width: 800,
  height: 600,
  thumb: "data:image/jpeg;base64,QQ==",
  file: "plugin/ai-files/att-1.png",
  source: "drop",
};

test("attachment mime sniffing trusts the declared type then the extension", () => {
  assert.equal(aiImageMime("a.png", ""), "image/png");
  assert.equal(aiImageMime("a.jpg", "image/jpeg"), "image/jpeg");
  assert.equal(aiImageMime("a.bin", "image/webp"), "image/webp");
  assert.equal(aiImageMime("a.txt", "text/plain"), "");
  assert.equal(aiImageMime("a.weird", ""), "");
});

test("normalization caps the list and rejects entries without an id", () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...IMAGE, id: `att-${index}` }));
  assert.equal(normalizeAiAttachments([...many, { kind: "image" }]).length, MAX_AI_ATTACHMENTS);
  assert.deepEqual(normalizeAiAttachments("nope"), []);
  const [clean] = normalizeAiAttachments([{ ...IMAGE, id: "att$bad!", data: "AAAA" }]);
  assert.equal(clean.id, "attbad");
  assert.equal(clean.kind, "image");
  assert.equal(clean.data, "AAAA", "in-memory data survives normalization");
  assert.equal(clean.source, "drop");
  assert.equal(clean.file, "plugin/ai-files/att-1.png");
});

test("stored attachments drop the base64 payload but keep the reference", () => {
  const [stored] = stripAttachmentData([{ ...IMAGE, data: "AAAA" }]);
  assert.equal("data" in stored, false);
  assert.equal(stored.file, IMAGE.file);
  assert.equal(stored.thumb, IMAGE.thumb);
  const [text] = normalizeAiAttachments([{ id: "t1", kind: "text", name: "notes.md", text: "# hi", bytes: 4 }]);
  assert.equal(text.text, "# hi");
  assert.equal(aiAttachmentFileName(text), "t1.txt");
})

test("stored file names and paths follow the mime type and data folder", () => {
  assert.equal(aiAttachmentFileName(IMAGE), "att-1.png");
  assert.equal(aiAttachmentFileName({ id: "att-2", kind: "image", mimeType: "image/jpeg" }), "att-2.jpg");
  assert.equal(aiAttachmentPath("plugin", IMAGE), "plugin/ai-files/att-1.png");
  assert.equal(aiAttachmentPath("data/", IMAGE), "data/ai-files/att-1.png");
  assert.equal(aiAttachmentPath("", { id: "x", kind: "text" }), "plugin/ai-files/x.txt");
});

test("model blocks carry text attachments first and images with their data", () => {
  const blocks = aiAttachmentBlocks([
    { id: "i1", kind: "image", mimeType: "image/png", data: "AAAA" },
    { id: "t1", kind: "text", name: "notes.md", text: "hello" },
    { id: "i2", kind: "image", mimeType: "image/png" },
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "【附件：notes.md】\nhello" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
});

test("hydration reads missing image bytes and marks unreadable ones", async () => {
  const hydrated = await hydrateAiAttachments([
    { ...IMAGE, data: "" },
    { ...IMAGE, id: "att-2", file: "plugin/ai-files/att-2.png" },
  ], async (file) => (file.endsWith("att-1.png") ? "BBBB" : ""));
  assert.equal(hydrated[0].data, "BBBB");
  assert.equal(hydrated[1].data, undefined);
});

test("sizes scale down only when needed and labels stay readable", () => {
  assert.deepEqual(scaleSize(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(scaleSize(3200, 1600, 1600), { width: 1600, height: 800 });
  assert.deepEqual(scaleSize(0, 0, 1600), { width: 0, height: 0 });
  assert.equal(bytesLabel(900), "900 B");
  assert.equal(bytesLabel(2048), "2 KB");
  assert.equal(bytesLabel(3 * 1024 * 1024), "3.0 MB");
});

test("image intake downscales the bitmap and builds a thumbnail", async () => {
  const draws = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args) => draws.push([canvas.width, canvas.height]) }),
    toDataURL: (mime) => `data:${mime};base64,QUJD`,
  };
  const bitmap = { width: 3200, height: 1600, close: () => draws.push("closed") };
  const attachment = await imageAttachmentFromBlob({ type: "image/png", size: 900_000 }, {
    name: "figure.png",
    source: "paste",
    id: "att-9",
    win: { document: { createElement: () => canvas }, createImageBitmap: async () => bitmap },
  });
  assert.equal(attachment.id, "att-9");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.width, AI_IMAGE_MAX_EDGE);
  assert.equal(attachment.height, 800);
  assert.match(attachment.thumb, /^data:image\/jpeg;base64,/);
  assert.deepEqual(draws, [[1600, 800], [160, 80], "closed"]);
});

test("file intake accepts images and text and reports the rest", async () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => "data:image/png;base64,QQ==",
  };
  const image = { name: "shot.png", type: "image/png", size: 1000 };
  const text = { name: "notes.md", type: "text/markdown", size: 12, text: async () => "# notes" };
  const binary = { name: "book.epub", type: "", size: 10 };
  const big = { name: "huge.png", type: "image/png", size: 7 * 1024 * 1024 };
  const { attachments, errors } = await intakeAiFiles([image, text, binary, big], {
    win: { document: { createElement: () => canvas }, createImageBitmap: async () => ({ width: 400, height: 300 }) },
  });
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].kind, "image");
  assert.equal(attachments[1].kind, "text");
  assert.equal(attachments[1].text, "# notes");
  assert.deepEqual(errors, [{ name: "book.epub", reason: "unsupported" }, { name: "huge.png", reason: "imagetooolarge" }]);
});

test("base64 becomes a blob and ids stay filesystem safe", () => {
  const blob = blobFromBase64("QUJD", "image/png");
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 3);
  assert.match(attachmentId(1, () => 0.5), /^att-[0-9a-z]+-[0-9a-z]+$/);
});
