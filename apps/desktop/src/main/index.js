import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import { BOOK_EXTENSIONS, isBookFile } from "../shared/books.js";
import { createAiRuntime } from "./ai-runtime.js";

const aiRuntime = createAiRuntime();

if (process.env.QBR_USER_DATA) app.setPath("userData", process.env.QBR_USER_DATA);
const userData = app.getPath("userData");
const dataRoot = path.join(userData, "data");
const vaultRoot = path.join(userData, "library");
const secretsPath = path.join(userData, "secrets.json");
const smoke = process.argv.includes("--qbr-smoke");
if (!app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

process.env.QBR_DATA_ROOT = dataRoot;
process.env.QBR_VAULT_ROOT = vaultRoot;
process.env.QBR_SMOKE = smoke ? "1" : "";
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(vaultRoot, { recursive: true });

let mainWindow = null;
let launchFile = "";
let smokeTimer = null;

function bookFromArgv(argv) {
  return (argv || []).find((arg) => isBookFile(arg) && fs.existsSync(arg)) || "";
}

function sendOpen(filePath) {
  if (!filePath) return;
  if (mainWindow) mainWindow.webContents.send("qbr:open-book", filePath);
  else launchFile = filePath;
}

// Attachments for AI chats: the main process owns the file dialog and reads
// the bytes so the renderer never touches the filesystem directly.
const AI_ATTACHMENT_FILTERS = [
  { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
  { name: "文本", extensions: ["txt", "md", "markdown", "csv", "json", "log"] },
  { name: "所有文件", extensions: ["*"] },
];
const AI_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;
const AI_ATTACHMENT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

function readAiAttachment(filePath) {
  try {
    const target = String(filePath || "");
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { ok: false, path: target, reason: "unreadable" };
    const name = path.basename(target);
    const ext = path.extname(target).slice(1).toLowerCase();
    if (stat.size > AI_ATTACHMENT_MAX_BYTES) return { ok: false, path: target, name, bytes: stat.size, reason: "toolarge" };
    return {
      ok: true,
      path: target,
      name,
      bytes: stat.size,
      mimeType: AI_ATTACHMENT_MIME[ext] || "",
      data: fs.readFileSync(target).toString("base64"),
    };
  } catch {
    return { ok: false, path: String(filePath || ""), reason: "unreadable" };
  }
}

// Screen-region capture for AI screenshots. The renderer sends CSS pixels
// (getBoundingClientRect), the page zoom maps them to DIP, and capturePage
// returns the composited frame — so one call covers spreads, scroll mode,
// EPUB iframes and manual zoom alike.
const CAPTURE_MAX_EDGE = 2400;

async function captureRegion(rect) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: "unavailable" };
  const source = rect || {};
  const factor = mainWindow.webContents.getZoomFactor?.() || 1;
  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  const scale = (value) => Math.max(0, Math.round(Number(value) * factor));
  const area = {
    x: scale(source.x),
    y: scale(source.y),
    width: Math.max(1, scale(source.width)),
    height: Math.max(1, scale(source.height)),
  };
  area.width = Math.min(area.width, Math.max(1, contentWidth - area.x));
  area.height = Math.min(area.height, Math.max(1, contentHeight - area.y));
  if (area.width < 8 || area.height < 8) return { ok: false, reason: "empty" };
  try {
    let image = await mainWindow.webContents.capturePage(area);
    if (!image || image.isEmpty()) return { ok: false, reason: "empty" };
    const size = image.getSize();
    const longest = Math.max(size.width, size.height);
    if (longest > CAPTURE_MAX_EDGE) {
      const ratio = CAPTURE_MAX_EDGE / longest;
      image = image.resize({
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
        quality: "good",
      });
    }
    const finalSize = image.getSize();
    return {
      ok: true,
      mimeType: "image/png",
      data: image.toPNG().toString("base64"),
      width: finalSize.width,
      height: finalSize.height,
    };
  } catch (error) {
    return { ok: false, reason: "capture", message: String(error?.message || error) };
  }
}

async function pickAiAttachments() {
  const options = {
    title: "选择附件",
    properties: ["openFile", "multiSelections"],
    filters: AI_ATTACHMENT_FILTERS,
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return { ok: true, files: [] };
  return { ok: true, files: result.filePaths.slice(0, 4).map(readAiAttachment) };
}

async function openBookDialog() {
  const options = {
    title: "打开书籍",
    properties: ["openFile"],
    filters: [
      { name: "电子书", extensions: [...BOOK_EXTENSIONS] },
      { name: "所有文件", extensions: ["*"] },
    ],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return "";
  const filePath = result.filePaths[0];
  if (!isBookFile(filePath)) {
    dialog.showErrorBox("不支持的格式", `“${path.basename(filePath)}”不是受支持的电子书格式。\n支持：${BOOK_EXTENSIONS.join("、")}`);
    return "";
  }
  app.addRecentDocument(filePath);
  return filePath;
}

function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  } catch {
    return {};
  }
}

function writeSecrets(value) {
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  fs.writeFileSync(secretsPath, JSON.stringify(value, null, 2));
}

function encryptSecret(value) {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
}

function decryptSecret(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("enc:")) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
    } catch {
      return "";
    }
  }
  if (value.startsWith("plain:")) return Buffer.from(value.slice(6), "base64").toString("utf8");
  return value;
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "打开书籍…", accelerator: "CmdOrCtrl+O", click: async () => sendOpen(await openBookDialog()) },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "resetZoom", label: "重置缩放" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "UV Reader",
    backgroundColor: "#1e1e1e",
    show: false,
    // Reading app: the native menu bar stays hidden (Alt still reveals it, so
    // the accelerators keep working).
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      spellcheck: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("console-message", (...args) => {
    const details = args[1];
    if (details && typeof details === "object" && "message" in details) {
      console.log(`[renderer:${details.level ?? "log"}] ${details.message}`);
    } else {
      console.log(`[renderer] ${args[2]}`);
    }
  });
  void mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("qbr:launch-file", () => launchFile);
ipcMain.handle("qbr:open-book-dialog", () => openBookDialog());
ipcMain.handle("qbr:open-path", (_event, target) => (target ? shell.openPath(String(target)) : ""));
ipcMain.handle("qbr:boot", (_event, payload = {}) => {
  const status = payload.ok ? "ok" : "failed";
  console.log(`[qbr] boot ${status}${payload.file ? ` (${payload.file})` : ""}${payload.detail ? ` ${payload.detail}` : ""}`);
  if (payload.error) console.error(`[qbr] ${payload.error}`);
  if (smoke) {
    clearTimeout(smokeTimer);
    setTimeout(() => app.exit(payload.ok ? 0 : 1), 50);
  }
  return true;
});
ipcMain.handle("qbr:show-item", (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});
ipcMain.handle("qbr:ai:stream", (event, payload = {}) =>
  aiRuntime.stream(payload, (delta) => {
    if (!event.sender.isDestroyed()) event.sender.send("qbr:ai:event", delta);
  }));
ipcMain.handle("qbr:ai:abort", (_event, requestId) => aiRuntime.abort(String(requestId || "")));
ipcMain.handle("qbr:ai:test", (_event, config) => aiRuntime.test(config || {}));
ipcMain.handle("qbr:ai:probe", (_event, payload) => aiRuntime.probe(payload || {}));
ipcMain.handle("qbr:ai:pick-files", () => pickAiAttachments());
ipcMain.handle("qbr:ai:read-file", (_event, target) => readAiAttachment(target));
ipcMain.handle("qbr:ai:capture-region", (_event, rect) => captureRegion(rect));
ipcMain.on("qbr:secret-sync", (event, id) => {
  const store = readSecrets();
  event.returnValue = id && store[id] ? decryptSecret(store[id]) : null;
});
ipcMain.handle("qbr:secret", (_event, action, id, value) => {
  const store = readSecrets();
  if (action === "get") return store[id] ? decryptSecret(store[id]) : null;
  if (action === "set") {
    store[id] = encryptSecret(String(value ?? ""));
    writeSecrets(store);
    return true;
  }
  if (action === "delete") {
    delete store[id];
    writeSecrets(store);
    return true;
  }
  if (action === "list") return Object.keys(store);
  return null;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  launchFile = bookFromArgv(process.argv.slice(1));
  app.on("second-instance", (_event, argv) => {
    const file = bookFromArgv(argv);
    if (file) sendOpen(file);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    sendOpen(filePath);
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    if (smoke) {
      smokeTimer = setTimeout(() => {
        console.error("[qbr] boot timed out");
        app.exit(2);
      }, 60_000);
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
