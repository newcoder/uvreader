import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { JSDOM } from "jsdom";

import { buildNavigationEpub, buildNavigationEpubFromTitles } from "../packages/reader/src/epub-export.js";

async function sampleEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata/><manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine>
    </package>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <head><title>Contents</title></head>
      <body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml"></a></li></ol></nav></body>
    </html>`);
  zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
      <navMap><navPoint id="n1" playOrder="1"><navLabel><text>Old</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap>
    </ncx>`);
  zip.file("OEBPS/text/ch1.xhtml", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head>
      <body><p>Intro</p><p>Chapter One</p><p>Body</p></body>
    </html>`);
  zip.file("OEBPS/text/ch2.xhtml", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch2</title></head>
      <body><p>Chapter Two</p><p>Body two</p></body>
    </html>`);
  return zip.generateAsync({ type: "uint8array" });
}

test("an EPUB copy gets nav, NCX and an anchor without touching the source bytes", async () => {
  const source = await sampleEpub();
  const dom = new JSDOM("");
  const entries = [{
    label: "Chapter One",
    level: 1,
    sectionId: "OEBPS/text/ch1.xhtml",
    anchorPath: [1, 1],
    anchorText: "Chapter One",
    anchorId: "qbr-toc-1",
  }];
  const output = await buildNavigationEpub(source, entries, {
    parser: dom.window.DOMParser,
    serializer: dom.window.XMLSerializer,
  });
  assert.ok(output.byteLength > 0);
  const zip = await JSZip.loadAsync(output);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  const ncx = await zip.file("OEBPS/toc.ncx").async("string");
  const chapter = await zip.file("OEBPS/text/ch1.xhtml").async("string");
  assert.match(nav, /href="text\/ch1\.xhtml#qbr-toc-1"/);
  assert.match(ncx, /src="text\/ch1\.xhtml#qbr-toc-1"/);
  assert.match(chapter, /id="qbr-toc-1"/);
  assert.equal((nav.match(/<\?xml/gi) || []).length, 1, "nav has one XML declaration");
  assert.equal((ncx.match(/<\?xml/gi) || []).length, 1, "NCX has one XML declaration");
  assert.equal((chapter.match(/<\?xml/gi) || []).length, 1, "chapter has one XML declaration");
  assert.equal(zip.file("mimetype") !== null, true);
  dom.window.close();
});

test("a converted EPUB can locate new chapter titles and write portable targets", async () => {
  const source = await sampleEpub();
  const dom = new JSDOM("");
  const output = await buildNavigationEpubFromTitles(source, [
    { title: "Chapter One", level: 1 },
    { title: "Chapter Two", level: 1 },
  ], { parser: dom.window.DOMParser, serializer: dom.window.XMLSerializer });
  const zip = await JSZip.loadAsync(output);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  const ncx = await zip.file("OEBPS/toc.ncx").async("string");
  const ch1 = await zip.file("OEBPS/text/ch1.xhtml").async("string");
  const ch2 = await zip.file("OEBPS/text/ch2.xhtml").async("string");
  assert.match(nav, /Chapter One/);
  assert.match(nav, /Chapter Two/);
  assert.match(nav, /text\/ch1\.xhtml#qbr-toc-1/);
  assert.match(nav, /text\/ch2\.xhtml#qbr-toc-2/);
  assert.match(ncx, /text\/ch2\.xhtml#qbr-toc-2/);
  assert.match(ch1, /id="qbr-toc-1"/);
  assert.match(ch2, /id="qbr-toc-2"/);
  dom.window.close();
});

test("an EPUB without a nav manifest gets a new nav entry", async () => {
  const source = await sampleEpub();
  const zip = await JSZip.loadAsync(source);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  zip.file("OEBPS/content.opf", opf.replace(/\s*<item id="nav"[^>]*\/>/, ""));
  zip.file("OEBPS/nav.xhtml", "");
  const changed = await zip.generateAsync({ type: "uint8array" });
  const dom = new JSDOM("");
  const output = await buildNavigationEpub(changed, [{
    label: "Chapter One",
    sectionId: "OEBPS/text/ch1.xhtml",
    anchorPath: [1, 1],
    anchorText: "Chapter One",
    anchorId: "qbr-toc-1",
  }], { parser: dom.window.DOMParser, serializer: dom.window.XMLSerializer });
  const result = await JSZip.loadAsync(output);
  const opfOut = await result.file("OEBPS/content.opf").async("string");
  const nav = await result.file("OEBPS/nav.xhtml").async("string");
  assert.match(opfOut, /properties="nav"/);
  assert.match(nav, /Chapter One/);
  dom.window.close();
});
