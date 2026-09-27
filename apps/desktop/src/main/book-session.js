// Persistent browser session for book sources that need a login (Z-Library).
// One partition holds the cookies; a visible window lets the reader sign in,
// and `sessionFetch` gives the download queue a fetch-like client on the same
// session so the whole flow can never touch the reader's own web contents.
import { BrowserWindow, net, session as electronSession } from "electron";

export const BOOK_SESSION_PARTITION = "persist:qbr-books";

function log(...args) {
  try { console.error("[qbr-books]", ...args); } catch { /* stderr may be gone */ }
}

function bookSession() {
  return electronSession.fromPartition(BOOK_SESSION_PARTITION);
}

function headerLookup(headers, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return null;
}

function aborted() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

// fetch-like wrapper over Electron's net stack, bound to the book session.
export function sessionFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: options.method || "GET",
      url: String(url),
      redirect: "follow",
      session: bookSession(),
    });
    if (options.signal) {
      if (options.signal.aborted) {
        try { request.abort(); } catch { /* never started */ }
        reject(aborted());
        return;
      }
      options.signal.addEventListener("abort", () => { try { request.abort(); } catch { /* gone */ } }, { once: true });
    }
    request.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    // Aborting before the response arrives emits "abort", not "error"; without
    // this the promise never settles and the search IPC reply is never sent.
    request.on("abort", () => reject(aborted()));
    request.on("response", (response) => {
      const status = Number(response.statusCode) || 0;
      const queue = [];
      const readers = [];
      let ended = false;
      let failure = null;
      const wake = () => { if (readers.length) readers.shift()(); };
      response.on("data", (chunk) => { queue.push(Buffer.from(chunk)); wake(); });
      response.on("end", () => { ended = true; wake(); });
      response.on("aborted", () => { failure ||= aborted(); ended = true; wake(); });
      response.on("error", (error) => { failure = error; ended = true; wake(); });
      const read = async () => {
        for (;;) {
          if (queue.length) return { done: false, value: queue.shift() };
          if (failure) throw failure;
          if (ended) return { done: true, value: undefined };
          await new Promise((settle) => readers.push(settle));
        }
      };
      const drain = async () => {
        const chunks = [];
        for (;;) {
          const { done, value } = await read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
      };
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headerLookup(response.headers, name) },
        body: { getReader: () => ({ read, cancel: async () => { try { request.abort(); } catch { /* gone */ } } }) },
        async arrayBuffer() { return drain(); },
        async text() { return (await drain()).toString("utf8"); },
        async json() { return JSON.parse((await drain()).toString("utf8")); },
      });
    });
    request.end();
  });
}

// True once the partition holds cookies for the URL (i.e. a login happened).
export async function bookSessionReady(url) {
  try {
    const cookies = await bookSession().cookies.get({ url: String(url) });
    return Array.isArray(cookies) && cookies.length > 0;
  } catch {
    return false;
  }
}

let loginWindow = null;
let loginResolvers = [];

// Opens the source's page in a normal window sharing the book session; the
// promise settles when the reader closes it, so callers can refresh after.
export function openBookLogin(url, { parent = null } = {}) {
  return new Promise((resolve) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginResolvers.push(resolve);
      loginWindow.loadURL(String(url)).catch(() => {});
      try { loginWindow.focus(); } catch { /* gone */ }
      return;
    }
    const win = new BrowserWindow({
      width: 1040,
      height: 780,
      parent: parent || undefined,
      autoHideMenuBar: true,
      title: "登录书籍来源",
      backgroundColor: "#ffffff",
      webPreferences: {
        partition: BOOK_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    loginWindow = win;
    loginResolvers = [resolve];
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      win.loadURL(String(target)).catch(() => {});
      return { action: "deny" };
    });
    win.on("closed", () => {
      loginWindow = null;
      const resolvers = loginResolvers;
      loginResolvers = [];
      for (const settle of resolvers) settle({ ok: true, closed: true });
    });
    win.loadURL(String(url)).catch(() => {});
  });
}

// Z-Library answers plain HTTP clients with a "Checking your browser" proof of
// work (503); only a real renderer passes it and keeps the clearance. A hidden
// window on the same partition loads pages and runs browser downloads, with
// one operation at a time so a single window is enough.
let pageWindow = null;
let pageQueue = Promise.resolve();

function bookPageWindow() {
  if (pageWindow && !pageWindow.isDestroyed()) return pageWindow;
  pageWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: BOOK_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  pageWindow.on("closed", () => { pageWindow = null; });
  return pageWindow;
}

function loadBookPage(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawChallenge = false;
    const started = Date.now();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.off?.("did-fail-load", onFail);
      error ? reject(error) : resolve();
    };
    const poll = () => {
      if (settled) return;
      const title = String(win.webContents.getTitle?.() || "");
      if (title && !/checking your browser/i.test(title)) {
        if (sawChallenge) log("zlib challenge passed");
        // Let late slots/scripts fill in before the DOM is read.
        setTimeout(() => finish(null), 600);
        return;
      }
      if (/checking your browser/i.test(title)) sawChallenge = true;
      if (Date.now() - started > timeoutMs) {
        finish(new Error("页面加载超时（未能通过来源验证）"));
        return;
      }
      setTimeout(poll, 600);
    };
    const timer = setTimeout(() => finish(new Error("页面加载超时")), timeoutMs + 2000);
    const onFail = (_event, code, description) => finish(new Error(`页面加载失败（${code} ${description || ""}）`));
    win.webContents.on("did-fail-load", onFail);
    win.loadURL(String(url)).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    setTimeout(poll, 800);
  });
}

// Loads a page in the hidden renderer and returns its final DOM.
export function fetchBookPage(url, { timeout = 30000 } = {}) {
  const run = async () => {
    const win = bookPageWindow();
    await loadBookPage(win, String(url), timeout);
    const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML", true);
    return String(html || "");
  };
  const result = pageQueue.then(run, run);
  pageQueue = result.catch(() => {});
  return result;
}

// Runs a browser download in the hidden renderer: the session holds the
// challenge clearance, so the file comes down exactly as in a real browser.
export function downloadBookFile(url, target, { onProgress = null, timeout = 240000 } = {}) {
  const run = () => new Promise((resolve, reject) => {
    const win = bookPageWindow();
    const ses = win.webContents.session;
    let settled = false;
    let item = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ses.off("will-download", onWillDownload); } catch { /* gone */ }
      error ? reject(error) : resolve({ ok: true });
    };
    const timer = setTimeout(() => { try { item?.cancel(); } catch { /* gone */ } finish(new Error("下载超时")); }, timeout);
    const onWillDownload = (_event, downloadItem) => {
      if (item) return;
      item = downloadItem;
      try { downloadItem.setSavePath(String(target)); } catch { /* the done handler reports it */ }
      downloadItem.on("updated", (_e, state) => {
        if (state !== "progressing") return;
        onProgress?.({ received: downloadItem.getReceivedBytes(), total: downloadItem.getTotalBytes() });
      });
      downloadItem.once("done", (_e, state) => {
        if (state === "completed") finish(null);
        else finish(new Error(state === "cancelled" ? "已取消" : "下载失败"));
      });
    };
    ses.on("will-download", onWillDownload);
    win.webContents.downloadURL(String(url));
  });
  const result = pageQueue.then(run, run);
  pageQueue = result.catch(() => {});
  return result;
}

export function closeBookSession() {
  try { loginWindow?.destroy(); } catch { /* already gone */ }
  loginWindow = null;
  try { pageWindow?.destroy(); } catch { /* already gone */ }
  pageWindow = null;
  const resolvers = loginResolvers;
  loginResolvers = [];
  for (const settle of resolvers) settle({ ok: true, closed: true });
}
