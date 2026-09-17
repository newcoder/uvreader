// Boots the packaged app (release/ output of `npm run dist`) against a book and
// exits with the shell's status, mirroring scripts/smoke.mjs for installers.
// Usage: node scripts/smoke-packaged.mjs [path-to-book] [path-to-executable]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const book = process.argv[2] || path.join(repoRoot, "assets/starter-books/11.epub");

function findExecutable() {
  const candidates = [
    path.join(appRoot, "release/win-unpacked/UV Reader.exe"),
    path.join(appRoot, "release/mac/UV Reader.app/Contents/MacOS/UV Reader"),
    path.join(appRoot, "release/mac-arm64/UV Reader.app/Contents/MacOS/UV Reader"),
    path.join(appRoot, "release/linux-unpacked/uv-reader"),
    path.join(appRoot, "release/linux-unpacked/UV Reader"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

const executable = process.argv[3] || findExecutable();
if (!executable) {
  console.error("No packaged app found; run `npm run dist:dir` first.");
  process.exit(1);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-smoke-"));
const extraArgs = process.env.CI ? ["--no-sandbox"] : [];
const child = spawn(executable, ["--qbr-smoke", book, ...extraArgs], {
  cwd: path.dirname(executable),
  stdio: "inherit",
  env: { ...process.env, QBR_USER_DATA: userData },
});

child.on("exit", (code) => {
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(code ?? 1);
});
