// Guards the release workflow: a v* tag must match the root package.json
// version, because electron-builder takes its version from that file.
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ref = process.env.GITHUB_REF_NAME
  || (process.env.GITHUB_REF || "").split("/").pop()
  || "";
const tag = ref.replace(/^v/, "").trim();

if (!tag) {
  console.error("No tag ref found. Run this from a tag push (GITHUB_REF_NAME).");
  process.exit(1);
}
if (tag !== pkg.version) {
  console.error(`Tag v${tag} does not match package.json version ${pkg.version}. Bump the version before tagging.`);
  process.exit(1);
}
console.log(`Release tag v${tag} matches package.json`);
