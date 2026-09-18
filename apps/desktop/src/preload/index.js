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
  },
};
