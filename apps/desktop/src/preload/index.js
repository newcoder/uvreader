import { ipcRenderer, webUtils } from "electron";

window.qbrDesktop = {
  paths: {
    dataRoot: process.env.QBR_DATA_ROOT || "",
    vaultRoot: process.env.QBR_VAULT_ROOT || "",
  },
  smoke: process.env.QBR_SMOKE === "1",
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return file?.path || "";
    }
  },
  getLaunchFile: () => ipcRenderer.invoke("qbr:launch-file"),
  openBookDialog: () => ipcRenderer.invoke("qbr:open-book-dialog"),
  openPath: (target) => ipcRenderer.invoke("qbr:open-path", target),
  reportBoot: (payload) => ipcRenderer.invoke("qbr:boot", payload),
  onOpenBook: (callback) => {
    ipcRenderer.on("qbr:open-book", (_event, filePath) => callback(filePath));
  },
  showItemInFolder: (filePath) => ipcRenderer.invoke("qbr:show-item", filePath),
  secrets: {
    getSecret: (id) => ipcRenderer.invoke("qbr:secret", "get", id),
    getSecretSync: (id) => ipcRenderer.sendSync("qbr:secret-sync", id),
    setSecret: (id, value) => ipcRenderer.invoke("qbr:secret", "set", id, value),
    deleteSecret: (id) => ipcRenderer.invoke("qbr:secret", "delete", id),
    listSecrets: () => ipcRenderer.invoke("qbr:secret", "list"),
  },
  books: {
    search: (payload, onSource) => {
      if (typeof onSource !== "function") return ipcRenderer.invoke("qbr:books:search", payload);
      const requestId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const listener = (_event, message) => {
        if (message?.requestId !== requestId) return;
        onSource(message);
      };
      ipcRenderer.on("qbr:books:search-source", listener);
      return ipcRenderer.invoke("qbr:books:search", { ...payload, requestId }).finally(() => {
        ipcRenderer.removeListener("qbr:books:search-source", listener);
      });
    },
    download: (payload, onEvent) => {
      const listener = (_event, message) => {
        if (message?.jobId !== payload?.jobId) return;
        if (typeof onEvent === "function") onEvent(message);
        if (message.kind === "done") ipcRenderer.removeListener("qbr:books:event", listener);
      };
      ipcRenderer.on("qbr:books:event", listener);
      return ipcRenderer.invoke("qbr:books:download", payload).catch((error) => {
        ipcRenderer.removeListener("qbr:books:event", listener);
        throw error;
      });
    },
    cancel: (jobId) => ipcRenderer.invoke("qbr:books:cancel", jobId),
    login: (url) => ipcRenderer.invoke("qbr:books:login", { url }),
    session: (url) => ipcRenderer.invoke("qbr:books:session", url),
  },
  ocr: {
    probe: (settings) => ipcRenderer.invoke("qbr:ocr:probe", settings),
    start: (payload, onEvent) => {
      const listener = (_event, message) => {
        if (message?.jobId !== payload?.request?.jobId) return;
        if (typeof onEvent === "function") onEvent(message);
        if (message.kind === "done") ipcRenderer.removeListener("qbr:ocr:event", listener);
      };
      ipcRenderer.on("qbr:ocr:event", listener);
      return ipcRenderer.invoke("qbr:ocr:start", payload).catch((error) => {
        ipcRenderer.removeListener("qbr:ocr:event", listener);
        throw error;
      });
    },
    cancel: (jobId) => ipcRenderer.invoke("qbr:ocr:cancel", jobId),
    session: (payload) => ipcRenderer.invoke("qbr:ocr:session", payload),
    // The invoke resolves as soon as the job starts, so the listener must stay
    // until the terminal "done" event (or a rejected start).
    textSource: (payload, onEvent) => {
      const listener = (_event, message) => {
        if (message?.jobId !== payload?.request?.jobId) return;
        if (typeof onEvent === "function") onEvent(message);
        if (message.kind === "done") ipcRenderer.removeListener("qbr:ocr:event", listener);
      };
      ipcRenderer.on("qbr:ocr:event", listener);
      return ipcRenderer.invoke("qbr:ocr:text-source", payload).catch((error) => {
        ipcRenderer.removeListener("qbr:ocr:event", listener);
        throw error;
      });
    },
  },
  mineru: {
    status: (settings) => ipcRenderer.invoke("qbr:mineru:status", settings),
    ensure: (settings) => ipcRenderer.invoke("qbr:mineru:ensure", settings),
    stop: () => ipcRenderer.invoke("qbr:mineru:stop"),
    clearCaches: (settings) => ipcRenderer.invoke("qbr:mineru:clear-cache", settings),
    path: (settings) => ipcRenderer.invoke("qbr:mineru:path", settings),
  },
  // 设置页里的链路探测:直接返回结果,不入任务队列。
  probe: {
    ocr: (settings) => ipcRenderer.invoke("qbr:probe:ocr", settings),
    docvortex: (settings) => ipcRenderer.invoke("qbr:probe:docvortex", settings),
    formula: (settings) => ipcRenderer.invoke("qbr:probe:formula", settings),
    calibre: (settings) => ipcRenderer.invoke("qbr:probe:calibre", settings),
    engine: (settings) => ipcRenderer.invoke("qbr:probe:engine", settings),
  },
  // 书坊引擎自己的配置(单一来源在引擎):应用只做 UI。
  engine: {
    config: (settings) => ipcRenderer.invoke("qbr:engine:config", settings),
    saveConfig: (settings, patch) => ipcRenderer.invoke("qbr:engine:save-config", { settings, patch }),
  },
  workshop: {
    list: () => ipcRenderer.invoke("qbr:workshop:list"),
    start: (request) => ipcRenderer.invoke("qbr:workshop:start", request),
    cancel: (id) => ipcRenderer.invoke("qbr:workshop:cancel", id),
    retry: (id) => ipcRenderer.invoke("qbr:workshop:retry", id),
    clear: () => ipcRenderer.invoke("qbr:workshop:clear"),
    pickFiles: () => ipcRenderer.invoke("qbr:workshop:pick-files"),
    // Returns an unsubscribe function so a closed view stops listening.
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("qbr:workshop:state", listener);
      return () => ipcRenderer.removeListener("qbr:workshop:state", listener);
    },
  },
  ai: {
    stream: (payload, onEvent) => {
      const listener = (_event, message) => {
        if (message?.requestId === payload?.requestId && typeof onEvent === "function") onEvent(message);
      };
      ipcRenderer.on("qbr:ai:event", listener);
      return ipcRenderer.invoke("qbr:ai:stream", payload).finally(() => {
        ipcRenderer.removeListener("qbr:ai:event", listener);
      });
    },
    abort: (requestId) => ipcRenderer.invoke("qbr:ai:abort", requestId),
    test: (config) => ipcRenderer.invoke("qbr:ai:test", config),
    probe: (payload) => ipcRenderer.invoke("qbr:ai:probe", payload),
    pickFiles: () => ipcRenderer.invoke("qbr:ai:pick-files"),
    readFile: (target) => ipcRenderer.invoke("qbr:ai:read-file", target),
    captureRegion: (rect) => ipcRenderer.invoke("qbr:ai:capture-region", rect),
  },
};
