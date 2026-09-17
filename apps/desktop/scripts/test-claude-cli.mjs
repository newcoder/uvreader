// Manual integration test for a local CLI AI provider (Claude Code by default).
// It needs a signed-in CLI on this machine, so it is not part of CI.
// Usage: npm run desktop:test:cli -- [provider-id] [binary-path]
//   npm run desktop:test:cli                       # claude-cli, auto-detected
//   npm run desktop:test:cli -- codex-cli          # any CLI provider id
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const book = path.join(repoRoot, "assets/starter-books/11.epub");
const appPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const provider = process.argv[2] || "claude-cli";
const binaryPath = process.argv[3] || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(label, check, timeoutMs = 60_000) {
  const start = Date.now();
  return (async function poll() {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for " + label);
    await sleep(200);
    return poll();
  })();
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-cli-"));
fs.mkdirSync(path.join(userData, "data"), { recursive: true });
fs.writeFileSync(path.join(userData, "data", "data.json"), JSON.stringify({
  settings: {
    onboarded: true,
    language: "zh",
    bookNotesFolder: "notes",
    dataFolder: "plugin",
    lastSeenVersion: appPackage.version,
    aiProvider: provider,
    aiCliPaths: binaryPath ? { [provider]: binaryPath } : {},
    aiEnabled: false,
    aiNeedsVerification: false,
    aiCompanionVisible: true,
  },
}, null, 2));

const app = await electron.launch({
  executablePath: require("electron"),
  args: [".", book],
  cwd: appRoot,
  env: { ...process.env, QBR_USER_DATA: userData },
});
const page = await app.firstWindow();
page.on("console", (message) => {
  if (message.type() === "error" || message.text().includes("UV Reader")) console.log("[renderer]", message.text().slice(0, 300));
});

try {
  await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
  await waitFor("reader ready", () => page.evaluate(() => {
    const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
    return Boolean(view?.engine?.currentLocation?.() || view?.pager?.total > 0);
  }), 30_000);
  console.log(`reader ready; provider=${provider}${binaryPath ? ` path=${binaryPath}` : " (auto-detect)"}`);

  if (!(await page.$(".qiaomu-reader-companion-setup"))) {
    await page.evaluate(async () => {
      try { await window.__qbrPlugin.openAiChat(); } catch {}
    });
  }
  await waitFor("companion setup", async () => Boolean(await page.$(".qiaomu-reader-companion-start")), 20_000);

  await page.click(".qiaomu-reader-companion-start");
  await waitFor("composer after connection test", async () => {
    const state = await page.evaluate(() => {
      const button = document.querySelector(".qiaomu-reader-companion-start");
      const feedback = document.querySelector(".qiaomu-reader-ai-setup-feedback");
      const alert = feedback?.getAttribute("role") === "alert";
      return {
        composer: Boolean(document.querySelector(".qiaomu-reader-ai-input")),
        button: button?.textContent?.trim() || "",
        feedback: alert ? feedback.textContent.trim() : "",
      };
    });
    if (state.composer) return "ready";
    if (state.feedback) throw new Error("connection test failed: " + state.feedback);
    return "";
  }, 120_000);
  console.log("connection test: ready");

  const resolved = await page.evaluate(() => window.__qbrPlugin.settings.aiCliPaths?.[window.__qbrPlugin.settings.aiProvider] || "");
  console.log("resolved CLI path:", resolved || "(none)");

  await page.fill(".qiaomu-reader-ai-input", "用一句话说明什么是量子纠缠。");
  await page.press(".qiaomu-reader-ai-input", "Enter");
  const answer = await waitFor("streamed answer", () => page.evaluate(() => {
    const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
    const text = bubbles.map((bubble) => bubble.textContent.trim()).filter(Boolean).join("\n");
    return text.length > 10 ? text : "";
  }), 180_000);
  console.log("answer:", answer.slice(0, 120).replace(/\s+/g, " "));
  console.log("CLI INTEGRATION OK");
} catch (error) {
  console.log("CLI INTEGRATION FAILED:", String(error).slice(0, 300));
  const state = await page.evaluate(() => {
    const error = document.querySelector(".qiaomu-reader-ai-setup-feedback[role='alert']");
    return { feedback: error?.textContent?.slice(0, 300) || "" };
  }).catch(() => ({}));
  console.log("panel state:", JSON.stringify(state));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
