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

async function launch(target, options = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-e2e-"));
  options.seed?.(userData);
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [".", target],
    cwd: appRoot,
    env: { ...process.env, QBR_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  return { app, page, userData };
}

function safeChatId(id) {
  return String(id || "chat").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
}

function startMockAi() {
  const state = { requests: 0, auth: "" };
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
      if (payload.stream) {
        response.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const chunks = ["MOCK ", "STREAM ", "ANSWER"];
        let index = 0;
        const timer = setInterval(() => {
          if (index < chunks.length) {
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index++] } }] })}\n\n`);
          } else {
            clearInterval(timer);
            response.write("data: [DONE]\n\n");
            response.end();
          }
        }, 30);
      } else {
        response.writeHead(200, { ...cors, "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "MOCK CONNECTION OK" } }] }));
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

async function highlightFromPopup(page, highlightsPath, bookKey, expected) {
  await waitFor("highlight popup", () => page.evaluate(() => {
    const view = window.__qbrApp?.workspace?.getLeavesOfType("qiaomu-reader")[0]?.view;
    return view?.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on") ? "on" : "";
  }), 15_000);
  // One click highlights with the current colour; the palette is the held /
  // ArrowDown path and is exercised by its own step.
  await page.click(".qiaomu-reader-hl-highlight");
  const stored = await waitFor("reading-highlights.json", () => {
    if (!fs.existsSync(highlightsPath)) return "";
    const data = JSON.parse(fs.readFileSync(highlightsPath, "utf8"));
    return data[bookKey]?.length ? data[bookKey] : "";
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
    const bookKey = book.replace(/\\/g, "/");
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("reader ready", () => readerReady(page), 30_000);
    console.log("epub: reader ready");

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

    assert.equal(await clickTopButton(page, "笔记"), true);
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

    const selected = await waitFor("highlightable selection", async () => {
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

    const highlightsPath = path.join(userData, "library", "plugin", "reading-highlights.json");
    const stored = await highlightFromPopup(page, highlightsPath, bookKey, { cfi: true });
    console.log("epub: highlight stored", stored.id, stored.color);

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
    await page.mouse.move(handle.x - 40, handle.y, { steps: 6 });
    await page.mouse.up();
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
    await page.evaluate(() => {
      document.querySelector(".qiaomu-reader-lib-card")?.click();
    });
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

async function runPdfScenario() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdf-"));
  const fixture = path.join(fixtureDir, "sample.pdf");
  writeMinimalPdf(fixture);
  const { app, page, userData } = await launch(fixture);
  try {
    const bookKey = fixture.replace(/\\/g, "/");
    await page.waitForSelector(".qiaomu-reader-view", { timeout: 30_000 });
    await waitFor("pdf ready", () => readerReady(page), 30_000);
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

    const highlightsPath = path.join(userData, "library", "plugin", "reading-highlights.json");
    const stored = await highlightFromPopup(page, highlightsPath, bookKey, { cfi: false });
    console.log("pdf: highlight stored", stored.id, stored.color);

    assert.equal(await clickTopButton(page, "适合页面"), true);
    const fitShare = await waitFor("pdf fit page fills the width", () => page.evaluate(() => {
      const view = window.__qbrApp.workspace.getLeavesOfType("qiaomu-reader")[0]?.view;
      const page = view?.pager?.currentPdfPageElement?.();
      const figure = page?.querySelector(".qiaomu-reader-pdf-native-page");
      const width = Number.parseFloat(figure?.style.getPropertyValue("--qiaomu-reader-pdf-fit-width"));
      const slot = page?.clientWidth || 0;
      if (view?.plugin?.settings?.fitPage !== true || !width || !slot) return "";
      const share = (width * view.pdfZoom) / slot;
      return share > 0.85 && share < 0.95 ? String(Math.round(share * 100)) : "";
    }), 10_000);
    console.log("pdf: fit page fills the slot width", fitShare, "%");
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
        const before = view.pager.currentPdfPageNumber();
        view.togglePanel("highlights");
        await new Promise((resolve) => setTimeout(resolve, 500));
        const items = [...document.querySelectorAll(".qiaomu-reader-hl-item")];
        const entry = items[items.length - 1]?.querySelector(".qiaomu-reader-hl-text");
        const entryText = entry?.textContent || "";
        items[items.length - 1]?.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
        return { before, after: view.pager.currentPdfPageNumber(), items: items.length, entryText };
      });
      if (jumped.error) throw new Error(jumped.error);
      if (!/^\[第 4 页\]/.test(jumped.entryText)) throw new Error(`the entry has no page prefix: ${jumped.entryText}`);
      if (jumped.after === jumped.before) throw new Error(`the highlight did not jump: ${JSON.stringify(jumped)}`);
      console.log("pdf: highlight entry jumped to page", jumped.after);
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

    const chatIndex = path.join(userData, "data", "chat", "index.json");
    const record = await waitFor("chat history file", () => {
      if (!fs.existsSync(chatIndex)) return "";
      const index = JSON.parse(fs.readFileSync(chatIndex, "utf8"));
      if (!index.length) return "";
      const file = path.join(userData, "data", "chat", `${safeChatId(index[0].id)}.json`);
      if (!fs.existsSync(file)) return "";
      const chat = JSON.parse(fs.readFileSync(file, "utf8"));
      return chat.turns?.some((turn) => String(turn.content).includes("MOCK STREAM ANSWER")) ? chat : "";
    }, 20_000);
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
    console.log("home: opened a book from the home page", cards, "cards");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
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

let failed = false;
try {
  await runHomeScenario();
  await runEbookScenario();
  await runPdfScenario();
  await runCjkPdfPinScenario();
  await runPinyinScenario();
  await runAiScenario();
  await runApiKeyScenario();
  await runScrollScenario();
  console.log("E2E OK");
} catch (error) {
  failed = true;
  console.error("E2E FAILED:", error?.stack || error);
} finally {
  process.exit(failed ? 1 : 0);
}
