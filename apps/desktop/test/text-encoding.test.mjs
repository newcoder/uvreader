import test from "node:test";
import assert from "node:assert/strict";

import { decodeText, stripBom, textQuality } from "../src/shared/text-encoding.js";

// 「第一章 起风了」的 GB18030 字节(实测解出来就是这七个字)。
const GBK = Buffer.from([0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xC6, 0xF0, 0xB7, 0xE7, 0xC1, 0xCB]);
const TEXT = "第一章 起风了";

test("GB18030 Chinese text decodes instead of turning into mojibake", () => {
  assert.equal(decodeText(GBK), TEXT);
  assert.equal(decodeText(Buffer.concat([Buffer.from("preface\r\n", "utf8"), GBK])), `preface\r\n${TEXT}`);
});

test("UTF-8 keeps working with or without a BOM", () => {
  assert.equal(decodeText(Buffer.from(TEXT, "utf8")), TEXT);
  assert.equal(decodeText(Buffer.from(`\uFEFF${TEXT}`, "utf8")), TEXT);
  assert.equal(decodeText(Buffer.from("plain ascii\n", "utf8")), "plain ascii\n");
  assert.equal(stripBom("\uFEFFx"), "x");
});

test("UTF-16 with a BOM decodes in both byte orders", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, "utf16le")]);
  assert.equal(decodeText(le), TEXT);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT, "utf16le").swap16()]);
  assert.equal(decodeText(be), TEXT);
});

test("UTF-16 without a BOM is picked by which byte order reads as text", () => {
  const le = Buffer.from(TEXT, "utf16le");
  assert.equal(decodeText(le), TEXT, "小端");
  assert.equal(decodeText(Buffer.from(TEXT, "utf16le").swap16()), TEXT, "大端");
  assert.ok(textQuality("第一章 起风了") > textQuality("㴽㴽㴽㴽"), "错序解出来的怪字质量更低");
});

test("empty and tiny inputs stay harmless", () => {
  assert.equal(decodeText(Buffer.alloc(0)), "");
  assert.equal(decodeText(Buffer.from([0x41])), "A");
  assert.equal(decodeText(new Uint8Array([0x42, 0x43])), "BC");
});
