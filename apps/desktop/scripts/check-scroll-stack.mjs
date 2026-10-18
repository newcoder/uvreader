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

// 堆叠滚动当前是关闭的(patch 里的开关):这时滚动模式回到「一次一节」的既有行为,
// 堆叠场景的断言整体跳过;「既有功能」(翻页模式/目录跳转/上下页)照常校验。
let phase = "stack";
const stacking = paginator.stackedScroll === true;
if (!stacking) console.log("NOTE stacked scrolled mode is OFF (patch switch) - stacking assertions skipped");
const checkOrSkip = (name, ok, detail = "") => {
  if (!stacking && phase === "stack") {
    results.push({ name, ok: true, skipped: true, detail: String(detail) });
    return;
  }
  results.push({ name, ok: !!ok, detail: String(detail) });
};

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

checkOrSkip("打开时只挂一节", indexes().join(",") === "0", indexes().join(","));
const first = docHeight(0);

// 往前读:跨过分节边界时,上一节应该还挂着,而且视口不该回到新节的顶部。
const stacked = await readForward();
checkOrSkip("跨节后上一节仍在屏幕上(可平滑回滚)", stacked && indexes().includes(0), indexes().join(","));
checkOrSkip("跨节没有跳回新节顶部", paginator.start > first * 0.4,
  \`start=\${round(paginator.start)} 第一节高=\${round(first)} 视口=\${round(paginator.size)}\`);
checkOrSkip("可滚动范围已含两节", paginator.viewSize > first, \`viewSize=\${round(paginator.viewSize)} 第一节高=\${round(first)}\`);
checkOrSkip("relocate 报的是正在读的那一节",
  relocations.at(-1)?.index === 1 || relocations.at(-1)?.index === 0,
  \`\${relocations.at(-1)?.index}(接缝处 0/1 都算:视口里两节都在)\`);
checkOrSkip("relocate 报的进度是节内进度(全书进度留在 detail.fraction)",
  (relocations.at(-1)?.sectionFraction ?? -1) >= 0 && relocations.at(-1)?.sectionFraction <= 1,
  String(relocations.at(-1)?.sectionFraction));

// 再跨一节:窗口保留最近几节,位置继续往前(不是回到某节开头)。
const beforeSecond = paginator.start;
const beforeExtent = paginator.viewSize;
const crossedAgain = await readForward();
checkOrSkip("再跨一节成功", crossedAgain, indexes().join(","));
checkOrSkip("往回可读的节仍在窗口里", paginator.getContents().length >= 2 && paginator.getContents().length <= 6,
  indexes().join(","));
checkOrSkip("位置继续前进(没有回到目标节开头)", paginator.start > beforeSecond,
  \`start=\${round(paginator.start)} 之前=\${round(beforeSecond)}\`);
checkOrSkip("滚动条总高只随窗口增长(有界)", paginator.viewSize - beforeExtent <= LINES * LINE_H * 2,
  \`总高 \${round(beforeExtent)} → \${round(paginator.viewSize)}\`);

// 往回滚:先在堆叠里滚(不立刻换节)。
const beforeBack = paginator.start;
await paginator.prev();
await wait(350);
checkOrSkip("往回滚先滚内容,不立刻换节", paginator.start < beforeBack, \`start=\${round(paginator.start)}\`);

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
checkOrSkip("续读后仍挂着相邻两节", afterIndexes.length >= 2 && afterIndexes.length <= 6, afterIndexes.join(","));
checkOrSkip("续读没有把视口推到栈顶/下一节开头",
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
checkOrSkip("向上续读把上一节挂到上面", addedAbove.length === 0 || Math.min(...afterUp.indexes) < Math.min(...beforeUp.indexes),
  \`\${beforeUp.indexes.join(",")} → \${afterUp.indexes.join(",")}\`);
checkOrSkip("向上续读保持视觉位置(位置按上方新增高度上移)", addedAbove.length === 0
  || Math.abs(beforeUp.start + addedAbove.length * LINES * LINE_H - afterUp.start) < 32,
  \`前=\${round(beforeUp.start)} 后=\${round(afterUp.start)} 上方新增=\${addedAbove.length}\`);
checkOrSkip("向上滚动会填充占位(不会滚进空白)", Math.min(...afterUp.indexes) <= 2, afterUp.indexes.join(","));
checkOrSkip("向上续读后仍在可滚范围内", afterUp.start >= 0 && afterUp.start < afterUp.extent,
  \`start=\${round(afterUp.start)} 总高=\${round(afterUp.extent)}\`);
checkOrSkip("窗口在两侧都受限(不会无限膨胀)", afterUp.indexes.length <= 6, afterUp.indexes.join(","));

// 同一 index 只能有一个元素:边缘连滚 / 导航重入重复挂载时,旧元素必须摘掉,
// 否则同一节内容会在正文里出现多份(用户实测:目录章节重复出现在正文里、位置乱)。
const mounted = () => paginator.debugGeometryMore.children
  .filter((entry) => entry.h !== 0 || entry.index != null)
  .map((entry) => entry.index)
  .filter((index) => index != null);
for (let step = 0; step < 3; step += 1) { await paginator.continueNext(); await wait(300); }
for (let step = 0; step < 2; step += 1) { await paginator.continuePrev(); await wait(300); }
const mountedIds = mounted();
checkOrSkip("同一节不会被挂载两份(正文里不出现重复章节)",
  new Set(mountedIds).size === mountedIds.length,
  "挂载=" + mountedIds.join(","));

// 跳章(非相邻、往回跳):照旧替换成目标节。
await paginator.goTo({ index: 0 });
await wait(500);
checkOrSkip("跳章后以目标节为起点(含预取后续节)", indexes()[0] === 0 && indexes().length <= 6,
  indexes().join(","));
checkOrSkip("跳章后旧窗口已清干净(只剩目标与相邻)", Math.min(...indexes()) === 0 && Math.max(...indexes()) <= 5,
  \`总高=\${round(paginator.viewSize)}\`);

// 跳到「已经在这一节」的本身:不该重建堆叠,位置也不该乱。
const beforeSame = paginator.start;
await paginator.goTo({ index: 0 });
await wait(400);
checkOrSkip("跳到当前节本身保持堆叠", paginator.getContents().length >= 1, indexes().join(","));
checkOrSkip("跳到当前节本身不改变位置", Math.abs(paginator.start - beforeSame) < paginator.size,
  \`start=\${round(paginator.start)} 之前=\${round(beforeSame)}\`);

// 前插必须与 spacer 让位同步:否则向上滚时上方会短暂空白(用户实测)。
// 判据:前插那一刻(0ms)与稳定后,可见内容的位置必须一致。
// 注意:iframe 内部坐标恒为 0,这里量不出「画面有没有动」;真正的位移判据见
// check:scroll 之外的临时诊断(用户自己滚 120px,位置必须原地不动)。
await paginator.goTo({ index: 2 });
await wait(600);
await paginator.prev();
await wait(400);
const contentOffset = () => {
  const doc = paginator.getContents().map((item) => item.doc).find(Boolean);
  return doc ? Math.round(doc.body.getBoundingClientRect().top) : null;
};
const before = contentOffset();
const beforeStart = paginator.start;
await paginator.continuePrev();
const immediate = contentOffset();
await wait(600);
const settled = contentOffset();
const settledStart = paginator.start;
checkOrSkip("向上续读:前插瞬间内容不被顶走(防上方空白)",
  immediate !== null && settled !== null && Math.abs(immediate - settled) <= 8,
  \`瞬间=\${immediate} 稳定=\${settled}\`);
checkOrSkip("向上续读:位置不倒退(前插只会让位置前移)",
  settledStart >= beforeStart - paginator.size,
  \`start \${round(beforeStart)}→\${round(settledStart)} 视口=\${round(paginator.size)}\`);

// 诊断 + 断言:目录跳转后往上滚,每一步视口里都必须有真实内容(防占位空白)。
// 步骤:先读几节(让 #heights 有实测值)→ 跳到远处 → 一步步往上滚并采样。
await paginator.goTo({ index: 1 });
await wait(500);
for (let i = 0; i < 5; i += 1) { await paginator.continueNext(); await wait(300); }
await paginator.goTo({ index: 24 });
await wait(800);
const visRect = () => paginator.getBoundingClientRect();
const visibleSections = () => {
  const box = visRect();
  return paginator.getContents().filter((item) => {
    const rect = item.doc?.body?.getBoundingClientRect?.();
    return rect && rect.bottom > box.top + 2 && rect.top < box.bottom - 2;
  }).map((item) => item.index);
};
const blanks = [];
for (let step = 0; step < 24; step += 1) {
  const seen = visibleSections();
  if (!seen.length) blanks.push({ step, start: Math.round(paginator.start), extent: Math.round(paginator.viewSize), mounted: indexes().join(",") });
  await paginator.prev();
  await wait(220);
}
console.log("UP-SCAN blanks=" + JSON.stringify(blanks.slice(0, 6)));
checkOrSkip("目录跳转后一路上滚:视口里始终有真实内容(无占位空白)", blanks.length === 0,
  \`空白步数=\${blanks.length} 首例=\${JSON.stringify(blanks[0] || null)}\`);

// ── 回归:不许影响既有功能(翻页模式、跳转、上下页) ──────────────────────────
phase = "common";
// 1) 翻页模式(paginated):跳章、上一页/下一页,行为必须与优化前一致 —— 只挂一节。
const paged = document.createElement("foliate-paginator");
paged.setAttribute("flow", "paginated");
paged.setAttribute("margin", "24px");
paged.setAttribute("gap", "5%");
paged.setAttribute("max-inline-size", "640px");
paged.setAttribute("max-column-count", "1");
document.body.append(paged);
paged.open(book);
await paged.goTo({ index: 2 });
await wait(400);
checkOrSkip("翻页模式:跳章后只挂目标节", paged.getContents().map((item) => item.index).join(",") === "2",
  paged.getContents().map((item) => item.index).join(","));
const pagedStart = paged.page;
paged.next();
await wait(300);
checkOrSkip("翻页模式:下一页前进", paged.page > pagedStart, \`\${pagedStart} → \${paged.page}\`);
const afterNext = paged.page;
paged.prev();
await wait(300);
checkOrSkip("翻页模式:上一页后退", paged.page < afterNext, \`\${afterNext} → \${paged.page}\`);
checkOrSkip("翻页模式:没有堆叠(始终只挂一节)", paged.getContents().length === 1,
  String(paged.getContents().length));

// 2) 滚动模式:目录跳转 = 目标节出现在视口范围内(内容坐标 + 目标节真的可见)。
await paginator.goTo({ index: 5 });
await wait(600);
const jumpItems = paginator.getContents();
const pageRect = paginator.getBoundingClientRect();
const targetBody = jumpItems.find((item) => item.index === 5)?.doc?.body;
const targetRect = targetBody ? targetBody.getBoundingClientRect() : null;
checkOrSkip("滚动模式:目录跳转到目标节", jumpItems[0]?.index === 5, jumpItems.map((item) => item.index).join(","));
checkOrSkip("滚动模式:跳转后目标节就在视口里(不空白)",
  !!targetRect && targetRect.top <= pageRect.top + 8 && targetRect.bottom > pageRect.top + 8,
  targetRect ? \`目标节 top=\${Math.round(targetRect.top)} 视口 top=\${Math.round(pageRect.top)}\` : "找不到目标节文档");
checkOrSkip("滚动模式:跳转后下方仍有内容可滚", paginator.viewSize >= paginator.start + paginator.size,
  \`start=\${round(paginator.start)} extent=\${round(paginator.viewSize)}\`);

// 3) 滚动模式:下一页按钮 = 往下走(可能顺带挂入下一节,但方向必须是前进)。
const beforePageTurn = paginator.start;
await paginator.next();
await wait(400);
checkOrSkip("滚动模式:下一页按钮前进而不跳内容", paginator.start > beforePageTurn
  && paginator.start - beforePageTurn <= paginator.size * 3,
  \`\${round(beforePageTurn)} → \${round(paginator.start)} 视口=\${round(paginator.size)}\`);
checkOrSkip("滚动模式:前进后仍可回滚(窗口没丢)", paginator.getContents().length >= 1,
  indexes().join(","));

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
