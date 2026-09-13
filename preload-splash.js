const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("splashApi", {
  getVersion: () => ipcRenderer.invoke("splash-get-version"),
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("splash-progress", handler);
    return () => ipcRenderer.removeListener("splash-progress", handler);
  },
});
