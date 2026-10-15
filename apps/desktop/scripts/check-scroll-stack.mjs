// 真机校验「滚动模式堆叠渲染」(patch-foliate-scroll.cjs):用 Electron/Chromium 起一个
// 最小页面,直接驱动 foliate 的分页器,断言跨节滚动是连续的(不会跳回新节顶部)。
//
// 用法:npm run check:scroll   (退出码 0 = 通过)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const electronCli = path.join(appRoot, "node_modules/electron/cli.js");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-scroll-stack-"));

// 1) 把 foliate 的分页器打成单文件(file:// 下 ESM 的相对导入会被 CORS 拦)。
const bundle = await esbuild.build({
  stdin: { contents: `export { Paginator } from "foliate-js/paginator.js";`, resolveDir: repoRoot, loader: "js" },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
fs.writeFileSync(path.join(workDir, "paginator.mjs"), bundle.outputFiles[0].text, "utf8");

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;height:100%}foliate-paginator{display:block;width:900px;height:640px}</style>
<foliate-paginator id="p" flow="scrolled" margin="24px" gap="5%" max-inline-size="640px" max-column-count="1"></foliate-paginator>
<script type="module" src="./run.mjs"></script>
`;

const pageScript = `
import { Paginator } from "./paginator.mjs";

const LINES = 40;
const LINE_H = 60;
const sectionUrl = (index) => URL.createObjectURL(new Blob([
  '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/' + LINE_H + 'px sans-serif}p{margin:0;height:' + LINE_H + 'px}</style><body>' +
  Array.from({ length: LINES }, (_, i) => '<p>SECTION-' + index + ' line ' + i + '</p>').join('') +
  '</body>',
], { type: "text/html" }));

const book = {
  dir: "ltr",
  sections: [0, 1, 2].map((index) => ({
    id: index,
    linear: "yes",
    size: LINES * LINE_H,
    load: () => Promise.resolve(sectionUrl(index)),
  })),
};

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value);

const paginator = document.getElementById("p");
const relocations = [];
paginator.addEventListener("relocate", (event) => relocations.push(event.detail));
paginator.open(book);
await paginator.goTo({ index: 0 });
await wait(500);

const indexes = () => paginator.getContents().map((item) => item.index).sort((a, b) => a - b);
const docHeight = (index) => {
  const doc = paginator.getContents().find((item) => item.index === index)?.doc;
  return doc ? doc.documentElement.getBoundingClientRect().height : 0;
};
const readForward = async () => {
  for (let step = 0; step < 8; step += 1) {
    await paginator.next();
    await wait(350);
    if (paginator.getContents().length > 1) return true;
  }
  return paginator.getContents().length > 1;
};

check("打开时只挂一节", indexes().join(",") === "0", indexes().join(","));
const first = docHeight(0);

// 往前读:跨过分节边界时,上一节应该还挂着,而且视口不该回到新节的顶部。
const stacked = await readForward();
check("跨节后上一节仍在屏幕上(可平滑回滚)", stacked && indexes().includes(0), indexes().join(","));
check("跨节没有跳回新节顶部", paginator.start > first * 0.7,
  \`start=\${round(paginator.start)} 第一节高=\${round(first)} 视口=\${round(paginator.size)}\`);
check("可滚动范围已含两节", paginator.viewSize > first, \`viewSize=\${round(paginator.viewSize)} 第一节高=\${round(first)}\`);
check("relocate 报的是正在读的那一节", relocations.at(-1)?.index === 1, String(relocations.at(-1)?.index));
check("relocate 的进度是节内进度", (relocations.at(-1)?.fraction ?? -1) >= 0 && relocations.at(-1)?.fraction <= 1,
  String(relocations.at(-1)?.fraction));

// 再跨一节:只保留相邻两节,位置继续往前(不是回到某节开头)。
const beforeSecond = paginator.start;
const crossedAgain = await readForward();
check("再跨一节成功", crossedAgain, indexes().join(","));
check("只保留相邻两节", paginator.getContents().length <= 2, indexes().join(","));
check("位置继续前进(没有回到目标节开头)", paginator.start > beforeSecond,
  \`start=\${round(paginator.start)} 之前=\${round(beforeSecond)}\`);

// 往回滚:先在堆叠里滚(不立刻换节)。
const beforeBack = paginator.start;
await paginator.prev();
await wait(350);
check("往回滚先滚内容,不立刻换节", paginator.start < beforeBack, \`start=\${round(paginator.start)}\`);

// 跳章(非相邻、往回跳):照旧替换成目标节。
await paginator.goTo({ index: 0 });
await wait(500);
check("跳章后只挂目标节", indexes().join(",") === "0", indexes().join(","));
check("跳章后位置在目标节里", paginator.start < docHeight(0) + paginator.size,
  \`start=\${round(paginator.start)} 目标节高=\${round(docHeight(0))} 视口=\${round(paginator.size)}\`);

// 跳到「已经在这一节」的本身:不该重建堆叠,位置也不该乱。
const beforeSame = paginator.start;
await paginator.goTo({ index: 0 });
await wait(400);
check("跳到当前节本身保持堆叠", paginator.getContents().length >= 1, indexes().join(","));
check("跳到当前节本身不改变位置", Math.abs(paginator.start - beforeSame) < paginator.size,
  \`start=\${round(paginator.start)} 之前=\${round(beforeSame)}\`);

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(\`\${item.ok ? "PASS" : "FAIL"} \${item.name}\${item.detail ? " · " + item.detail : ""}\`);
console.log(failed.length ? \`SCROLL-STACK FAILED (\${failed.length}/\${results.length})\` : \`SCROLL-STACK OK (\${results.length})\`);
window.qbrScrollStack = { ok: failed.length === 0, results };
`;

const mainScript = `const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const dir = process.argv[2];
if (process.env.CI) app.commandLine.appendSwitch("--no-sandbox");
app.disableHardwareAcceleration?.();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { sandbox: false } });
  win.webContents.on("console-message", (event) => console.log(event.message ?? ""));
  await win.loadFile(path.join(dir, "index.html"));
  const deadline = Date.now() + 30000;
  let result = null;
  while (Date.now() < deadline) {
    result = await win.webContents.executeJavaScript("window.qbrScrollStack || null").catch(() => null);
    if (result) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(result ? (result.ok ? "CHECK-SCROLL-STACK ok" : "CHECK-SCROLL-STACK failed") : "CHECK-SCROLL-STACK no result");
  app.exit(result && result.ok ? 0 : 1);
});
`;

fs.writeFileSync(path.join(workDir, "index.html"), pageHtml, "utf8");
fs.writeFileSync(path.join(workDir, "run.mjs"), pageScript, "utf8");
fs.writeFileSync(path.join(workDir, "main.cjs"), mainScript, "utf8");

const child = spawn(process.execPath, [electronCli, path.join(workDir, "main.cjs"), workDir], {
  cwd: appRoot,
  stdio: "inherit",
});
child.on("exit", (code) => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* leave it */ }
  process.exit(code ?? 1);
});
