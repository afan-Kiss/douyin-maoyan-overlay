const { app, BrowserWindow, ipcMain, screen } = require("electron");

app.commandLine.appendSwitch("high-dpi-support", "1");
const fs = require("fs");
const path = require("path");
const { ensureSingleInstance } = require("./lib/single-instance");
const {
  createStartupSplash,
  createSplashController,
  checkAndDownloadUpdate,
  bindSplashReady,
} = require("./lib/startup-splash");
const { displayVersion } = require("./lib/update/version");
const {
  initClientLogger,
  startLogUpload,
  stopLogUpload,
} = require("./lib/client-logger");

const CONFIG_PATH = path.join(__dirname, "config.json");

let splashVersionIpcReady = false;

function readAppVersionShort() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    return displayVersion(pkg.version || "1.0.0").replace(/^v/, "");
  } catch {
    return "1.0";
  }
}

function ensureSplashVersionIpc() {
  if (splashVersionIpcReady) return;
  splashVersionIpcReady = true;
  ipcMain.handle("splash-get-version", () => readAppVersionShort());
}

let mods = null;
let mainWindow = null;
let splashController = null;
let servicePromise = null;
let stopPushUpdate = null;
let stopClientLogUpload = null;
let activeLogUploadUrl = "";
let updateManager = null;

function getMods() {
  if (!mods) {
    mods = {
      maoyan: require("./maoyan-service"),
      settings: require("./lib/settings"),
      windowSize: require("./lib/window-size"),
      remoteSync: require("./lib/remote-sync"),
      adminServer: require("./admin-server"),
      update: require("./lib/update"),
      autoStart: require("./lib/auto-start"),
      updatePush: require("./lib/update-push"),
    };
  }
  return mods;
}

function loadLightConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return {
      updateServerUrl: config.updateServerUrl || "https://xiangyuzhubao.xyz",
      remoteAdminUrl: config.remoteAdminUrl || "",
    };
  } catch {
    return {
      updateServerUrl: "https://xiangyuzhubao.xyz",
      remoteAdminUrl: "",
    };
  }
}

function loadConfig() {
  const { loadSettings } = getMods().settings;
  const { buildApiBase } = getMods().maoyan;
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
  const { loadSettings } = getMods().settings;
  const { resolveWindowSize } = getMods().windowSize;
  const overlay = loadSettings();
  const w = overlay.window || {};
  const size = resolveWindowSize(w.width, w.height, screen.getDisplayMatching(win.getBounds()), {
    liveOutput: w.liveOutput === true,
  });
  win.setContentSize(size.width, size.height);
  win.setAlwaysOnTop(false);
  win.webContents.send("window-mode-changed", {
    liveOutput: size.liveOutput === true,
    contentWidth: size.width,
    contentHeight: size.height,
  });
}

function notifySettingsChanged() {
  const { loadSettings } = getMods().settings;
  const overlay = loadSettings();
  mainWindow?.webContents.send("settings-changed", overlay);
  applyWindowSettings(mainWindow);
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ onReadyToShow } = {}) {
  const { resolveWindowSize } = getMods().windowSize;
  const { confirmUpdateHealth } = getMods().update;
  const config = loadConfig();
  const winCfg = config.window || {};
  const size = resolveWindowSize(winCfg.width, winCfg.height, null, {
    liveOutput: winCfg.liveOutput === true,
  });

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 360,
    minHeight: 400,
    frame: false,
    transparent: winCfg.transparent === true,
    alwaysOnTop: false,
    resizable: true,
    hasShadow: true,
    useContentSize: true,
    backgroundColor: winCfg.transparent === true ? "#00000000" : "#050a0b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1,
    },
  });

  mainWindow.setContentSize(size.width, size.height);
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    mainWindow.webContents.setZoomFactor(1);
  });

  mainWindow.once("ready-to-show", async () => {
    splashController?.close();
    splashController = null;
    mainWindow.show();
    onReadyToShow?.();
    try {
      if (await confirmUpdateHealth()) {
        console.log("更新健康确认完成，已清理备份");
      }
    } catch (error) {
      console.warn("更新健康确认失败:", error.message);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      app.quit();
    }
  });
}

async function startMaoyanService() {
  const { getApiStatus, ensureMaoyanService } = getMods().maoyan;
  const current = await getApiStatus();
  if (current.ready) {
    return current;
  }

  if (servicePromise) return servicePromise;

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

function startClientLogUpload(baseUrl) {
  const next = String(baseUrl || "").trim();
  if (!next) return;
  if (activeLogUploadUrl === next && stopClientLogUpload) return;
  if (stopClientLogUpload) {
    stopClientLogUpload().catch(() => {});
  }
  activeLogUploadUrl = next;
  stopClientLogUpload = startLogUpload(next);
}

function startBackgroundServices(config) {
  const { startRemoteSync } = getMods().remoteSync;
  const { startAdminServer } = getMods().adminServer;
  const { startUpdatePush } = getMods().updatePush;

  if (!servicePromise) {
    void startMaoyanService();
  }

  if (config.remoteAdminUrl) {
    startRemoteSync(config.remoteAdminUrl, notifySettingsChanged);
    stopPushUpdate = startUpdatePush(config.remoteAdminUrl, updateManager, {
      log: (msg) => console.log(msg),
    });
    startClientLogUpload(config.remoteAdminUrl);
    console.log(`远程后台同步: ${config.remoteAdminUrl}`);
    return;
  }

  startAdminServer({ onChange: notifySettingsChanged })
    .then((admin) => {
      stopPushUpdate = startUpdatePush(admin.url, updateManager, {
        log: (msg) => console.log(msg),
      });
      startClientLogUpload(admin.url);
      console.log(`本地后台控制: ${admin.url}`);
    })
    .catch((e) => {
      console.error("后台服务启动失败", e.message);
    });
}

function scheduleAutoStartRegistration() {
  const { ensureAutoStart } = getMods().autoStart;
  setImmediate(() => {
    try {
      const autoStart = ensureAutoStart();
      if (autoStart.ok && !autoStart.already) {
        console.log(`已注册开机自启动: ${autoStart.command || autoStart.label}`);
      }
    } catch (error) {
      console.warn("注册自启动失败:", error.message);
    }
  });
}

function registerIpcHandlers() {
  if (ipcMain.listenerCount("window-minimize") > 0) return;
  const { loadSettings, saveSettings } = getMods().settings;
  const {
    getApiStatus,
    isMaoyanLoggedIn,
    getMaoyanSessionStatus,
    startMaoyanLogin,
  } = getMods().maoyan;

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
  ipcMain.handle("get-session-status", () => getMaoyanSessionStatus());
  ipcMain.handle("is-login-running", () => {
    const { isLoginRunning } = require("./lib/maoyan-login");
    return isLoginRunning();
  });
  ipcMain.handle("start-login", (event, options = {}) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return startMaoyanLogin({ parentWindow, ...options });
  });
  const { onLoginResult } = require("./lib/maoyan-login");
  onLoginResult((result) => {
    if (result?.ok && result?.detailApiReady) {
      const { getApiStatus } = getMods().maoyan;
      const { forceBackgroundVerify } = require("./lib/session-status");
      void getApiStatus().then((status) => {
        if (status.apiBase) forceBackgroundVerify(status.apiBase, require("./maoyan-service").getDataDir());
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("login-result", result);
    }
  });
  ensureSplashVersionIpc();

  ipcMain.on("window-minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.on("window-close", () => {
    app.quit();
  });
}

if (!ensureSingleInstance({ onSecondInstance: focusMainWindow })) {
  // 第二个实例会弹窗提示并退出
} else {
  app.whenReady().then(async () => {
    ensureSplashVersionIpc();
    const appVersion = readAppVersionShort();
    const splashWindow = createStartupSplash(appVersion);
    splashController = createSplashController(splashWindow);
    splashController.send({ phase: "starting", message: "正在启动…", percent: 3, showBar: true });
    bindSplashReady(splashWindow, splashController);

    const lightConfig = loadLightConfig();
    const { UpdateManager } = require("./lib/update/manager");
    updateManager = new UpdateManager(lightConfig);
    splashController.send({ phase: "checking", message: "正在检查更新…", percent: 8, showBar: true });

    const SPLASH_MAX_MS = 45_000;
    setTimeout(() => {
      if (!splashController) return;
      console.warn("启动页超时，强制进入主界面");
      splashController.close();
      splashController = null;
    }, SPLASH_MAX_MS);

    const UPDATE_CHECK_TIMEOUT_MS = 15_000;
    let updated = false;
    try {
      updated = await Promise.race([
        checkAndDownloadUpdate(updateManager, splashController),
        new Promise((resolve) => {
          setTimeout(() => {
            console.warn("更新检查超时，跳过并进入主程序");
            updateManager?.endJob?.();
            splashController.send({
              phase: "loading",
              message: "正在加载主界面…",
              percent: 92,
              showBar: true,
            });
            resolve(false);
          }, UPDATE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.warn("更新检查失败:", error.message);
      updateManager?.endJob?.();
      updated = false;
    }
    if (updated) return;

    splashController.send({ phase: "loading", message: "正在加载主界面…", percent: 92, showBar: true });

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    initClientLogger({ appVersion: displayVersion(pkg.version).replace(/^v/, "") });
    if (lightConfig.remoteAdminUrl) {
      startClientLogUpload(lightConfig.remoteAdminUrl);
    }
    console.log(`电影实时票房榜 ${displayVersion(pkg.version)} 启动`);

    getMods();
    registerIpcHandlers();

    const config = loadConfig();
    void startMaoyanService();
    createWindow({ onReadyToShow: () => startBackgroundServices(config) });
    scheduleAutoStartRegistration();

    setImmediate(() => {
      try {
        getMods().update.prepareUpdateEnvironmentEarly();
      } catch (error) {
        console.warn("更新环境初始化失败:", error.message);
      }
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    stopPushUpdate?.();
    stopPushUpdate = null;
    const stopLogs = stopClientLogUpload;
    stopClientLogUpload = null;
    activeLogUploadUrl = "";
    if (typeof stopLogs === "function") {
      stopLogs().catch(() => {});
    }
    if (mods) {
      mods.remoteSync.stopRemoteSync();
      mods.adminServer.stopAdminServer();
      mods.maoyan.shutdownMaoyanService();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      getMods();
      registerIpcHandlers();
      const config = loadConfig();
      createWindow();
      startBackgroundServices(config);
    }
  });
}
