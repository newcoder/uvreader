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
    search: (payload) => ipcRenderer.invoke("qbr:books:search", payload),
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
