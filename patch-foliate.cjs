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

// The lenient fallback is deliberate, but the warning it logs dumps the whole
// XML parser error text into the console on every section of a sloppy book,
// which reads as an app failure. Silence it.
const warnFrom = "console.warn(doc.querySelector('parsererror')?.innerText ?? 'Invalid XHTML')";
const warnTo = "/* malformed XHTML falls back to HTML parsing below; stay quiet */";
if (fs.existsSync(epubPath)) {
  const text = fs.readFileSync(epubPath, "utf8");
  if (text.includes(warnFrom)) {
    fs.writeFileSync(epubPath, text.split(warnFrom).join(warnTo));
    patched += 1;
  } else if (text.includes(warnTo)) {
    patched += 1;
  }
}

// Remote @font-face rules (WeRead scraper exports point at jsdelivr) can never
// load under the desktop CSP; the iframe then logs a refusal per font. Strip
// the rules while the book CSS is rewritten so no request is ever made.
const cssFrom = `        return replaceSeries(replacedUrls,
            /@import\\s*["']([^"'\\n]*?)["']/gi,
            (_, url) => this.loadHref(url, href, parents)
                .then(url => \`@import "\${url}"\`))`;
const cssTo = `        const withImports = await replaceSeries(replacedUrls,
            /@import\\s*["']([^"'\\n]*?)["']/gi,
            (_, url) => this.loadHref(url, href, parents)
                .then(url => \`@import "\${url}"\`))
        // Remote fonts cannot load offline; drop those rules and the CSP
        // refusal noise with them.
        return withImports.replace(/@font-face\\s*\\{[^}]*\\}/gi,
            (rule) => /url\\(\\s*["']?https?:/i.test(rule) ? "" : rule)`;
if (fs.existsSync(epubPath)) {
  const text = fs.readFileSync(epubPath, "utf8");
  if (text.includes(cssFrom)) {
    fs.writeFileSync(epubPath, text.split(cssFrom).join(cssTo));
    patched += 1;
  } else if (text.includes(cssTo)) {
    patched += 1;
  }
}
console.log(`foliate-js hardened in ${patched} file(s)`);
