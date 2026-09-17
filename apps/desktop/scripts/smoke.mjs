// Launches the desktop shell in smoke mode against a book and exits with the
// shell's status. Usage: npm run smoke -- [path-to-book]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const book = process.argv[2] || path.join(repoRoot, "assets/starter-books/11.epub");
const electronCli = path.join(appRoot, "node_modules/electron/cli.js");

const child = spawn(process.execPath, [electronCli, ".", "--qbr-smoke", book], {
  cwd: appRoot,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
