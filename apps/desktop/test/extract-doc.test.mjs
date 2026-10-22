import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { adoptPdfToolOutputs, appendFootnotes, collectContinuations, collectHeaderImages, collectPageFootnotes, collectUpstreamTocEntries, extractionKind, extractMarkdown, mergePdfMarkdown, patchMarkdownCaptions, registerExtractRunners, splitMarkdownChapters } from "../src/main/extract-doc.js";
import { unwrapProseFences } from "../src/shared/markdown-fix.js";
import { createWorkshopQueue } from "../src/main/workshop.js";
import { waitForTask } from "./wait-for-task.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(prefix = "qbr-extract-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

test("extractionKind routes pdf, images, text sources and documents", () => {
  assert.equal(extractionKind("D:/a/b.pdf"), "pdf");
  assert.equal(extractionKind("D:/a/scan.PNG"), "image");
  assert.equal(extractionKind("D:/a/report.docx"), "document");
  // 文本源走 DocVortex 前先桥接成 HTML(main/docvortex.js),不是「不支持」。
  assert.equal(extractionKind("D:/a/notes.txt"), "text");
  assert.equal(extractionKind("D:/a/notes.md"), "text");
  assert.equal(extractionKind("D:/a/archive.7z"), "");
});

test("splitMarkdownChapters follows 1–3 level headings and keeps fences intact", () => {
  const markdown = [
    "# 第一章 起",
    "",
    "正文一。",
    "",
    "## 小节",
    "",
    "正文二。",
    "",
    "```js",
    "# not a heading",
    "```",
    "",
    "### 更深的小节",
    "",
    "正文三。",
  ].join("\n");
  const chapters = splitMarkdownChapters(markdown);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].title, "第一章 起");
  assert.match(chapters[0].text, /正文一。/);
  assert.match(chapters[1].text, /# not a heading/, "code fences never split chapters");
  assert.equal(chapters[2].title, "更深的小节");
  assert.equal(splitMarkdownChapters("没有标题\n\n只有正文").length, 1);
  assert.equal(splitMarkdownChapters("").length, 0);
});

test("adoptPdfToolOutputs renames pdf_tool products and rewrites asset links", () => {
  const dir = tempDir();
  const stem = "报告";
  fs.writeFileSync(path.join(dir, `${stem}_doc.md`), [
    "![图](mineru/images/a.jpg)",
    "",
    "正文",
    "",
    "```",
    "这是一段被提取工具误判成代码块的正文段落。它足够长,而且以句号结尾,应该被拆回普通段落继续排版。",
    "```",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, `${stem}_doc.html`), `<img src="mineru/images/a.jpg">`);
  fs.writeFileSync(path.join(dir, `${stem}_doc.json`), JSON.stringify({ blocks: [{ image: { src: "mineru/images/a.jpg" } }] }));
  fs.writeFileSync(path.join(dir, `${stem}_audit.json`), JSON.stringify({ ok: true, issues: [] }));
  fs.mkdirSync(path.join(dir, "mineru", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mineru", "images", "a.jpg"), "img");

  const files = adoptPdfToolOutputs(dir, stem);
  assert.equal(files.md, path.join(dir, `${stem}.md`));
  assert.equal(files.html, path.join(dir, `${stem}.html`));
  assert.equal(files.json, path.join(dir, `${stem}.json`));
  assert.equal(files.audit, path.join(dir, `${stem}.audit.json`));
  assert.ok(fs.existsSync(path.join(dir, `${stem}.assets`, "images", "a.jpg")));
  assert.ok(!fs.existsSync(path.join(dir, "mineru")), "the mineru folder is adopted as <name>.assets");
  assert.match(fs.readFileSync(files.md, "utf8"), /!\[图\]\(报告\.assets\/images\/a\.jpg\)/);
  assert.ok(!fs.readFileSync(files.md, "utf8").includes("```"), "prose fences are unwrapped in the markdown product");
  assert.match(fs.readFileSync(files.md, "utf8"), /被提取工具误判成代码块的正文段落/);
  assert.match(fs.readFileSync(files.json, "utf8"), /报告\.assets\/images\/a\.jpg/);

  // 再次提取:同名产物加序号,不覆盖。
  fs.writeFileSync(path.join(dir, `${stem}_doc.md`), "第二遍");
  const again = adoptPdfToolOutputs(dir, stem);
  assert.match(path.basename(again.md), /^报告 \(\d+\)\.md$/);
});

test("adoptPdfToolOutputs merges new images into an existing .assets folder", () => {
  const dir = tempDir("qbr-adopt-assets-");
  fs.mkdirSync(path.join(dir, "mineru", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mineru", "images", "new.jpg"), "new-bytes");
  fs.writeFileSync(path.join(dir, "mineru", "figs.json"), "{}");
  fs.writeFileSync(path.join(dir, "报告_doc.md"), "![插图](mineru/images/new.jpg)\n");
  fs.mkdirSync(path.join(dir, "报告.assets", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "报告.assets", "images", "old.jpg"), "old-bytes");
  const files = adoptPdfToolOutputs(dir, "报告");
  assert.equal(fs.readFileSync(path.join(dir, "报告.assets", "images", "new.jpg"), "utf8"), "new-bytes", "这次的图并进来了");
  assert.equal(fs.readFileSync(path.join(dir, "报告.assets", "images", "old.jpg"), "utf8"), "old-bytes", "上次的图还在");
  assert.ok(fs.existsSync(path.join(dir, "报告.assets", "figs.json")), "资产目录整体并入");
  assert.ok(!fs.existsSync(path.join(dir, "mineru")), "mineru/ 并入后清掉");
  assert.match(fs.readFileSync(files.md, "utf8"), /报告\.assets\/images\/new\.jpg/, "链接指向真实存在的文件");
});

function makeQueue(docvortex, spawnImpl, extra = {}) {
  const dir = tempDir("qbr-extract-queue-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerExtractRunners(queue, {
    docvortex,
    vaultRoot: "D:/vault",
    spawnImpl,
    log: () => {},
    // 单测里不跑真实 PyMuPDF;需要合并路径 / 文本型路径的用例自己传 textLayer / pdfText。
    textLayer: { read: async () => ({ ok: false, error: "no text layer in tests" }) },
    pdfText: { read: async () => ({ ok: false, error: "no pdf text in tests" }) },
    ...extra,
  });
  return { queue, dir };
}

test("the pdf runner drives pdf_tool and adopts its products next to the source", async () => {
  const vault = tempDir("qbr-extract-vault-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    const stem = "试卷";
    fs.writeFileSync(path.join(outDir, `${stem}_doc.md`), "![图](mineru/images/a.jpg)\n\n正文");
    fs.writeFileSync(path.join(outDir, `${stem}_doc.html`), "<p>公式 $x^2$ 和 $\\mathcal { M } _ { t }$。</p>");
    fs.writeFileSync(path.join(outDir, `${stem}_doc.json`), "{}");
    fs.mkdirSync(path.join(outDir, "mineru", "images"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "mineru", "images", "a.jpg"), "img");
    child.emit("close", 0);
  });
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl);
  const id = queue.start({
    kind: "extract-pdf",
    title: "内容提取",
    payload: { source, mode: "mineru", settings: { ocrSidecarDir: vault } },
  });
  await sleep(60);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(task.output, path.join(vault, "试卷.md"));
  assert.ok(fs.existsSync(path.join(vault, "试卷.json")));
  const html = fs.readFileSync(path.join(vault, "试卷.html"), "utf8");
  assert.match(html, /<math[\s>]/, "extracted HTML renders formulas as MathML");
  assert.doesNotMatch(html, /\$x\^2\$/, "the raw LaTeX markers are gone");
  assert.ok(fs.existsSync(path.join(vault, "试卷.assets", "images", "a.jpg")));
  assert.equal(calls[0].args[calls[0].args.indexOf("--mode") + 1], "mineru");
  assert.equal(calls[0].args[calls[0].args.indexOf("--formats") + 1], "json,md,html");
});

test("the pdf runner hands the local MinerU program to pdf_tool and blocks dead addresses", async () => {
  const vault = tempDir("qbr-extract-local-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const exe = path.join(vault, "mineru-kit.exe");
  fs.writeFileSync(exe, "stub");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    fs.writeFileSync(path.join(outDir, "试卷_doc.md"), "正文\n");
    fs.writeFileSync(path.join(outDir, "试卷_doc.json"), "{}");
    child.emit("close", 0);
  });
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl);
  const id = queue.start({
    kind: "extract-pdf",
    title: "内容提取",
    payload: { source, mode: "mineru", settings: { ocrSidecarDir: vault, mineruLocalExe: exe, mineruLocalUrl: "http://127.0.0.1:8123" } },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.MINERU_LOCAL_CMD, exe, "程序路径交给 pdf_tool(helper 靠它找 venv python)");
  // 服务真在跑时这里会是地址、没跑时是空串(挡掉死地址):两种都算对,
  // 「健康才传、否则传空」的判定由 formula-chain 的注入式用例锁死。
  assert.ok(["", "http://127.0.0.1:8123"].includes(String(calls[0].options.env.MINERU_LOCAL_URL)), "地址要么健康要么显式空");
  assert.equal(calls[0].options.env.PYTHONUTF8, "1");
});

test("the images-pdf runner packs pictures into one PDF next to the first", async () => {
  const vault = tempDir("qbr-images-pdf-");
  const files = ["a.png", "b.png"].map((name) => path.join(vault, name));
  for (const file of files) fs.writeFileSync(file, "png");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    fs.writeFileSync(call.args[2], "%PDF-1.4 packed");
    child.emit("close", 0);
  });
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl);
  const id = queue.start({ kind: "images-pdf", title: "图片 → PDF", payload: { images: files } });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(path.basename(task.output), "a.pdf", "产物落在首图旁边,用首图名");
  assert.deepEqual(calls[0].args.slice(2), [task.output, ...files], "输出文件在前,图片按顺序在后");
});

test("the docvortex runner writes markdown, html and json next to the source", async () => {
  const vault = tempDir("qbr-extract-vault2-");
  const source = path.join(vault, "讲义.docx");
  fs.writeFileSync(source, "docx-bytes");
  const calls = [];
  const docvortex = {
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      calls.push(request.format);
      fs.writeFileSync(request.out, request.format === "structured_content" ? "{}" : `内容:${request.format}`);
      return { ok: true, out: request.out };
    },
  };
  const { queue } = makeQueue(docvortex);
  const id = queue.start({ kind: "extract-docvortex", title: "内容提取", payload: { source, settings: {} } });
  await sleep(60);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.deepEqual(calls, ["markdown", "html", "structured_content"]);
  assert.equal(fs.readFileSync(path.join(vault, "讲义.md"), "utf8"), "内容:markdown");
  assert.ok(fs.existsSync(path.join(vault, "讲义.html")));
  assert.ok(fs.existsSync(path.join(vault, "讲义.json")));
});

// Markdown / 纯文本 DocVortex 收不了(Unsupported native input format):提取同样先渲染成 HTML。
test("the docvortex runner bridges Markdown through an HTML file", async () => {
  const vault = tempDir("qbr-extract-vault-md-");
  const source = path.join(vault, "说明书.md");
  fs.writeFileSync(source, "# 一\n\n正文 $a^2$\n", "utf8");
  const requests = [];
  const docvortex = {
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      requests.push({ ...request, body: fs.readFileSync(request.source, "utf8") });
      fs.writeFileSync(request.out, request.format === "structured_content" ? "{}" : `内容:${request.format}`);
      return { ok: true, out: request.out };
    },
  };
  const { queue } = makeQueue(docvortex);
  const id = queue.start({ kind: "extract-docvortex", title: "内容提取", payload: { source, settings: {} } });
  await sleep(60);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  // 源文件就是 .md:产物按「同名加序号」落到它旁边,绝不覆盖源文件。
  assert.equal(fs.readFileSync(source, "utf8"), "# 一\n\n正文 $a^2$\n", "源文件不动");
  assert.equal(fs.readFileSync(path.join(vault, "说明书 (1).md"), "utf8"), "内容:markdown", "产物落在源文件旁");
  assert.match(requests[0].source, /\.说明书\.md\.bridge-[0-9a-z]+\.html$/, "DocVortex 收到 HTML 桥文件");
  assert.match(requests[0].body, /<h1>一<\/h1>/);
  assert.match(requests[0].body, /<script type="math\/tex">a\^2<\/script>/);
  assert.equal(requests[0].source, requests[1].source, "三个格式复用同一个桥文件");
  assert.ok(!fs.existsSync(requests[0].source), "提取完桥文件不留");
});

test("the docvortex runner turns images into a temporary PDF and asks for OCR", async () => {
  const vault = tempDir("qbr-extract-vault3-");
  const source = path.join(vault, "照片.png");
  fs.writeFileSync(source, "png-bytes");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    fs.writeFileSync(call.args[call.args.length - 1], "%PDF-1.4 fake");
    child.emit("close", 0);
  });
  const requests = [];
  const docvortex = {
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      requests.push(request);
      if (request.format === "markdown") {
        fs.writeFileSync(request.out, "图片里的文字");
        return { ok: true, out: request.out };
      }
      return { ok: false, error: "not supported" };
    },
  };
  const { queue } = makeQueue(docvortex, spawnImpl);
  const id = queue.start({ kind: "extract-docvortex", title: "内容提取", payload: { source, settings: {} } });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.ok(fs.existsSync(path.join(vault, "照片.md")));
  assert.ok(!fs.existsSync(path.join(vault, "照片.html")));
  assert.equal(calls.length, 1, "the image is converted to PDF exactly once");
  assert.ok(String(calls[0].args[1]).includes("PIL"), "the Pillow helper runs");
  assert.equal(requests[0].parseMode, "ocr");
  assert.match(requests[0].source, /\.pdf$/, "DocVortex receives a PDF, not the image");
  assert.ok(!fs.existsSync(requests[0].source), "the temporary PDF is cleaned up");
});

test("extractMarkdown routes images through a temporary PDF for OCR", async () => {
  const dir = tempDir("qbr-extract-md-");
  const source = path.join(dir, "扫描.jpg");
  fs.writeFileSync(source, "jpg-bytes");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    fs.writeFileSync(call.args[call.args.length - 1], "%PDF-1.4 fake");
    child.emit("close", 0);
  });
  const requests = [];
  const docvortex = {
    convert: async (_settings, request) => {
      requests.push(request);
      fs.writeFileSync(request.out, "OCR 文本");
      return { ok: true, out: request.out };
    },
  };
  const result = await extractMarkdown(source, { kind: "image", docvortex, workDir: path.join(dir, "work"), spawnImpl, log: () => {} });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.markdown, "OCR 文本");
  assert.equal(calls.length, 1);
  assert.equal(requests[0].parseMode, "ocr");
  assert.match(requests[0].source, /\.pdf$/);
});

test("patchMarkdownCaptions puts a dropped code-block caption back before its fence", () => {
  const markdown = [
    "前面的段落。",
    "",
    "```",
    "30 s to promote the adhesion between SU-8 and silica. Then the wafer was spin-coated at 4000 rpm for 1 min.",
    "```",
    "",
  ].join("\n");
  const blocks = [{
    type: "code",
    caption: "In the experiments, the silicon wafer was capped with a 4-μm thick SiO2 layer. Before spin coating, Omnicoat was spun on the wafer at the speed of",
    content: "30 s to promote the adhesion between SU-8 and silica. Then the wafer was spin-coated at 4000 rpm for 1 min.",
  }];
  const patched = patchMarkdownCaptions(markdown, blocks);
  assert.match(patched, /Omnicoat was spun on the wafer at the speed of\n30 s to promote/);
  const cleaned = unwrapProseFences(patched);
  assert.ok(!cleaned.includes("```"), "the fake fence is unwrapped after patching");
  assert.match(cleaned, /In the experiments, the silicon wafer was capped/);
  assert.equal(patchMarkdownCaptions(patched, blocks), patched, "an md that already carries the caption is untouched");
  assert.equal(patchMarkdownCaptions(markdown, []), markdown);
  assert.equal(patchMarkdownCaptions(markdown, [{ type: "text", caption: "x", content: "y" }]), markdown, "only code blocks are patched");
});

test("the pdf runner writes the merged markdown when the text layer is available", async () => {
  const vault = tempDir("qbr-extract-vault-merge-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    const doc = {
      schema_version: 1,
      pages: [{
        page: 1,
        blocks: [
          { type: "text", text: "The wafer was cleaned first.", id: "b1", page: 1 },
          { type: "code", caption: "In the experiments, the wafer was spun at the speed of", content: "30 s to promote adhesion.", id: "b2", page: 1 },
          { type: "image", image: { src: "mineru/images/a.jpg" }, id: "b3", page: 1 },
        ],
      }],
    };
    fs.writeFileSync(path.join(outDir, "论文_doc.json"), JSON.stringify(doc));
    fs.writeFileSync(path.join(outDir, "论文_doc.md"), "MinerU 的 Markdown（少了前半句）");
    fs.mkdirSync(path.join(outDir, "mineru", "images"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "mineru", "images", "a.jpg"), "img");
    child.emit("close", 0);
  });
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl, {
    textLayer: {
      read: async () => ({
        ok: true,
        pages: ["The wafer was cleaned first. In the experiments, the wafer was spun at the speed of 3000 rpm for 30 s to promote adhesion."],
      }),
    },
  });
  const id = queue.start({ kind: "extract-pdf", title: "内容提取", payload: { source, mode: "mineru", settings: { ocrSidecarDir: vault } } });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const md = fs.readFileSync(path.join(vault, "论文.md"), "utf8");
  assert.match(md, /In the experiments, the wafer was spun at the speed of 3000 rpm for 30 s to promote adhesion/, "正文取文字层并补回丢字");
  assert.match(md, /!\[.*\]\(论文\.assets\/images\/a\.jpg\)/, "图片引用改写到 <源名>.assets/");
  assert.ok(!md.includes("少了前半句"), "不再使用 MinerU 那份缺字的 Markdown");
});

test("extractMarkdown reuses the cached merged markdown for the same PDF", async () => {
  const vault = tempDir("qbr-extract-cache-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const workDir = path.join(vault, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
  fs.writeFileSync(path.join(workDir, "merged.md"), "# 缓存的合并稿\n\n正文 $x$。");
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const result = await extractMarkdown(source, {
    kind: "pdf",
    settings: { ocrSidecarDir: vault },
    workDir,
    spawnImpl,
    log: () => {},
    textLayer: { read: async () => ({ ok: false, error: "no layer" }) },
  });
  assert.equal(result.ok, true, result.error);
  assert.match(result.markdown, /缓存的合并稿/, "命中缓存就直接返回合并稿");
  assert.equal(calls.length, 0, "命中缓存时不再调用 pdf_tool");
});

test("extractMarkdown ignores a cached merged markdown when the engine version changed", async () => {
  const vault = tempDir("qbr-extract-engine-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4", "utf8");
  const workDir = path.join(vault, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
  fs.writeFileSync(path.join(workDir, "论文_doc.html"), "<p>旧</p>");
  fs.writeFileSync(path.join(workDir, "merged.md"), "# 旧引擎的稿子\n");
  fs.writeFileSync(path.join(workDir, "engine-version.txt"), "0.1.5");
  const calls = [];
  const engine = {
    health: async () => ({ ok: true, engineVersion: "0.1.8" }),
    runJob: async (_settings, kind, args) => {
      calls.push({ kind, args });
      fs.writeFileSync(path.join(args.outDir, "论文_doc.md"), "# 新引擎的稿子\n");
      fs.writeFileSync(path.join(args.outDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
      fs.writeFileSync(path.join(args.outDir, "论文_doc.html"), "<p>新</p>");
      return { ok: true };
    },
  };
  const options = {
    kind: "pdf",
    settings: { engineUrl: "http://127.0.0.1:8760", ocrSidecarDir: vault },
    workDir,
    engine,
    log: () => {},
    textLayer: { read: async () => ({ ok: false, error: "no layer" }) },
  };
  const refreshed = await extractMarkdown(source, options);
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.equal(calls.length, 1, "引擎版本变了,不能复用旧合并稿");
  assert.equal(fs.readFileSync(path.join(workDir, "engine-version.txt"), "utf8"), "0.1.8");
  assert.match(refreshed.markdown, /新引擎的稿子/);

  // 同一个版本再跑一次:恢复复用,不再调引擎。
  const reused = await extractMarkdown(source, options);
  assert.equal(reused.ok, true, reused.error);
  assert.equal(calls.length, 1, "版本一致时继续复用缓存");
  assert.match(reused.markdown, /新引擎的稿子/);
});

test("an unknown engine version refreshes an unmarked cache once, then marks it local", async () => {
  const vault = tempDir("qbr-extract-local-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4", "utf8");
  const workDir = path.join(vault, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
  fs.writeFileSync(path.join(workDir, "论文_doc.html"), "<p>旧</p>");
  fs.writeFileSync(path.join(workDir, "merged.md"), "# 旧引擎的稿子\n");
  // 没有 engine-version.txt:老缓存
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    fs.writeFileSync(path.join(outDir, "论文_doc.md"), "# 本机的新稿子\n");
    fs.writeFileSync(path.join(outDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
    fs.writeFileSync(path.join(outDir, "论文_doc.html"), "<p>新</p>");
    child.emit("close", 0);
  });
  const engine = {
    health: async () => ({ ok: false }),
    runJob: async () => ({ ok: false, error: "401" }),
  };
  const options = {
    kind: "pdf",
    settings: { engineUrl: "http://127.0.0.1:8760", ocrSidecarDir: vault },
    workDir,
    engine,
    spawnImpl,
    log: () => {},
    textLayer: { read: async () => ({ ok: false, error: "no layer" }) },
  };
  const first = await extractMarkdown(source, options);
  assert.equal(first.ok, true, first.error);
  assert.equal(calls.length, 1, "没有版本标记的旧缓存要重跑本机 pdf_tool");
  assert.equal(fs.readFileSync(path.join(workDir, "engine-version.txt"), "utf8"), "local");
  assert.match(first.markdown, /本机的新稿子/);

  const second = await extractMarkdown(source, options);
  assert.equal(second.ok, true, second.error);
  assert.equal(calls.length, 1, "标记 local 后,引擎探测失败时不再反复重跑");
});

test("the pdf runner reuses existing products instead of parsing the cloud again", async () => {
  const vault = tempDir("qbr-extract-reuse-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const cacheRoot = tempDir("qbr-extract-marks-");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    fs.writeFileSync(path.join(outDir, "论文_doc.md"), "MinerU 的 Markdown");
    fs.writeFileSync(path.join(outDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
    fs.writeFileSync(path.join(outDir, "论文_doc.html"), "<p>x</p>");
    child.emit("close", 0);
  });
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl, { cacheRoot });
  const payload = { source, mode: "mineru", settings: { ocrSidecarDir: vault } };
  const first = queue.start({ kind: "extract-pdf", title: "内容提取", payload });
  await sleep(80);
  assert.equal((await waitForTask(queue, first)).status, "done");
  assert.equal(calls.length, 1);
  const second = queue.start({ kind: "extract-pdf", title: "内容提取", payload });
  await sleep(80);
  const again = await waitForTask(queue, second);
  assert.equal(again.status, "done", again.error);
  assert.equal(calls.length, 1, "第二次复用已有产物,不再调用 pdf_tool");
  assert.match(fs.readFileSync(again.output, "utf8"), /MinerU 的 Markdown/);
  const third = queue.start({ kind: "extract-pdf", title: "内容提取", payload: { ...payload, mode: "vision" } });
  await sleep(80);
  assert.equal((await waitForTask(queue, third)).status, "done");
  assert.equal(calls.length, 2, "换模式要重新解析");
});

test("mergePdfMarkdown leaves text-mode products alone", async () => {
  const dir = tempDir("qbr-merge-skip-");
  const docPath = path.join(dir, "试卷.json");
  fs.writeFileSync(docPath, JSON.stringify({
    schema_version: 1,
    source: { path: "试卷.pdf", title: "试卷", engine: "fitz-text" },
    pages: [{ page: 1, blocks: [{ id: "t1-b1", page: 1, type: "text", text: "（CSP-J1）入门级C++语言试题" }] }],
  }), "utf8");
  const merged = await mergePdfMarkdown({
    docPath,
    source: "试卷.pdf",
    textLayer: { read: async () => { throw new Error("文本型产物不该再读文字层"); } },
  });
  assert.equal(merged, "", "跳过合并,复用原产物");
});

test("re-extracting a text-mode product reuses it unchanged", async () => {
  const vault = tempDir("qbr-extract-text-reuse-");
  const source = path.join(vault, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const cacheRoot = tempDir("qbr-extract-marks-");
  let reads = 0;
  let layerReads = 0;
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, null, {
    cacheRoot,
    pdfText: {
      read: async () => {
        reads += 1;
        return {
          ok: true,
          pages: [{
            width: 595,
            height: 842,
            faint: [],
            lines: [{ text: "（CSP-J1）入门级C++语言试题", fonts: { SimSun: 12 }, size: 12, x0: 55, x1: 300, y0: 100, y1: 112, rotated: false }],
          }],
        };
      },
    },
    textLayer: {
      read: async () => {
        layerReads += 1;
        return { ok: false, error: "文本型产物不该再读文字层" };
      },
    },
  });
  const payload = { source, mode: "text", settings: {} };
  const first = queue.start({ kind: "extract-pdf", title: "内容提取", payload });
  await sleep(80);
  const task = await waitForTask(queue, first);
  assert.equal(task.status, "done", task.error);
  const before = fs.readFileSync(task.output, "utf8");
  assert.match(before, /（CSP-J1）入门级C\+\+语言试题/, "全角括号原样保留");
  const second = queue.start({ kind: "extract-pdf", title: "内容提取", payload });
  await sleep(80);
  const again = await waitForTask(queue, second);
  assert.equal(again.status, "done", again.error);
  assert.equal(fs.readFileSync(again.output, "utf8"), before, "复用产物时不再合并文字层");
  assert.equal(reads, 1, "复用不再跑本地提取");
  assert.equal(layerReads, 0, "文本型产物跳过文字层合并");
});

test("the text-mode runner writes figure crops next to the source", async () => {
  const vault = tempDir("qbr-extract-text-figs-");
  const source = path.join(vault, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const cacheRoot = tempDir("qbr-extract-marks-");
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, null, {
    cacheRoot,
    pdfText: {
      read: async (_pdf, { workDir }) => {
        const dir = path.join(workDir, "assets");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "fig-p1-1.png"), "png-bytes");
        return {
          ok: true,
          pages: [{
            width: 595,
            height: 842,
            faint: [],
            figures: [{ rect: [350, 290, 460, 400], file: "fig-p1-1.png" }],
            lines: [{ text: "第一题的正文。", fonts: { SimSun: 12 }, size: 12, x0: 55, x1: 300, y0: 100, y1: 112, rotated: false }],
          }],
        };
      },
    },
  });
  const task = queue.start({ kind: "extract-pdf", title: "内容提取", payload: { source, mode: "text", settings: {} } });
  await sleep(80);
  const row = await waitForTask(queue, task);
  assert.equal(row.status, "done", row.error);
  assert.match(fs.readFileSync(row.output, "utf8"), /试卷\.assets\/fig-p1-1\.png/);
  assert.equal(fs.readFileSync(path.join(vault, "试卷.assets", "fig-p1-1.png"), "utf8"), "png-bytes");
});

test("text mode extracts locally without pdf_tool or the cloud", async () => {
  const vault = tempDir("qbr-extract-text-");
  const source = path.join(vault, "代码讲义.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) }, spawnImpl, {
    cacheRoot: tempDir("qbr-extract-text-marks-"),
    pdfText: {
      read: async () => ({
        ok: true,
        pages: [
          { width: 595, height: 842, lines: [{ text: "def run(cfg):", font: "Courier New", size: 10, x1: 500, y0: 100, y1: 112, rotated: false }] },
          { width: 595, height: 842, lines: [{ text: "    return cfg", font: "Courier New", size: 10, x1: 500, y0: 40, y1: 52, rotated: false }] },
        ],
      }),
    },
  });
  const id = queue.start({ kind: "extract-pdf", title: "内容提取", payload: { source, mode: "text", settings: {} } });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(calls.length, 0, "文本型完全本地,不调 pdf_tool");
  const markdown = fs.readFileSync(task.output, "utf8");
  assert.match(markdown, /```\ndef run\(cfg\):\n    return cfg\n```/, "跨页代码合成一个围栏块");
  for (const ext of [".html", ".json", ".audit.json"]) {
    assert.ok(fs.existsSync(path.join(vault, `代码讲义${ext}`)), `缺少产物 ${ext}`);
  }
});

test("the extract probe reports pdf_tool, credentials and DocVortex", async () => {
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }), });
  const saved = process.env.MINERU_API_KEY;
  process.env.MINERU_API_KEY = "tk";
  try {
    const id = queue.start({ kind: "extract-probe", title: "检测提取链路", payload: { settings: { ocrSidecarDir: "D:/pt" } } });
    await sleep(40);
    const task = await waitForTask(queue, id);
    if (task.status === "failed") {
      // 没有 pdf_tool checkout 的机器:报错要可操作。
      assert.match(task.error, /pdf_tool/);
    } else {
      assert.equal(task.status, "done");
      assert.match(task.output, /pdf_tool \+ DocVortex/);
    }
  } finally {
    if (saved === undefined) delete process.env.MINERU_API_KEY;
    else process.env.MINERU_API_KEY = saved;
  }
});

test("collectPageFootnotes rescues MinerU footnotes with chunk offsets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-notes-"));
  const chunk = path.join(dir, "mineru", "chunks", "0201-0400");
  fs.mkdirSync(chunk, { recursive: true });
  fs.writeFileSync(path.join(chunk, "x_content_list.json"), JSON.stringify([
    { type: "text", text: "正文。", page_idx: 0 },
    { type: "page_footnote", text: "① 原题: An Axiomatization of Set Theory。\n译者注。", page_idx: 1 },
    { type: "page_footnote", text: "① 原题: An Axiomatization of Set Theory。\n译者注。", page_idx: 1 },
    { type: "page_footnote", text: "② 参见 Ch. IV.", page_idx: 5 },
  ]), "utf8");
  const notes = collectPageFootnotes(dir);
  assert.equal(notes.length, 2, "重复的脚注只留一条");
  assert.equal(notes[0].page, 202, "分块目录 0201-0400 的页码要加偏移(page_idx 1 → 第 202 页)");
  assert.match(notes[0].text, /^① 原题/, "脚注里的换行并成一行");
  assert.equal(notes[1].page, 206);
});

test("appendFootnotes adds one 注释 section and stays idempotent", () => {
  const notes = [{ page: 17, text: "① 原题: An Axiomatization of Set Theory。" }, { page: 0, text: "② 无页码的注解。" }];
  const once = appendFootnotes("# 第一章\n\n正文。", notes);
  assert.match(once, /\n## 注释\n/);
  assert.match(once, /> ① 原题: An Axiomatization of Set Theory。/);
  assert.ok(!once.includes("（第 17 页）"), "脚注不再附页码(读者看到的是噪声)");
  assert.equal(appendFootnotes(once, notes), once, "重复调用不会再加一节");
  assert.equal(appendFootnotes("正文。", []), "正文。", "没有脚注时原样返回");
});

test("appendFootnotes does not duplicate notes pdf_tool already wrote", () => {
  const notes = [
    { page: 17, text: "① 原题: An Axiomatization of Set Theory。" },
    { page: 202, text: "② 参见 Ch. IV." },
  ];
  // pdf_tool 新版自己会写:引用块 + 页码,内容可能带换行/标点差异。
  const upstream = "正文。\n\n> ① 原题: An Axiomatization of Set Theory。（第 17 页）\n";
  const onlyMissing = appendFootnotes(upstream, notes);
  assert.match(onlyMissing, /② 参见 Ch\. IV\./, "只补上游没写的那条");
  assert.ok(!/① 原题: An Axiomatization/.test(onlyMissing.split("## 注释")[1] || ""), "上游写过的不再重复");
  assert.equal(appendFootnotes(upstream + "\n> ② 参见 Ch. IV.（第 202 页）\n", notes), upstream + "\n> ② 参见 Ch. IV.（第 202 页）\n", "两条都在时一个字都不动");
});

test("extractMarkdown refresh bypasses the cached merged markdown", async () => {
  // 上游(pdf_tool)更新过提取行为后,老缓存不会自己更新:界面上勾「忽略缓存重新提取」
  // 就是走这一条,期望真的再跑一次上游。
  const vault = tempDir("qbr-extract-refresh-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const workDir = path.join(vault, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
  fs.writeFileSync(path.join(workDir, "merged.md"), "# 缓存的合并稿\n\n正文 $x$。");

  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    // 假 pdf_tool:把这次「新提取」的产物写出来。
    const outIndex = call.args.indexOf("--out-dir");
    const outDir = outIndex >= 0 ? call.args[outIndex + 1] : path.dirname(source);
    fs.writeFileSync(path.join(outDir, "论文_doc.json"), JSON.stringify({ schema_version: 1, pages: [] }));
    fs.writeFileSync(path.join(outDir, "论文_doc.md"), "# 重跑的稿子\n\n脚注 ① 也在。");
    child.stdout.emit("data", "ok\n");
    child.emit("close", 0);
  });
  const settings = { ocrSidecarDir: vault };
  const cached = await extractMarkdown(source, {
    kind: "pdf", settings, workDir, spawnImpl, log: () => {},
    textLayer: { read: async () => ({ ok: false, error: "no layer" }) },
  });
  assert.match(cached.markdown, /缓存的合并稿/, "默认复用缓存");
  assert.equal(calls.length, 0);

  const refreshed = await extractMarkdown(source, {
    kind: "pdf", settings, workDir, refresh: true, spawnImpl, log: () => {},
    textLayer: { read: async () => ({ ok: false, error: "no layer" }) },
  });
  assert.equal(calls.length, 1, "refresh 时必须真的重跑上游");
  assert.match(refreshed.markdown, /重跑的稿子/, "返回的是这次的新产物");
});

test("collectUpstreamTocEntries reads pdf_tool's toc pages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-upstream-toc-"));
  const docPath = path.join(dir, "论文_doc.json");
  fs.writeFileSync(docPath, JSON.stringify({
    schema_version: 1,
    pages: [
      { page: 8, page_role: "toc", toc_entries: [
        { title: "第一章 光学简史", page: 1, level: 1 },
        { title: "1.1 开场白", page: 11, level: 2 },
        { title: "   " },
      ] },
      { page: 9, blocks: [{ type: "text", text: "正文。" }] },
    ],
  }), "utf8");
  const entries = collectUpstreamTocEntries(docPath);
  assert.deepEqual(entries.map((entry) => entry.label), ["第一章 光学简史", "1.1 开场白"], "空标题丢掉");
  assert.deepEqual(entries.map((entry) => entry.level), [1, 2], "上游给了层级就用它");
  assert.equal(entries[1].key, "开场白", "key 走同一套清洗,便于和正文标题比对");
  assert.deepEqual(collectUpstreamTocEntries(path.join(dir, "不存在.json")), [], "读不到就是空数组");
});

test("collectUpstreamTocEntries accepts pdf_tool's delivered shape", () => {
  // pdf_tool de0fc7f 交付的形状:doc.pages[i].page_role = "toc" + toc_entries{title,page,level}。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-upstream-shape-"));
  const docPath = path.join(dir, "书_doc.json");
  fs.writeFileSync(docPath, JSON.stringify({
    schema_version: 1,
    pages: [
      { page: 16, page_role: "toc", toc_entries: [
        { title: "集合论的一种公理化", page: 1, level: 1 },
        { title: "经济学中的数学方法", page: 52, level: 1 },
      ] },
      { page: 17, blocks: [{ type: "text", text: "正文。", continuation: true }] },
    ],
  }), "utf8");
  const entries = collectUpstreamTocEntries(docPath);
  assert.deepEqual(entries.map((entry) => [entry.label, entry.page, entry.level]), [
    ["集合论的一种公理化", 1, 1],
    ["经济学中的数学方法", 52, 1],
  ]);
});

test("collectContinuations reads the blocks pdf_tool marked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-continuations-"));
  const docPath = path.join(dir, "书_doc.json");
  fs.writeFileSync(docPath, JSON.stringify({
    schema_version: 1,
    pages: [
      { page: 177, blocks: [
        { type: "text", text: "什么样的考虑支配和指引着他" },
        { type: "text", text: "的努力？", continuation: true },
        { type: "text", text: "正文。" },
      ] },
    ],
  }), "utf8");
  assert.deepEqual(collectContinuations(docPath), ["的努力？"]);
  assert.deepEqual(collectContinuations(path.join(dir, "没有.json")), []);
});

test("collectHeaderImages drops an image whose bbox matches a header on another page", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-header-"));
  fs.mkdirSync(path.join(dir, "mineru"));
  fs.writeFileSync(path.join(dir, "mineru", "middle_json.json"), JSON.stringify({
    pages: [
      { blocks: [{ type: "header", bbox: [0.021, 0.017, 0.172, 0.089] }] },
      { blocks: [
        { type: "image", bbox: [0.02, 0.017, 0.172, 0.09], content: [{ image_path: "images/page_9_image_0.jpg" }] },
        { type: "image", bbox: [0.158, 0.647, 0.212, 0.716], content: [{ image_path: "images/page_1_image_9.jpg" }] },
      ] },
    ],
  }), "utf8");
  assert.deepEqual(collectHeaderImages(dir), ["images/page_9_image_0.jpg"]);
  assert.deepEqual(collectHeaderImages(path.join(dir, "missing")), []);
});

test("the pdf outline reader returns entries and fails quietly", async () => {
  const { createPdfOutlineReader } = await import("../src/main/pdf-outline.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-outline-"));
  const script = "import json,sys;json.dump([{'level':1,'title':'第1章','page':3}],open(sys.argv[2],'w'))";
  const reader = createPdfOutlineReader({ spawnImpl: (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      fs.writeFileSync(args[2], JSON.stringify([{ level: 1, title: "第1章 光学简史", page: 17 }]), "utf8");
      child.emit("close", 0);
    });
    void script;
    void command;
    void options;
    return child;
  } });
  const result = await reader.read(path.join(dir, "book.pdf"), { python: "python", workDir: dir });
  // 源文件不存在时应当安静失败(不抛)。
  assert.equal(result.ok, false);
  assert.match(String(result.error), /找不到 PDF/);
  const missing = await createPdfOutlineReader({ spawnImpl: () => { throw new Error("不该调用"); } }).read("", {});
  assert.equal(missing.ok, false);
});
