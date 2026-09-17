// Offline, deterministic reformatting of the pinned plain-text sources. All
// source text, credits and full Gutenberg license are retained in each EPUB.
import fs from "node:fs/promises";
import crypto from "node:crypto";
import JSZip from "jszip";
const dir = new URL("../assets/starter-books/", import.meta.url);
const catalog = JSON.parse(await fs.readFile(new URL("catalog.json", dir), "utf8"));
const covers = JSON.parse(await fs.readFile(new URL("covers/catalog.json", dir), "utf8"));
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const authors = { 7337: "老子", 52323: "蘅塘退士 编", 24047: "刘义庆", 2680: "Marcus Aurelius", 43: "Robert Louis Stevenson", 11: "Lewis Carroll" };
const now = new Date("2026-09-09T00:00:00Z");
const output = [];
for (const book of catalog) {
  const bytes = await fs.readFile(new URL(`${book.id}.txt`, dir));
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== book.sha256) throw Error(`Source changed: ${book.id}`);
  const text = bytes.toString("utf8").replaceAll("\r\n", "\n").replace(/^\uFEFF/, "");
  const start = /\*\*\* START OF THE PROJECT GUTENBERG EBOOK .*?\*\*\*/.exec(text);
  const end = /\*\*\* END OF THE PROJECT GUTENBERG EBOOK .*?\*\*\*/.exec(text);
  if (!start || !end) throw Error(`Missing source license boundaries: ${book.id}`);
  const body = text.slice(start.index + start[0].length, end.index);
  const sections = [];
  let lines = [], label = book.title, sawHeading = false;
  const flush = () => { if (lines.join("").trim()) sections.push({ label, text: lines.join("\n") }); lines = []; };
  for (const line of body.split("\n")) {
    const heading = book.id === "7337" ? /^第.{1,5}章$/.test(line)
      : book.id === "24047" ? /^.{2,5}第[一二三四五六七八九十]+$/.test(line)
      : book.id === "52323" ? /^\d{3}$/.test(line) && (Number(line) - 1) % 20 === 0
      : /^(CHAPTER [IVXLCDM]+\.|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH) BOOK|INTRODUCTION|APPENDIX|GLOSSARY)$/.test(line);
    if (heading || (!line.trim() && lines.join("\n").length > 14000)) {
      if (sawHeading || sections.length || lines.join("\n").length > 200) flush();
      sawHeading ||= heading;
      label = heading ? line : `${label} · ${sections.length + 1}`;
    }
    lines.push(line);
  }
  flush();
  // The first-run reading view begins with the work; original publication
  // metadata and full license remain available from the final TOC entry.
  sections.push({ label: "Source & license", text: text.slice(0, start.index + start[0].length) + "\n\n" + text.slice(end.index) });
  const language = ["7337", "52323", "24047"].includes(book.id) ? "zh" : "en";
  const zip = new JSZip();
  const file = (name, content, compression = "DEFLATE") => zip.file(name, content, { date: now, compression });
  file("mimetype", "application/epub+zip", "STORE");
  file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  file("EPUB/style.css", "body{line-height:1.65}h1,h2{font-weight:600}p{margin:0 0 1em}pre{white-space:pre-wrap}");
  const credit = covers.find(c => c.id === book.id);
  const artwork = await fs.readFile(new URL(`covers/${book.id}.jpg`, dir));
  if (!credit || crypto.createHash("sha256").update(artwork).digest("hex") !== credit.sha256) throw Error(`Cover changed: ${book.id}`);
  file("EPUB/cover.jpg", artwork, "STORE");
  // Credits do not add a spine page or move existing reading locations.
  file("EPUB/cover-credits.txt", "Cover artwork only; the text edition remains Project Gutenberg.\n" + JSON.stringify(credit, null, 2));
  const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}"><head><title>${escape(title)}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;
  for (const [i, section] of sections.entries()) {
    const paragraphs = section.text.split(/\n\s*\n/).filter(p => p.trim()).map(p => {
      // Preserve poetry lineation. Prose source wrapping is typographic only.
      const content = book.id === "52323" || i === sections.length - 1 ? escape(p).replaceAll("\n", "<br/>") : escape(p.replace(/\n/g, language === "zh" ? "" : " "));
      return `<p>${content}</p>`;
    }).join("\n");
    file(`EPUB/s${i}.xhtml`, xhtml(section.label, paragraphs));
  }
  file("EPUB/nav.xhtml", xhtml(book.title, `<nav epub:type="toc"><h1>${escape(book.title)}</h1><ol>${sections.map((s, i) => `<li><a href="s${i}.xhtml">${escape(s.label)}</a></li>`).join("")}</ol></nav>`));
  file("EPUB/package.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:qbr:starter:${book.id}</dc:identifier><dc:title>${escape(book.title)}</dc:title><dc:creator>${escape(authors[book.id])}</dc:creator><dc:language>${language}</dc:language><dc:source>${book.source}</dc:source><dc:rights>Public domain in the USA; see included Project Gutenberg license.</dc:rights><meta property="dcterms:modified">2026-09-09T00:00:00Z</meta></metadata><manifest><item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="cover-credits" href="cover-credits.txt" media-type="text/plain"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${sections.map((s, i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${sections.map((s, i) => `<itemref idref="s${i}"/>`).join("")}</spine></package>`);
  const epub = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  await fs.writeFile(new URL(`${book.id}.epub`, dir), epub);
  output.push({ ...book, language, author: authors[book.id], epubBytes: epub.length, epubSha256: crypto.createHash("sha256").update(epub).digest("hex"), sections: sections.length });
  console.log(`${book.title}: ${epub.length} bytes (${sections.length} sections)`);
}
await fs.writeFile(new URL("editions.json", dir), JSON.stringify(output, null, 2) + "\n");
await fs.writeFile(new URL("../packages/reader/src/starter-book-data.js", import.meta.url), output.map(b => `import book${b.id} from "../../../assets/starter-books/${b.id}.epub";`).join("\n") + "\nexport const STARTER_BOOKS = [\n" + output.sort((a,b)=>a.epubBytes-b.epubBytes).map(b=>`  { id: "${b.id}", filename: ${JSON.stringify(b.title+'.epub')}, data: book${b.id} },`).join("\n") + "\n];\n");
