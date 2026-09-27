// Persistent browser session for book sources that need a login (Z-Library).
// One partition holds the cookies; a visible window lets the reader sign in,
// and `sessionFetch` gives the download queue a fetch-like client on the same
// session so the whole flow can never touch the reader's own web contents.
import { BrowserWindow, net, session as electronSession } from "electron";

export const BOOK_SESSION_PARTITION = "persist:qbr-books";

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

export function closeBookSession() {
  try { loginWindow?.destroy(); } catch { /* already gone */ }
  loginWindow = null;
  const resolvers = loginResolvers;
  loginResolvers = [];
  for (const settle of resolvers) settle({ ok: true, closed: true });
}
