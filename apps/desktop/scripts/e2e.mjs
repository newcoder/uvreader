// End-to-end checks for the desktop shell. EPUB: open, page turn, select text in
// the book iframe, highlight from the popup, verify the store and reading note.
// PDF: open, select text in the pdf.js text layer, highlight, verify the store.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import JSZip from "jszip";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const book = path.resolve(process.argv[2] || path.join(repoRoot, "assets/starter-books/11.epub"));
// Searchable Chinese page, printed from a small zh-CN HTML page with Chrome's
// --print-to-pdf; used by the pinned-pinyin check on fixed-layout pages.
const cjkPdf = path.join(appRoot, "test-fixtures/cjk.pdf");
const appPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

function writeMinimalPdf(file) {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  ];
  const stream = "BT /F1 24 Tf 72 700 Td (Hello PDF highlight test) Tj ET";
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(output.length);
    output += object;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, output, "latin1");
}

// Three pages with embedded text: a cover, a TOC page carrying an ASCII dual
// row (exercises/answers) and the body page the exercises live on.
function writeTocFixturePdf(file) {
  const stream = (text) => `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 9 0 R >> >> >>\nendobj\n",
  ];
  const pushStream = (text) => {
    const body = stream(text);
    objects.push(`${objects.length + 1} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`);
  };
  const page = (contents) => objects.push(`${objects.length + 1} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 9 0 R >> >> >>\nendobj\n`);
  pushStream("Cover");
  page(objects.length + 2);
  pushStream("Unit One Calculations .... 1/3");
  page(objects.length + 2);
  pushStream("Unit One Calculations");
  objects.push("9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(output.length);
    output += object;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, output, "latin1");
}

// Generated TOC persistence: save → reload the app with the same profile → the
// reader prefers the saved list and expands a dual row into 试题/解答 entries;
// clearing it removes the file and the navigation falls back to the outline.
async function runTocScenario() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-toc-"));
  const fixture = path.join(fixtureDir, "toc.pdf");
  writeTocFixturePdf(fixture);
  const first = await launch(fixture);
  let userData = first.userData;
  try {
    await first.page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(first.page), 30_000);
    const saved = await first.page.evaluate(async () => {
      const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
      const file = view?.file;
      if (!file) return null;
      const stat = file.stat || {};
      const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
      const ok = await window.__qbrPlugin.saveGeneratedToc(file.path, {
        stamp,
        entries: [
          { title: "Unit One Calculations", level: 1, page: 1, page2: 3 },
          { title: "Preface", level: 1, page: null, page2: null },
        ],
      });
      const loaded = await window.__qbrPlugin.loadGeneratedToc(file.path, stamp);
      return { ok, stamp, entries: loaded?.entries?.length || 0 };
    });
    if (!saved?.ok || saved.entries !== 2) throw new Error(`generated TOC did not persist: ${JSON.stringify(saved)}`);
    console.log("toc: saved", saved.entries, "entries (stamp", saved.stamp || "none", ")");
  } finally {
    await first.app.close().catch(() => {});
  }
  const second = await launch(fixture, { userData });
  try {
    await second.page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(second.page), 30_000);
    const items = await waitFor("generated TOC applied", () => second.page.evaluate(() => {
      const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
      const toc = view?.tocItems || [];
      const exercises = toc.find((item) => (item.label || "").includes("试题"));
      const answers = toc.find((item) => (item.label || "").includes("解答"));
      return exercises && answers ? JSON.stringify({ exercises: exercises.page, answers: answers.page, count: toc.length }) : "";
    }), 20_000);
    const parsed = JSON.parse(items);
    if (parsed.exercises !== 1 || parsed.answers !== 3) throw new Error(`unexpected TOC targets: ${items}`);
    console.log("toc: generated navigation", items);
    const cleared = await second.page.evaluate(async () => {
      const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
      const file = view?.file;
      await window.__qbrPlugin.clearGeneratedToc(file.path);
      const stat = file.stat || {};
      const stamp = Number.isFinite(stat.mtime) || Number.isFinite(stat.size) ? `${stat.mtime || 0}:${stat.size || 0}` : "";
      return window.__qbrPlugin.loadGeneratedToc(file.path, stamp);
    });
    if (cleared !== null) throw new Error("clearing the generated TOC did not remove it");
    console.log("toc: cleared back to the original outline");
  } finally {
    await second.app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function launch(target, options = {}) {
  const userData = options.userData || fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-"));
  options.seed?.(userData);
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [".", target],
    cwd: appRoot,
    env: { ...process.env, QBR_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    const text = message.text();
    if (/UV Reader:/.test(text)) console.log("[console]", text.slice(0, 180));
  });
  return { app, page, userData };
}

// Conversations live one file per chat under the book's folder; the host's
// legacy data/chat directory still holds conversations without a book.
function allStoredChats(userData) {
  const chats = [];
  const readingRoot = path.join(userData, "library", "plugin", "reading");
  try {
    const index = JSON.parse(fs.readFileSync(path.join(readingRoot, "index.json"), "utf8"));
    for (const entry of Object.values(index?.books || {})) {
      const dir = path.join(readingRoot, entry.folder, "chats");
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
          if (payload?.data?.id) chats.push(payload.data);
        } catch { /* skip a damaged chat file */ }
      }
    }
  } catch { /* no per-book index yet */ }
  const legacyDir = path.join(userData, "data", "chat");
  if (fs.existsSync(legacyDir)) {
    for (const name of fs.readdirSync(legacyDir)) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(legacyDir, name), "utf8"));
        if (chat?.id) chats.push(chat);
      } catch { /* skip unreadable chat files */ }
    }
  }
  return chats;
}

function readStoredChats(userData, bookKey) {
  const legacy = allStoredChats(userData).filter((chat) => (chat.bookPath || "") === bookKey);
  if (legacy.length) return legacy;
  return allStoredChats(userData).filter((chat) => !chat.bookPath);
}

// Find the user turn that carried an attachment.
function chatTurnWithAttachment(userData) {
  for (const chat of allStoredChats(userData)) {
    const turn = (chat.turns || []).find((item) => item.role === "user" && Array.isArray(item.attachments) && item.attachments.length);
    if (turn) return turn;
  }
  return null;
}

// Every stored turn across all chat files.
function storedChatTurns(userData) {
  return allStoredChats(userData).flatMap((chat) => chat.turns || []);
}

function startMockAi(options = {}) {
  const state = {
    requests: 0,
    auth: "",
    // Capability probes read these live, so a scenario can flip them between
    // checks without restarting the server.
    vision: options.vision !== false,
    tools: options.tools !== false,
    probeDigit: options.probeDigit || "7",
    sawImage: false,
    sawTools: false,
    imageRequests: 0,
    lastUserText: "",
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      state.requests += 1;
      state.auth = request.headers.authorization || "";
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      const cors = { "Access-Control-Allow-Origin": "*" };
      const hasImage = Array.isArray(payload.messages) && payload.messages.some(
        (message) => Array.isArray(message?.content)
          && message.content.some((part) => part?.type === "image_url"),
      );
      const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
      const lastMessage = Array.isArray(payload.messages) ? payload.messages.at(-1) : null;
      const lastRole = String(lastMessage?.role || "");
      const lastText = typeof lastMessage?.content === "string" ? lastMessage.content : "";
      // A real chat with tools: the reader marks the message, the mock asks for
      // a search, and the round after the tool result answers.
      const wantsTool = hasTools && lastRole === "user" && lastText.includes("工具") && !lastText.includes("probe_number");
      const afterTool = hasTools && lastRole === "tool";
      if (lastRole === "user" && lastText) state.lastUserText = lastText;
      if (hasImage) { state.sawImage = true; state.imageRequests += 1; }
      if (hasTools) state.sawTools = true;
      if (hasImage && !state.vision) {
        response.writeHead(400, { ...cors, "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "this model does not support image input" } }));
        return;
      }
      if (hasTools && !state.tools) {
        response.writeHead(400, { ...cors, "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "tools are not supported by this endpoint" } }));
        return;
      }
      // pi collects even `completeSimple` through the streaming API, so the
      // probe answers must be delivered as SSE.
      const sse = (events, { streamed = false } = {}) => {
        response.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const write = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
        if (streamed) {
          let index = 0;
          const timer = setInterval(() => {
            if (index < events.length) write(events[index++]);
            else {
              clearInterval(timer);
              response.write("data: [DONE]\n\n");
              response.end();
            }
          }, 30);
          return;
        }
        for (const event of events) write(event);
        response.write("data: [DONE]\n\n");
        response.end();
      };
      const json = (body) => {
        response.writeHead(200, { ...cors, "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      // Only the message that itself carries an image gets the digit; an image
      // sitting in history must not hijack a later text turn.
      const lastHasImage = Array.isArray(lastMessage?.content)
        && lastMessage.content.some((part) => part?.type === "image_url");
      if (lastHasImage && !payload.stream) {
        json({ choices: [{ message: { content: state.probeDigit } }] });
        return;
      }
      if (lastHasImage) {
        sse([{ choices: [{ delta: { content: state.probeDigit } }] }]);
        return;
      }
      if (wantsTool) {
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "search_book", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: "Alice" }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
        return;
      }
      if (afterTool) {
        sse([{ choices: [{ delta: { content: "MOCK TOOL ANSWER" } }] }]);
        return;
      }
      // The probe asks for probe_number by name; the tool loop scenario marks
      // its own message instead.
      const probeRequest = hasTools && lastText.includes("probe_number");
      if (probeRequest && !payload.stream) {
        json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "call_probe", type: "function", function: { name: "probe_number", arguments: JSON.stringify({ n: 7 }) } }],
            },
          }],
        });
        return;
      }
      if (probeRequest) {
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "probe_number", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ n: 7 }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
        return;
      }
      if (payload.stream) {
        // A marked message streams a LaTeX answer so the desktop can prove it
        // typesets formulas instead of showing raw TeX.
        const chunks = lastText.includes("MATH QUESTION")
          ? ["答案：", "前面已证 $\\mathrm{Re}(f,g) \\leq \\frac{1}{2}$。"]
          : ["MOCK ", "STREAM ", "ANSWER"];
        sse(chunks.map((content) => ({ choices: [{ delta: { content } }] })), { streamed: true });
      } else {
        json({ choices: [{ message: { content: "MOCK CONNECTION OK" } }] });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

function readerReady(page) {
  return page.evaluate(() => {
    const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
    return Boolean(view?.engine?.currentLocation?.() || view?.pager?.total > 0);
  });
}

// Books opened from outside the library are copied into the vault by the shell,
// so the reader's book key is the vault-relative path, not the launched path.
async function currentBookKey(page) {
  return await waitFor("book key", () => page.evaluate(() => {
    const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
    return view?.file?.path || "";
  }), 20_000);
}

// Highlights now live in per-book folders (with the legacy global file as the
// archived fallback), so read whichever layout is authoritative.
function readStoredHighlights(userData, bookKey) {
  const pluginDir = path.join(userData, "library", "plugin");
  try {
    const index = JSON.parse(fs.readFileSync(path.join(pluginDir, "reading", "index.json"), "utf8"));
    const folder = index?.books?.[bookKey]?.folder;
    if (folder) {
      const file = path.join(pluginDir, "reading", folder, "highlights.json");
      if (fs.existsSync(file)) {
        const payload = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(payload?.data)) return payload.data;
      }
    }
  } catch { /* fall through to the legacy files */ }
  for (const name of ["reading-highlights.json", "reading-highlights.legacy.json"]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(pluginDir, name), "utf8"));
      if (Array.isArray(data?.[bookKey])) return data[bookKey];
    } catch { /* try the next file */ }
  }
  return null;
}

function readStoredMarks(userData, bookKey) {
  const pluginDir = path.join(userData, "library", "plugin");
  try {
    const index = JSON.parse(fs.readFileSync(path.join(pluginDir, "reading", "index.json"), "utf8"));
    const folder = index?.books?.[bookKey]?.folder;
    if (folder) {
      const file = path.join(pluginDir, "reading", folder, "marks.json");
      if (fs.existsSync(file)) {
        const payload = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(payload?.data)) return payload.data;
      }
    }
  } catch { /* fall through to the legacy settings copy */ }
  return null;
}

function readStoredDraft(userData, bookKey) {
  const pluginDir = path.join(userData, "library", "plugin");
  try {
    const index = JSON.parse(fs.readFileSync(path.join(pluginDir, "reading", "index.json"), "utf8"));
    const folder = index?.books?.[bookKey]?.folder;
    if (folder) {
      const file = path.join(pluginDir, "reading", folder, "drafts.json");
      if (fs.existsSync(file)) {
        const payload = JSON.parse(fs.readFileSync(file, "utf8"));
        return payload?.data?.text ? payload.data : null;
      }
    }
  } catch { /* fall through to the legacy file */ }
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(pluginDir, "ai-drafts.json"), "utf8"));
    return legacy?.[bookKey]?.text ? legacy[bookKey] : null;
  } catch {
    return null;
  }
}

async function highlightFromPopup(page, userData, bookKey, expected) {
  await waitFor("highlight popup", () => page.evaluate(() => {
    const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
    return view?.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on") ? "on" : "";
  }), 15_000);
  // One click highlights with the current colour; the palette is the held /
  // ArrowDown path and is exercised by its own step.
  await page.click(".qiaomu-reader-hl-highlight");
  const stored = await waitFor("stored highlight", () => {
    const list = readStoredHighlights(userData, bookKey);
    return list?.length ? list : "";
  });
  if (expected.cfi !== undefined) {
    if (expected.cfi) {
      if (!stored[0].cfi) throw new Error("expected a CFI highlight");
    } else if (stored[0].cfi) {
      throw new Error("expected a block-anchored highlight");
    }
  }
  return stored[0];
}

// Selects a visible passage inside the book iframe and waits for the highlight
// popup, returning the selected text.
async function selectPassage(page) {
  return waitFor("highlightable selection", async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const text = await frame.evaluate(() => {
          const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
          if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return "";
          const nodes = [...document.querySelectorAll("p, h1, h2, h3, blockquote, li")].filter((el) => {
            const length = el.textContent.trim().length;
            if (length <= 30 || length >= 400) return false;
            const rect = el.getBoundingClientRect();
            const inViewport = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
            return rect.width > 0 && rect.height > 0 && inViewport;
          });
          const el = nodes[0];
          if (!el) return "";
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          return selection.toString().replace(/\s+/g, " ").trim();
        });
        if (!text) continue;
        await sleep(300);
        const popupOn = await page.evaluate(() => {
          const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
          return view?.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on");
        });
        if (popupOn) return text;
      } catch {}
    }
    return "";
  }, 25_000);
}

function clickTopButton(page, label) {
  return page.evaluate((text) => {
    const buttons = [...document.querySelectorAll(".qiaomu-reader-top .qiaomu-reader-ibtn")];
    const target = buttons.find((button) => {
      const labelEl = document.getElementById(button.getAttribute("aria-labelledby") || "");
      return (labelEl?.textContent || "").includes(text);
    });
    target?.click();
    return Boolean(target);
  }, label);
}

async function wheelInBook(page, deltaY) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const sent = await frame.evaluate((delta) => {
        const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
        if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return false;
        const x = document.documentElement.clientWidth / 2;
        const y = document.documentElement.clientHeight / 2;
        const target = document.elementFromPoint(x, y) || document.body;
        target.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true }));
        return true;
      }, deltaY);
      if (sent) return true;
    } catch {}
  }
  return false;
}

async function runEbookScenario() {
  const { app, page, userData } = await launch(book);
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    const bookKey = await currentBookKey(page);
    console.log("epub: reader ready");

    // Toolbar: reading actions only — no note or reset-timer buttons — and the
    // search button last with its own box that searches on Enter.
    const tray = await page.evaluate(() => {
      // Quiet UI turns aria-label into a hidden sibling referenced by
      // aria-labelledby, so read the accessible name from either.
      const nameOf = (el) => {
        const id = el.getAttribute("aria-labelledby");
        const label = id ? el.ownerDocument.getElementById(id) : null;
        return (label?.textContent || el.getAttribute("aria-label") || "").trim();
      };
      const top = document.querySelector(".qiaomu-reader-top");
      const buttons = [...top.querySelectorAll(".qiaomu-reader-ibtn")];
      const right = top.querySelector(".qiaomu-reader-top-right");
      // Quiet UI appends hidden label spans inside the tray; skip them.
      const groups = [...(right?.children || [])].filter((el) => !el.classList.contains("qiaomu-reader-a11y-label"));
      return {
        labels: buttons.map(nameOf),
        lastCls: String(groups.at(-1)?.className || ""),
        hasBox: Boolean(top.querySelector(".qiaomu-reader-top-find")),
        boxBeforeSearch: (() => {
          const box = top.querySelector(".qiaomu-reader-top-find");
          const next = box?.nextElementSibling;
          return Boolean(next && next.classList.contains("qiaomu-reader-ibtn"));
        })(),
      };
    });
    if (tray.labels.includes("本书阅读笔记")) throw new Error("the note button is still in the tray");
    if (tray.labels.includes("重置计时器")) throw new Error("the reset-timer button is still in the tray");
    if (!tray.hasBox) throw new Error("the toolbar search box is missing");
    if (!tray.boxBeforeSearch) throw new Error("the search button should follow its box");
    if (!/qiaomu-reader-pdf-zoom-control/.test(tray.lastCls)) {
      throw new Error(`the PDF zoom control should be the last toolbar group: ${JSON.stringify(tray)}`);
    }
    await page.fill(".qiaomu-reader-top-find", "Alice");
    await page.press(".qiaomu-reader-top-find", "Enter");
    const toolbarHits = await waitFor("toolbar search results", () => page.evaluate(() => {
      const panel = document.querySelector(".qiaomu-reader-find-panel");
      const items = document.querySelectorAll(".qiaomu-reader-find-item").length;
      return panel?.classList.contains("qiaomu-reader-panel-open") && items > 0 ? String(items) : "";
    }), 20_000);
    // The results card hangs below the toolbar, directly under the search box.
    const findCard = await page.evaluate(() => {
      const panel = document.querySelector(".qiaomu-reader-find-panel");
      const top = document.querySelector(".qiaomu-reader-top");
      const box = document.querySelector(".qiaomu-reader-top-find");
      if (!panel || !top || !box) return null;
      const card = panel.getBoundingClientRect();
      const bar = top.getBoundingClientRect();
      const input = box.getBoundingClientRect();
      return {
        below: Math.round(card.top - bar.bottom),
        leftGap: Math.round(card.left - input.left),
        width: Math.round(card.width),
      };
    });
    if (!findCard || findCard.below < -6 || findCard.below > 12) {
      throw new Error(`the search panel should hang right under the toolbar: ${JSON.stringify(findCard)}`);
    }
    if (Math.abs(findCard.leftGap) > 14) {
      throw new Error(`the search panel should hang under the search box: ${JSON.stringify(findCard)}`);
    }
    console.log("epub: toolbar search from the box found", toolbarHits, "results; card", JSON.stringify(findCard));
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.closePanel?.());

    const locationOf = () => page.evaluate(() => JSON.stringify(
      window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.engine.currentLocation(),
    ));
    const before = await locationOf();
    await page.click(".qiaomu-reader-area", { position: { x: 24, y: 24 } });
    const after = await waitFor("page turn", async () => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press("ArrowRight");
      await sleep(500);
      const current = await locationOf();
      return current !== before ? current : "";
    }, 15_000);
    console.log("epub: page turn ok", after.slice(0, 80));

    const beforeWheel = await locationOf();
    const afterWheel = await waitFor("wheel page turn", async () => {
      await wheelInBook(page, 160);
      await sleep(700);
      const current = await locationOf();
      return current !== beforeWheel ? current : "";
    }, 15_000);
    console.log("epub: wheel page turn ok", afterWheel.slice(0, 80));

    assert.equal(await clickTopButton(page, "阅读设置"), true);
    await page.waitForSelector(".modal-container.mod-open .modal-close-button", { timeout: 10_000 });
    await page.click(".modal-container.mod-open .modal-close-button");
    await waitFor("settings modal closed", () => page.evaluate(() => !document.querySelector(".modal-container.mod-open")), 8_000);
    console.log("epub: reading settings modal opens and closes");

    assert.equal(await clickTopButton(page, "适合页面"), true);
    await waitFor("fit page applied", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const pressed = view?.fitBtn?.getAttribute("aria-pressed");
      const marked = view?.contentEl?.classList.contains("qiaomu-reader-fit-page");
      return view?.plugin?.settings?.fitPage === true && pressed === "true" && marked ? "ok" : "";
    }), 10_000);
    console.log("epub: fit page toggles the reader layout");

    assert.equal(await clickTopButton(page, "目录"), true);
    await page.waitForSelector(".qbr-toc-panel", { timeout: 15_000 });
    const tocItems = await waitFor("toc panel on the left", () => page.evaluate(() => {
      const reader = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const toc = window.__qbrApp.workspace.getLeavesOfType("qbr-toc")[0]?.view;
      const items = toc?.contentEl?.querySelectorAll(".qbr-toc-item").length || 0;
      const readerVisible = Boolean(reader && !reader.containerEl.hidden);
      const tocVisible = Boolean(toc && !toc.containerEl.hidden && !window.__qbrApp.workspace.leftSplit.collapsed);
      return readerVisible && tocVisible && items ? String(items) : "";
    }), 15_000);
    console.log("epub: toc panel opens on the left", tocItems, "items");
    await waitFor("toc button pressed", () => page.evaluate(() => {
      const btn = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.tocBtn;
      return btn?.classList.contains("qiaomu-reader-ibtn-on") && btn?.getAttribute("aria-expanded") === "true" ? "ok" : "";
    }), 8_000);
    const tocPressedStyle = await page.evaluate(() => {
      const btn = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.tocBtn;
      if (!btn) return null;
      const style = getComputedStyle(btn);
      return { background: style.backgroundColor, shadow: style.boxShadow, color: style.color };
    });
    if (!tocPressedStyle || tocPressedStyle.background === "rgba(0, 0, 0, 0)" || tocPressedStyle.shadow === "none") {
      throw new Error(`the pressed TOC button should paint a pressed state: ${JSON.stringify(tocPressedStyle)}`);
    }
    console.log("epub: toc button pressed style", JSON.stringify(tocPressedStyle));
    const tocHeader = await page.evaluate(() => {
      const head = document.querySelector(".qbr-toc-panel .qbr-panel-head");
      const title = head?.querySelector(".qbr-panel-title");
      const close = head?.querySelector(".qbr-panel-actions button svg");
      return { title: title?.textContent || "", iconClose: Boolean(close) };
    });
    if (tocHeader.title !== "目录") throw new Error(`unexpected contents title: ${tocHeader.title}`);
    if (!tocHeader.iconClose) throw new Error("the toc close control must be an icon button");
    await page.evaluate(() => {
      const toc = window.__qbrApp.workspace.getLeavesOfType("qbr-toc")[0];
      toc?.view?.contentEl?.querySelector(".qbr-panel-actions button")?.click();
    });
    await waitFor("toc panel closed", () => page.evaluate(() => !window.__qbrApp.workspace.getLeavesOfType("qbr-toc").length), 8_000);
    await waitFor("toc button released", () => page.evaluate(() => {
      const btn = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.tocBtn;
      return btn && !btn.classList.contains("qiaomu-reader-ibtn-on") && btn.getAttribute("aria-expanded") === "false" ? "ok" : "";
    }), 8_000);

    // The book note left the tray: the book's own menus (library card, mobile
    // overflow) open it, and it still opens beside the reader.
    await page.evaluate(async () => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const plugin = view.plugin;
      const note = await plugin.createBookNote(view.file, view.file.basename, "notes");
      await plugin.app.qbrDesktopOpenNote?.(note, plugin);
    });
    await page.waitForSelector(".qbr-note-panel", { timeout: 15_000 });
    const notePanel = await waitFor("note panel beside the reader", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const note = window.__qbrApp.workspace.getLeavesOfType("qbr-note")[0]?.view;
      const body = note?.contentEl?.querySelector(".qbr-note-body");
      return view && !view.containerEl.hidden && note && !note.containerEl.hidden && body ? (body.textContent || "").length : 0;
    }), 15_000);
    console.log("epub: note panel opens beside the reader", notePanel, "chars");
    await page.evaluate(() => {
      const note = window.__qbrApp.workspace.getLeavesOfType("qbr-note")[0];
      note?.view?.contentEl?.querySelector(".qbr-note-actions button:last-child")?.click();
    });
    await waitFor("note panel closed", () => page.evaluate(() => !window.__qbrApp.workspace.getLeavesOfType("qbr-note").length), 8_000);

    const selected = await selectPassage(page);
    console.log("epub: selected", selected.slice(0, 40));

    // The palette opens from the highlight button (ArrowDown or a held press);
    // a missing port leaves the trigger dead and this step times out. Swatches
    // carry no repeated colour names.
    await page.focus(".qiaomu-reader-hl-highlight");
    await page.keyboard.press("ArrowDown");
    const colorOptions = await waitFor("highlight color dropdown", () => page.evaluate(() => {
      const options = [...document.querySelectorAll(".qiaomu-reader-color-dropdown .qiaomu-reader-color-option")];
      if (options.length < 3) return "";
      const swatches = options.map((option) => option.querySelector(".qiaomu-reader-color-swatch")?.getAttribute("style") || "");
      const unlabeled = options.filter((option) => !option.textContent.trim()).length;
      return swatches.every(Boolean) && unlabeled === options.length ? swatches : "";
    }), 8_000);
    const checked = await page.evaluate(() => [...document.querySelectorAll(".qiaomu-reader-color-dropdown .qiaomu-reader-color-option")].filter((option) => option.getAttribute("aria-checked") === "true").length);
    if (checked !== 1) throw new Error(`expected exactly one checked color, saw ${checked}`);
    await page.keyboard.press("Escape");
    await waitFor("color dropdown closed", () => page.evaluate(() => !document.querySelector(".qiaomu-reader-color-dropdown")), 5_000);
    console.log("epub: highlight swatch palette ready", colorOptions.length, "swatches");

    const stored = await highlightFromPopup(page, userData, bookKey, { cfi: true });
    console.log("epub: highlight stored", stored.id, stored.color);

    // Reading-position bookmarks follow their book's folder too.
    await page.evaluate(() => {
      const plugin = window.__qbrPlugin;
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const cfi = view.engine?.currentLocation()?.cfi;
      if (!cfi) return;
      plugin.settings.locationMarks = [...(plugin.settings.locationMarks || []), {
        id: "e2e-location-mark", bookPath: view.file.path, title: "E2E 位置", excerpt: "", anchor: { cfi },
      }];
    });
    await page.evaluate(() => window.__qbrPlugin.saveLocationMarks());
    const marks = await waitFor("bookmark stored in the book folder", () => readStoredMarks(userData, bookKey) || "", 10_000);
    if (!marks.some((mark) => mark.id === "e2e-location-mark")) {
      throw new Error(`the bookmark did not reach the book folder: ${JSON.stringify(marks).slice(0, 160)}`);
    }
    console.log("epub: bookmark stored in the book folder");

    // The undo toast must follow the passage, not sit at the page bottom.
    const placedToast = await waitFor("placed highlight toast", () => page.evaluate(() => {
      const el = document.querySelector(".qiaomu-reader-selection-feedback");
      return el?.style.top && el.style.bottom === "auto" ? el.style.top : "";
    }), 8_000);
    console.log("epub: undo toast follows the passage", placedToast);
    if (!(await tapTextInFrames(page, selected.slice(0, 6)))) throw new Error("could not tap the page to dismiss the toast");
    await waitFor("toast dismissed by tapping the page", () => page.evaluate(
      () => !document.querySelector(".qiaomu-reader-selection-feedback")), 8_000);
    console.log("epub: tapping the page dismissed the undo toast");

    // Clicking a stored highlight reopens its toolbar: the engine emits
    // show-annotation and the view routes it back into the highlight popup.
    // The selection is text-level on purpose — an element-content range
    // collapses into a CFI without client rects, which the overlay cannot
    // hit-test.
    const clickText = await waitFor("text-level selection", async () => {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const text = await frame.evaluate(() => {
            const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
            if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return "";
            const el = [...document.querySelectorAll("p")].find((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
                && node.textContent.trim().length > 40;
            });
            if (!el) return "";
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            if (!node) return "";
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, Math.min(14, node.textContent.length));
            const selection = document.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
            node.parentElement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            return selection.toString().replace(/\s+/g, " ").trim();
          });
          if (text) { await sleep(300); return text; }
        } catch {}
      }
      return "";
    }, 15_000);
    await waitFor("highlight popup for the click test", () => page.evaluate(
      () => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on")), 10_000);
    await page.click(".qiaomu-reader-hl-highlight");
    const clickNeedle = clickText.slice(0, 6);
    const clickedHl = await waitFor("click-test highlight stored", () => page.evaluate((needle) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const hit = view.plugin.getHighlights(view.file.path).find((hl) => hl.cfi && hl.text?.includes(needle));
      return hit ? { id: hit.id } : "";
    }, clickNeedle), 10_000);
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view._hideHlPopup());
    await clearSelectionInFrames(page);
    if (!(await clickTextInFrames(page, clickNeedle))) throw new Error("could not click the stored highlight");
    await waitFor("highlight toolbar reopened", () => page.evaluate((id) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      return view._editHlId === id && view.hlPopup.classList.contains("qiaomu-reader-hl-popup-on");
    }, clickedHl.id), 10_000);
    console.log("epub: clicking the highlight reopened its toolbar");

    // The reopened highlight also offers the undo toast again: undo removes it,
    // and the follow-up toast puts it back.
    const undoToast = await waitFor("undo toast for the clicked highlight", () => page.evaluate(() => {
      const el = document.querySelector(".qiaomu-reader-selection-feedback");
      return el?.style.top ? el.textContent : "";
    }), 8_000);
    await page.click(".qiaomu-reader-selection-feedback button");
    await waitFor("highlight removed by the undo toast", () => page.evaluate((id) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      return view.plugin.getHighlights(view.file.path).every((hl) => hl.id !== id);
    }, clickedHl.id), 8_000);
    await page.click(".qiaomu-reader-selection-feedback button");
    await waitFor("highlight restored by the second undo", () => page.evaluate((id) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      return view.plugin.getHighlights(view.file.path).some((hl) => hl.id === id);
    }, clickedHl.id), 8_000);
    console.log("epub: the undo toast removed and restored the highlight", undoToast.slice(0, 8));
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view._hideHlPopup());

    // The highlights list docks beside the pages and its divider drags.
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.togglePanel("highlights"));
    const dock = await waitFor("docked highlights panel", () => page.evaluate(() => {
      const body = document.querySelector(".qiaomu-reader-body");
      const panel = document.querySelector(".qiaomu-reader-hl-dock");
      if (!body?.classList.contains("qiaomu-reader-hl-open") || !panel) return "";
      return { width: Math.round(panel.getBoundingClientRect().width), items: document.querySelectorAll(".qiaomu-reader-hl-item").length };
    }), 10_000);
    if (dock.items < 1) throw new Error("the docked list should hold the stored highlight");
    const handle = await page.evaluate(() => {
      const rect = document.querySelector(".qiaomu-reader-splitter-hl").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 60 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 20, handle.y, { steps: 4 });
    // With the button still held the divider follows the pointer and the reader
    // holds its reflow (no blur veil, no re-pagination frame by frame).
    const dragging = await waitFor("divider following the held pointer", () => page.evaluate((before) => {
      const html = document.documentElement;
      const panel = document.querySelector(".qiaomu-reader-hl-dock");
      const width = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
      if (!html.classList.contains("qbr-split-dragging") || width < before + 8) return "";
      if (document.querySelector(".qiaomu-reader-relayouting")) return "";
      return String(width);
    }, dock.width), 5_000);
    console.log("epub: divider followed the held pointer to", dragging, "px with the reflow held");
    await page.mouse.move(handle.x - 40, handle.y, { steps: 6 });
    await page.mouse.up();
    await waitFor("divider drag released", () => page.evaluate(
      () => !document.documentElement.classList.contains("qbr-split-dragging")), 5_000);
    const widened = await waitFor("wider highlights dock", () => page.evaluate((before) => {
      const panel = document.querySelector(".qiaomu-reader-hl-dock");
      const width = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
      return width > before + 20 ? String(width) : "";
    }, dock.width), 8_000);
    console.log("epub: docked highlights panel", dock.items, "items, width", dock.width, "->", widened);
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.togglePanel("highlights"));

    // A search hit in a section that was not rendered when the search ran must
    // still be outlined after the reader jumps to it.
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.findBtn?.click());
    await page.waitForSelector(".qiaomu-reader-toc-find-input", { timeout: 10_000 });
    await page.fill(".qiaomu-reader-toc-find-input", "Alice");
    const resultCount = await waitFor("search results", () => page.evaluate(
      () => document.querySelectorAll(".qiaomu-reader-find-item").length), 20_000);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".qiaomu-reader-find-item")];
      rows[rows.length - 1]?.click();
    });
    // The overlay is hit-tested across the visible page: the current location
    // range covers the whole spread, not just the match.
    const outlined = await waitFor("outlined search hit", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const entry = view.engine.contents().find(({ doc, overlayer }) => doc && overlayer);
      const range = view.engine.currentLocation()?.range;
      if (!entry || !range) return "";
      const rect = range.getBoundingClientRect();
      for (let y = rect.top + 4; y < rect.bottom; y += 16) {
        for (let x = rect.left + 4; x < rect.right; x += 16) {
          const [key] = entry.overlayer.hitTest({ x, y });
          if (String(key).startsWith("foliate-search:")) return key;
        }
      }
      return "";
    }), 15_000);
    if (!String(outlined).startsWith("foliate-search:")) throw new Error(`the search hit is not outlined: ${outlined}`);
    console.log("epub: search hit outlined after jumping", resultCount, "results");
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.findBtn?.click());

    const notePath = path.join(userData, "library", "notes", `${path.basename(book, path.extname(book))}.md`);
    const needle = selected.slice(0, 12);
    const note = await waitFor("reading note", () => {
      if (!fs.existsSync(notePath)) return "";
      const text = fs.readFileSync(notePath, "utf8");
      return text.includes(needle) ? text : "";
    }, 20_000);
    console.log("epub: note updated", note.length, "bytes");

    const beforeLibrary = await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.file?.path || "");
    await page.evaluate(() => {
      document.querySelector(".qiaomu-reader-top .qiaomu-reader-ibtn")?.click();
    });
    await page.waitForSelector(".qiaomu-reader-lib-card", { timeout: 15_000 });
    const cards = await page.evaluate(() => document.querySelectorAll(".qiaomu-reader-lib-card").length);
    await page.evaluate((previous) => {
      // The launched book was copied into the library and sorts first (most
      // recently read), so pick the first card for a different book. Card
      // titles show the basename without the extension.
      const name = String(previous).split("/").pop().replace(/\.[^.]+$/, "");
      const cards = [...document.querySelectorAll(".qiaomu-reader-lib-card")];
      const titleOf = (card) => card.querySelector(".qiaomu-reader-lib-book-title")?.textContent || "";
      const target = cards.find((card) => titleOf(card) !== name) || cards[1] || cards[0];
      target?.click();
    }, beforeLibrary);
    const libraryBook = await waitFor("reader switched from the library", () => page.evaluate((previous) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const library = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader-library")[0]?.view;
      const ready = Boolean(view && !view.containerEl.hidden && (view.engine?.currentLocation?.() || view.pager?.total));
      const libraryHidden = !library || library.containerEl.hidden;
      const path = view?.file?.path || "";
      return ready && libraryHidden && path && path !== previous ? path : "";
    }, beforeLibrary), 30_000);
    console.log("epub: library card opens the reader", cards, "cards ->", libraryBook);
    const expectedTitle = libraryBook.split("/").pop().replace(/\.[^.]+$/, "");
    const windowTitle = await waitFor("window title follows the book", () => page.evaluate((expected) => (
      document.title.includes(expected) ? document.title : ""
    ), expectedTitle), 10_000);
    console.log("epub: window title follows the book:", windowTitle);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// Close the app after a highlight and reopen it: the traces folder must have
// been created on open, and the highlight plus the reading position must come
// back from the per-book files (regression for the refresh that used to wipe
// the in-memory maps on every book open).
async function runRestartScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-restart-"));
  let bookKey = "";
  const readingRoot = path.join(userData, "library", "plugin", "reading");
  try {
    const { app, page } = await launch(book, { userData });
    try {
      await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
      await waitFor("reader ready", () => readerReady(page), 30_000);
      bookKey = await currentBookKey(page);
      const folder = await waitFor("reading folder created on open", () => {
        const indexFile = path.join(readingRoot, "index.json");
        if (!fs.existsSync(indexFile)) return "";
        const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
        const name = index?.books?.[bookKey]?.folder;
        if (!name || !fs.existsSync(path.join(readingRoot, name, "book.json"))) return "";
        return name;
      }, 20_000);
      console.log("restart: reading folder created on open:", folder);

      const locationOf = () => page.evaluate(() => JSON.stringify(
        window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.engine.currentLocation(),
      ));
      const beforeTurn = await locationOf();
      await page.click(".qiaomu-reader-area", { position: { x: 24, y: 24 } });
      await waitFor("page turn", async () => {
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("ArrowRight");
        await sleep(500);
        return (await locationOf()) !== beforeTurn ? "turned" : "";
      }, 15_000);

      const selected = await selectPassage(page);
      if (!selected) throw new Error("restart: no highlightable passage");
      const stored = await highlightFromPopup(page, userData, bookKey, { cfi: true });
      console.log("restart: highlight stored", stored.id);
      await sleep(500);
    } finally {
      await app.close().catch(() => {});
    }

    const onDisk = readStoredHighlights(userData, bookKey) || [];
    if (onDisk.length !== 1) throw new Error(`restart: expected 1 highlight on disk, saw ${onDisk.length}`);
    const cfi = onDisk[0].cfi;

    const { app: app2, page: page2 } = await launch(book, { userData });
    try {
      await page2.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
      await waitFor("reader ready", () => readerReady(page2), 30_000);
      // Let the open pipeline (refresh + render) settle before asserting, so a
      // refresh that wipes the in-memory maps cannot slip past the check.
      await sleep(1500);
      const restored = await waitFor("highlight restored after restart", () => page2.evaluate((key) => {
        const list = window.__qbrPlugin.getHighlights(key);
        return list.length ? { count: list.length, id: list[0]?.id || "" } : null;
      }, bookKey), 20_000);
      if (restored.count !== 1 || restored.id !== onDisk[0].id) {
        throw new Error(`restart: highlight lost after restart: ${JSON.stringify(restored)}`);
      }
      const painted = await waitFor("highlight applied to the book", () => page2.evaluate((range) => {
        const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
        return view?.engine?.highlightAt?.(range)?.id || "";
      }, cfi), 20_000);
      const progress = await page2.evaluate((key) => window.__qbrPlugin.getProgress(key), bookKey);
      if (!progress || !(Number(progress.pct) > 0)) {
        throw new Error(`restart: reading position not restored: ${JSON.stringify(progress)}`);
      }
      console.log("restart: restored", restored.id, "painted", painted, "progress", Math.round(progress.pct * 100) + "%");
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// Reading projects: the traces move into the project folder, identity and
// bookmarks stay with the book, and deleting the project brings everything back.
async function runProjectsScenario() {
  let bookKey = "";
  const { app, page, userData } = await launch(book);
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    bookKey = await currentBookKey(page);
    await page.evaluate((key) => window.__qbrPlugin.addHighlight(key, {
      id: "project-hl", color: "yellow", text: "项目测试划线", cfi: "epubcfi(/6/2!/4/2,/1:0,/1:6)", created: Date.now(),
    }), bookKey);
    const before = await waitFor("highlight in the book folder", () => readStoredHighlights(userData, bookKey), 15_000);
    if (!before.some((hl) => hl.id === "project-hl")) throw new Error("the highlight did not reach the book folder");

    const created = await page.evaluate(() => window.__qbrPlugin.createReadingProject("E2E 项目"));
    if (created !== "E2E 项目") throw new Error(`unexpected project name: ${created}`);
    const moved = await page.evaluate((key) => window.__qbrPlugin.moveBookToReadingProject(key, "E2E 项目"), bookKey);
    if (!moved?.moved) throw new Error(`the move reported nothing: ${JSON.stringify(moved)}`);

    const readingRoot = path.join(userData, "library", "plugin", "reading");
    const index = JSON.parse(fs.readFileSync(path.join(readingRoot, "index.json"), "utf8"));
    const folder = index.books[bookKey]?.folder;
    if (!folder) throw new Error("the index lost the book");
    const projectDir = path.join(readingRoot, "_projects", "E2E 项目", folder);
    if (!fs.existsSync(path.join(projectDir, "highlights.json"))) throw new Error("highlights did not move into the project");
    if (!fs.existsSync(path.join(readingRoot, folder, "book.json"))) throw new Error("book.json left the book folder");
    const project = JSON.parse(fs.readFileSync(path.join(readingRoot, "_projects", "E2E 项目", "project.json"), "utf8"));
    if (project.books[0]?.path !== bookKey) throw new Error(`project.json does not list the book: ${JSON.stringify(project.books)}`);
    const inMemory = await page.evaluate((key) => window.__qbrPlugin.getHighlights(key).length, bookKey);
    if (inMemory !== before.length) throw new Error(`the reader lost highlights after the move: ${inMemory} vs ${before.length}`);
    console.log("projects: traces moved into the project, identity stayed", folder);

    // The home page shows the project and opens the manager.
    await page.evaluate(async () => {
      const leaf = window.__qbrApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "qbr-home", active: true });
    });
    await page.waitForSelector(".qbr-home-view", { timeout: 15_000 });
    const card = await waitFor("project card on the home page", () => page.evaluate(() => {
      const cards = [...document.querySelectorAll(".qbr-home-card")];
      return cards.some((item) => item.textContent.includes("E2E 项目")) ? "found" : "";
    }), 15_000);
    if (card !== "found") throw new Error("the home page did not list the project");
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".qbr-home-actions button")];
      buttons.find((button) => button.textContent.includes("阅读项目"))?.click();
    });
    await page.waitForSelector(".qiaomu-reader-projects-modal", { timeout: 15_000 });
    console.log("projects: home page lists the project and the manager opens");

    // Deleting the project moves the traces back and removes the folder.
    const result = await page.evaluate(() => window.__qbrPlugin.deleteReadingProject("E2E 项目"));
    if (result.failed.length) throw new Error(`delete reported failures: ${JSON.stringify(result.failed)}`);
    if (!fs.existsSync(path.join(readingRoot, folder, "highlights.json"))) throw new Error("highlights did not move back");
    if (fs.existsSync(path.join(readingRoot, "_projects", "E2E 项目", "project.json"))) throw new Error("the project folder survived the delete");
    const restored = readStoredHighlights(userData, bookKey) || [];
    if (!restored.some((hl) => hl.id === "project-hl")) throw new Error("the highlight was lost in the round trip");
    console.log("projects: deleting the project moved everything back");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// Scanned PDF → a generated searchable copy: the reader reports progress,
// records the copy in book.json and reads from it on the next open. Uses the
// real pdf_tool sidecar; skipped when it is not installed.
async function runOcrScenario() {
  const sidecarDir = process.env.QBR_OCR_SIDECAR || "D:\\projects\\auto_chat";
  const scanSource = path.join(sidecarDir, "pdf_tool", "pdfs", "small_ocr.pdf");
  if (!fs.existsSync(path.join(sidecarDir, "pdf_tool", "reader", "server.py")) || !fs.existsSync(scanSource)) {
    console.log("ocr: skipped — no pdf_tool sidecar at", sidecarDir);
    return;
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-ocr-"));
  const booksDir = path.join(userData, "library", "Books");
  fs.mkdirSync(booksDir, { recursive: true });
  // A non-ASCII name on purpose: the sidecar's stdio must stay UTF-8 end to end.
  const scanPath = path.join(booksDir, "扫描件测试.pdf");
  fs.copyFileSync(scanSource, scanPath);
  const cacheDir = path.join(userData, "ocr-cache");
  const { app, page } = await launch(scanPath, {
    userData,
    seed: (dir) => {
      process.env.PDF_TOOL_OCR_CACHE = cacheDir;
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          ocrScannedPdf: true,
          ocrSidecarDir: sidecarDir,
          ocrPython: process.env.QBR_OCR_PYTHON || "python",
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    const shown = await waitFor("ocr progress bar", () => page.evaluate(() => {
      const el = document.querySelector(".qiaomu-reader-ocr-bar");
      return el ? (el.querySelector(".qiaomu-reader-ocr-text")?.textContent || "bar") : "";
    }), 40_000);
    console.log("ocr: progress bar shown:", shown.slice(0, 30));
    const progress = await waitFor("ocr progress", () => page.evaluate(() => {
      const text = document.querySelector(".qiaomu-reader-ocr-bar .qiaomu-reader-ocr-text")?.textContent || "";
      return /\d+\s*\/\s*\d+/.test(text) ? text : "";
    }), 120_000);
    console.log("ocr: progress", progress);
    // The first generated page lands in the loaded document's text (search /
    // selection) while the reader stays usable; no reopen or file switch.
    const firstPageText = await waitFor("first generated page text", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const pages = view?._pdfLazy?._pageText || [];
      return pages.some((text) => String(text).trim().length > 4) ? "ready" : "";
    }), 180_000);
    console.log("ocr:", firstPageText, "— reader usable, first page text visible");
    if (!(await readerReady(page))) throw new Error("the reader stopped working during OCR");

    // The page on screen must carry the generated text layer (this is what
    // selection and highlights use); a cached, already-painted page has to be
    // repainted when its text arrives.
    const painted = await waitFor("visible page text layer", () => page.evaluate(() => {
      const layers = [...document.querySelectorAll(".qiaomu-reader-pdf-text-layer")];
      const filled = layers.find((layer) => (layer.textContent || "").trim().length > 4);
      return filled ? filled.textContent.trim().slice(0, 16) : "";
    }), 180_000);
    console.log("ocr: visible page text layer:", painted);

    // The find panel must reach the generated text too (this is how the user
    // confirms search and the next-match jump on a scanned book).
    const fingerprint = fs.readdirSync(cacheDir).find((name) => name.startsWith("sha1-"));
    const params = fingerprint ? fs.readdirSync(path.join(cacheDir, fingerprint)).find((name) => name.startsWith("rapid_")) : "";
    let word = "";
    if (fingerprint && params) {
      const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, fingerprint, params, "page_0001.json"), "utf8"));
      word = String(cached.lines?.[0]?.[0] || "").trim().slice(0, 4);
    }
    if (word) {
      await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.findBtn?.click());
      await page.waitForSelector(".qiaomu-reader-toc-find-input", { timeout: 10_000 });
      await page.fill(".qiaomu-reader-toc-find-input", word);
      const found = await waitFor("find panel hit on generated text", () => page.evaluate(() => {
        const rows = document.querySelectorAll(".qiaomu-reader-find-item").length;
        const info = document.querySelector(".qiaomu-reader-find-info")?.textContent || "";
        return rows ? `${rows} hits · ${info}` : "";
      }), 30_000);
      console.log("ocr: find panel", found.slice(0, 40), "for", word);
      await page.evaluate(() => document.querySelector(".qiaomu-reader-find-controls button:nth-child(2)")?.click());
      const stepped = await page.evaluate(() => document.querySelector(".qiaomu-reader-find-info")?.textContent || "");
      console.log("ocr: after next —", stepped.slice(0, 24));
    }

    await waitFor("text layer ready", () => page.evaluate(() => (
      document.querySelector(".qiaomu-reader-ocr-bar")?.dataset.kind === "ready" ? "ready" : ""
    )), 900_000);
    const done = await page.evaluate(() => document.querySelector(".qiaomu-reader-ocr-bar .qiaomu-reader-ocr-text")?.textContent || "");
    console.log("ocr: all pages done —", done.slice(0, 30));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function runPdfScenario() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdf-"));
  const fixture = path.join(fixtureDir, "sample.pdf");
  writeMinimalPdf(fixture);
  const { app, page, userData } = await launch(fixture);
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("pdf ready", () => readerReady(page), 30_000);
    const bookKey = await currentBookKey(page);
    console.log("pdf: reader ready");

    // The selection popup follows the debounced selection check; retry the
    // whole step instead of assuming the first dispatch always lands.
    const selected = await waitFor("pdf selection with popup", async () => {
      const text = await page.evaluate(() => {
        const spans = [...document.querySelectorAll(".qiaomu-reader-pdf-text-layer span")]
          .filter((span) => span.textContent.trim().length > 3);
        const el = spans[0];
        if (!el) return "";
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
        return selection.toString().trim();
      });
      if (!text) return "";
      await sleep(250);
      const open = await page.evaluate(() => window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]
        ?.view?.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on") || false);
      return open ? text : "";
    }, 20_000);
    console.log("pdf: selected", selected.slice(0, 40));

    const stored = await highlightFromPopup(page, userData, bookKey, { cfi: false });
    console.log("pdf: highlight stored", stored.id, stored.color);

    // The fit toggle fills the reading slot (the zoom menu's old separate fit
    // width is gone), so the page covers essentially the whole column.
    assert.equal(await clickTopButton(page, "适合页面"), true);
    const fitShare = await waitFor("pdf fit page fills the width", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const page = view?.pager?.currentPdfPageElement?.();
      const figure = page?.querySelector(".qiaomu-reader-pdf-native-page");
      const width = Number.parseFloat(figure?.style.getPropertyValue("--qiaomu-reader-pdf-fit-width"));
      const slot = page?.clientWidth || 0;
      if (view?.plugin?.settings?.fitPage !== true || !width || !slot) return "";
      const share = (width * view.pdfZoom) / slot;
      return share > 0.97 && share < 1.01 ? String(Math.round(share * 100)) : "";
    }), 10_000);
    console.log("pdf: fit page fills the slot width", fitShare, "%");

    // A divider drag holds the PDF reflow while the pointer moves and lands it
    // once the button is released.
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.togglePanel("highlights"));
    await waitFor("pdf dock open", () => page.evaluate(
      () => document.querySelector(".qiaomu-reader-body")?.classList.contains("qiaomu-reader-hl-open")), 10_000);
    const handle = await page.evaluate(() => {
      const rect = document.querySelector(".qiaomu-reader-splitter-hl").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 60 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 30, handle.y, { steps: 5 });
    const held = await waitFor("pdf reflow held during the drag", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const laidOut = view.pager.builtWidth || 0;
      if (!document.documentElement.classList.contains("qbr-split-dragging")) return "";
      if (document.querySelector(".qiaomu-reader-relayouting")) return "";
      return laidOut && Math.abs(view.areaEl.clientWidth - laidOut) > 8 ? String(laidOut) : "";
    }), 8_000);
    await page.mouse.move(handle.x - 60, handle.y, { steps: 6 });
    await page.mouse.up();
    const landed = await waitFor("pdf reflow landed after the drag", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const laidOut = view.pager.builtWidth || 0;
      if (document.documentElement.classList.contains("qbr-split-dragging")) return "";
      if (document.querySelector(".qiaomu-reader-relayouting")) return "";
      return laidOut && Math.abs(view.areaEl.clientWidth - laidOut) < 8 ? String(laidOut) : "";
    }), 20_000);
    console.log("pdf: divider drag held the reflow at", held, "px and landed at", landed, "px");
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.togglePanel("highlights"));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// Pinned pinyin on a fixed-layout page: block-anchored, painted in the flow,
// restored after a restart.
async function runCjkPdfPinScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-cjk-"));
  const start = () => electron.launch({
    executablePath: require("electron"),
    args: [".", cjkPdf],
    cwd: appRoot,
    env: { ...process.env, QBR_USER_DATA: userData },
  });
  const selectHan = (page) => page.evaluate(() => {
    const spans = [...document.querySelectorAll(".qiaomu-reader-pdf-text-layer span")];
    for (const span of spans) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent || "";
      const at = [...text].findIndex((char) => /[\u4e00-\u9fff]/u.test(char));
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      span.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      return text.slice(at, at + 1);
    }
    return "";
  });
  const pinState = (page) => page.evaluate(() => {
    const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
    const span = document.querySelector(".qiaomu-reader-flow-pin");
    return {
      pins: view.plugin.getPins(view.file.path).map((pin) => ({ id: pin.id, block: pin.block, text: pin.text, pinyin: pin.pinyin })),
      span: span ? { py: span.getAttribute("data-py"), text: span.textContent } : null,
    };
  });

  const app = await start();
  let page = await app.firstWindow();
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("cjk pdf ready", () => readerReady(page), 30_000);
    // The text layer of the first spread is drawn a moment after the pager.
    const char = await waitFor("Han character in the CJK text layer", async () => (await selectHan(page)) || "", 20_000);
    const labelled = await waitFor("pinyin chip for the pdf selection", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      const chip = document.querySelector(".qiaomu-reader-py-chip");
      if (!chip) return "";
      return {
        label: chip.tagName === "BUTTON" ? chip.querySelector(".qiaomu-reader-py-pinyin")?.textContent || "" : "",
        tag: chip.tagName,
        pending: view._pendingSel?.text || "",
        block: view._pendingSel?.block,
      };
    }), 15_000);
    const labelledText = labelled.label || "";
    if (!labelledText) throw new Error(`unexpected reading chip: ${JSON.stringify(labelled)}`);
    await page.click(".qiaomu-reader-py-chip");
    const painted = await waitFor("pinned reading in the flow", () => pinState(page), 15_000);
    assert.ok(Number.isInteger(painted.pins[0]?.block), "a fixed-layout pin carries a block anchor");
    assert.equal(painted.span?.py, labelledText);
    await page.click(".qiaomu-reader-flow-pin");
    const card = await waitFor("pin card for the flow pin", () => page.evaluate(
      () => document.querySelector(".qiaomu-reader-pin-popup-on")?.textContent || ""), 10_000);
    if (!card.includes("移除注音")) throw new Error(`unexpected pin card: ${card}`);
    console.log("pdf: pinned reading painted and opens its card", char, labelledText);
    await app.close();
    fs.rmSync(`${userData}/Cache`, { recursive: true, force: true });

    const again = await start();
    page = await again.firstWindow();
    try {
      await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
      await waitFor("cjk pdf reopened", () => readerReady(page), 30_000);
      const restored = await waitFor("pin restored after restart", async () => {
        const state = await pinState(page);
        return state.pins.length ? state : "";
      }, 15_000);
      assert.equal(restored.pins.length, 1, "the pin survived the restart");
      const painted = await waitFor("reading painted again", async () => {
        const state = await pinState(page);
        return state.span ? state : "";
      }, 10_000).catch(() => restored);
      assert.equal(painted.span?.py, labelledText, `the reading is painted again: ${JSON.stringify(painted)}`);
      console.log("pdf: pinned reading restored after a restart");

      // A highlight entry in the docked list jumps to its page even when that
      // page has not been rendered yet.
      // The text layer of a digital PDF arrives in the background (page by
      // page), so wait for page 4's text instead of assuming it is already in
      // the flow - a one-shot lookup raced the text pass.
      await waitFor("page 4 text in the flow", () => page.evaluate(() => {
        const flow = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.pager.flow;
        return [...flow.querySelectorAll("p,h1,h2,h3,h4,.qiaomu-reader-pdf-text-layer")]
          .some((el) => el.textContent.includes("第4页的正文内容"));
      }), 30_000);
      const jumped = await page.evaluate(async () => {
        const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
        const flow = view.pager.flow;
        const blocks = [...flow.querySelectorAll("p,h1,h2,h3,h4,.qiaomu-reader-pdf-text-layer")];
        const needle = "第4页的正文内容";
        const index = blocks.findIndex((el) => el.textContent.includes(needle));
        if (index < 0) return { error: "no late block" };
        const full = blocks[index].textContent;
        const at = full.indexOf(needle);
        view.plugin.addHighlight(view.file.path, {
          id: "e2e-late", color: "yellow", text: needle, block: index, occ: 0,
          pre: full.slice(Math.max(0, at - 24), at), post: full.slice(at + needle.length, at + needle.length + 24), created: Date.now(),
        });
        view._renderFlowHighlights();
        const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // Diagnostics for the failure message: if the flow dropped page 4's text
        // layer while the click was in flight, the anchor has nothing to match.
        const liveCount = (countAll) => {
          const live = [...view.pager.flow.querySelectorAll("p,h1,h2,h3,h4,.qiaomu-reader-pdf-text-layer")];
          return countAll ? live.length : live.filter((el) => el.textContent.includes(needle)).length;
        };
        const clickEntry = () => items[items.length - 1]?.click();
        const before = view.pager.currentPdfPageNumber();
        view.togglePanel("highlights");
        await settle(500);
        const items = [...document.querySelectorAll(".qiaomu-reader-hl-item")];
        const entry = items[items.length - 1]?.querySelector(".qiaomu-reader-hl-text");
        const entryText = entry?.textContent || "";
        clickEntry();
        // Under load the first click can land before the reader is ready, so poll
        // for the page change and click once more rather than trusting one sleep.
        let after = view.pager.currentPdfPageNumber();
        for (let attempt = 0; attempt < 25 && after === before; attempt += 1) {
          await settle(200);
          after = view.pager.currentPdfPageNumber();
          if (after === before && attempt === 14) clickEntry();
        }
        return { before, after, items: items.length, entryText, needleLive: liveCount(), flowBlocks: liveCount(true) };
      });
      if (jumped.error) throw new Error(jumped.error);
      if (!/^\[第 4 页\]/.test(jumped.entryText)) throw new Error(`the entry has no page prefix: ${jumped.entryText}`);
      if (jumped.after === jumped.before) throw new Error(`the highlight did not jump: ${JSON.stringify(jumped)}`);
      console.log("pdf: highlight entry jumped to page", jumped.after);

      // A page illustration opens the zoomable viewer; its toolbar carries the
      // zoom controls and the AI attach action, and Escape closes it.
      await page.evaluate(() => {
        const img = document.querySelector(".qiaomu-reader-pdf-lazy[src]");
        img?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      const viewer = await waitFor("image viewer", () => page.evaluate(() => {
        const layer = document.querySelector(".qiaomu-reader-lightbox");
        if (!layer) return "";
        return JSON.stringify({
          buttons: [...layer.querySelectorAll(".qiaomu-reader-lightbox-btn")].map((b) => b.textContent),
          zoom: layer.dataset.zoom || "",
        });
      }), 10_000);
      if (!viewer.includes("AI")) throw new Error(`the image viewer has no AI attach action: ${viewer}`);
      const zoomed = await page.evaluate(async () => {
        const layer = document.querySelector(".qiaomu-reader-lightbox");
        const before = Number(layer.dataset.zoom) || 0;
        [...layer.querySelectorAll(".qiaomu-reader-lightbox-btn")].find((b) => b.textContent === "＋")?.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { before, after: Number(layer.dataset.zoom) || 0 };
      });
      if (!(zoomed.after > zoomed.before)) throw new Error(`the viewer did not zoom: ${JSON.stringify(zoomed)}`);
      await page.keyboard.press("Escape");
      await sleep(300);
      const viewerClosed = await page.evaluate(() => !document.querySelector(".qiaomu-reader-lightbox"));
      if (!viewerClosed) throw new Error("Escape did not close the image viewer");
      console.log("pdf: page image opens the zoomable viewer", viewer);
    } finally {
      await again.close().catch(() => {});
    }
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function runAiScenario() {
  const mock = await startMockAi();
  const base = `http://127.0.0.1:${mock.port}/v1`;
  let bookKey = "";
  const { app, page, userData } = await launch(book, {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          aiProvider: "custom",
          aiBases: { custom: base },
          aiModels: { custom: "mock-model" },
          aiEnabled: false,
          aiNeedsVerification: false,
          aiCompanionVisible: true,
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    bookKey = await currentBookKey(page);
    if (!(await page.$(".qiaomu-reader-companion-setup"))) {
      await page.evaluate(async () => {
        try {
          await window.__qbrPlugin.openAiChat();
        } catch {}
      });
    }
    await waitFor("companion setup", async () => Boolean(await page.$(".qiaomu-reader-companion-start")), 20_000);
    console.log("ai: setup panel ready");

    await page.click(".qiaomu-reader-companion-start");
    await page.waitForSelector(".qiaomu-reader-ai-input", { timeout: 20_000 });
    console.log("ai: connection test passed, composer ready");

    await page.fill(".qiaomu-reader-ai-input", "MOCK QUESTION");
    await page.press(".qiaomu-reader-ai-input", "Enter");
    await waitFor("streamed answer", () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
      return bubbles.some((bubble) => bubble.textContent.includes("MOCK STREAM ANSWER")) ? "yes" : "";
    }), 20_000);
    console.log("ai: answer streamed");

    // LaTeX in an answer is typeset (KaTeX), not shown as raw dollar code.
    await page.fill(".qiaomu-reader-ai-input", "MATH QUESTION");
    await page.press(".qiaomu-reader-ai-input", "Enter");
    await waitFor("math answer", () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
      const bubble = bubbles.find((entry) => entry.textContent.includes("答案"));
      return bubble?.querySelector(".katex math") ? "yes" : "";
    }), 25_000);
    const mathInfo = await page.evaluate(() => {
      const math = document.querySelector(".qiaomu-reader-ai-msg-ai .katex math");
      return {
        tag: math?.tagName || "",
        tex: math?.querySelector('annotation[encoding="application/x-tex"]')?.textContent || "",
      };
    });
    if (mathInfo.tag.toLowerCase() !== "math" || !/frac/.test(mathInfo.tex)) {
      throw new Error(`the formula did not typeset: ${JSON.stringify(mathInfo)}`);
    }
    console.log("ai: latex formula rendered", mathInfo.tex.slice(0, 30));

    const record = await waitFor("chat stored in the book folder", () => (
      readStoredChats(userData, bookKey).find((chat) => (
        chat.turns?.some((turn) => String(turn.content).includes("MOCK STREAM ANSWER"))
      )) || ""
    ), 20_000);
    if (mock.state.requests < 2) throw new Error(`expected a connection test and a chat request, saw ${mock.state.requests}`);
    console.log("ai: chat persisted", record.id, `(${mock.state.requests} requests)`);

    // Selecting English text asks the configured service for a translation and
    // shows it in the reading chip.
    const selected = await waitFor("english selection", async () => {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const text = await frame.evaluate(() => {
            const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
            if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return "";
            const el = [...document.querySelectorAll("p")].find((node) => {
              const length = node.textContent.trim().length;
              if (length <= 30 || length >= 400) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
            });
            if (!el) return "";
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = document.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
            el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
            return selection.toString().replace(/\s+/g, " ").trim();
          });
          if (text) return text;
        } catch {}
      }
      return "";
    }, 20_000);
    const translated = await waitFor("selection translation", () => page.evaluate(() => {
      const chip = document.querySelector(".qiaomu-reader-py-chip");
      const gloss = chip?.querySelector(".qiaomu-reader-py-gloss")?.textContent || "";
      return gloss.includes("MOCK STREAM ANSWER") ? gloss : "";
    }), 20_000);
    console.log("ai: selection translated", selected.slice(0, 18), "->", translated.slice(0, 24));

    // Unsent composer text belongs to the book and lands in its folder.
    await page.evaluate(() => {
      const input = document.querySelector(".qiaomu-reader-ai-composer .qiaomu-reader-ai-input");
      if (!input) return;
      input.value = "DRAFT-MARKER-42";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const draft = await waitFor("draft stored in the book folder", () => readStoredDraft(userData, bookKey), 15_000);
    console.log("ai: draft stored in the book folder", draft.text.slice(0, 24));

    // The toolbar AI button is a toggle: it closes an open companion, opens it
    // again and keeps its pressed state in sync with the sidebar.
    const aiButtonState = () => page.evaluate(() => {
      const button = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.aiBtn;
      return {
        open: window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat").length > 0,
        pressed: Boolean(button?.classList.contains("qiaomu-reader-ibtn-on")),
        expanded: button?.getAttribute("aria-expanded") || "",
      };
    });
    const beforeToggle = await aiButtonState();
    if (!beforeToggle.open || !beforeToggle.pressed || beforeToggle.expanded !== "true") {
      throw new Error(`the AI button should be pressed while the companion is open: ${JSON.stringify(beforeToggle)}`);
    }
    await page.evaluate(() => {
      window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.aiBtn?.click();
    });
    await waitFor("ai button closes the companion", async () => {
      const state = await aiButtonState();
      return !state.open && !state.pressed && state.expanded === "false" ? "closed" : "";
    }, 10_000);
    await page.evaluate(() => {
      window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.aiBtn?.click();
    });
    await waitFor("ai button reopens the companion", async () => {
      const state = await aiButtonState();
      return state.open && state.pressed && state.expanded === "true" ? "open" : "";
    }, 15_000);
    console.log("ai: toolbar button toggles the companion with a pressed state");

    // Leaving the reader (the back button opens the library) closes the
    // companion sidebar while keeping the saved preference.
    const companion = await page.evaluate(
      () => window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat").length);
    if (!companion) throw new Error("the companion should be open before the route change");
    await page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      view?.contentEl?.querySelector(".qiaomu-reader-top .qiaomu-reader-ibtn")?.click();
    });
    await waitFor("companion closed on leaving the reader", () => page.evaluate(() => {
      const leaves = window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat");
      return leaves.length === 0 && window.__qbrPlugin.settings.aiCompanionVisible !== false ? "closed" : "";
    }), 10_000);
    console.log("ai: companion closed on leaving the reader, preference kept");

    // Conversations belong to the book: after a restart the panel lists the
    // stored copy even though the host history file no longer holds it.
    await app.close().catch(() => {});
    const second = await launch(book, { userData });
    try {
      await second.page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
      await waitFor("reader ready", () => readerReady(second.page), 30_000);
      const restored = await waitFor("chat restored after restart", () => second.page.evaluate((id) => {
        const chat = (window.__qbrPlugin.settings.aiChatHistory || []).find((item) => item.id === id);
        return chat && JSON.stringify(chat.turns || []).includes("MOCK STREAM ANSWER") ? chat.id : "";
      }, record.id), 20_000);
      console.log("ai: chat restored after restart", restored);

      await second.page.evaluate(async () => {
        if (!document.querySelector(".qiaomu-reader-ai-input")) await window.__qbrPlugin.openAiChat?.();
      });
      await waitFor("composer after restart", () => second.page.evaluate(
        () => Boolean(document.querySelector(".qiaomu-reader-ai-composer .qiaomu-reader-ai-input"))), 20_000);
      const draftBack = await waitFor("draft restored after restart", () => second.page.evaluate(
        () => document.querySelector(".qiaomu-reader-ai-composer .qiaomu-reader-ai-input")?.value || "",
      ).then((value) => (value.includes("DRAFT-MARKER-42") ? value : "")), 20_000);
      console.log("ai: draft restored after restart", draftBack.slice(0, 24));
    } finally {
      await second.app.close().catch(() => {});
    }
  } finally {
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// The AI settings state what the endpoint proved it can do: one minimal probe
// per capability, remembered per provider/base/model, with the manual override
// as the only way to contradict the result.
async function runCapabilityScenario() {
  const mock = await startMockAi({ probeDigit: "4" });
  const base = `http://127.0.0.1:${mock.port}/v1`;
  const { app, page, userData } = await launch(book, {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          aiProvider: "custom",
          aiBases: { custom: base },
          aiModels: { custom: "mock-vision-model" },
          aiEnabled: true,
          aiNeedsVerification: false,
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    // Render the AI settings group and pin the probe digit so the mock can
    // answer it without reading pixels.
    const painted = await page.evaluate(() => {
      Math.random = () => 0.4;
      const plugin = window.__qbrPlugin;
      const host = document.createElement("div");
      host.id = "e2e-ai-settings";
      document.body.appendChild(host);
      const redraw = () => {
        host.replaceChildren();
        plugin.settingsTab._groupAi(host, redraw, {});
      };
      plugin.settingsTab._groupAi(host, redraw, {});
      return [...host.querySelectorAll(".setting-item")].map((row) => row.querySelector(".setting-item-name")?.textContent || "");
    });
    if (!painted.includes("图片识别") || !painted.includes("工具调用")) {
      throw new Error(`capability rows are missing: ${JSON.stringify(painted)}`);
    }
    const clickCapability = (name) => page.evaluate((label) => {
      const row = [...document.querySelectorAll("#e2e-ai-settings .setting-item")]
        .find((item) => item.querySelector(".setting-item-name")?.textContent === label);
      const button = row?.querySelector("button");
      if (!button) return false;
      button.click();
      return true;
    }, name);
    const capabilityRow = (name) => page.evaluate((label) => {
      const row = [...document.querySelectorAll("#e2e-ai-settings .setting-item")]
        .find((item) => item.querySelector(".setting-item-name")?.textContent === label);
      return { desc: row?.querySelector(".setting-item-description")?.textContent || "", button: row?.querySelector("button")?.textContent || "" };
    }, name);

    if (!(await clickCapability("图片识别"))) throw new Error("the image capability check is missing");
    const imageState = await waitFor("image support detected", async () => {
      const row = await capabilityRow("图片识别");
      return row.desc.includes("已支持") ? row : "";
    }, 20_000);
    if (!mock.state.sawImage) throw new Error("the probe did not send an image part");
    const afterImage = await page.evaluate(() => window.__qbrPlugin.settings.aiCapabilities);
    const key = Object.keys(afterImage)[0] || "";
    if (afterImage[key]?.image?.state !== "yes") throw new Error(`image capability not remembered: ${JSON.stringify(afterImage)}`);
    console.log("capability: image probe proved support", `(${imageState.button})`, "key", key);

    // The same endpoint can refuse a tools array; the probe reports it and the
    // remembered fact flips to "not supported".
    mock.state.tools = false;
    if (!(await clickCapability("工具调用"))) throw new Error("the tools capability check is missing");
    const toolsState = await waitFor("tools refusal detected", async () => {
      const row = await capabilityRow("工具调用");
      return row.desc.includes("当前模型不支持") ? row : "";
    }, 20_000);
    const afterTools = await page.evaluate(() => window.__qbrPlugin.settings.aiCapabilities);
    if (afterTools[key]?.tools?.state !== "no") throw new Error(`tools capability not remembered: ${JSON.stringify(afterTools)}`);
    console.log("capability: tools probe reported", toolsState.desc);

    // Re-checking after the endpoint starts accepting tools flips it back.
    mock.state.tools = true;
    if (!(await clickCapability("工具调用"))) throw new Error("the tools re-check is missing");
    await waitFor("tools support re-checked", async () => {
      const row = await capabilityRow("工具调用");
      return row.desc.includes("已支持") ? row : "";
    }, 20_000);
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "data", "data.json"), "utf8")).settings.aiCapabilities;
    if (persisted[key]?.tools?.state !== "yes") throw new Error(`re-checked capability not persisted: ${JSON.stringify(persisted)}`);
    console.log("capability: re-check persisted", JSON.stringify(persisted[key]));

    // A manual override wins over any detection result and repaints the row.
    // The name appears twice (the state row and the advanced override row), so
    // pick the row that actually carries the dropdown.
    const overrideSelect = (name) => page.evaluate((label) => {
      const rows = [...document.querySelectorAll("#e2e-ai-settings .setting-item")]
        .filter((item) => item.querySelector(".setting-item-name")?.textContent === label);
      const select = rows.map((item) => item.querySelector("select")).find(Boolean);
      if (!select) return false;
      select.value = "no";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, name);
    if (!(await overrideSelect("图片识别"))) throw new Error("the capability override is missing from the advanced section");
    await sleep(300);
    const forced = await capabilityRow("图片识别");
    const forcedSettings = await page.evaluate(() => ({ mode: window.__qbrPlugin.settings.aiVisionMode, saved: window.__qbrPlugin.settings.aiCapabilities }));
    if (forcedSettings.mode !== "no") throw new Error(`the override was not stored: ${JSON.stringify(forcedSettings)}`);
    if (!forced.desc.includes("当前模型不支持")) throw new Error(`the override did not repaint the row as: ${JSON.stringify(forced)}`);
    console.log("capability: manual override repainted the row as", forced.desc);
    // Back to automatic so the image turn below uses the detected capability.
    await page.evaluate(async () => {
      window.__qbrPlugin.settings.aiVisionMode = "auto";
      await window.__qbrPlugin.saveAll();
    });

    // An image turn: paste a PNG, see the chip, send it with no typed text, and
    // find the image part in the request plus the stored turn on disk.
    await page.evaluate(async () => {
      try { await window.__qbrPlugin.openAiChat(); } catch {}
    });
    await page.waitForSelector(".qiaomu-reader-ai-input", { timeout: 20_000 });
    const pasted = await page.evaluate(async () => {
      const input = document.querySelector(".qiaomu-reader-ai-input");
      if (!input) return "no composer";
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 48;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 96, 48);
      ctx.fillStyle = "#111111";
      ctx.font = "600 34px sans-serif";
      ctx.fillText("4", 34, 38);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], "figure.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      return "pasted";
    });
    if (pasted !== "pasted") throw new Error(`paste failed: ${pasted}`);
    const chip = await waitFor("attachment chip", () => page.evaluate(() => {
      const chip = document.querySelector(".qiaomu-reader-ai-attach-chip");
      return chip ? chip.querySelector(".qiaomu-reader-ai-attach-name")?.textContent || "chip" : "";
    }), 20_000);
    const imagesBefore = mock.state.imageRequests;
    await page.click(".qiaomu-reader-ai-send");
    const answer = await waitFor("image turn answered", () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
      return bubbles.some((bubble) => bubble.textContent.trim() === "4") ? "4" : "";
    }), 20_000);
    if (mock.state.imageRequests <= imagesBefore) throw new Error("the sent turn did not carry the image part");
    const cleared = await waitFor("composer cleared after sending", () => page.evaluate(
      () => (document.querySelector(".qiaomu-reader-ai-attach-slot")?.textContent || "").trim() === "" ? "cleared" : ""), 10_000);
    const storedTurn = await waitFor("stored attachment metadata", () => {
      const turn = chatTurnWithAttachment(userData);
      return turn?.attachments?.[0]?.file ? turn : "";
    }, 15_000);
    if (storedTurn.attachments[0].data) {
      throw new Error(`the stored attachment kept bytes: ${JSON.stringify(storedTurn.attachments[0]).slice(0, 160)}`);
    }
    const savedFile = path.join(userData, "library", storedTurn.attachments[0].file);
    if (!fs.existsSync(savedFile)) throw new Error(`the attachment file is missing: ${savedFile}`);
    if (!/^plugin\/reading\/.+\/attachments\//.test(storedTurn.attachments[0].file.replace(/\\/g, "/"))) {
      throw new Error(`the attachment did not land in the book folder: ${storedTurn.attachments[0].file}`);
    }
    console.log("attachment:", chip, "sent with the image part and stored at", storedTurn.attachments[0].file, "->", answer, cleared);

    // Screenshot: drag a box over the reading area. Esc cancels first, then a
    // real drag attaches the captured region as an image.
    const clickAttachItem = (label) => page.evaluate((text) => {
      const items = [...document.querySelectorAll(".qiaomu-reader-ai-attach-menu .qiaomu-reader-ai-attach-item")];
      const item = items.find((el) => el.textContent.trim() === text);
      if (!item) return [...items].map((el) => el.textContent.trim()).join("|");
      item.click();
      return "clicked";
    }, label);
    await page.click(".qiaomu-reader-ai-attach");
    const menu = await page.evaluate(() => [...document.querySelectorAll(".qiaomu-reader-ai-attach-menu .qiaomu-reader-ai-attach-item")]
      .map((el) => el.textContent.trim()));
    if (!menu.includes("截图")) throw new Error(`the screenshot entry is missing: ${JSON.stringify(menu)}`);
    await clickAttachItem("截图");
    await waitFor("screenshot overlay", () => page.evaluate(
      () => Boolean(document.querySelector(".qiaomu-reader-shot"))), 8_000);
    await page.keyboard.press("Escape");
    await waitFor("screenshot overlay cancelled", () => page.evaluate(
      () => !document.querySelector(".qiaomu-reader-shot")), 8_000);
    const chipsBefore = await page.evaluate(
      () => document.querySelectorAll(".qiaomu-reader-ai-attach-slot .qiaomu-reader-ai-attach-chip").length);

    await page.click(".qiaomu-reader-ai-attach");
    await clickAttachItem("截图");
    await waitFor("screenshot overlay again", () => page.evaluate(
      () => Boolean(document.querySelector(".qiaomu-reader-shot"))), 8_000);
    const area = await page.evaluate(() => {
      const rect = document.querySelector(".qiaomu-reader-area").getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    await page.mouse.move(area.x + 40, area.y + 60);
    await page.mouse.down();
    await page.mouse.move(area.x + 300, area.y + 220, { steps: 8 });
    await page.mouse.up();
    const shotChip = await waitFor("screenshot chip", () => page.evaluate(() => {
      const chips = [...document.querySelectorAll(".qiaomu-reader-ai-attach-slot .qiaomu-reader-ai-attach-chip")];
      const chip = chips.find((el) => /截图|Screenshot/.test(el.querySelector(".qiaomu-reader-ai-attach-name")?.textContent || ""));
      return chip ? chip.querySelector(".qiaomu-reader-ai-attach-name").textContent : "";
    }), 15_000);
    const shot = await page.evaluate(() => {
      const leaf = window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat")[0];
      const list = leaf?.view?.attachments || [];
      const entry = list.find((item) => item.source === "shot");
      return entry ? { source: entry.source, width: entry.width, height: entry.height, bytes: entry.bytes, file: entry.file } : null;
    });
    if (!shot) throw new Error("the screenshot attachment is missing from the composer");
    if (shot.width < 200 || shot.width > 900 || shot.height < 120 || shot.height > 600) {
      throw new Error(`the captured region has the wrong size: ${JSON.stringify(shot)}`);
    }
    if (shot.file && !fs.existsSync(path.join(userData, "library", shot.file))) {
      throw new Error(`the screenshot file is missing: ${shot.file}`);
    }
    if (chipsBefore !== 0) throw new Error(`Esc should have cancelled without attachments, saw ${chipsBefore}`);
    console.log("screenshot:", shotChip, `${shot.width}x${shot.height}`, `${Math.round(shot.bytes / 1024)}KB`, "->", shot.file);

    // Double-clicking a thumbnail previews the real image; Esc closes it.
    await page.dblclick(".qiaomu-reader-ai-attach-slot .qiaomu-reader-ai-attach-chip");
    const preview = await waitFor("image preview", () => page.evaluate(() => {
      const overlay = document.querySelector(".qiaomu-reader-image-preview");
      const src = overlay?.querySelector("img")?.getAttribute("src") || "";
      return src.startsWith("data:image/") ? src.slice(0, 16) : "";
    }), 10_000);
    await page.keyboard.press("Escape");
    await waitFor("image preview closed", () => page.evaluate(
      () => !document.querySelector(".qiaomu-reader-image-preview")), 8_000);
    console.log("preview:", preview, "opened and closed");

    // "Current page" from the same menu captures the page (or the visible
    // reading area) without drawing a box.
    await page.click(".qiaomu-reader-ai-attach");
    if (await clickAttachItem("当前页图片") !== "clicked") throw new Error("the current-page entry is missing");
    const pageShot = await waitFor("current page attachment", () => page.evaluate(() => {
      const leaf = window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat")[0];
      const list = (leaf?.view?.attachments || []).filter((item) => item.source === "shot");
      const wide = list.find((item) => item.width >= 400);
      return wide ? `${wide.width}x${wide.height}` : "";
    }), 15_000);
    console.log("current page:", pageShot);

    // Tools: the model asks to search, the reader runs it and answers with the
    // result. The composer still holds the two screenshots, so clear them.
    await page.evaluate(() => {
      const leaf = window.__qbrApp.workspace.getLeavesOfType("qiaomu-book-reader-ai-chat")[0];
      if (leaf?.view) leaf.view.attachments = [];
    });
    await page.evaluate(() => document.querySelector(".qiaomu-reader-ai-attach-slot")?.replaceChildren());
    await page.fill(".qiaomu-reader-ai-input", "用工具检索 Alice");
    await page.press(".qiaomu-reader-ai-input", "Enter");
    await waitFor("tool answer", () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
      return bubbles.some((bubble) => bubble.textContent.includes("MOCK TOOL ANSWER")) ? "yes" : "";
    }), 30_000);
    const toolInfo = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".qiaomu-reader-ai-tool")].at(-1);
      return {
        title: card?.querySelector(".qiaomu-reader-ai-tool-title")?.textContent || "",
        status: card?.querySelector(".qiaomu-reader-ai-tool-status")?.textContent || "",
        result: card?.querySelector(".qiaomu-reader-ai-tool-text")?.textContent || "",
      };
    });
    if (!toolInfo.title.includes("检索全书")) throw new Error(`the tool step has the wrong title: ${JSON.stringify(toolInfo)}`);
    if (toolInfo.status !== "完成") throw new Error(`the tool step did not finish: ${JSON.stringify(toolInfo)}`);
    if (!/Alice/.test(toolInfo.result)) throw new Error(`the tool result has no search hit: ${JSON.stringify(toolInfo).slice(0, 200)}`);
    const toolIcon = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".qiaomu-reader-ai-tool")].at(-1);
      const svg = card?.querySelector(".qiaomu-reader-ai-tool-icon svg");
      return svg ? Math.round(svg.getBoundingClientRect().width) : 0;
    });
    if (!toolIcon || toolIcon > 20) throw new Error(`the tool step icon should be small and present: ${toolIcon}px`);
    const storedTool = await waitFor("stored tool turn", () => {
      const turn = storedChatTurns(userData).find((item) => item.role === "tool");
      return turn?.toolName === "search_book" ? turn : "";
    }, 15_000);
    if (storedTool.isError) throw new Error("the stored tool turn is an error");
    console.log("tools:", toolInfo.title, "->", toolInfo.status, `(${toolInfo.result.length} chars)`, `${toolIcon}px icon`, "stored as", storedTool.toolName);

    // Every question carries where the reader was when it was submitted.
    const locatedTurn = await waitFor("stored question location", () => {
      const turn = storedChatTurns(userData).find((item) => item.role === "user" && item.location?.page);
      return turn ? turn.location : "";
    }, 15_000);
    if (!mock.state.lastUserText.includes("提问时位置")) {
      throw new Error(`the model did not receive the position: ${mock.state.lastUserText.slice(0, 120)}`);
    }
    const locationChip = await page.evaluate(() => {
      const chip = document.querySelector(".qiaomu-reader-ai-location-chip");
      return chip ? chip.textContent.trim() : "";
    });
    await page.evaluate(() => document.querySelector(".qiaomu-reader-ai-location-chip")?.click());
    console.log("location:", JSON.stringify(locatedTurn), "->", locationChip, "chip jumps back");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    mock.server.close();
  }
}

async function runApiKeyScenario() {
  const mock = await startMockAi();
  const base = `http://127.0.0.1:${mock.port}/v1`;
  const { app, page, userData } = await launch(book, {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          aiProvider: "deepseek",
          aiBases: { deepseek: base },
          aiModels: { deepseek: "deepseek-chat" },
          aiEnabled: false,
          aiNeedsVerification: false,
          aiCompanionVisible: true,
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    if (!(await page.$(".qiaomu-reader-companion-setup"))) {
      await page.evaluate(async () => {
        try {
          await window.__qbrPlugin.openAiChat();
        } catch {}
      });
    }
    await waitFor("companion setup", async () => Boolean(await page.$(".qiaomu-reader-companion-setup")), 20_000);
    const keyInput = page.locator('.qiaomu-reader-companion-setup input[type="password"]');
    await keyInput.waitFor({ timeout: 10_000 });
    await keyInput.fill("sk-test-123");
    await keyInput.dispatchEvent("change");
    await sleep(400);
    await page.click(".qiaomu-reader-companion-start");
    await sleep(4000);
    const diag = await page.evaluate(() => {
      const plugin = window.__qbrPlugin;
      const feedback = document.querySelector(".qiaomu-reader-ai-setup-feedback");
      const setup = document.querySelector(".qiaomu-reader-companion-setup");
      return {
        secretId: plugin.settings.aiSecrets?.deepseek || "",
        keyValue: (() => {
          try { return String(plugin.app.secretStorage.getSecret(plugin.settings.aiSecrets?.deepseek || "") || ""); } catch (error) { return `error: ${error.message}`; }
        })(),
        aiEnabled: plugin.settings.aiEnabled,
        feedback: feedback?.textContent || "",
        hasComposer: Boolean(document.querySelector(".qiaomu-reader-ai-input")),
        hasSetup: Boolean(setup),
      };
    });
    console.log("apikey diag:", JSON.stringify(diag), "mock:", JSON.stringify(mock.state));
    await page.waitForSelector(".qiaomu-reader-ai-input", { timeout: 20_000 });
    if (mock.state.auth !== "Bearer sk-test-123") throw new Error(`unexpected Authorization header: ${JSON.stringify(mock.state.auth)}`);
    console.log("apikey: connection test used the stored key");

    await page.fill(".qiaomu-reader-ai-input", "MOCK QUESTION");
    await page.press(".qiaomu-reader-ai-input", "Enter");
    await waitFor("streamed answer", () => page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".qiaomu-reader-ai-msg-ai")];
      return bubbles.some((bubble) => bubble.textContent.includes("MOCK STREAM ANSWER")) ? "yes" : "";
    }), 20_000);

    const settings = JSON.parse(fs.readFileSync(path.join(userData, "data", "data.json"), "utf8")).settings;
    if (!settings.aiSecrets?.deepseek) throw new Error("the secret id was not persisted in settings");
    if (!fs.existsSync(path.join(userData, "secrets.json"))) throw new Error("secrets.json was not written");
    console.log("apikey: key stored, answer streamed, secret persisted");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    mock.server.close();
  }
}

async function runScrollScenario() {
  const { app, page, userData } = await launch(book, {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          readMode: "scroll",
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    const pageInfo = await page.evaluate(() => {
      const input = document.querySelector(".qiaomu-reader-pageinput");
      const total = document.querySelector(".qiaomu-reader-pagetotal");
      return { value: input?.value || "", total: total?.textContent || "", disabled: Boolean(input?.disabled) };
    });
    if (!pageInfo.value || !pageInfo.total.includes("/")) throw new Error(`page jump control missing: ${JSON.stringify(pageInfo)}`);
    const chrome = await page.evaluate(() => ({
      bottomBar: document.querySelectorAll(".qiaomu-reader-bot").length,
      navButtons: document.querySelectorAll(".qiaomu-reader-navbtn").length,
    }));
    if (chrome.navButtons || chrome.bottomBar) throw new Error(`reader chrome still shows the bottom bar: ${JSON.stringify(chrome)}`);
    console.log("scroll: top page jump", pageInfo.value, pageInfo.total, "| bottom bar removed");

    const locationOf = () => page.evaluate(() => JSON.stringify(
      window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.engine.currentLocation(),
    ));
    const before = await locationOf();
    const jumped = await waitFor("page jump", async () => {
      await page.fill(".qiaomu-reader-pageinput", "6");
      await page.press(".qiaomu-reader-pageinput", "Enter");
      await sleep(700);
      const current = await locationOf();
      return current !== before ? current : "";
    }, 15_000);
    console.log("scroll: page jump moved the view", jumped.slice(0, 60));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// Geometry regression for the toolbar page nav: as the window narrows it must
// never sit on top of the back button or the right tray (search, settings,
// zoom). Prints the measured numbers so a failure explains itself.
async function runNavScenario() {
  const { app, page, userData } = await launch(book, {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          readMode: "scroll",
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    const measure = () => page.evaluate(() => {
      const rect = (el) => {
        const box = el?.getBoundingClientRect();
        return box ? { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) } : null;
      };
      const bar = document.querySelector(".qiaomu-reader-top");
      return {
        bar: rect(bar),
        back: rect(bar?.firstElementChild),
        nav: rect(document.querySelector(".qiaomu-reader-pagejump")),
        tray: rect(document.querySelector(".qiaomu-reader-top-right")),
        left: document.querySelector(".qiaomu-reader-pagejump")?.style?.left || "",
      };
    });
    for (const width of [1200, 1000, 900, 820, 760, 700, 660]) {
      await app.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]?.setSize(value, 760);
      }, width);
      await sleep(600);
      const m = await measure();
      // The tray is left-aligned; the nav must clear its right edge. The other
      // side only has to stay inside the bar.
      const overlapsTray = m.nav && m.tray ? m.nav.left < m.tray.right + 4 : false;
      const insideBar = m.nav && m.bar ? m.nav.left >= m.bar.left && m.nav.right <= m.bar.right : false;
      console.log(`nav: width=${width} bar=${m.bar?.left}-${m.bar?.right} tray=${m.tray?.left}-${m.tray?.right} nav=${m.nav?.left}-${m.nav?.right} styleLeft=${m.left} overlapTray=${overlapsTray} insideBar=${insideBar}`);
      if (overlapsTray) throw new Error(`page nav overlaps the button tray at width ${width}`);
      if (!insideBar) throw new Error(`page nav leaves the toolbar at width ${width}`);
    }
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// Tab visibility guard: each library tab owns a grid, and switching must hide
// the other one (a missing rule once left the local cards under the online
// results).
async function runLibraryTabsScenario() {
  const { app, page, userData } = await launch("");
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await waitFor("home cards", async () => (await page.$$(".qbr-home-card")).length > 0, 20_000);
    // Tag one book first so the tree's tag node has something to filter.
    await page.evaluate(() => window.__qbrPlugin.setBookTags("Books/示例书库/Alice in Wonderland.epub", ["测试标签"]));
    await page.evaluate(() => window.__qbrPlugin.openLibrary());
    await waitFor("library modal", async () => Boolean(await page.$(".qiaomu-reader-modal-lib")), 15_000);
    await waitFor("library tree", () => page.evaluate(() => document.querySelectorAll(".qiaomu-reader-lib-tree .qiaomu-reader-lib-node").length >= 5), 30_000);
    await waitFor("library grids", () => page.evaluate(() => document.querySelectorAll(".qiaomu-reader-lib-grid").length === 2), 30_000);
    const state = () => page.evaluate(() => {
      const local = document.querySelector(".qiaomu-reader-lib-grid:not(.qiaomu-reader-lib-online-grid)");
      const online = document.querySelector(".qiaomu-reader-lib-online-grid");
      const visible = (el) => Boolean(el && typeof el.checkVisibility === "function" && el.checkVisibility());
      return {
        local: visible(local),
        online: visible(online),
        on: document.querySelector(".qiaomu-reader-lib-node-on")?.dataset?.node || "",
        cards: document.querySelectorAll(".qiaomu-reader-lib-card").length,
      };
    });
    let seen = await state();
    if (!seen.local || seen.online || seen.on !== "all") {
      throw new Error(`本地书库 should be the default node with the local grid: ${JSON.stringify(seen)}`);
    }
    // A tag node filters the local grid to that tag.
    await page.evaluate(() => document.querySelector('.qiaomu-reader-lib-node[data-node="tag:测试标签"]')?.click());
    await sleep(300);
    seen = await state();
    if (seen.on !== "tag:测试标签" || seen.cards !== 1) {
      throw new Error(`the tag node should filter to one book: ${JSON.stringify(seen)}`);
    }
    // 网络搜书 swaps the pane for the online search.
    await page.evaluate(() => document.querySelector('.qiaomu-reader-lib-node[data-node="online"]')?.click());
    await sleep(400);
    seen = await state();
    if (seen.local || !seen.online) throw new Error(`the online node should hide the local grid: ${JSON.stringify(seen)}`);
    // A query typed in the online pane must not filter the local grid, and a
    // finished download must land in the local tree when switching back.
    const leaked = await page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader-library")[0].view;
      const input = document.querySelector(".qiaomu-reader-lib-search-input");
      view._onlineQuery = "zzz-not-a-book";
      input.value = "zzz-not-a-book";
      document.querySelector('.qiaomu-reader-lib-node[data-node="all"]')?.click();
      return { value: input.value, cards: document.querySelectorAll(".qiaomu-reader-lib-card").length };
    });
    if (leaked.value !== "" || leaked.cards < 1) {
      throw new Error(`the online query leaked into the local grid: ${JSON.stringify(leaked)}`);
    }
    const download = await page.evaluate(async () => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader-library")[0].view;
      view._onlineQuery = "";
      view._runOnlineSearch = async () => {};
      document.querySelector('.qiaomu-reader-lib-node[data-node="online"]')?.click();
      const before = document.querySelectorAll(".qiaomu-reader-lib-card").length;
      window.__qbrPlugin.downloadBook = async () => {
        const rel = "Books/示例书库/下载测试书.epub";
        const src = window.__qbrApp.vault.getAbstractFileByPath("Books/示例书库/Alice in Wonderland.epub");
        const bytes = await window.__qbrApp.vault.readBinary(src);
        if (!window.__qbrApp.vault.getAbstractFileByPath(rel)) await window.__qbrApp.vault.createBinary(rel, bytes);
        return { ok: true, path: `${window.qbrDesktop.paths.vaultRoot}/${rel}`, name: "下载测试书.epub" };
      };
      await view._startOnlineDownload({ title: "下载测试书", source: "gutenberg" }, { status: null });
      return { before, stale: Boolean(view._libStale) };
    });
    if (!download.stale) throw new Error("a finished download should mark the local pane stale");
    await page.evaluate(() => document.querySelector('.qiaomu-reader-lib-node[data-node="all"]')?.click());
    const grown = await waitFor("downloaded book in the local grid", () => page.evaluate((before) => (
      document.querySelectorAll(".qiaomu-reader-lib-card").length > before
        ? String(document.querySelectorAll(".qiaomu-reader-lib-card").length)
        : ""
    ), download.before), 10_000);
    console.log("library: online query stays in its pane; a finished download lands in the grid", grown, "cards");

    // Back to the local library, then collapse and expand the tree.
    await page.evaluate(() => document.querySelector('.qiaomu-reader-lib-node[data-node="all"]')?.click());
    await sleep(300);
    await page.click(".qiaomu-reader-lib-collapse");
    await sleep(300);
    const collapsed = await page.evaluate(() => document.querySelector(".qiaomu-reader-lib")?.classList.contains("qiaomu-reader-lib-nav-collapsed"));
    if (!collapsed) throw new Error("the tree did not collapse");
    await page.click(".qiaomu-reader-lib-navbtn");
    await sleep(300);
    const stillCollapsed = await page.evaluate(() => document.querySelector(".qiaomu-reader-lib")?.classList.contains("qiaomu-reader-lib-nav-collapsed"));
    if (stillCollapsed) throw new Error("the tree did not expand again");
    console.log("library tree: node selection, tag filtering and collapse work");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function runHomeScenario() {
  const { app, page, userData } = await launch("");
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    const cards = await waitFor("home cards", async () => {
      const count = await page.evaluate(() => document.querySelectorAll(".qbr-home-card").length);
      return count ? String(count) : "";
    }, 20_000);
    const clicked = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".qbr-home-card")]
        .find((entry) => entry.textContent.includes("Alice in Wonderland"));
      card?.click();
      return Boolean(card);
    });
    if (!clicked) throw new Error("the home page has no Alice in Wonderland card");
    await waitFor("reader opened from the home page", () => readerReady(page), 30_000);
    // A home card hands over a vault-relative path: the book is already in the
    // library, so opening it must reuse it instead of importing a copy.
    const opened = await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view?.file?.path || "");
    if (!opened.endsWith("Alice in Wonderland.epub") || opened.includes(" (")) {
      throw new Error(`the home page should open the library copy in place, saw ${opened}`);
    }
    const copies = await page.evaluate(() => window.__qbrApp.vault.getFiles()
      .filter((f) => f.extension === "epub" && f.basename.startsWith("Alice in Wonderland")).length);
    if (copies !== 1) throw new Error(`opening a library book from the home page copied it (${copies} copies)`);
    console.log("home: opened a book from the home page", cards, "cards, library copy reused");
    // The native menu bar stays hidden (Alt still reveals it).
    const menuBarVisible = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window ? window.isMenuBarVisible() : null;
    });
    if (menuBarVisible !== false) throw new Error(`the native menu bar should be hidden, saw ${menuBarVisible}`);
    console.log("home: native menu bar hidden");
    // 历史遗留的库外阅读记录(导入修复前以绝对路径记录)不得出现在「继续阅读」。
    const leaked = await page.evaluate(async () => {
      const plugin = window.__qbrPlugin;
      await plugin._readingStore().saveBook(
        "C:/outside/stale.epub",
        "progress",
        { pct: 0, percent: 0, lastRead: Date.now() },
        { title: "stale", format: "epub" },
      );
      await plugin._loadBooksLayout();
      return Object.keys(plugin.progress || {}).filter((key) => key.includes("outside"));
    });
    if (leaked.length) throw new Error(`an outside reading record leaked into progress: ${leaked}`);
    await page.waitForTimeout(1500);
    const staleCard = await page.evaluate(() => [...document.querySelectorAll(".qbr-home-card")]
      .some((card) => card.textContent.includes("stale")));
    if (staleCard) throw new Error("the stale outside record rendered a home card");
    console.log("home: outside reading records stay out of 继续阅读");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function runWorkshopScenario() {
  const sidecarDir = process.env.QBR_OCR_SIDECAR || "D:\\projects\\auto_chat";
  const { app, page, userData } = await launch("", {
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          ocrScannedPdf: true,
          ocrSidecarDir: sidecarDir,
          ocrPython: process.env.QBR_OCR_PYTHON || "python",
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    const rail = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".qbr-workshop-rail button")];
      return {
        count: buttons.length,
        labels: buttons.map((b) => b.textContent.trim()),
        active: buttons.filter((b) => b.classList.contains("is-active")).map((b) => b.dataset.tool),
      };
    });
    if (rail.count < 5) throw new Error(`the workshop rail should list every tool: ${JSON.stringify(rail)}`);
    if (!rail.labels.includes("文字层") || !rail.labels.includes("电子书制作")) {
      throw new Error(`unexpected workshop rail: ${JSON.stringify(rail.labels)}`);
    }
    // 处理组的顺序:文字层 → 格式转换 → 内容提取 → 电子书制作。
    const head = rail.labels.slice(0, 4);
    if (head.join("|") !== "文字层|格式转换|内容提取|电子书制作") {
      throw new Error(`unexpected workshop rail order: ${JSON.stringify(head)}`);
    }
    // Switching tools shows exactly one panel.
    const convert = await page.evaluate(() => {
      const button = [...document.querySelectorAll(".qbr-workshop-rail button")].find((b) => b.dataset.tool === "convert");
      button?.click();
      const visible = [...document.querySelectorAll(".qbr-workshop-panel")].filter((panel) => !panel.hidden);
      return { visible: visible.map((panel) => panel.dataset.tool), title: visible[0]?.querySelector("h2 b")?.textContent || "" };
    });
    if (convert.visible.length !== 1 || convert.visible[0] !== "convert" || convert.title !== "格式转换") {
      throw new Error(`the convert panel did not open alone: ${JSON.stringify(convert)}`);
    }
    console.log("workshop: page opens with", rail.count, "tools; panel switching ok");
    // 内容提取面板:标题就是「内容提取」+ EXTRACT;会误导的预设矩阵已撤掉(选中无效果)。
    const extract = await page.evaluate(() => {
      const button = [...document.querySelectorAll(".qbr-workshop-rail button")].find((b) => b.dataset.tool === "extract");
      button?.click();
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='extract']");
      return {
        title: panel?.querySelector("h2 b")?.textContent || "",
        en: panel?.querySelector("h2 span")?.textContent.trim() || "",
        presets: panel ? panel.querySelectorAll(".qbr-workshop-preset").length : -1,
      };
    });
    if (extract.title !== "内容提取" || extract.en.toLowerCase() !== "extract" || extract.presets !== 0) {
      throw new Error(`the extract panel should be plain 内容提取 without a preset matrix: ${JSON.stringify(extract)}`);
    }
    // 格式转换面板:预设卡片点击后有可见的选中态。
    const preset = await page.evaluate(() => {
      const button = [...document.querySelectorAll(".qbr-workshop-rail button")].find((b) => b.dataset.tool === "convert");
      button?.click();
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='convert']");
      const ready = [...panel.querySelectorAll(".qbr-workshop-preset.is-ready")];
      const first = ready[0];
      const before = Boolean(first?.classList.contains("is-selected"));
      first?.click();
      const after = Boolean(first?.classList.contains("is-selected"));
      return { ready: ready.length, before, after, label: first?.querySelector("b")?.textContent || "" };
    });
    if (!preset.ready || !preset.before || !preset.after) {
      throw new Error(`the convert preset should show a visible selected state: ${JSON.stringify(preset)}`);
    }
    console.log("workshop: extract is plain 内容提取 (no preset matrix); convert preset selected:", preset.label);
    // 选「图片 → PDF」后,转换专用控件要让位;切回「文档互转」再回来(预设决定后续操作)。
    const imgPreset = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='convert']");
      const cards = [...panel.querySelectorAll(".qbr-workshop-preset")];
      const find = (text) => cards.find((card) => (card.querySelector("b")?.textContent || "").includes(text));
      const rows = [...panel.querySelectorAll(".qbr-workshop-row")];
      const hidden = (text) => rows.filter((row) => (row.textContent || "").includes(text)).every((row) => row.hidden);
      const labelOf = () => [...panel.querySelectorAll("button")].find((b) => /打包为 PDF|开始转换/.test(b.textContent || ""))?.textContent || "";
      find("图片")?.click();
      const imgLabel = labelOf();
      const formatHidden = hidden("目标格式");
      const parseHidden = hidden("解析方式");
      find("文档互转")?.click();
      return { formatHidden, parseHidden, imgLabel, formatBack: !hidden("目标格式"), docLabel: labelOf() };
    });
    if (!imgPreset.formatHidden || !imgPreset.parseHidden) {
      throw new Error(`图片 → PDF should hide the conversion-only rows: ${JSON.stringify(imgPreset)}`);
    }
    if (imgPreset.imgLabel !== "打包为 PDF" || !imgPreset.formatBack || imgPreset.docLabel !== "开始转换") {
      throw new Error(`the panel should follow the preset: ${JSON.stringify(imgPreset)}`);
    }
    console.log("workshop: preset switches the panel (图片 → PDF hides format/parse, button says 打包为 PDF)");
    // 「EPUB → Markdown」预设:选中后目标格式预选 md(2026-10-18,W2-3)。
    const epubPreset = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='convert']");
      const cards = [...panel.querySelectorAll(".qbr-workshop-preset")];
      const find = (text) => cards.find((card) => (card.querySelector("b")?.textContent || "").includes(text));
      const card = find("EPUB → Markdown");
      card?.click();
      const select = [...panel.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "markdown"));
      const value = select?.value || "";
      find("文档互转")?.click();
      return { found: Boolean(card), value };
    });
    if (!epubPreset.found || epubPreset.value !== "markdown") {
      throw new Error(`EPUB → Markdown should preselect the md target: ${JSON.stringify(epubPreset)}`);
    }
    console.log("workshop: EPUB → Markdown preselects the markdown target");
    // 「打开 设置 → 书坊」应当直接落在书坊 tab 上,并在那里原地给检测结果。
    const mineru = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const link = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='convert'] button")]
        .find((b) => b.textContent === "打开 设置 → 书坊");
      link?.click();
      await wait(2200);
      const activeTab = [...document.querySelectorAll(".qiaomu-reader-set-tab")]
        .find((b) => b.classList.contains("qiaomu-reader-set-tab-on"))?.textContent || "";
      const tabLabels = [...document.querySelectorAll(".qiaomu-reader-set-tab")].map((b) => (b.textContent || "").trim());
      const wrapped = Boolean(window.__qbrPlugin?.settingsTab?._qbrWorkshopTab);
      const tabFlag = String(window.__qbrPlugin?.settingsTab?._tab || "");
      const bodyTab = document.querySelector(".qiaomu-reader-set-body")?.dataset?.tab || "";
      const body = document.querySelector(".qiaomu-reader-set-body");
      const tab = activeTab === "书坊" ? { textContent: activeTab } : null;
      // 现场打一条假路径:不带失焦(input 事件)也要进设置,并出现在「已试」里。
      const exeRow = [...(body?.querySelectorAll(".qbr-workshop-row") || [])]
        .find((row) => (row.textContent || "").includes("本地 MinerU 程序"));
      const exeField = exeRow?.querySelector("input");
      if (exeField) {
        exeField.value = "C:\\no-such-dir\\mineru-kit.exe";
        exeField.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const button = [...(body?.querySelectorAll("button") || [])].find((b) => b.textContent === "检测本地 MinerU");
      button?.click();
      await wait(1600);
      const text = button?.closest(".qbr-workshop-row")?.querySelector(".qbr-mineru-status")?.textContent || "";
      // 链路探测要原地出结果(不再「已入队」跳到书坊任务)。
      const ocrButton = [...(body?.querySelectorAll("button") || [])].find((b) => b.textContent === "检测文字层链路");
      ocrButton?.click();
      await wait(2500);
      const ocrText = ocrButton?.closest(".qbr-workshop-row")?.querySelector(".qbr-mineru-status")?.textContent || "";
      document.querySelector('[data-route="workshop"]')?.click();
      return { link: Boolean(link), tab: Boolean(tab), activeTab, tabLabels, wrapped, tabFlag, bodyTab, found: Boolean(button), text, ocrFound: Boolean(ocrButton), ocrText, typedSaved: String(window.__qbrPlugin?.settings?.mineruLocalExe || "") };
    });
    if (!mineru.link || !mineru.tab) throw new Error(`「打开 设置 → 书坊」应跳到书坊 tab:${JSON.stringify(mineru)}`);
    if (!mineru.found) throw new Error(`书坊 tab 里应该有「检测本地 MinerU」:${JSON.stringify(mineru)}`);
    if (/不支持/.test(mineru.text) || /检测中/.test(mineru.text) || /未检测/.test(mineru.text)) {
      throw new Error(`检测本地 MinerU should reach the bridge and report a real state: ${mineru.text}`);
    }
    if (!mineru.ocrFound || /未检测|检测中|已入队/.test(mineru.ocrText)) {
      throw new Error(`检测文字层链路 should report inline: ${JSON.stringify(mineru)}`);
    }
    if (mineru.typedSaved !== "C:\\no-such-dir\\mineru-kit.exe") {
      throw new Error(`刚输入的路径应立刻进设置(不用失焦):${JSON.stringify(mineru.typedSaved)}`);
    }
    console.log("settings: 书坊 tab reports local MinerU —", mineru.text, "· text layer —", mineru.ocrText);
    // The nav route returns home and the workshop remembers the last tool.
    await page.click('[data-route="home"]');
    await page.waitForSelector(".qbr-home-view", { timeout: 10_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 10_000 });
    const remembered = await page.evaluate(() => (
      document.querySelector(".qbr-workshop-rail button.is-active")?.dataset.tool || ""
    ));
    if (remembered !== "convert") throw new Error(`the workshop should remember the last tool, saw ${remembered}`);
    console.log("workshop: route remembers the last tool");
    // The task queue: an environment self-check (OCR sidecar probe) started
    // through the bridge lands in the tasks panel with its output.
    const hasSidecar = fs.existsSync(path.join(sidecarDir, "pdf_tool", "reader", "server.py"));
    if (hasSidecar) {
      const started = await page.evaluate(() => window.qbrDesktop.workshop.start({
        kind: "probe",
        title: "环境自检",
        detail: "OCR 程序",
        payload: {
          settings: {
            ocrSidecarDir: window.__qbrPlugin.settings.ocrSidecarDir,
            ocrPython: window.__qbrPlugin.settings.ocrPython,
          },
        },
      }));
      const finished = await waitFor("workshop probe task", () => page.evaluate(async (id) => {
        const state = await window.qbrDesktop.workshop.list();
        const task = state.tasks.find((entry) => entry.id === id);
        return task && task.status !== "running" && task.status !== "queued" ? task.status : "";
      }, started), 30_000);
      if (finished !== "done") throw new Error(`the probe task should finish done, saw ${finished}`);
      await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="tasks"]')?.click());
      const shown = await waitFor("task listed in the panel", () => page.evaluate(() => {
        const row = document.querySelector(".qbr-workshop-task");
        return row ? row.textContent.replace(/\s+/g, " ").trim() : "";
      }), 10_000);
      console.log("workshop: task queue probe finished and is listed —", shown.slice(0, 70));
    } else {
      console.log("workshop: task queue probe skipped — no pdf_tool sidecar at", sidecarDir);
    }
    // 书坊入口开关:关闭后导航隐藏,恢复后重新出现。
    const navToggle = await page.evaluate(async () => {
      const plugin = window.__qbrPlugin;
      const button = () => [...document.querySelectorAll("[data-route]")].find((entry) => entry.dataset.route === "workshop");
      plugin.settings.workshopEnabled = false;
      window.__qbrApp.workspace.trigger("layout-change");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const hidden = Boolean(button()?.hidden);
      plugin.settings.workshopEnabled = true;
      window.__qbrApp.workspace.trigger("layout-change");
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { hidden, shown: !button()?.hidden };
    });
    if (!navToggle.hidden || !navToggle.shown) {
      throw new Error(`the workshop switch did not hide/show the nav entry: ${JSON.stringify(navToggle)}`);
    }
    console.log("workshop: the workshop switch hides and restores the nav entry");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function runWorkshopOcrScenario() {
  const sidecarDir = process.env.QBR_OCR_SIDECAR || "D:\\projects\\auto_chat";
  const scanSource = path.join(sidecarDir, "pdf_tool", "pdfs", "small_ocr.pdf");
  if (!fs.existsSync(path.join(sidecarDir, "pdf_tool", "reader", "server.py")) || !fs.existsSync(scanSource)) {
    console.log("workshop-ocr: skipped — no pdf_tool sidecar at", sidecarDir);
    return;
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-ocr-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-ocr-outside-"));
  fs.mkdirSync(path.join(userData, "library", "Books"), { recursive: true });
  fs.copyFileSync(scanSource, path.join(userData, "library", "Books", "扫描件测试.pdf"));
  fs.copyFileSync(scanSource, path.join(outsideDir, "扫描件测试.pdf"));
  const { app, page } = await launch("", {
    userData,
    seed: (dir) => {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(path.join(dir, "data", "data.json"), JSON.stringify({
        settings: {
          onboarded: true,
          language: "zh",
          bookNotesFolder: "notes",
          dataFolder: "plugin",
          lastSeenVersion: appPackage.version,
          ocrScannedPdf: true,
          ocrSidecarDir: sidecarDir,
          ocrPython: process.env.QBR_OCR_PYTHON || "python",
        },
      }, null, 2));
    },
  });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    // 文字层工具是默认面板:选书 → 生成文字层。
    const picked = await page.evaluate(() => {
      const pick = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='ocr'] button")]
        .find((button) => button.textContent.includes("选择书库文件"));
      pick?.click();
      const row = [...document.querySelectorAll(".qbr-workshop-book")]
        .find((entry) => entry.textContent.includes("扫描件测试"));
      const box = row?.querySelector("input");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      return Boolean(row);
    });
    if (!picked) throw new Error("the vault PDF was not listed in the text-layer picker");
    await page.evaluate(() => {
      const start = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='ocr'] button")]
        .find((button) => button.textContent.includes("开始处理"));
      start?.click();
    });
    const cached = await waitFor("text-layer task", () => page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.kind === "ocr-cache" && entry.status !== "running" && entry.status !== "queued");
      return task ? `${task.status}|${task.output}` : "";
    }), 300_000);
    if (!cached.startsWith("done")) throw new Error(`the text-layer task should finish done: ${cached}`);
    if (!/2 页文字层已生成/.test(cached)) throw new Error(`unexpected text-layer output: ${cached}`);
    const pageCache = fs.readdirSync(path.join(userData, "ocr-cache"));
    const fingerprint = pageCache.find((name) => name.startsWith("sha1-"));
    if (!fingerprint) throw new Error("the text layer did not land in the reader's OCR cache");
    console.log("workshop-ocr: text layer generated —", cached.slice(0, 40));

    // 导出可搜索 PDF:默认命名 .uvtext.pdf,落回书库。
    await page.evaluate(() => {
      document.querySelector('input[name="qbr-ocr-mode"][value="export"]')?.click();
      const start = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='ocr'] button")]
        .find((button) => button.textContent.includes("开始处理"));
      start?.click();
    });
    const exported = await waitFor("searchable export task", () => page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.kind === "ocr-export" && entry.status !== "running" && entry.status !== "queued");
      return task ? `${task.status}|${task.output}` : "";
    }), 300_000);
    if (!exported.startsWith("done")) throw new Error(`the export task should finish done: ${exported}`);
    const exportPath = path.join(userData, "library", "Books", "扫描件测试.uvtext.pdf");
    if (!fs.existsSync(exportPath)) throw new Error(`expected the .uvtext.pdf next to the source: ${exportPath}`);
    console.log("workshop-ocr: searchable PDF exported —", path.basename(exportPath), fs.statSync(exportPath).size, "bytes");

    // 重复导出:同名覆盖,不再产生 (1) 副本。
    const exportCount = await page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      return state.tasks.filter((entry) => entry.kind === "ocr-export").length;
    });
    await page.evaluate(() => {
      const start = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='ocr'] button")]
        .find((button) => button.textContent.includes("开始处理"));
      start?.click();
    });
    const reExported = await waitFor("re-export task", () => page.evaluate(async (count) => {
      const state = await window.qbrDesktop.workshop.list();
      const tasks = state.tasks.filter((entry) => entry.kind === "ocr-export");
      if (tasks.length <= count) return "";
      const newest = tasks[0];
      return newest.status !== "running" && newest.status !== "queued" ? `${newest.status}|${newest.output}` : "";
    }, exportCount), 300_000);
    if (!reExported.startsWith("done")) throw new Error(`the re-export should finish done: ${reExported}`);
    if (fs.existsSync(path.join(userData, "library", "Books", "扫描件测试 (1).uvtext.pdf"))) {
      throw new Error("re-exporting created a numbered copy instead of overwriting");
    }
    if (!fs.existsSync(exportPath)) throw new Error("the overwritten export is missing");
    console.log("workshop-ocr: re-export overwrites the same .uvtext.pdf");

    // 库外文件就地导出:产物落在源文件旁,不导入书库。
    const outsideSource = path.join(outsideDir, "扫描件测试.pdf").replace(/\\/g, "/");
    const outsideOut = path.join(outsideDir, "扫描件测试.uvtext.pdf").replace(/\\/g, "/");
    const outsideTask = await page.evaluate(async ({ source, out, settings }) => window.qbrDesktop.workshop.start({
      kind: "ocr-export", title: "导出可搜索 PDF", detail: source,
      payload: { settings, source, out },
    }), {
      source: outsideSource,
      out: outsideOut,
      settings: { ocrSidecarDir: sidecarDir, ocrPython: process.env.QBR_OCR_PYTHON || "python" },
    });
    const outsideDone = await waitFor("outside export", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, outsideTask), 300_000);
    if (!outsideDone.startsWith("done")) throw new Error(`the in-place export should finish done: ${outsideDone}`);
    if (!fs.existsSync(outsideOut)) throw new Error(`expected the .uvtext.pdf next to the outside source: ${outsideOut}`);
    const strays = await page.evaluate(() => window.__qbrApp.vault.getFiles()
      .filter((file) => file.basename.startsWith("扫描件测试") && !file.path.startsWith("Books/"))
      .map((file) => file.path));
    if (strays.length) throw new Error(`the outside scan was imported into the library: ${strays}`);
    console.log("workshop-ocr: outside scan exported in place —", path.basename(outsideOut));

    // 打开导出的副本搜索只出现在第 2 页的词:未渲染页也必须出现在结果列表里
    // (DOM 文本层只覆盖渲染过的页;修复后查找用懒加载视图的逐页文本)。
    const copyFingerprint = fs.readdirSync(path.join(userData, "ocr-cache")).find((name) => name.startsWith("sha1-"));
    const copyParams = fs.readdirSync(path.join(userData, "ocr-cache", copyFingerprint)).find((name) => name.startsWith("rapid_"));
    const page2 = JSON.parse(fs.readFileSync(path.join(userData, "ocr-cache", copyFingerprint, copyParams, "page_0002.json"), "utf8"));
    const phrase = String((page2.lines || []).map((line) => line[0]).find((text) => String(text || "").trim().length >= 6) || "").trim().slice(0, 6);
    if (!phrase) throw new Error("page 2 produced no searchable line");
    await page.evaluate(async () => {
      const file = window.__qbrApp.vault.getAbstractFileByPath("Books/扫描件测试.uvtext.pdf");
      await window.__qbrPlugin.openFile(file);
    });
    await waitFor("exported copy open", () => readerReady(page), 30_000);
    await page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view;
      view.findBtn?.click();
    });
    await page.waitForSelector(".qiaomu-reader-toc-find-input", { timeout: 10_000 });
    await page.fill(".qiaomu-reader-toc-find-input", phrase);
    const found = await waitFor("find results cover the unrendered page", () => page.evaluate(() => {
      const rows = [...document.querySelectorAll(".qiaomu-reader-find-item")];
      const info = document.querySelector(".qiaomu-reader-find-info")?.textContent || "";
      return rows.length ? `${rows.length}|${rows[0]?.querySelector(".qiaomu-reader-toc-where")?.textContent || ""}|${info}` : "";
    }), 30_000);
    if (!found.includes("第 2 页")) throw new Error(`the page-2 hit is missing from the result list: ${found}`);
    console.log("workshop-ocr: searchable copy lists the unrendered page —", found);

    // 任务行的产物操作:打开产物 + 在文件夹中显示。
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="tasks"]')?.click());
    const rowActions = await waitFor("task row actions", () => page.evaluate(() => {
      const row = [...document.querySelectorAll(".qbr-workshop-task")].find((entry) => entry.textContent.includes("导出"));
      return row ? [...row.querySelectorAll(".qbr-workshop-task-btn")].map((button) => button.textContent).join(",") : "";
    }), 10_000);
    if (!rowActions.includes("打开产物") || !rowActions.includes("在文件夹中显示")) {
      throw new Error(`task row actions missing: ${rowActions}`);
    }
    console.log("workshop-ocr: task row offers 打开产物 / 在文件夹中显示");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

async function runWorkshopConvertScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-conv-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-conv-src-"));
  fs.mkdirSync(path.join(userData, "library", "Books"), { recursive: true });
  await writeMinimalDocx(path.join(userData, "library", "Books", "转换测试.docx"));
  const outsideSource = path.join(outsideDir, "转换测试.docx");
  await writeMinimalDocx(outsideSource);
  const { app, page } = await launch("", { userData });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    // Skip on machines without docvortex installed.
    const probe = await page.evaluate(() => window.qbrDesktop.workshop.start({
      kind: "docvortex-probe", title: "检测 DocVortex", payload: { settings: {} },
    }));
    const probed = await waitFor("docvortex probe", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, probe), 20_000);
    if (!probed.startsWith("done")) {
      console.log("workshop-convert: skipped — docvortex unavailable:", probed.slice(0, 90));
      return;
    }
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="convert"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='convert']", { timeout: 10_000 });
    const picked = await page.evaluate(() => {
      const pick = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='convert'] button")]
        .find((button) => button.textContent.includes("选择书库文件"));
      pick?.click();
      const row = [...document.querySelectorAll(".qbr-workshop-book")].find((entry) => entry.textContent.includes("转换测试"));
      const box = row?.querySelector("input");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      return Boolean(row);
    });
    if (!picked) throw new Error("the docx was not listed in the convert picker");
    await page.evaluate(() => {
      const select = document.querySelector(".qbr-workshop-panel[data-tool='convert'] select");
      if (select) select.value = "markdown";
      const start = [...document.querySelectorAll(".qbr-workshop-panel[data-tool='convert'] button")]
        .find((button) => button.textContent.includes("开始转换"));
      start?.click();
    });
    const converted = await waitFor("convert task", () => page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.kind === "docvortex-convert" && entry.status !== "running" && entry.status !== "queued");
      return task ? `${task.status}|${task.output}|${task.error}` : "";
    }), 120_000);
    if (!converted.startsWith("done")) throw new Error(`the convert task should finish done: ${converted}`);
    const mdPath = path.join(userData, "library", "Books", "转换测试.md");
    if (!fs.existsSync(mdPath)) throw new Error(`expected the markdown next to the library copy: ${mdPath}`);
    const text = fs.readFileSync(mdPath, "utf8");
    if (!text.includes("书坊转换测试")) throw new Error("the converted markdown lost the text");
    console.log("workshop-convert: docx → markdown landed —", path.basename(mdPath), text.length, "chars");
    // 本地文件就地处理:直接以绝对路径入队(不导入书库),产物落在源文件旁。
    const outsideOut = path.join(outsideDir, "转换测试.md");
    const outsideTask = await page.evaluate(async ({ source, out }) => window.qbrDesktop.workshop.start({
      kind: "docvortex-convert", title: "文档互转", detail: source,
      payload: { settings: {}, source, out, format: "markdown" },
    }), { source: outsideSource.replace(/\\/g, "/"), out: outsideOut.replace(/\\/g, "/") });
    const outsideDone = await waitFor("in-place convert", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}` : "";
    }, outsideTask), 120_000);
    if (!outsideDone.startsWith("done")) throw new Error(`the in-place conversion should finish done: ${outsideDone}`);
    if (!fs.existsSync(outsideOut)) throw new Error(`expected the markdown next to the outside source: ${outsideOut}`);
    const strays = await page.evaluate(() => window.__qbrApp.vault.getFiles()
      .filter((file) => file.basename.startsWith("转换测试") && !file.path.startsWith("Books/"))
      .map((file) => file.path));
    if (strays.length) throw new Error(`the outside docx was imported into the library: ${strays}`);
    console.log("workshop-convert: outside docx processed in place —", path.basename(outsideOut));

    // Markdown 就地转换:DocVortex 没有原生 md 输入(直接给它会报 Unsupported native
    // input format),书坊先渲染成 HTML 桥再转换 —— 源文件不动、桥文件不残留。
    const mdText = "# 系统规格\n\n1. 列表后接正文:\n书坊 Markdown 桥测试。\n\n行内公式 $E = mc^2$。\n";
    const mdSource = path.join(outsideDir, "系统规格.md");
    fs.writeFileSync(mdSource, mdText, "utf8");
    const mdOut = path.join(outsideDir, "系统规格.docx");
    const mdTask = await page.evaluate(async ({ source, out }) => window.qbrDesktop.workshop.start({
      kind: "docvortex-convert", title: "文档互转", detail: source,
      payload: { settings: {}, source, out, format: "docx" },
    }), { source: mdSource.replace(/\\/g, "/"), out: mdOut.replace(/\\/g, "/") });
    const mdDone = await waitFor("markdown convert", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}|${task.error}` : "";
    }, mdTask), 120_000);
    if (!mdDone.startsWith("done")) throw new Error(`the markdown conversion should finish done: ${mdDone}`);
    if (fs.readFileSync(mdSource, "utf8") !== mdText) throw new Error("the markdown source should not be rewritten");
    if (!fs.existsSync(mdOut)) throw new Error(`expected the docx next to the markdown source: ${mdOut}`);
    const bridgeStrays = fs.readdirSync(outsideDir).filter((name) => name.includes("bridge"));
    if (bridgeStrays.length) throw new Error(`the bridge file should be cleaned up: ${bridgeStrays.join(",")}`);
    console.log("workshop-convert: markdown converted in place —", path.basename(mdOut), fs.statSync(mdOut).size, "bytes");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

// 公式优先链路(pdf_tool MinerU → HTML → DocVortex 真公式)。默认跳过:MinerU 是
// 计费云服务;设 QBR_E2E_MINERU=1 才真跑。
async function runWorkshopFormulaScenario() {
  if (process.env.QBR_E2E_MINERU !== "1") {
    console.log("workshop-formula: skipped — set QBR_E2E_MINERU=1 to run the MinerU chain");
    return;
  }
  if (!process.env.MINERU_API_KEY && !process.env.MINERU_TOKEN) {
    console.log("workshop-formula: skipped — no MINERU_API_KEY / MINERU_TOKEN");
    return;
  }
  const sidecarDir = String(process.env.QBR_OCR_SIDECAR || "").trim();
  const scan = path.join(sidecarDir, "pdf_tool", "test-docs", "testpdf2.pdf");
  if (!sidecarDir || !fs.existsSync(scan)) {
    console.log("workshop-formula: skipped — no scanned fixture under", sidecarDir || "(QBR_OCR_SIDECAR unset)");
    return;
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-formula-"));
  const { app, page } = await launch("", { userData });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    // 面板上「解析方式」有公式优先选项。
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="convert"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='convert']", { timeout: 10_000 });
    const hasOption = await page.evaluate(() => [...document.querySelectorAll(".qbr-workshop-panel[data-tool='convert'] select option")]
      .some((option) => option.textContent.includes("公式优先")));
    if (!hasOption) throw new Error("the convert panel lost the 公式优先 parse option");
    // 链路自检:pdf_tool 目录 + MinerU 凭据 + DocVortex。
    const probe = await page.evaluate((settings) => window.qbrDesktop.workshop.start({
      kind: "formula-probe", title: "检测公式链路", payload: { settings },
    }), { ocrSidecarDir: sidecarDir });
    const probed = await waitFor("formula probe", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, probe), 60_000);
    if (!probed.startsWith("done")) throw new Error(`the formula probe should pass: ${probed}`);
    console.log("workshop-formula: probe ok —", probed.split("|")[1]);
    // 本地扫描件 → 导入书库 → 公式优先转 DOCX(只跑前 3 页,省云端额度)。
    const imported = await page.evaluate((absolute) => window.__qbrPlugin.importBookToLibrary(absolute), scan);
    if (!imported) throw new Error("the scanned fixture was not imported");
    const out = imported.replace(/\.pdf$/i, ".公式.docx");
    const task = await page.evaluate(async ({ source, out, settings }) => window.qbrDesktop.workshop.start({
      kind: "formula-convert", title: "公式文档", detail: source,
      payload: { source, out, format: "docx", pages: "1-3", settings },
    }), { source: imported, out, settings: { ocrSidecarDir: sidecarDir } });
    const done = await waitFor("formula convert", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const entry = state.tasks.find((row) => row.id === id);
      return entry && entry.status !== "running" && entry.status !== "queued" ? `${entry.status}|${entry.output}|${entry.error}` : "";
    }, task), 600_000);
    if (!done.startsWith("done")) throw new Error(`the formula conversion should finish done: ${done}`);
    const docx = path.join(userData, "library", out);
    if (!fs.existsSync(docx)) throw new Error(`expected the docx in the library: ${docx}`);
    const zip = await JSZip.loadAsync(fs.readFileSync(docx));
    const xml = await zip.file("word/document.xml").async("string");
    const omml = (xml.match(/<m:oMath>/g) || []).length;
    const subs = (xml.match(/<m:sSub>/g) || []).length;
    if (omml < 5 || subs < 1) throw new Error(`the docx should carry real OMML equations (oMath=${omml}, sSub=${subs})`);
    console.log(`workshop-formula: MinerU → DocVortex docx with ${omml} OMML equations and ${subs} subscripts`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function writeMinimalDocx(file) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>书坊转换测试：这是一段用来验证 DOCX 到 Markdown 的文字。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段文字，用来确认换行与段落。</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

// 内容提取:书库 DOCX → md/html/json 落源文件旁(面板预览),并验证向导直接吃 DOCX。
async function runWorkshopExtractScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-extract-"));
  fs.mkdirSync(path.join(userData, "library", "Books"), { recursive: true });
  await writeMinimalDocx(path.join(userData, "library", "Books", "讲义.docx"));
  const { app, page } = await launch("", { userData });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    // Skip on machines without DocVortex.
    const probe = await page.evaluate(() => window.qbrDesktop.workshop.start({ kind: "docvortex-probe", title: "检测 DocVortex", payload: {} }));
    const probed = await waitFor("docvortex probe", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, probe), 20_000);
    if (!probed.startsWith("done")) {
      console.log("workshop-extract: skipped — docvortex unavailable:", probed.slice(0, 90));
      return;
    }
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="extract"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='extract']", { timeout: 10_000 });
    const picked = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='extract']");
      const pick = [...panel.querySelectorAll("button")].find((button) => button.textContent.includes("选择书库文件"));
      pick?.click();
      const row = [...document.querySelectorAll(".qbr-workshop-book")].find((entry) => entry.textContent.includes("讲义"));
      const box = row?.querySelector("input");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      return Boolean(row);
    });
    if (!picked) throw new Error("the docx was not listed in the extract picker");
    const before = await page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      return state.tasks.filter((task) => task.kind.startsWith("extract-")).length;
    });
    await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='extract']");
      const start = [...panel.querySelectorAll("button")].find((button) => button.textContent.includes("开始提取"));
      start?.click();
    });
    const done = await waitFor("extract task", () => page.evaluate(async (count) => {
      const state = await window.qbrDesktop.workshop.list();
      const tasks = state.tasks.filter((task) => task.kind.startsWith("extract-"));
      if (tasks.length <= count) return "";
      const newest = tasks[0];
      return newest.status !== "running" && newest.status !== "queued" ? `${newest.status}|${newest.output}|${newest.error}` : "";
    }, before), 180_000);
    if (!done.startsWith("done")) throw new Error(`the extraction should finish done: ${done}`);
    const md = path.join(userData, "library", "Books", "讲义.md");
    if (!fs.existsSync(md)) throw new Error(`expected the markdown next to the source: ${md}`);
    if (!fs.readFileSync(md, "utf8").includes("书坊转换测试")) throw new Error("the extracted markdown lost the text");
    if (!fs.existsSync(path.join(userData, "library", "Books", "讲义.json"))) throw new Error("expected the structured json next to the source");
    await waitFor("extract preview", () => page.evaluate(() => {
      const text = document.querySelector(".qbr-workshop-extract-text")?.textContent || "";
      return text.includes("书坊转换测试") ? text.slice(0, 12) : "";
    }), 20_000);
    console.log("workshop-extract: docx → md/json next to the source with a panel preview");
    // 向导直接吃 DOCX:内部自动提取。
    const count = await page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      return state.tasks.filter((task) => task.kind === "book-build").length;
    });
    await page.evaluate(() => window.qbrDesktop.workshop.start({
      kind: "book-build", title: "生成电子书", payload: { source: "Books/讲义.docx", settings: {}, title: "讲义" },
    }));
    const epubDone = await waitFor("wizard from docx", () => page.evaluate(async (beforeBooks) => {
      const state = await window.qbrDesktop.workshop.list();
      const tasks = state.tasks.filter((task) => task.kind === "book-build");
      if (tasks.length <= beforeBooks) return "";
      const newest = tasks[0];
      return newest.status !== "running" && newest.status !== "queued" ? `${newest.status}|${newest.output}|${newest.error}` : "";
    }, count), 180_000);
    if (!epubDone.startsWith("done")) throw new Error(`the wizard build from docx should finish done: ${epubDone}`);
    console.log("workshop-extract: wizard built from docx —", path.basename(epubDone.split("|")[1]));
    // 图片提取:先合成单页 PDF,再走 DocVortex OCR(此前报 Unsupported native input format)。
    const pngBase64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000000";
      ctx.font = "72px sans-serif";
      ctx.fillText("OCR TEST 2026", 48, 140);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    fs.writeFileSync(path.join(userData, "library", "Books", "扫描页.png"), Buffer.from(pngBase64, "base64"));
    const imageTask = await page.evaluate(() => window.qbrDesktop.workshop.start({
      kind: "extract-docvortex",
      title: "内容提取",
      payload: { source: "Books/扫描页.png", settings: { ocrPython: process.env.QBR_OCR_PYTHON || "python" } },
    }));
    const imageDone = await waitFor("image extract", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const entry = state.tasks.find((row) => row.id === id);
      return entry && entry.status !== "running" && entry.status !== "queued" ? `${entry.status}|${entry.output}|${entry.error}` : "";
    }, imageTask), 300_000);
    if (!imageDone.startsWith("done")) throw new Error(`the image extraction should finish done: ${imageDone}`);
    const scanMd = path.join(userData, "library", "Books", "扫描页.md");
    if (!fs.existsSync(scanMd)) throw new Error("expected 扫描页.md next to the image");
    const scanText = fs.readFileSync(scanMd, "utf8");
    if (!/OCR|2026/i.test(scanText)) throw new Error(`the OCR markdown should keep the recognised text: ${JSON.stringify(scanText.slice(0, 80))}`);
    console.log("workshop-extract: image → temp PDF → OCR:", JSON.stringify(scanText.trim().slice(0, 24)));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// 电子书制作向导(W1-2):txt → 章节 → 字体子集 → EPUB,并在阅读器打开。
async function runWorkshopEpubScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-epub-"));
  fs.mkdirSync(path.join(userData, "library", "Books"), { recursive: true });
  const source = path.join(userData, "library", "Books", "测试小说.txt");
  fs.writeFileSync(source, "第一章 起风了\n\n第一段正文，犇。\n\n第二章 雨\n\n第二段正文。\n", "utf8");
  const { app, page } = await launch("", { userData });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    const payload = {
      source: "Books/测试小说.txt",
      settings: { ocrPython: process.env.QBR_OCR_PYTHON || "python" },
      styles: { indent: 2 },
      title: "测试小说",
      author: "书坊",
      cover: { mode: "template", palette: "ink", subtitle: "封面副标题" },
    };
    const task = await page.evaluate((request) => window.qbrDesktop.workshop.start({
      kind: "book-build", title: "生成电子书", payload: request,
    }), payload);
    const done = await waitFor("book-build", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const entry = state.tasks.find((row) => row.id === id);
      return entry && entry.status !== "running" && entry.status !== "queued" ? `${entry.status}|${entry.output}|${entry.error}` : "";
    }, task), 300_000);
    if (!done.startsWith("done")) throw new Error(`the book build should finish done: ${done}`);
    const out = path.join(userData, "library", "Books", "测试小说.epub");
    if (!fs.existsSync(out)) throw new Error(`expected the epub next to the source: ${out}`);
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const opf = await zip.file("OEBPS/content.opf").async("string");
    if (!opf.includes("<dc:title>测试小说</dc:title>")) throw new Error("the epub lost its metadata");
    const nav = await zip.file("OEBPS/nav.xhtml").async("string");
    if (!nav.includes("第一章 起风了") || !nav.includes("第二章 雨")) throw new Error("the epub lost its chapters");
    const css = await zip.file("OEBPS/styles.css").async("string");
    if (!/text-indent: 2em/.test(css) || /background:/.test(css)) throw new Error("the epub lost its styles");
    const coverImage = await zip.file("OEBPS/images/cover.jpg")?.async("nodebuffer");
    if (!coverImage?.length || coverImage[0] !== 0xff || coverImage[1] !== 0xd8) {
      throw new Error("the template cover should be a real JPEG inside the epub");
    }
    if (!opf.includes(`<itemref idref="cover"/>`) || !opf.includes(`<meta name="cover" content="cover-image"/>`)) {
      throw new Error("the cover is missing from the opf");
    }
    console.log("workshop-epub: template cover", Math.round(coverImage.length / 1024) + "KB");
    // 不再嵌入字体:成品里不该有 fonts/ 目录(阅读器用自己的字体)。
    const fontEntries = Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/"));
    if (fontEntries.length) throw new Error(`the epub should not embed fonts any more: ${fontEntries.join(",")}`);
    console.log("workshop-epub: txt → epub", fs.statSync(out).size, "bytes (no embedded fonts)");
    // 成品质量:Markdown 里的本地图片收进 EPUB,LaTeX 公式转 MathML(真实 latex2mathml)。
    const figBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    fs.mkdirSync(path.join(userData, "library", "Books", "mineru", "images"), { recursive: true });
    fs.writeFileSync(path.join(userData, "library", "Books", "mineru", "images", "fig1.png"), figBytes);
    fs.writeFileSync(path.join(userData, "library", "Books", "论文.md"), [
      "# 第一章 结果",
      "",
      "![图一](mineru/images/fig1.png)",
      "",
      "行内公式 $E = mc^2$ 与 \\frac{1}{2} 无关。",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
    ].join("\n"), "utf8");
    const paperTask = await page.evaluate((request) => window.qbrDesktop.workshop.start({
      kind: "book-build", title: "生成电子书", payload: request,
    }), { source: "Books/论文.md", settings: { ocrPython: process.env.QBR_OCR_PYTHON || "python" }, title: "论文", cover: { mode: "none" } });
    const paperDone = await waitFor("paper book-build", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const entry = state.tasks.find((row) => row.id === id);
      return entry && entry.status !== "running" && entry.status !== "queued" ? `${entry.status}|${entry.output}|${entry.error}` : "";
    }, paperTask), 300_000);
    if (!paperDone.startsWith("done")) throw new Error(`the markdown build should finish done: ${paperDone}`);
    const paperZip = await JSZip.loadAsync(fs.readFileSync(paperDone.split("|")[1]));
    const paperImage = await paperZip.file("OEBPS/images/image-1.png")?.async("nodebuffer");
    if (paperImage?.length !== figBytes.length) throw new Error("the markdown image should be embedded into the epub");
    const paperOpf = await paperZip.file("OEBPS/content.opf").async("string");
    if (!paperOpf.includes('href="images/image-1.png" media-type="image/png"')) throw new Error("the embedded image is missing from the opf");
    const paperChapter = await paperZip.file("OEBPS/chapter-001.xhtml").async("string");
    if (!paperChapter.includes('src="images/image-1.png"')) throw new Error("the chapter should reference the embedded image");
    if (!paperChapter.includes("<math") || !paperChapter.includes("display=\"block\"")) {
      throw new Error(`the formulas should become MathML (is latex2mathml installed?): ${paperChapter.slice(0, 200)}`);
    }
    const paperNav = await paperZip.file("OEBPS/nav.xhtml").async("string");
    if (!paperNav.includes("第一章 结果")) throw new Error("the markdown chapters should reach the nav");
    console.log("workshop-epub: md + image + MathML →", fs.statSync(paperDone.split("|")[1]).size, "bytes");
    // 面板向导:选择书稿 → 实时预览 → 生成 EPUB(UI 路径)。
    fs.writeFileSync(path.join(userData, "library", "Books", "示例文稿.txt"), "第一章 面板\n\n面板生成的正文。\n\n第二章 继续\n\n第二章的正文。\n", "utf8");
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="book"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='book']", { timeout: 10_000 });
    const structure = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      return {
        steps: [...panel.querySelectorAll(".qbr-workshop-step-head b")].map((node) => node.textContent),
        tools: [...panel.querySelectorAll(".qbr-workshop-subtool b")].map((node) => node.textContent),
        cards: panel.querySelectorAll(".qbr-workshop-card").length,
      };
    });
    if (structure.steps.join(",") !== "内容,目录,书名与封面,排版样式") throw new Error(`unexpected wizard steps: ${JSON.stringify(structure)}`);
    if (!structure.tools.some((tool) => tool.includes("AZW3")) || !structure.tools.some((tool) => tool.includes("CBZ"))) {
      throw new Error(`the secondary tools should live under 更多工具: ${JSON.stringify(structure.tools)}`);
    }
    if (structure.cards !== 2) throw new Error(`the panel should be one wizard card plus 更多工具, saw ${structure.cards}`);
    console.log("workshop-epub: steps", structure.steps.join(" → "), "· tools", structure.tools.length);
    const wizardPicked = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      const pick = [...panel.querySelectorAll("button")].find((button) => button.textContent.includes("选择书稿"));
      pick?.click();
      const row = [...document.querySelectorAll(".qbr-workshop-book")].find((entry) => entry.textContent.includes("示例文稿"));
      const box = row?.querySelector("input");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      return Boolean(row);
    });
    if (!wizardPicked) throw new Error("the wizard did not list the txt manuscript");
    const layout = await page.evaluate(() => {
      const grid = document.querySelector(".qbr-workshop-panel[data-tool='book'] .qbr-workshop-wizard");
      return {
        hasGrid: Boolean(grid),
        hasPreview: Boolean(document.querySelector(".qbr-workshop-panel[data-tool='book'] .qbr-workshop-wizard-preview")),
        controls: grid ? grid.querySelectorAll(".qbr-workshop-wizard-controls input, .qbr-workshop-wizard-controls select, .qbr-workshop-wizard-controls button").length : 0,
      };
    });
    if (!layout.hasGrid || layout.controls < 6) throw new Error(`the wizard should keep its controls: ${JSON.stringify(layout)}`);
    if (layout.hasPreview) throw new Error(`the wizard preview column should be gone: ${JSON.stringify(layout)}`);
    console.log("workshop-epub: wizard keeps its controls; preview column removed");
    const ranges = await page.evaluate(() => [...document.querySelectorAll(".qbr-workshop-panel[data-tool='book'] input[type='range']")]
      .map((input) => `${input.min}-${input.max}:${input.value}`));
    if (ranges.length !== 2 || ranges[0] !== "0-4:2" || ranges[1] !== "0-2:0") {
      throw new Error(`the wizard should keep just the indent and spacing sliders at their defaults: ${ranges.join(", ")}`);
    }
    // 目录编辑(两章,改名第一章)。
    const detected = await waitFor("detected chapters", () => page.evaluate(() => {
      const inputs = [...document.querySelectorAll(".qbr-workshop-chapter .qbr-workshop-input")].map((input) => input.value);
      return inputs.length ? inputs : "";
    }), 15_000);
    if (detected.length !== 2 || !detected[0].includes("面板")) {
      throw new Error(`expected two detected chapters, saw ${JSON.stringify(detected)}`);
    }
    await page.evaluate(() => {
      const input = document.querySelector(".qbr-workshop-chapter .qbr-workshop-input");
      input.value = "改名后的第一章";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log("workshop-epub:", detected.length, "chapters detected and renamed");
    const before = await page.evaluate(async () => {
      const state = await window.qbrDesktop.workshop.list();
      return state.tasks.filter((task) => task.kind === "book-build").length;
    });
    await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      const button = [...panel.querySelectorAll("button")].find((entry) => entry.textContent.includes("生成 EPUB"));
      button?.click();
    });
    const uiDone = await waitFor("wizard build", () => page.evaluate(async (count) => {
      const state = await window.qbrDesktop.workshop.list();
      const tasks = state.tasks.filter((task) => task.kind === "book-build");
      if (tasks.length <= count) return "";
      const newest = tasks[0];
      return newest.status !== "running" && newest.status !== "queued" ? `${newest.status}|${newest.output}` : "";
    }, before), 300_000);
    if (!uiDone.startsWith("done")) throw new Error(`the wizard build should finish done: ${uiDone}`);
    const wizardOut = uiDone.split("|")[1];
    if (!fs.existsSync(wizardOut)) throw new Error(`expected the wizard epub: ${wizardOut}`);
    const wizardZip = await JSZip.loadAsync(fs.readFileSync(wizardOut));
    const wizardCover = await wizardZip.file("OEBPS/images/cover.jpg")?.async("nodebuffer");
    if (!wizardCover?.length) throw new Error("the wizard should render the default template cover");
    const wizardNav = await wizardZip.file("OEBPS/nav.xhtml").async("string");
    if (!wizardNav.includes("改名后的第一章")) throw new Error("the edited chapter title should reach the epub nav");
    console.log("workshop-epub: wizard built", path.basename(wizardOut), fs.statSync(wizardOut).size, "bytes");
    // 预览:非文本源读同目录已提取的 Markdown,不再把二进制当文本读(乱码修复)。
    const scanPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(path.join(userData, "library", "Books", "扫描页.png"), scanPng);
    fs.writeFileSync(path.join(userData, "library", "Books", "扫描页.md"), "# 扫描页\n\n识别出来的正文,用于预览。\n", "utf8");
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="book"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='book']", { timeout: 10_000 });
    await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      panel.querySelector(".qbr-workshop-chip .qbr-workshop-chip-x")?.click();
      const list = panel.querySelector(".qbr-workshop-booklist");
      if (list?.hidden) {
        const pick = [...panel.querySelectorAll("button")].find((button) => button.textContent.includes("选择书稿"));
        pick?.click();
      }
    });
    const scanned = await page.evaluate(() => {
      const panel = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      const list = panel.querySelector(".qbr-workshop-booklist");
      const rows = [...list.querySelectorAll(".qbr-workshop-book")];
      const row = rows.find((entry) => entry.textContent.includes("扫描页") && entry.textContent.includes("PNG"));
      const box = row?.querySelector("input");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      return {
        found: Boolean(row),
        rows: rows.map((entry) => entry.textContent.slice(0, 22)),
        listHidden: Boolean(list.hidden),
        chips: [...panel.querySelectorAll(".qbr-workshop-chip")].map((entry) => entry.textContent.slice(0, 16)),
      };
    });
    if (!scanned.found) throw new Error(`the panel should list the scanned png once it exists: ${JSON.stringify(scanned)}`);
    console.log("workshop-epub: scanned png listed in the source picker");
    // 最后用阅读器打开生成物(阅读模式会隐藏导航,放到场景末尾)。
    await page.evaluate(async () => {
      const file = window.__qbrApp.vault.getAbstractFileByPath("Books/测试小说.epub");
      await window.__qbrPlugin.openFile(file);
    });
    await waitFor("generated epub open", () => readerReady(page), 30_000);
    console.log("workshop-epub: the reader opened the generated book");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// 电子书制作:图片 → CBZ(纯打包)+ EPUB → AZW3 / 图片 → EPUB(Calibre,缺失则跳过)。
async function runWorkshopBookScenario() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-wshop-book-"));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-book-images-"));
  fs.mkdirSync(path.join(userData, "library", "Books"), { recursive: true });
  await writeMinimalEpub(path.join(userData, "library", "Books", "拼音测试书.epub"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  for (const name of ["1.png", "2.png", "10.png"]) fs.writeFileSync(path.join(imageDir, name), png);
  const { app, page } = await launch("", { userData });
  try {
    await page.waitForSelector(".qbr-home-view", { timeout: 30_000 });
    await page.click('[data-route="workshop"]');
    await page.waitForSelector(".qbr-workshop-view", { timeout: 15_000 });
    await page.evaluate(() => document.querySelector('.qbr-workshop-rail button[data-tool="book"]')?.click());
    await page.waitForSelector(".qbr-workshop-panel[data-tool='book']", { timeout: 10_000 });
    const panel = await page.evaluate(() => {
      const root = document.querySelector(".qbr-workshop-panel[data-tool='book']");
      return {
        tools: [...root.querySelectorAll(".qbr-workshop-subtool b")].map((node) => node.textContent),
        selects: [...root.querySelectorAll("select")].map((s) => [...s.options].map((o) => o.value).join(",")),
      };
    });
    if (!panel.tools.some((label) => label.includes("EPUB → AZW3 / MOBI")) || !panel.tools.some((label) => label.includes("图片 → CBZ"))) {
      throw new Error(`the book panel should offer the AZW3 and CBZ tools: ${JSON.stringify(panel.tools)}`);
    }
    if (!panel.selects.some((values) => values.includes("azw3")) || !panel.selects.some((values) => values.includes("cbz"))) {
      throw new Error(`the book panel lost its target selects: ${JSON.stringify(panel.selects)}`);
    }
    console.log("workshop-book: panel offers", panel.tools.join(" / "));
    // 图片 → CBZ(不需要 Calibre)。
    const images = ["1.png", "2.png", "10.png"].map((name) => path.join(imageDir, name).replace(/\\/g, "/"));
    const cbzTask = await page.evaluate((payload) => window.qbrDesktop.workshop.start({
      kind: "images-cbz", title: "图片 → CBZ", payload,
    }), { images, format: "cbz" });
    const cbzDone = await waitFor("images-cbz", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, cbzTask), 120_000);
    if (!cbzDone.startsWith("done")) throw new Error(`packing images should finish done: ${cbzDone}`);
    const cbzPath = path.join(path.dirname(imageDir), `${path.basename(imageDir)}.cbz`);
    if (!fs.existsSync(cbzPath)) throw new Error(`expected the cbz next to the image folder: ${cbzPath}`);
    const zip = await JSZip.loadAsync(fs.readFileSync(cbzPath));
    const entries = Object.keys(zip.files);
    if (entries.length !== 3 || entries[0] !== "1.png" || entries[2] !== "10.png") {
      throw new Error(`the cbz should keep the natural order: ${entries.join(",")}`);
    }
    console.log("workshop-book: images packed —", path.basename(cbzPath), entries.join(","));
    // Calibre:EPUB → AZW3 与 图片 → EPUB。
    const probe = await page.evaluate(() => window.qbrDesktop.workshop.start({ kind: "calibre-probe", title: "检测 Calibre", payload: {} }));
    const probed = await waitFor("calibre probe", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, probe), 30_000);
    if (!probed.startsWith("done")) {
      console.log("workshop-book: Calibre conversions skipped —", probed.slice(0, 90));
      return;
    }
    const convertTask = await page.evaluate(() => window.qbrDesktop.workshop.start({
      kind: "ebook-convert", title: "转为 AZW3",
      payload: { source: "Books/拼音测试书.epub", format: "azw3", out: "Books/拼音测试书.azw3" },
    }));
    const converted = await waitFor("ebook-convert", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, convertTask), 300_000);
    if (!converted.startsWith("done")) throw new Error(`epub → azw3 should finish done: ${converted}`);
    const azw3 = path.join(userData, "library", "Books", "拼音测试书.azw3");
    if (!fs.existsSync(azw3) || fs.statSync(azw3).size < 1000) throw new Error(`the azw3 looks wrong: ${azw3}`);
    console.log("workshop-book: epub → azw3", fs.statSync(azw3).size, "bytes");
    const epubTask = await page.evaluate((payload) => window.qbrDesktop.workshop.start({
      kind: "images-cbz", title: "图片 → EPUB", payload,
    }), { images, format: "epub" });
    const epubDone = await waitFor("images-epub", () => page.evaluate(async (id) => {
      const state = await window.qbrDesktop.workshop.list();
      const task = state.tasks.find((entry) => entry.id === id);
      return task && task.status !== "running" && task.status !== "queued" ? `${task.status}|${task.output}${task.error}` : "";
    }, epubTask), 300_000);
    if (!epubDone.startsWith("done")) throw new Error(`images → epub should finish done: ${epubDone}`);
    const epubOut = epubDone.split("|")[1];
    if (!fs.existsSync(epubOut) || fs.statSync(epubOut).size < 1000) throw new Error(`the images epub looks wrong: ${epubOut}`);
    console.log("workshop-book: images → epub", fs.statSync(epubOut).size, "bytes");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
}

async function writeMinimalEpub(file) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">pinyin-fixture</dc:identifier>
    <dc:title>拼音测试书</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`);
  zip.file("OEBPS/chapter1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>
  <h1>第一章</h1>
  <p>犇这个字很少见，意思是群牛受惊奔跑。</p>
  <p>阅读是一件安静而长久的事情，值得每天坚持。</p>
  <p>望梅止渴这个成语出自三国时期的故事。</p>
  <p>这是一段比较长的中文句子，用来验证长选区不会显示注音和释义信息。</p>
</body></html>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

async function selectTextInFrames(page, needle, wholeParagraph = false) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const text = await frame.evaluate(({ needle, wholeParagraph }) => {
        const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
        if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return "";
        if (wholeParagraph) {
          const el = [...document.querySelectorAll("p")].find((node) => node.textContent.includes(needle));
          if (!el) return "";
          const range = document.createRange();
          range.selectNodeContents(el);
          document.getSelection().removeAllRanges();
          document.getSelection().addRange(range);
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          return document.getSelection().toString();
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = null, offset = -1;
        while ((node = walker.nextNode())) {
          offset = node.textContent.indexOf(needle);
          if (offset >= 0) break;
        }
        if (!node || offset < 0) return "";
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + needle.length);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        node.parentElement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
        return document.getSelection().toString();
      }, { needle, wholeParagraph });
      if (text) return text;
    } catch {}
  }
  return "";
}

// A plain tap in the book (no click) is what dismisses the pinned-reading card.
async function tapTextInFrames(page, needle) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const hit = await frame.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = null, offset = -1;
        while ((node = walker.nextNode())) {
          offset = node.textContent.indexOf(text);
          if (offset >= 0) break;
        }
        if (!node || offset < 0) return false;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + text.length);
        const rect = range.getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || node.parentElement;
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
        target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
        return true;
      }, needle);
      if (hit) return true;
    } catch {}
  }
  return false;
}

async function clearSelectionInFrames(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try { await frame.evaluate(() => document.getSelection()?.removeAllRanges()); } catch {}
  }
}

async function clickTextInFrames(page, needle) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const point = await frame.evaluate((text) => {
        const frameRect = document.defaultView?.frameElement?.getBoundingClientRect();
        if (!frameRect || frameRect.width < 50 || frameRect.height < 50) return null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = null, offset = -1;
        while ((node = walker.nextNode())) {
          offset = node.textContent.indexOf(text);
          if (offset >= 0) break;
        }
        if (!node || offset < 0) return null;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + text.length);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y) || node.parentElement;
        target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, cancelable: true }));
        return { x, y, target: target.tagName };
      }, needle);
      if (point) return point;
    } catch {}
  }
  return null;
}

async function runPinyinScenario() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pinyin-"));
  const chineseBook = path.join(fixtureDir, "pinyin.epub");
  await writeMinimalEpub(chineseBook);
  const { app, page, userData } = await launch(chineseBook);
  try {
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    const chip = await waitFor("pinyin chip", async () => {
      const selected = await selectTextInFrames(page, "犇");
      if (!selected) return "";
      await sleep(300);
      const value = await page.evaluate(() => document.querySelector(".qiaomu-reader-py-chip")?.textContent || "");
      return value.includes("bēn") && value.includes("群牛受惊奔跑") ? value : "";
    }, 20_000);
    console.log("pinyin: single character shows reading and glossary", chip.slice(0, 24));
    const wordChip = await waitFor("word definition", async () => {
      const selected = await selectTextInFrames(page, "阅读");
      if (!selected) return "";
      await sleep(250);
      return page.evaluate(() => {
        const chip = document.querySelector(".qiaomu-reader-py-chip");
        const gloss = chip?.querySelector(".qiaomu-reader-py-gloss")?.textContent || "";
        return gloss ? { pinyin: chip.querySelector(".qiaomu-reader-py-pinyin")?.textContent || "", gloss } : "";
      });
    }, 15_000);
    if (wordChip.gloss.includes("群牛")) throw new Error("a word must not reuse the character glossary");
    console.log("pinyin: word shows its definition", wordChip.pinyin, "|", wordChip.gloss);
    const idiomChip = await waitFor("idiom definition", async () => {
      const selected = await selectTextInFrames(page, "望梅止渴");
      if (!selected) return "";
      await sleep(250);
      return page.evaluate(
        () => document.querySelector(".qiaomu-reader-py-chip .qiaomu-reader-py-gloss")?.textContent || "");
    }, 15_000);
    if (!idiomChip.includes("比喻")) throw new Error("an idiom should show its figurative meaning");
    console.log("pinyin: idiom shows its definition", idiomChip.slice(0, 20));

    // A traditional query must find the simplified text in the book.
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.findBtn?.click());
    await page.waitForSelector(".qiaomu-reader-toc-find-input", { timeout: 10_000 });
    await page.fill(".qiaomu-reader-toc-find-input", "閱讀");
    const found = await waitFor("traditional query finds simplified text", () => page.evaluate(() => {
      const rows = [...document.querySelectorAll(".qiaomu-reader-find-item .qiaomu-reader-find-text")];
      return rows.map((row) => row.textContent).find((text) => text.includes("阅读")) || "";
    }), 15_000);
    console.log("pinyin: traditional query found", found.slice(0, 20));
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.findBtn?.click());
    await selectTextInFrames(page, "比较长的中文句子", true);
    await sleep(400);
    if (!(await page.evaluate(() => !document.querySelector(".qiaomu-reader-py-chip")))) {
      throw new Error("a long selection must not show the pinyin chip");
    }
    console.log("pinyin: long selections stay clean");

    await selectTextInFrames(page, "犇");
    await sleep(300);
    await page.click(".qiaomu-reader-py-chip");
    const pin = await waitFor("pinned reading", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const stored = view?.plugin.getPins(view.file.path) || [];
      const live = stored[0] ? view.engine.getPin(stored[0].id) : null;
      return stored.length === 1 && live?.pin?.pinyin === "bēn"
        ? { id: stored[0].id, cfi: stored[0].cfi }
        : "";
    }), 15_000);
    console.log("pinyin: chip pinned the reading", pin.id);

    await page.evaluate((cfi) => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view.engine.goTo(cfi), pin.cfi);
    await sleep(600);
    await page.evaluate(() => window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0].view._hideHlPopup());
    // The book renders inside a closed shadow root, so a page-level mouse click
    // cannot address the character. Dispatch the same click in the section
    // document at the character's coordinates instead.
    const clicked = await clickTextInFrames(page, "犇");
    if (!clicked) throw new Error("could not click the pinned character");
    const card = await waitFor("pin card", async () => {
      const text = await page.evaluate(() => {
        const pop = document.querySelector(".qiaomu-reader-pin-popup-on");
        return pop ? pop.textContent : "";
      });
      return text.includes("bēn") && text.includes("群牛受惊奔跑") ? text : "";
    }, 10_000);
    console.log("pinyin: clicking the pin opens its card", card.slice(0, 24));
    if (!(await tapTextInFrames(page, "阅读是一件安静"))) throw new Error("could not tap the page to dismiss the card");
    await waitFor("pin card dismissed", () => page.evaluate(() => !document.querySelector(".qiaomu-reader-pin-popup-on")), 8_000);
    console.log("pinyin: tapping the page dismissed the card");
    await clickTextInFrames(page, "犇");
    await waitFor("pin card reopened", () => page.evaluate(
      () => Boolean(document.querySelector(".qiaomu-reader-pin-popup-on"))), 8_000);
    await page.click(".qiaomu-reader-pin-remove");
    await waitFor("pin removed", () => page.evaluate((id) => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      return view.plugin.getPins(view.file.path).length === 0 && view.engine.getPin(id) === null
        && !document.querySelector(".qiaomu-reader-pin-popup-on");
    }, pin.id), 10_000);
    console.log("pinyin: the card removed the pin");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

const scenarios = [
  ["home", runHomeScenario],
  ["workshop", runWorkshopScenario],
  ["workshop-ocr", runWorkshopOcrScenario],
  ["workshop-convert", runWorkshopConvertScenario],
  ["workshop-formula", runWorkshopFormulaScenario],
  ["workshop-book", runWorkshopBookScenario],
  ["workshop-epub", runWorkshopEpubScenario],
  ["workshop-extract", runWorkshopExtractScenario],
  ["library", runLibraryTabsScenario],
  ["ebook", runEbookScenario],
  ["restart", runRestartScenario],
  ["projects", runProjectsScenario],
  ["ocr", runOcrScenario],
  ["pdf", runPdfScenario],
  ["cjk-pin", runCjkPdfPinScenario],
  ["pinyin", runPinyinScenario],
  ["ai", runAiScenario],
  ["api-key", runApiKeyScenario],
  ["capability", runCapabilityScenario],
  ["scroll", runScrollScenario],
  ["nav", runNavScenario],
  ["toc", runTocScenario],
];
const only = (process.env.QBR_E2E_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean);

let failed = false;
try {
  for (const [name, run] of scenarios) {
    if (only.length && !only.includes(name)) continue;
    await run();
  }
  console.log("E2E OK");
} catch (error) {
  failed = true;
  console.error("E2E FAILED:", error?.stack || error);
} finally {
  process.exit(failed ? 1 : 0);
}
