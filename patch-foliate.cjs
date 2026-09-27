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
console.log(`foliate-js sandbox hardened in ${patched} file(s)`);
