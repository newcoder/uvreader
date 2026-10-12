// 验证:docx 的页眉(header 部件)会不会进 DocVortex 的产物。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const zip = new JSZip();
zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`);
zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`);
zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${R}/header" Target="header1.xml"/>
</Relationships>`);
zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
  <w:p><w:r><w:t>正文第一段:这里应该只有正文。</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文第二段。</w:t></w:r></w:p>
  <w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`);
zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>内部资料 · 请勿外传</w:t></w:r></w:p></w:hdr>`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docx-header-"));
const docx = path.join(work, "带页眉.docx");
fs.writeFileSync(docx, await zip.generateAsync({ type: "nodebuffer" }));
console.log("生成:", docx);

const out = path.join(work, "out.md");
try {
  execFileSync("docvortex", ["convert", docx, "--format", "markdown", "--output", out, "--overwrite"], { encoding: "utf8" });
  const md = fs.readFileSync(out, "utf8");
  console.log("产物长度:", md.length);
  console.log("含页眉文字「内部资料」:", md.includes("内部资料"));
  console.log("含正文:", md.includes("正文第一段"));
  console.log("--- 产物 ---");
  console.log(md.slice(0, 300));
} catch (error) {
  console.log("失败:", String(error.stdout || error.message).slice(-200));
}
