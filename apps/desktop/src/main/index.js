import { BrowserWindow, Menu, app, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BOOK_EXTENSIONS, isBookFile } from "../shared/books.js";
import { WORKSHOP_PICK_EXTENSIONS } from "../shared/workshop-formats.js";
import { createAiRuntime } from "./ai-runtime.js";
import { createEngineClient, describeEngineHealth } from "./engine-client.js";
import { createEngineInstaller, registerEngineComponentRunner, registerEngineInstallRunner } from "./engine-install.js";
import { createEngineService, portFromUrl } from "./engine-service.js";
import { syncLocalMineru } from "./engine-wiring.js";
import { createCalibre } from "./calibre.js";
import { createCoverRenderer } from "./cover-render.js";
import { createDocvortex, registerDocvortexRunners } from "./docvortex.js";
import { extractMarkdown, registerExtractRunners } from "./extract-doc.js";
import { clearMineruCaches, createMineruLocalService, resolveLocalBackend, resolveMineruKit } from "./mineru-local.js";
import { createPdfCleaner, createPdfTextReader, registerTextConvertRunner } from "./pdf-text.js";
import { createFormulaChain, pdfToolScriptCommand, registerFormulaRunners, resolveMineruToken } from "./workshop-formula.js";
import { registerBookRunners } from "./workshop-book.js";
import { createPdfOutlineReader } from "./pdf-outline.js";
import { registerEpubRunners } from "./workshop-epub.js";
import { registerAiRunners } from "./workshop-ai.js";
import { createPdfOcr, OCR_PROBE_TIMEOUT, resolveOcrOutput } from "./pdf-ocr.js";
import { registerOcrRunners } from "./workshop-ocr.js";
import { registerQuestionRunners } from "./workshop-questions.js";
import { createTextLayerReader } from "./text-layer.js";
import { createWorkshopQueue } from "./workshop.js";
import { createBookDownloads } from "./book-downloads.js";
import { bookSessionReady, closeBookSession, downloadBookFile, downloadBookFileFromPage, fetchBookPage, forgetBookSession, openBookLogin, searchPdfdrive, sessionFetch } from "./book-session.js";

const aiRuntime = createAiRuntime();
const engineClient = createEngineClient();

if (process.env.QBR_USER_DATA) app.setPath("userData", process.env.QBR_USER_DATA);
const userData = app.getPath("userData");
// Main-process logs (the [qbr-books] search/download lines) also land in
// userData/qbr.log so a slow or stuck search can be inspected after the fact;
// the file is truncated once it passes ~1 MB.
const logPath = path.join(userData, "qbr.log");
try {
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    originalError(...args);
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.writeFileSync(logPath, "");
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${args.map((arg) => (typeof arg === "string" ? arg : String(arg?.stack || arg))).join(" ")}\n`);
    } catch { /* logging must never break the app */ }
  };
} catch { /* console keeps working */ }
// 主进程自己的日志入口:走 console.error(上面已经接管,会同时落到 userData/qbr.log)。
// 注意:调用方要把**这个函数**传进去(别再写 `log: (...args) => log(...)` 那种自引用)。
const log = (...args) => console.error("[qbr]", ...args);
const dataRoot = path.join(userData, "data");
const vaultRoot = path.join(userData, "library");
const secretsPath = path.join(userData, "secrets.json");
// 书坊引擎装在这里:Windows 用 %LOCALAPPDATA%\UVReader\engine\<版本>(与手工部署的
// venv/token.txt 同一个根,方便找);其他平台放应用数据目录。QBR_ENGINE_ROOT 可覆盖(测试用)。
const engineRoot = process.env.QBR_ENGINE_ROOT || (process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "UVReader", "engine")
  : path.join(userData, "engine"));
// The sidecar's page cache lives with the app profile: the second open of a
// book is a cache hit instead of a re-OCR.
const pdfOcr = createPdfOcr({ cacheRoot: path.join(userData, "ocr-cache") });
// 本地 MinerU 常驻服务:启动时自动拉起(设置里可关),书坊里检测;退出只收自己拉起的进程。
const mineruLocal = createMineruLocalService({ uploadDir: path.join(userData, "mineru-service") });
// 书坊任务队列:串行执行,历史落盘(最近 20 条,不自动续跑)。W0-3+ 为各工具
// 注册 runner;这里先提供「环境自检」(探测 OCR sidecar)。
const workshop = createWorkshopQueue({
  file: path.join(userData, "workshop-tasks.json"),
  onState: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("qbr:workshop:state", state);
  },
});
workshop.register("probe", async ({ payload, report, signal }) => {
  report({ total: 2, label: "检测 OCR 程序" });
  const result = await pdfOcr.probe(payload?.settings || {}, OCR_PROBE_TIMEOUT);
  if (signal.aborted) throw new Error("任务已取消");
  report({ done: 1, total: 2, label: "检测完成" });
  if (!result?.ok) throw new Error(String(result?.detail || "OCR 程序不可用"));
  report({ done: 2, total: 2 });
  return { output: String(result.detail || "ok") };
});
// 文字层工具:批量生成文字层 / 导出可搜索 PDF(.uvtext.pdf)。
registerOcrRunners(workshop, { pdfOcr, vaultRoot });
// 文档互转(DocVortex):检测 + 转换。
const docvortex = createDocvortex({ engine: engineClient });
registerDocvortexRunners(workshop, { docvortex, vaultRoot, cleaner: createPdfCleaner({ engine: engineClient, pdfText: createPdfTextReader({ engine: engineClient }) }) });
// 公式优先链路:pdf_tool(MinerU)→ HTML → DocVortex(真公式)。
const formulaChain = createFormulaChain({ engine: engineClient, textLayer: createTextLayerReader({ engine: engineClient }) });
registerFormulaRunners(workshop, {
  chain: formulaChain,
  docvortex,
  vaultRoot,
  cacheRoot: path.join(userData, "formula-cache"),
});
// 电子书制作:Calibre 互转(EPUB→AZW3/MOBI)+ 图片打包(CBZ/EPUB)。
const calibre = createCalibre();
registerBookRunners(workshop, { calibre, vaultRoot, engine: engineClient });
// 电子书制作向导(W1-2):txt/md/PDF/Office → 章节 → 字体子集 → EPUB(含模板封面)。
// 缓存布局:<book-cache>/library(字体)、/subset(字体子集)、/extract(非文本源的提取中间产物)。
const bookCacheRoot = path.join(userData, "book-cache");
const coverRenderer = createCoverRenderer({
  createWindow: (options) => new BrowserWindow(options),
});
// 指定封面图:统一转 JPEG(webp 等格式也能进 EPUB)。
const readCoverImage = async (filePath) => {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return null;
  return { data: image.toJPEG(90), mediaType: "image/jpeg", fileName: "cover.jpg" };
};
registerEpubRunners(workshop, { vaultRoot, cacheRoot: bookCacheRoot, coverRenderer, readImage: readCoverImage, docvortex, outlineReader: createPdfOutlineReader({ engine: engineClient }), textLayer: createTextLayerReader({ engine: engineClient }), engine: engineClient });
// 内容提取(PDF/Office/OFD/图片 → md/html/json):pdf_tool + DocVortex。
registerExtractRunners(workshop, { docvortex, vaultRoot, cacheRoot: bookCacheRoot, pdfText: createPdfTextReader({ engine: engineClient }), textLayer: createTextLayerReader({ engine: engineClient }), engine: engineClient });
// 题库(W1 新):提取(引擎优先)→ 规则解析 → `<源名>_questions.json`(uvreader.question-bank/v1)
// + `_questions.md`(可读版)+ `_audit.json`(提示/校验)。不做 AI 兜底,认不出就给 warning。
registerQuestionRunners(workshop, {
  extractMarkdown,
  docvortex,
  textLayer: createTextLayerReader({ engine: engineClient }),
  engine: engineClient,
  vaultRoot,
  cacheRoot: bookCacheRoot,
});
// LLM 辅助(W2-1):AI 元数据推断 / AI 封面文案 / AI 分章建议 / AI 清理 —— 复用伴读的 AI 运行时与凭据。
registerAiRunners(workshop, { aiRuntime, vaultRoot, cacheRoot: bookCacheRoot });
// 格式转换的「文本型」链路(本地 fitz 提取 → DocVortex;与公式优先同构)。
registerTextConvertRunner(workshop, { docvortex, vaultRoot, cacheRoot: bookCacheRoot, pdfText: createPdfTextReader({ engine: engineClient }) });
// 书坊引擎的安装/更新(E3b):查最新 engine-v* 资产(或本地包)→ 下载 + sha256 → 解压 → 拉起;
// 结果(engineUrl / engineToken)回给设置页,由面板写进设置。
registerEngineInstallRunner(workshop, { engineRoot });
// 可选组件(E4):把 DocVortex 这类「还要另外装」的东西装进引擎自己的 Python。
registerEngineComponentRunner(workshop, { engine: engineClient });
// 引擎进程的启停(设置页「启动引擎 / 停止引擎」+ 启动应用时自动开启)。
const engineService = createEngineService({
  engineRoot,
  installer: createEngineInstaller(),
  log,
});
// Online book downloads land in the library so they appear as regular books.
const bookDownloads = createBookDownloads({
  downloadRoot: path.join(vaultRoot, "Books", "下载"),
  fetchImpl: sessionFetch,
  pageFetch: fetchBookPage,
  fileDownload: downloadBookFile,
  // A download wall is either a dead login or the daily download limit
  // (Z-Library: 10 books/day signed in, 5 anonymous). Only an anonymous
  // session is wiped and sent to the login window; a signed-in account keeps
  // its cookies because re-login cannot lift a quota, and the failed row
  // offers a manual 登录后下载 button instead.
  onAuthWall: (url) => {
    const target = String(url || "");
    void bookSessionReady(target).then((signedIn) => {
      if (signedIn) return;
      void forgetBookSession(target).finally(() => {
        try { void openBookLogin(target, { parent: BrowserWindow.getFocusedWindow() || mainWindow }); }
        catch { /* best effort */ }
      });
    }).catch(() => {});
  },
  pdfdriveSearch: searchPdfdrive,
  pageDownload: downloadBookFileFromPage,
});
const smoke = process.argv.includes("--qbr-smoke");

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

// External links are the only URLs allowed to leave the renderer: anything
// else (javascript:, file:, data:) is dropped instead of opened.
function externalHttpUrl(target) {
  try {
    const url = new URL(String(target));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
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

// 答题页的题库:源文件旁的 `<源名>_questions.json`(书坊数据提取产物)。
// 只读 JSON,限制大小;解析失败一律返回 null(面板会给出「没有题库」的提示)。
const QUIZ_BANK_MAX_BYTES = 8 * 1024 * 1024;

function readQuizBank(filePath) {
  try {
    const target = String(filePath || "");
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > QUIZ_BANK_MAX_BYTES) return null;
    const bank = JSON.parse(fs.readFileSync(target, "utf8"));
    return bank && typeof bank === "object" ? bank : null;
  } catch {
    return null;
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
  // Atomic write: a crash mid-save must not leave a truncated secret store.
  const body = JSON.stringify(value, null, 2);
  const temp = `${secretsPath}.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, secretsPath);
}

let warnedPlainSecrets = false;

function encryptSecret(value) {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  // No OS keyring (some Linux sessions): the keys stay usable, but say so once
  // instead of silently storing plain base64.
  if (!warnedPlainSecrets) {
    warnedPlainSecrets = true;
    console.error("[qbr] 系统密钥加密不可用，API 密钥将以本地编码形式保存在 secrets.json");
  }
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
  // The renderer is privileged (Node integration is how the host shim reads
  // files), so it must never navigate away from the shell. Book links open in
  // the system browser; window.open is denied outright.
  const appUrl = pathToFileURL(path.join(__dirname, "index.html")).toString();
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === appUrl || url.startsWith(`${appUrl}#`)) return;
    event.preventDefault();
    const external = externalHttpUrl(url);
    if (external) void shell.openExternal(external);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    // The hidden windows (zlib's page loader, PDF Drive, a login window) count
    // as open windows, so window-all-closed never fires after the visible
    // window goes away and the process lingers invisibly. Quitting here runs
    // before-quit, which cancels the jobs and destroys those windows.
    if (process.platform !== "darwin") app.quit();
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
ipcMain.handle("qbr:mineru:status", (_event, settings) => mineruLocal.status(settings || {}));
ipcMain.handle("qbr:mineru:ensure", (_event, settings) => mineruLocal.ensure(settings || {}));
ipcMain.handle("qbr:mineru:stop", () => mineruLocal.stop());
ipcMain.handle("qbr:mineru:path", (_event, settings = {}) => ({ path: resolveMineruKit(settings || {}) }));
// 直接在设置页里跑的链路探测(不入队):文字层 / DocVortex / 公式 / Calibre。
ipcMain.handle("qbr:probe:ocr", (_event, settings = {}) => pdfOcr.probe(settings || {}, OCR_PROBE_TIMEOUT));
ipcMain.handle("qbr:probe:docvortex", (_event, settings = {}) => docvortex.probe(settings || {}));
ipcMain.handle("qbr:probe:calibre", (_event, settings = {}) => calibre.probe(settings || {}));
// 书坊引擎(本地 HTTP 服务):应用只做探测,能力清单由引擎的 /v1/health 上报。
ipcMain.handle("qbr:probe:engine", async (_event, settings = {}) => {
  const value = settings || {};
  const result = await engineClient.health(value, { refresh: value.refresh === true });
  if (!result.ok) return { ok: false, detail: result.error || "连接不上引擎" };
  let health = result.data || {};
  let synced = null;
  // 引擎还用不上 MinerU、而本机有活着的本地 MinerU 服务:把地址 / 程序 / 凭据写进引擎配置
  // (只写引擎没配的时候,不覆盖用户填的;凭据只发给本机引擎)。
  if (health.capabilities?.mineru?.ok !== true) {
    synced = await syncLocalMineru({
      settings: value,
      engine: engineClient,
      resolveBackend: (input) => resolveLocalBackend(input),
      resolveKit: (input) => resolveMineruKit(input),
      log: (message, detail) => log("[engine]", message, detail || ""),
    });
    if (synced?.capabilities) health = { ...health, capabilities: synced.capabilities };
  }
  return { ok: true, detail: describeEngineHealth(health), health, synced };
});
// 引擎自己的配置(路径 / 凭据 / 并发):配置的单一来源在引擎,应用只做 UI。
ipcMain.handle("qbr:engine:config", (_event, settings = {}) => engineClient.config(settings || {}));
ipcMain.handle("qbr:engine:save-config", (_event, payload = {}) => engineClient.saveConfig(payload?.settings || {}, payload?.patch || {}));
ipcMain.handle("qbr:engine:jobs", (_event, payload = {}) => engineClient.jobs(payload?.settings || {}, payload?.limit || 20));
// 引擎进程:状态 / 启动 / 停止 / 应用启动时自动开启(只动应用自己起的那个)。
ipcMain.handle("qbr:engine:service", () => engineService.status());
ipcMain.handle("qbr:engine:start", (_event, payload = {}) => {
  const port = Math.min(65535, Math.max(1, Number(payload?.port) || portFromUrl(payload?.engineUrl)));
  return engineService.start({ port });
});
ipcMain.handle("qbr:engine:stop", () => engineService.stop());
ipcMain.handle("qbr:engine:auto-start", async (_event, settings = {}) => {
  const value = settings || {};
  if (value.engineAutoStart === false) return { skipped: "disabled" };
  const state = await engineService.status();
  if (!state.installed) return { skipped: "not-installed" };
  const health = await engineClient.health(value);
  if (health?.ok) return { skipped: "running", detail: describeEngineHealth(health.data || {}) };
  try {
    return await engineService.start({ port: portFromUrl(value.engineUrl) });
  } catch (error) {
    log("[engine] auto-start failed:", String(error?.message || error));
    return { skipped: "failed", error: String(error?.message || error) };
  }
});
// 离线安装:选一个本地引擎包(zip / tar.gz),交给 engine-install 任务。
ipcMain.handle("qbr:engine:pick-bundle", async () => {
  const options = {
    title: "选择书坊引擎安装包",
    properties: ["openFile"],
    filters: [
      { name: "引擎包", extensions: ["zip", "gz", "tgz"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? "" : String(result.filePaths?.[0] || "");
});
ipcMain.handle("qbr:probe:formula", async (_event, settings = {}) => {
  const value = settings || {};
  const target = pdfToolScriptCommand(value);
  if (target.error) return { ok: false, detail: target.error };
  const backend = await resolveLocalBackend(value);
  const token = resolveMineruToken(value, {});
  if (!backend.url && !token && !backend.exe) {
    return { ok: false, detail: "没有找到 MinerU 凭据或本地 MinerU:在「设置 → 书坊」里填。" };
  }
  const probe = await docvortex.probe(value);
  if (!probe.ok) return { ok: false, detail: `DocVortex 不可用:${String(probe.detail || "").slice(0, 120)}` };
  const backendText = backend.url ? `本地服务 ${backend.url}` : backend.exe ? "本地 CLI" : "云端凭据";
  return { ok: true, detail: `pdf_tool 就绪 · ${backendText} · DocVortex 可用` };
});
ipcMain.handle("qbr:mineru:clear-cache", async (_event, settings = {}) => {
  const running = (await mineruLocal.status(settings || {})).status === "running";
  const formulaCache = path.join(userData, "formula-cache");
  const serviceDir = path.join(userData, "mineru-service");
  // 服务在跑时上传目录还被占着:跳过并如实告诉界面,不假装清干净了。
  if (running) return { ...clearMineruCaches([formulaCache]), skippedService: serviceDir };
  return { ...clearMineruCaches([formulaCache, serviceDir]), skippedService: "" };
});
ipcMain.handle("qbr:open-book-dialog", () => openBookDialog());
ipcMain.handle("qbr:open-path", (_event, target) => {
  const value = String(target || "");
  if (!value) return "";
  // The note view sends a vault-relative path; shell.openPath needs an
  // absolute one or it silently fails.
  const absolute = path.isAbsolute(value) ? value : path.resolve(vaultRoot, value);
  return shell.openPath(absolute);
});
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
ipcMain.handle("qbr:quiz:read-bank", (_event, target) => readQuizBank(target));
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

// Online book search and downloads: the renderer sends the configured sources,
// the main process reaches the network and writes files into the library.
ipcMain.handle("qbr:books:search", (event, payload = {}) => {
  const sender = event.sender;
  return bookDownloads.search(
    { sources: payload.sources || [], query: payload.query || "" },
    {
      // Each source's rows go to the renderer as they settle; requestId lets
      // the preload ignore updates from a superseded search.
      onSource: (update) => {
        if (sender.isDestroyed()) return;
        sender.send("qbr:books:search-source", { requestId: String(payload.requestId || ""), ...update });
      },
    },
  );
});
ipcMain.handle("qbr:books:download", (event, payload = {}) => {
  const sender = event.sender;
  const jobId = String(payload.jobId || "");
  return bookDownloads.download(jobId, payload.result || {}, {
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("qbr:books:event", { kind: "progress", ...progress });
    },
    onDone: (result) => {
      if (!sender.isDestroyed()) sender.send("qbr:books:event", { kind: "done", ...result });
    },
  });
});
ipcMain.handle("qbr:books:cancel", (_event, jobId) => bookDownloads.cancel(String(jobId || "")));
// Sign-in window for session-gated sources (Z-Library); settles on close so
// the renderer can re-run its search with the fresh cookies.
ipcMain.handle("qbr:books:login", (_event, payload = {}) => openBookLogin(String(payload.url || "")));
ipcMain.handle("qbr:books:session", (_event, url) => bookSessionReady(String(url || "")));

// Scanned-PDF text layer: the renderer sends the sidecar settings with every
// call; output files must stay inside the vault, sources may be absolute files
// opened from outside it.
ipcMain.handle("qbr:ocr:probe", (_event, settings) => pdfOcr.probe(settings || {}));
ipcMain.handle("qbr:ocr:start", (event, payload = {}) => {
  const sender = event.sender;
  const request = payload.request || {};
  const jobId = String(request.jobId || "");
  return pdfOcr.start(payload.settings || {}, {
    jobId,
    source: String(request.source || ""),
    out: resolveOcrOutput(vaultRoot, request.out),
    timeout: request.timeout,
  }, {
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("qbr:ocr:event", { kind: "progress", ...progress });
    },
    onDone: (result) => {
      if (!sender.isDestroyed()) sender.send("qbr:ocr:event", { kind: "done", ...result });
    },
  });
});
ipcMain.handle("qbr:ocr:cancel", (_event, jobId) => pdfOcr.cancel(String(jobId || "")));
// Hybrid phase 1: MinerU layout analysis, output kept inside the vault.
ipcMain.handle("qbr:ocr:text-source", (event, payload = {}) => {
  const sender = event.sender;
  const request = payload.request || {};
  const jobId = String(request.jobId || "");
  return pdfOcr.startTextSource(payload.settings || {}, {
    jobId,
    source: String(request.source || ""),
    out: resolveOcrOutput(vaultRoot, request.out),
    token: String(request.token || ""),
    force: Boolean(request.force),
    timeout: Number(request.timeout) || 0,
  }, {
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("qbr:ocr:event", { kind: "progress", ...progress });
    },
    onDone: (result) => {
      if (!sender.isDestroyed()) sender.send("qbr:ocr:event", { kind: "done", ...result });
    },
  });
});
// Reading sessions: lazy single-page text layers for a scanned PDF that is
// already open (one warm sidecar process per book).
ipcMain.handle("qbr:ocr:session", (_event, payload = {}) => {
  const action = String(payload.action || "");
  if (action === "open") return pdfOcr.openSession(payload.settings || {}, String(payload.source || ""), String(payload.textSource || ""));
  if (action === "page") return pdfOcr.page(payload.sessionId, payload.page, payload.options || {});
  if (action === "close") return pdfOcr.closeSession(payload.sessionId);
  throw new Error(`未知的 OCR 会话操作：${action}`);
});
// 书坊任务队列:列表 / 启动 / 取消 / 重试 / 清空历史;状态变化经
// qbr:workshop:state 推送(队列本身负责串行与历史落盘)。
ipcMain.handle("qbr:workshop:list", () => workshop.snapshot());
ipcMain.handle("qbr:workshop:start", (_event, request = {}) => workshop.start(request || {}));
ipcMain.handle("qbr:workshop:cancel", (_event, id) => workshop.cancel(String(id || "")));
ipcMain.handle("qbr:workshop:retry", (_event, id) => workshop.retry(String(id || "")));
ipcMain.handle("qbr:workshop:clear", () => {
  workshop.clearHistory();
  return workshop.snapshot();
});
// 书坊文件对话框:多选本地文件(打开后自动导入书库)。
ipcMain.handle("qbr:workshop:pick-files", async () => {
  const options = {
    title: "选择文件",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "文档与电子书", extensions: [...WORKSHOP_PICK_EXTENSIONS] },
      { name: "电子书", extensions: [...BOOK_EXTENSIONS] },
      { name: "所有文件", extensions: ["*"] },
    ],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
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
  app.on("before-quit", () => { pdfOcr.cancelAll(); bookDownloads.cancelAll(); closeBookSession(); mineruLocal.stop(); });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
