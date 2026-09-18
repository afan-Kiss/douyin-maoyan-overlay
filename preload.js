const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getPosterCacheDir: () => ipcRenderer.invoke("get-poster-cache-dir"),
  resolvePosters: (movies) => ipcRenderer.invoke("resolve-posters", movies),
  getOverlaySettings: () => ipcRenderer.invoke("get-overlay-settings"),
  onSettingsChanged: (callback) => {
    const handler = (_event, settings) => callback(settings);
    ipcRenderer.on("settings-changed", handler);
    return () => ipcRenderer.removeListener("settings-changed", handler);
  },
  getApiStatus: () => ipcRenderer.invoke("get-api-status"),
  ensureApi: () => ipcRenderer.invoke("ensure-api"),
  isLoggedIn: () => ipcRenderer.invoke("is-logged-in"),
  getSessionStatus: () => ipcRenderer.invoke("get-session-status"),
  reportSessionApiError: (code) => ipcRenderer.invoke("report-session-api-error", code),
  isLoginRunning: () => ipcRenderer.invoke("is-login-running"),
  startLogin: (options) => ipcRenderer.invoke("start-login", options),
  onLoginResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on("login-result", handler);
    return () => ipcRenderer.removeListener("login-result", handler);
  },
  onApiReady: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("api-ready", handler);
    return () => ipcRenderer.removeListener("api-ready", handler);
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
});
