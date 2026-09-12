const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getOverlaySettings: () => ipcRenderer.invoke("get-overlay-settings"),
  onSettingsChanged: (callback) => {
    const handler = (_event, settings) => callback(settings);
    ipcRenderer.on("settings-changed", handler);
    return () => ipcRenderer.removeListener("settings-changed", handler);
  },
  getApiStatus: () => ipcRenderer.invoke("get-api-status"),
  ensureApi: () => ipcRenderer.invoke("ensure-api"),
  isLoggedIn: () => ipcRenderer.invoke("is-logged-in"),
  startLogin: () => ipcRenderer.invoke("start-login"),
  onApiReady: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("api-ready", handler);
    return () => ipcRenderer.removeListener("api-ready", handler);
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
});
