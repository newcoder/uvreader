// Drops `allow-scripts` from foliate-js' section iframes. Combined with
// `allow-same-origin` it makes the sandbox a no-op (Chromium warns about it),
// and the reader only runs in Chromium, where the WebKit event bug the
// attribute works around (bugs.webkit.org/show_bug.cgi?id=218086) does not
// apply. Re-applied by postinstall because npm rewrites node_modules.
const fs = require("node:fs");
const path = require("node:path");

const from = "allow-same-origin allow-scripts";
const to = "allow-same-origin";
const targets = ["paginator.js", "fixed-layout.js"]
  .map((name) => path.join(__dirname, "node_modules", "foliate-js", name));

let patched = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) continue;
  fs.writeFileSync(file, text.split(from).join(to));
  patched += 1;
}

// Sloppy EPUBs (WeRead scraper exports and the like) carry malformed
// attributes; the strict XHTML parse produces a document with a <parsererror>
// and the section renders as an XML error page instead of the chapter.
// loadHref already falls back to the lenient HTML parser - do the same when a
// section document is parsed.
const epubPath = path.join(__dirname, "node_modules", "foliate-js", "epub.js");
const loadFrom = `    async loadDocument(item) {\n        const str = await this.loadText(item.href)\n        return this.parser.parseFromString(str, item.mediaType)\n    }`;
const loadTo = `    async loadDocument(item) {\n        const str = await this.loadText(item.href)\n        let doc = this.parser.parseFromString(str, item.mediaType)\n        // Malformed XHTML (unquoted attributes) only parses in the lenient\n        // HTML mode; the strict result would render as a parsererror page.\n        if (item.mediaType === MIME.XHTML && (doc.querySelector('parsererror') || !doc.documentElement?.namespaceURI)) {\n            doc = this.parser.parseFromString(str, MIME.HTML)\n        }\n        return doc\n    }`;
if (fs.existsSync(epubPath)) {
  const text = fs.readFileSync(epubPath, "utf8");
  if (text.includes(loadFrom)) {
    fs.writeFileSync(epubPath, text.split(loadFrom).join(loadTo));
    patched += 1;
  } else if (text.includes(loadTo)) {
    patched += 1;
  }
}
console.log(`foliate-js hardened in ${patched} file(s)`);
