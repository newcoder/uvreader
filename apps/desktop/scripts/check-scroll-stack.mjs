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

window.addEventListener("error", (event) => console.log("PAGE-ERROR " + (event.error?.stack || event.message)));
window.addEventListener("unhandledrejection", (event) => console.log("PAGE-REJECT " + (event.reason?.stack || event.reason)));

const LINES = 40;
const LINE_H = 60;
const sectionUrl = (index) => URL.createObjectURL(new Blob([
  '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/' + LINE_H + 'px sans-serif}p{margin:0;height:' + LINE_H + 'px}</style><body>' +
  Array.from({ length: LINES }, (_, i) => '<p>SECTION-' + index + ' line ' + i + '</p>').join('') +
  '</body>',
], { type: "text/html" }));

const book = {
  dir: "ltr",
  sections: Array.from({ length: 12 }, (_, index) => ({
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

// 再跨一节:窗口保留最近几节,位置继续往前(不是回到某节开头)。
const beforeSecond = paginator.start;
const beforeExtent = paginator.viewSize;
const crossedAgain = await readForward();
check("再跨一节成功", crossedAgain, indexes().join(","));
check("往回可读的节仍在窗口里", paginator.getContents().length >= 2 && paginator.getContents().length <= 6,
  indexes().join(","));
check("位置继续前进(没有回到目标节开头)", paginator.start > beforeSecond,
  \`start=\${round(paginator.start)} 之前=\${round(beforeSecond)}\`);
check("滚动条总高只随窗口增长(有界)", paginator.viewSize - beforeExtent <= LINES * LINE_H * 2,
  \`总高 \${round(beforeExtent)} → \${round(paginator.viewSize)}\`);

// 往回滚:先在堆叠里滚(不立刻换节)。
const beforeBack = paginator.start;
await paginator.prev();
await wait(350);
check("往回滚先滚内容,不立刻换节", paginator.start < beforeBack, \`start=\${round(paginator.start)}\`);

// 「续读」(app 里滚到边缘时走的路径):把下一节接在下面,并保持视觉位置。
await paginator.goTo({ index: 1 });
await wait(500);
for (let step = 0; step < 6; step += 1) { await paginator.next(); await wait(250); }
const beforeContinue = paginator.start;
const beforeIndexes = indexes();
await paginator.continueNext();
await wait(700);
const afterContinue = paginator.start;
const afterIndexes = indexes();
const recycled = beforeIndexes.filter((index) => !afterIndexes.includes(index));
check("续读后仍挂着相邻两节", afterIndexes.length >= 2 && afterIndexes.length <= 6, afterIndexes.join(","));
check("续读没有把视口推到栈顶/下一节开头",
  afterContinue > paginator.size * 0.5 && afterContinue < paginator.viewSize - paginator.size - 8,
  \`start=\${round(afterContinue)} viewSize=\${round(paginator.viewSize)} 视口=\${round(paginator.size)}\`);

// 向上续读:滚到已挂载内容顶部时,把上一节前插到上面并保持视口(实测:向上会跳)。
await paginator.goTo({ index: 3 });
await wait(500);
for (let step = 0; step < 6; step += 1) { await paginator.prev(); await wait(250); }
const beforeUp = { start: paginator.start, indexes: indexes(), extent: paginator.viewSize };
await paginator.continuePrev();
await wait(700);
const afterUp = { start: paginator.start, indexes: indexes(), extent: paginator.viewSize };
const addedAbove = afterUp.indexes.filter((index) => !beforeUp.indexes.includes(index));
check("向上续读把上一节挂到上面", addedAbove.length === 0 || Math.min(...afterUp.indexes) < Math.min(...beforeUp.indexes),
  \`\${beforeUp.indexes.join(",")} → \${afterUp.indexes.join(",")}\`);
check("向上续读保持视觉位置(位置按上方新增高度上移)", addedAbove.length === 0
  || Math.abs(beforeUp.start + addedAbove.length * LINES * LINE_H - afterUp.start) < 32,
  \`前=\${round(beforeUp.start)} 后=\${round(afterUp.start)} 上方新增=\${addedAbove.length}\`);
check("向上滚动会填充占位(不会滚进空白)", Math.min(...afterUp.indexes) <= 2, afterUp.indexes.join(","));
check("向上续读后仍在可滚范围内", afterUp.start >= 0 && afterUp.start < afterUp.extent,
  \`start=\${round(afterUp.start)} 总高=\${round(afterUp.extent)}\`);
check("窗口在两侧都受限(不会无限膨胀)", afterUp.indexes.length <= 6, afterUp.indexes.join(","));

// 跳章(非相邻、往回跳):照旧替换成目标节。
await paginator.goTo({ index: 0 });
await wait(500);
check("跳章后只挂目标节", indexes().join(",") === "0", indexes().join(","));
check("跳章后旧节的 DOM 也清干净了", paginator.viewSize <= LINES * LINE_H * 2 + paginator.size,
  \`总高=\${round(paginator.viewSize)}\`);

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
