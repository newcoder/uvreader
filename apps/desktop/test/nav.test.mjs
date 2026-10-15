// 导航目录专项测试:审计判据 + 端到端(印刷目录 / 标题 / 上游条目 / 回退 / 深嵌套)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { registerEpubRunners } from "../src/main/workshop-epub.js";
import { auditNav, parseNav, parseNcx } from "../src/shared/epub-nav-audit.js";
import { waitForTask } from "./wait-for-task.mjs";

function tempDir(prefix = "qbr-nav-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function buildFromMarkdown(markdown, { payload = {}, title = "测试书" } = {}) {
  const vault = tempDir();
  const source = path.join(vault, "书稿.md");
  fs.writeFileSync(source, markdown, "utf8");
  const queue = createWorkshopQueue({ file: path.join(vault, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: vault, cacheRoot: path.join(vault, "cache"), subsetter: null, docvortex: null });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {}, title, ...payload } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  const ncx = await zip.file("OEBPS/toc.ncx").async("string");
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  return { task, zip, nav, ncx, names, audit: auditNav({ nav, ncx, fileNames: names, chapterFiles: names.filter((name) => /chapter-[^/]+\.xhtml$/.test(name)) }) };
}

const printedToc = [
  "# 目录",
  "",
  "第一章 光学简史 …… 1",
  "1.1 开场白 …… 11",
  "第二章 波动 …… 12",
  "2.1 一维波 …… 12",
  "第三章 几何光学 …… 43",
].join("\n");

const body = [
  "# 第一章 光学简史",
  "",
  "正文一。",
  "",
  "# 1.1 开场白",
  "",
  "正文二。",
  "",
  "# 的努力？",
  "",
  "半个句子被分页截断了。",
  "",
  "# 第二章 波动",
  "",
  "正文三。",
  "",
  "# 2.1 一维波",
  "",
  "正文四。",
  "",
  "# 第三章 几何光学",
  "",
  "正文五。",
].join("\n");

test("parseNav reads links and nesting depth", () => {
  const nav = `<nav><ol>
      <li><a href="chapter-001.xhtml">第一章</a>
        <ol><li><a href="chapter-002.xhtml">1.1 小节</a></li></ol>
      </li>
    </ol></nav>`;
  const parsed = parseNav(nav);
  assert.deepEqual(parsed.entries.map((entry) => entry.href), ["chapter-001.xhtml", "chapter-002.xhtml"]);
  assert.deepEqual(parsed.entries.map((entry) => entry.depth), [1, 2]);
  assert.equal(parsed.maxDepth, 2);
  assert.equal(parsed.balanced, true);
  assert.deepEqual(parsed.problems, []);
});

test("a sub-list written as a sibling <li> is reported (readers ignore it)", () => {
  // 这就是用户实测「面板只有一级」的结构:子级 <ol> 是上一个 <li> 的兄弟,
  // foliate/Calibre 只读 ol 的直接 li 孩子,整个二层看不见。
  const nav = `<nav><ol>
      <li><a href="chapter-001.xhtml">第一章</a></li>
      <ol><li><a href="chapter-002.xhtml">1.1 小节</a></li></ol>
    </ol></nav>`;
  const parsed = parseNav(nav);
  assert.equal(parsed.balanced, true, "标签是配对的 —— 只有结构性检查能抓到它");
  assert.ok(parsed.problems.some((problem) => problem.includes("没写在 <li> 里")), parsed.problems.join(" / "));
  const audit = auditNav({ nav, ncx: "", fileNames: ["OEBPS/chapter-001.xhtml", "OEBPS/chapter-002.xhtml"] });
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((problem) => problem.includes("导航结构")), "审计要把它当问题报出来");
});

test("auditNav reports dangling links, broken nesting and NCX drift", () => {
  const bad = auditNav({
    nav: `<ol><li><a href="chapter-001.xhtml">第一章</a></li><ol><li><a href="chapter-999.xhtml">不见了</a></li></ol>`,
    ncx: `<content src="chapter-001.xhtml"/>`,
    fileNames: ["OEBPS/chapter-001.xhtml"],
    chapterFiles: ["OEBPS/chapter-001.xhtml"],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((problem) => problem.includes("chapter-999")), "断链要报出来");
  assert.ok(bad.problems.some((problem) => problem.includes("不配对")), "层级不配对要报出来");
  assert.ok(bad.problems.some((problem) => problem.includes("NCX")), "NCX 与 nav 条数不同要报出来");

  const dirty = auditNav({
    nav: `<ol><li><a href="a.xhtml">标题 $^{①}$</a></li></ol>`,
    ncx: `<content src="a.xhtml"/>`,
    fileNames: ["a.xhtml"],
    chapterFiles: ["a.xhtml"],
  });
  assert.ok(dirty.problems.some((problem) => problem.includes("残留公式")), "标题里的公式标记要报出来");
});

test("a printed toc drives the nav and a fragment never reaches it", async () => {
  const { nav, audit, task } = await buildFromMarkdown([printedToc, "", body].join("\n\n"));
  assert.match(task.detail, /目录来自印刷目录/);
  const labels = parseNav(nav).entries.map((entry) => entry.label);
  assert.ok(labels.includes("第一章 光学简史"));
  assert.ok(labels.includes("1.1 开场白"), "印刷目录里的条目都在");
  assert.ok(!labels.some((label) => label.includes("努力")), "被截断的半句不进导航");
  assert.ok(!labels.some((label) => label.includes("目录")), "印刷目录章自己也不进导航");
  assert.equal(audit.ok, true, audit.problems.join(" / "));
  assert.ok(audit.stats.linkedChapters >= 5, "正文里的章都在导航里");
  assert.ok(audit.stats.maxDepth >= 2, "1.1 这类条目应该嵌在章下面");
});

test("without a printed toc the nav comes from the chapter titles", async () => {
  const { nav, audit, task } = await buildFromMarkdown(body);
  assert.match(task.detail, /目录来自正文标题/, "没有目录页时写明导航来自正文标题");
  const labels = parseNav(nav).entries.map((entry) => entry.label);
  assert.ok(labels.includes("第一章 光学简史"));
  assert.ok(labels.includes("第二章 波动"));
  assert.equal(audit.ok, true, audit.problems.join(" / "));
});

test("a single matching entry falls back to the chapter titles", async () => {
  const tinyToc = ["# 目录", "", "第一章 光学简史 …… 1", "", "别的一节 …… 99"].join("\n");
  const { nav, task } = await buildFromMarkdown([tinyToc, "", body].join("\n\n"));
  assert.ok(!/目录来自印刷目录 1 条/.test(task.detail), "只匹配一条就不该用印刷目录");
  const labels = parseNav(nav).entries.map((entry) => entry.label);
  assert.ok(labels.includes("的努力？") === false || labels.length > 2, "回退到标题分章");
  assert.ok(labels.length >= 3);
});

test("a long printed toc with three levels stays well formed", async () => {
  const lines = ["# 目录", ""];
  const content = [];
  for (let chapter = 1; chapter <= 12; chapter += 1) {
    lines.push(`第 ${chapter} 章 主题 ${chapter} …… ${chapter}`);
    content.push(`# 第 ${chapter} 章 主题 ${chapter}`, "", `正文 ${chapter}。`, "");
    for (let section = 1; section <= 3; section += 1) {
      lines.push(`${chapter}.${section} 小节 ${chapter}.${section} …… ${chapter}`);
      content.push(`# ${chapter}.${section} 小节 ${chapter}.${section}`, "", `小节正文 ${chapter}.${section}。`, "");
    }
    lines.push(`${chapter}.1.1 细目 ${chapter} …… ${chapter}`);
    content.push(`# ${chapter}.1.1 细目 ${chapter}`, "", `细目正文 ${chapter}。`, "");
  }
  const { audit, nav, ncx } = await buildFromMarkdown([lines.join("\n"), "", content.join("\n")].join("\n\n"));
  assert.equal(audit.ok, true, audit.problems.join(" / "));
  assert.equal(audit.stats.maxDepth, 3, "1.1.1 应该是第三级");
  assert.equal(parseNcx(ncx).points.length, parseNav(nav).entries.length, "NCX 与 nav 条数一致");
  assert.equal(audit.stats.duplicateLabels, 0, "长目录里不该有重复标题");
});

test("page anchor comments stay out of the book", async () => {
  const { zip, nav } = await buildFromMarkdown(["<!--page:16-->", "# 第一章 起点", "", "正文。", "<!-- page:17 -->"].join("\n"));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.ok(!chapter.includes("page:16") && !chapter.includes("page:17"), "锚点注释不进正文");
  assert.ok(!nav.includes("page:16"), "锚点注释不进导航");
});
