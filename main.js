const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const {
  ensureMaoyanService,
  getApiStatus,
  shutdownMaoyanService,
  isMaoyanLoggedIn,
  startMaoyanLogin,
  buildApiBase,
} = require("./maoyan-service");
const { loadSettings, saveSettings } = require("./lib/settings");
const { resolveWindowSize } = require("./lib/window-size");
const { startRemoteSync, stopRemoteSync } = require("./lib/remote-sync");
const { startAdminServer, stopAdminServer } = require("./admin-server");
const { UpdateManager, currentVersionDisplay } = require("./lib/update");
const { ensureAutoStart } = require("./lib/auto-start");
const { startUpdatePush, stopUpdatePush } = require("./lib/update-push");

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  const overlay = loadSettings();
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    config.apiBase = buildApiBase(config);
    config.pollIntervalMs = overlay.pollIntervalMs;
    config.topCount = overlay.topCount;
    config.window = { ...config.window, ...overlay.window };
    config.overlay = overlay;
    config.remoteAdminUrl = config.remoteAdminUrl || "";
    config.updateServerUrl = config.updateServerUrl || "https://xiangyuzhubao.xyz";
    return config;
  } catch {
    const fallback = {
      apiBase: "http://127.0.0.1:8765",
      pollIntervalMs: overlay.pollIntervalMs,
      topCount: overlay.topCount,
      window: overlay.window,
      overlay,
      remoteAdminUrl: "",
      updateServerUrl: "https://xiangyuzhubao.xyz",
    };
    fallback.apiBase = buildApiBase(fallback);
    return fallback;
  }
}

function applyWindowSettings(win) {
  if (!win) return;
  const overlay = loadSettings();
  const w = overlay.window || {};
  const size = resolveWindowSize(w.width, w.height, screen.getDisplayMatching(win.getBounds()));
  win.setSize(size.width, size.height);
  win.setAlwaysOnTop(Boolean(w.alwaysOnTop));
}

function notifySettingsChanged() {
  const overlay = loadSettings();
  mainWindow?.webContents.send("settings-changed", overlay);
  applyWindowSettings(mainWindow);
}

let mainWindow = null;
let servicePromise = null;
let stopPushUpdate = null;

function createWindow() {
  const config = loadConfig();
  const winCfg = config.window || {};
  const size = resolveWindowSize(winCfg.width, winCfg.height);

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 360,
    minHeight: 400,
    frame: false,
    transparent: winCfg.transparent === true,
    alwaysOnTop: Boolean(winCfg.alwaysOnTop),
    resizable: true,
    hasShadow: true,
    backgroundColor: winCfg.transparent === true ? "#00000000" : "#050a0b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startMaoyanService() {
  const current = await getApiStatus();
  if (current.ready) {
    return current;
  }

  servicePromise = null;

  servicePromise = ensureMaoyanService(loadConfig())
    .then((status) => {
      mainWindow?.webContents.send("api-ready", status);
      if (!status.ready) servicePromise = null;
      return status;
    })
    .catch((err) => {
      servicePromise = null;
      const status = {
        ready: false,
        error: err?.message || "票房服务启动失败",
        apiBase: loadConfig().apiBase,
      };
      mainWindow?.webContents.send("api-ready", status);
      return status;
    });

  return servicePromise;
}

ipcMain.handle("get-config", () => loadConfig());
ipcMain.handle("get-overlay-settings", () => loadSettings());
ipcMain.handle("save-overlay-settings", (_event, patch) => {
  const saved = saveSettings(patch);
  notifySettingsChanged();
  return saved;
});
ipcMain.handle("get-api-status", () => getApiStatus());
ipcMain.handle("ensure-api", () => startMaoyanService());
ipcMain.handle("is-logged-in", () => isMaoyanLoggedIn());
ipcMain.handle("start-login", () => startMaoyanLogin());

ipcMain.on("window-minimize", () => {
  mainWindow?.minimize();
});

ipcMain.on("window-close", () => {
  app.quit();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const config = loadConfig();
    console.log(`猫眼票房展示 ${currentVersionDisplay()} 启动`);

    try {
      const autoStart = ensureAutoStart();
      if (autoStart.ok && !autoStart.already) {
        console.log(`已注册开机自启动: ${autoStart.command || autoStart.label}`);
      }
    } catch (error) {
      console.warn("注册自启动失败:", error.message);
    }

    const updateManager = new UpdateManager(config);
    setTimeout(async () => {
      try {
        const updated = await updateManager.autoUpdateIfNeeded();
        if (updated) return;
      } catch (error) {
        console.warn("自动更新检查失败:", error.message);
      }
    }, 2000);

    createWindow();
    startMaoyanService();
    if (config.remoteAdminUrl) {
      startRemoteSync(config.remoteAdminUrl, notifySettingsChanged);
      stopPushUpdate = startUpdatePush(config.remoteAdminUrl, updateManager, {
        log: (msg) => console.log(msg),
      });
      console.log(`远程后台同步: ${config.remoteAdminUrl}`);
    } else {
      try {
        const admin = await startAdminServer({ onChange: notifySettingsChanged });
        stopPushUpdate = startUpdatePush(admin.url, updateManager, {
          log: (msg) => console.log(msg),
        });
        console.log(`本地后台控制: ${admin.url}`);
      } catch (e) {
        console.error("后台服务启动失败", e.message);
      }
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    stopPushUpdate?.();
    stopPushUpdate = null;
    stopRemoteSync();
    stopAdminServer();
    shutdownMaoyanService();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      startMaoyanService();
    }
  });
}
