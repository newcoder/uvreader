import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

import {
  appendNumbering,
  groupDocxLists,
  listInfoOfParagraph,
  planNumbering,
  restoreDocxLists,
  rewriteDocxLists,
  scanDocxParagraphs,
} from "../src/main/docx-numbering.js";

// DocVortex 画出来的段落(实测结构):列表项 = 字面标记 + w:ind 左缩进,没有 w:numPr。
const para = (text, indent = "", style = "") => `<w:p><w:pPr>${style}${indent ? `<w:ind w:left="${indent}"/>` : ""}</w:pPr>`
  + `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

function fixture() {
  return [
    '<w:document xmlns:w="w"><w:body>',
    para("Specification of DUL"),
    para("1. General requirements:", "340"),
    para("- High-performance workstation", "680"),
    para("- Chipset: Intel Q870", "680"),
    para("2. CPU", "340"),
    para("- Model: Ultra 9", "680"),
    para("N/A", ""),
    para("1. 另一份清单", "340"),
    para("2. 第二项", "340"),
    "</w:body></w:document>",
  ].join("");
}

test("listInfoOfParagraph only claims indented marker paragraphs", () => {
  assert.equal(listInfoOfParagraph(para("正文段落", "340")), null, "没有标记就不算列表");
  assert.equal(listInfoOfParagraph(para("1. 没有缩进", "")), null, "顶格的 1. 是正文,不动它");
  const ordered = listInfoOfParagraph(para("1. General requirements:", "340"));
  assert.equal(ordered.kind, "ol");
  assert.equal(ordered.level, 0);
  assert.equal(ordered.marker, "1. ");
  assert.equal(ordered.start, 1);
  const nested = listInfoOfParagraph(para("- Chipset", "680"));
  assert.equal(nested.kind, "ul");
  assert.equal(nested.level, 1);
  const third = listInfoOfParagraph(para("- 第三层", "1020"));
  assert.equal(third.level, 2);
});

test("groupDocxLists keeps a section's bullets and the following number in one block", () => {
  const paragraphs = scanDocxParagraphs(fixture());
  groupDocxLists(paragraphs);
  const lists = paragraphs.filter((paragraph) => paragraph.list);
  assert.equal(lists.length, 7);
  const groups = [...new Set(lists.map((paragraph) => paragraph.group))];
  assert.equal(groups.length, 3, "块一:ol@0 + ul@1;块二(正文之后):ol@0");
  const first = groups.find((group) => group.kind === "ol" && group.level === 0);
  assert.equal(first.paragraphs.length, 2, "1. 和 2. 在同一个有序列表里(中间夹着细则也不断)");
  assert.deepEqual(first.paragraphs.map((paragraph) => paragraph.list.start), [1, 2]);
  assert.equal(first.paragraphs[0].list.usable, true);
  const bullets = groups.find((group) => group.kind === "ul");
  assert.equal(bullets.paragraphs.length, 3, "三行细则是一个 bullet 列表");
  const later = groups.find((group) => group !== first && group.kind === "ol");
  assert.ok(later && later !== first, "普通段落打断列表:后面的清单是新的块(从 1 重新开始)");
  assert.equal(later.start, 1);
});

test("groupDocxLists keeps deliberately non-sequential numbering as text", () => {
  const xml = [para("1. 一", "340"), para("3. 三", "340"), para("4. 四", "340")].join("");
  const paragraphs = scanDocxParagraphs(xml);
  groupDocxLists(paragraphs);
  assert.equal(paragraphs[0].group.sequential, false);
  assert.equal(paragraphs[0].list.usable, false, "跳号的不换自动编号");
});

test("rewriteDocxLists swaps the marker for w:numPr and drops the level indent", () => {
  const xml = fixture();
  const paragraphs = scanDocxParagraphs(xml);
  const { ids } = planNumbering(groupDocxLists(paragraphs).flatMap((block) => block.groups));
  const out = rewriteDocxLists(xml, paragraphs, ids);
  assert.ok(!out.includes(">1. General requirements:<"), "字面编号去掉了");
  assert.match(out, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/);
  assert.match(out, /<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="\d+"\/><\/w:numPr>/, "细则按第 2 层");
  assert.match(out, /<w:t xml:space="preserve">General requirements:<\/w:t>/);
  assert.match(out, /<w:t xml:space="preserve">High-performance workstation<\/w:t>/, "只去掉标记,正文不动");
  assert.ok(!out.includes('<w:ind w:left="340"/>'), "缩进交给编号层级,避免叠一层");
  assert.match(out, /<w:t xml:space="preserve">Specification of DUL<\/w:t>/, "普通段落原样");
});

test("rewriteDocxLists keeps pStyle ahead of numPr when the paragraph has one", () => {
  const xml = para("1. 标题项", "340", '<w:pStyle w:val="ListParagraph"/>');
  const paragraphs = scanDocxParagraphs(xml);
  const { ids } = planNumbering(groupDocxLists(paragraphs).flatMap((block) => block.groups));
  const out = rewriteDocxLists(xml, paragraphs, ids);
  assert.match(out, /<w:pStyle w:val="ListParagraph"\/><w:numPr>/, "CT_PPr 的顺序:pStyle 在前");
});

test("appendNumbering inserts abstractNum before the existing w:num entries", () => {
  const stock = '<?xml version="1.0"?><w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="0"></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
  const { abstract, num } = { abstract: 1, num: 2 };
  const out = appendNumbering(stock, {
    abstracts: [`<w:abstractNum w:abstractNumId="${abstract}"></w:abstractNum>`],
    nums: [`<w:num w:numId="${num}"><w:abstractNumId w:val="${abstract}"/></w:num>`],
  });
  assert.ok(out.indexOf(`<w:abstractNum w:abstractNumId="${abstract}"`) < out.indexOf(`<w:num w:numId="${num}"`), "abstractNum 必须排在所有 w:num 之前");
  assert.ok(out.includes('<w:num w:numId="1">'), "原有编号保留");
  assert.ok(out.endsWith("</w:numbering>"));
});

test("planNumbering reuses one abstractNum per list kind and honours the start number", () => {
  const xml = [para("3. 三", "340"), para("4. 四", "340"), para("- a", "680")].join("");
  const paragraphs = scanDocxParagraphs(xml);
  const groups = groupDocxLists(paragraphs).flatMap((block) => block.groups);
  const { ids, abstracts, nums } = planNumbering(groups);
  assert.equal(ids.size, 2);
  assert.equal(abstracts.length, 2, "ol 与 ul 各一份");
  assert.match(nums[0], /<w:startOverride w:val="3"\/>/, "原文从 3 开始就还是 3");
  assert.match(nums[0], /<w:abstractNumId w:val="\d+"\/><w:lvlOverride/, "abstractNumId 在 lvlOverride 之前");
});

test("restoreDocxLists rewrites a real zip and stays idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docx-numbering-"));
  const file = path.join(dir, "out.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file("word/numbering.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="0"></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  zip.file("word/document.xml", `<?xml version="1.0"?>${fixture()}`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));

  const count = await restoreDocxLists(file);
  assert.equal(count, 7, "7 个列表段落都换成了真编号");
  const reread = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await reread.file("word/document.xml").async("string");
  const numbering = await reread.file("word/numbering.xml").async("string");
  assert.equal((xml.match(/<w:numPr>/g) || []).length, 7);
  assert.ok(!/w:t[^>]*>\s*\d+\.\s/.test(xml), "不再有字面编号");
  assert.equal((numbering.match(/<w:abstractNum w:abstractNumId="\d+"/g) || []).length, 3, "原有 1 份 + ol/ul 各一份");
  assert.ok(numbering.includes('<w:numFmt w:val="decimal"/>') && numbering.includes('<w:numFmt w:val="bullet"/>'));
  assert.equal(await restoreDocxLists(file), 0, "再跑一次没有可改的(幂等)");
});
