const { app, BrowserWindow, ipcMain, screen, Menu } = require("electron");

app.commandLine.appendSwitch("high-dpi-support", "1");
// loadFile 页面需允许加载 userData 下的 file:// 海报缓存
app.commandLine.appendSwitch("allow-file-access-from-files");
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
  report,
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
    const cache = {};
    mods = {
      get maoyan() {
        return (cache.maoyan ||= require("./maoyan-service"));
      },
      get settings() {
        return (cache.settings ||= require("./lib/settings"));
      },
      get windowSize() {
        return (cache.windowSize ||= require("./lib/window-size"));
      },
      get remoteSync() {
        return (cache.remoteSync ||= require("./lib/remote-sync"));
      },
      get adminServer() {
        return (cache.adminServer ||= require("./admin-server"));
      },
      get update() {
        return (cache.update ||= require("./lib/update"));
      },
      get autoStart() {
        return (cache.autoStart ||= require("./lib/auto-start"));
      },
      get updatePush() {
        return (cache.updatePush ||= require("./lib/update-push"));
      },
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

function persistResolvedWindowSize(size, liveOutput) {
  try {
    const { loadSettings, saveSettings } = getMods().settings;
    const cur = loadSettings().window || {};
    if (
      cur.width === size.width &&
      cur.height === size.height &&
      Boolean(cur.liveOutput) === Boolean(liveOutput)
    ) {
      return;
    }
    saveSettings({
      window: {
        width: size.width,
        height: size.height,
        liveOutput: Boolean(liveOutput),
      },
    });
  } catch {
    /* ignore */
  }
}

/** 始终锁定 9:16；liveOutput 固定 1080×1920 且不可拉宽/最大化 */
function lockWindowAspect(win, size, liveOutput) {
  if (!win || win.isDestroyed()) return;
  const { ASPECT_RATIO, MIN_WIDTH, MIN_HEIGHT } = getMods().windowSize;
  const ratio = ASPECT_RATIO || 9 / 16;

  win.setMinimumSize(liveOutput ? size.width : MIN_WIDTH || 360, liveOutput ? size.height : MIN_HEIGHT || 640);
  if (liveOutput) {
    win.setMaximumSize(size.width, size.height);
    win.setResizable(false);
  } else {
    // 解除 liveOutput 的锁高；仍靠 setAspectRatio 保持 9:16
    const work = screen.getPrimaryDisplay()?.workAreaSize || { width: 1920, height: 1080 };
    win.setMaximumSize(Math.max(work.width, 1200), Math.max(work.height, 1920));
    win.setResizable(true);
  }
  win.setMaximizable(false);
  win.setFullScreenable(false);
  win.setContentSize(size.width, size.height);
  win.setAspectRatio(ratio);
}

function applyWindowSettings(win) {
  if (!win) return;
  const { loadSettings } = getMods().settings;
  const { resolveWindowSize } = getMods().windowSize;
  const overlay = loadSettings();
  const w = overlay.window || {};
  const liveOutput = w.liveOutput === true;
  const size = resolveWindowSize(w.width, w.height, screen.getDisplayMatching(win.getBounds()), {
    liveOutput,
  });
  lockWindowAspect(win, size, liveOutput);
  persistResolvedWindowSize(size, liveOutput);
  win.setAlwaysOnTop(w.alwaysOnTop === true);
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
  const { resolveWindowSize, MIN_WIDTH, MIN_HEIGHT } = getMods().windowSize;
  const { confirmUpdateHealth } = getMods().update;
  const config = loadConfig();
  const winCfg = config.window || {};
  const liveOutput = winCfg.liveOutput === true;
  const size = resolveWindowSize(winCfg.width, winCfg.height, screen.getPrimaryDisplay(), {
    liveOutput,
  });
  // 启动时写回纠正后的 9:16，避免下次继续读到横向/错误比例
  persistResolvedWindowSize(size, liveOutput);

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: liveOutput ? size.width : MIN_WIDTH || 360,
    minHeight: liveOutput ? size.height : MIN_HEIGHT || 640,
    maxWidth: liveOutput ? size.width : undefined,
    maxHeight: liveOutput ? size.height : undefined,
    frame: false,
    autoHideMenuBar: true,
    title: "",
    transparent: winCfg.transparent === true,
    alwaysOnTop: winCfg.alwaysOnTop === true,
    resizable: !liveOutput,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    useContentSize: true,
    backgroundColor: winCfg.transparent === true ? "#00000000" : "#050a0b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      zoomFactor: 1,
    },
  });

  lockWindowAspect(mainWindow, size, liveOutput);
  mainWindow.setAlwaysOnTop(winCfg.alwaysOnTop === true);
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    mainWindow.webContents.setZoomFactor(1);
    // 文档 <title> 会写回窗口标题；无边框下不需要标题栏文字
    if (!mainWindow.isDestroyed()) mainWindow.setTitle("");
  });

  mainWindow.once("ready-to-show", async () => {
    splashController?.close();
    splashController = null;
    // show 后再锁一次，避免 Windows 在展示时丢掉 aspect / 尺寸
    lockWindowAspect(mainWindow, size, liveOutput);
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

  // 兜底：系统仍触发最大化时立刻还原为当前 9:16 内容尺寸
  mainWindow.on("maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.unmaximize();
    applyWindowSettings(mainWindow);
  });
  mainWindow.on("enter-full-screen", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(false);
    applyWindowSettings(mainWindow);
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
    console.log("[MAOYAN_STARTUP]", {
      stage: "already_ready",
      apiBase: current.apiBase,
      detailApiReady: Boolean(current.detailApiReady),
      loginRequired: Boolean(current.loginRequired),
    });
    return current;
  }

  if (servicePromise) return servicePromise;

  console.log("[MAOYAN_STARTUP]", { stage: "ensure_begin", apiBase: loadConfig().apiBase });
  servicePromise = ensureMaoyanService(loadConfig())
    .then((status) => {
      mainWindow?.webContents.send("api-ready", status);
      if (!status.ready) servicePromise = null;
      console.log("[MAOYAN_STARTUP]", {
        stage: status.ready ? "service_ready" : "service_fail",
        apiBase: status.apiBase,
        error: status.error || "",
        detailApiReady: Boolean(status.detailApiReady),
        loginRequired: Boolean(status.loginRequired),
      });
      return status;
    })
    .catch((err) => {
      servicePromise = null;
      const status = {
        ready: false,
        error: err?.message || "票房服务启动失败",
        apiBase: loadConfig().apiBase,
      };
      console.log("[MAOYAN_STARTUP]", {
        stage: "service_exception",
        apiBase: status.apiBase,
        error: status.error,
      });
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
  try {
    if (!servicePromise) {
      void startMaoyanService();
    }
  } catch (error) {
    console.error("启动票房服务失败:", error?.message || error);
  }

  if (config.remoteAdminUrl) {
    try {
      const { startRemoteSync } = getMods().remoteSync;
      startRemoteSync(config.remoteAdminUrl, notifySettingsChanged);
      console.log(`远程后台同步: ${config.remoteAdminUrl}`);
    } catch (error) {
      console.error("远程设置同步启动失败:", error?.message || error);
    }
    try {
      const { startUpdatePush } = getMods().updatePush;
      stopPushUpdate = startUpdatePush(config.remoteAdminUrl, updateManager, {
        log: (msg) => console.log(msg),
        intervalMs: 15000,
      });
    } catch (error) {
      console.error("云端更新推送启动失败:", error?.message || error);
    }
    try {
      startClientLogUpload(config.remoteAdminUrl);
    } catch (error) {
      console.error("客户端日志上报启动失败:", error?.message || error);
    }
    return;
  }

  // 延后拉起本地后台，避免与首屏抢 CPU
  setTimeout(() => {
    try {
      const { startAdminServer } = getMods().adminServer;
      startAdminServer({ onChange: notifySettingsChanged })
        .then((admin) => {
          try {
            const { startUpdatePush } = getMods().updatePush;
            stopPushUpdate = startUpdatePush(admin.url, updateManager, {
              log: (msg) => console.log(msg),
              intervalMs: 15000,
            });
          } catch (error) {
            console.error("本地更新推送启动失败:", error?.message || error);
          }
          startClientLogUpload(admin.url);
          console.log(`本地后台控制: ${admin.url}`);
        })
        .catch((e) => {
          console.error("后台服务启动失败", e.message);
        });
    } catch (error) {
      console.error("后台服务启动失败:", error?.message || error);
    }
  }, 3000);
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

function getPosterCacheDir() {
  return path.join(app.getPath("userData"), "poster-cache");
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
  ipcMain.handle("get-poster-cache-dir", () => getPosterCacheDir());
  ipcMain.handle("clear-poster-fail-cooldown", (_event, movieId) => {
    const { clearPosterFailureCooldown } = require("./lib/poster-resolver");
    return clearPosterFailureCooldown(movieId || "", { cacheDir: getPosterCacheDir() });
  });
  ipcMain.handle("resolve-posters", (_event, movies, options = {}) => {
    const { resolveMissingPosters } = require("./lib/poster-resolver");
    const opts = options && typeof options === "object" ? options : {};
    return resolveMissingPosters(Array.isArray(movies) ? movies : [], {
      cacheDir: getPosterCacheDir(),
      posterRetry: Boolean(opts.posterRetry),
      clearFailCooldown: Boolean(opts.clearFailCooldown),
      clearMovieId: opts.clearMovieId || "",
    });
  });
  ipcMain.handle("get-overlay-settings", () => loadSettings());
  ipcMain.handle("save-overlay-settings", (_event, patch) => {
    const saved = saveSettings(patch);
    notifySettingsChanged();
    return saved;
  });
  ipcMain.handle("get-api-status", () => getApiStatus());
  ipcMain.handle("ensure-api", () => startMaoyanService());
  ipcMain.handle("is-logged-in", () => isMaoyanLoggedIn());
  ipcMain.handle("get-session-status", async () => {
    const status = getMaoyanSessionStatus();
    const apiStatus = await getApiStatus().catch(() => null);
    if (apiStatus?.apiBase) {
      const { syncSessionStatusFromServer } = require("./lib/session-status");
      return syncSessionStatusFromServer(apiStatus.apiBase);
    }
    return status;
  });
  ipcMain.handle("report-session-api-error", (_event, code) => {
    const { reportSessionApiError } = require("./lib/session-status");
    return reportSessionApiError(code);
  });
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
    if (result?.ok && (result?.detailApiReady || result?.loginCookieReady)) {
      try {
        const { mergeSessionStatus } = require("./lib/session-status");
        const { getDataDir } = require("./maoyan-service");
        mergeSessionStatus(
          {
            storageStateExists: true,
            identityCookieExists: true,
            loginCookieReady: true,
            detailApiReady: Boolean(result.detailApiReady),
            browserSessionVerified: Boolean(result.detailApiReady),
            signatureReady: Boolean(result.detailApiReady),
            signatureCaptured: Boolean(result.detailApiReady),
            detailPayloadValid: Boolean(result.detailApiReady),
            accountLoggedIn: result.accountLoggedIn !== false,
            sessionUsable: Boolean(result.detailApiReady),
            loginRequired: false,
            lastVerifyError: result.detailApiReady ? null : "mtgsig_deferred",
            lastVerifyAt: new Date().toISOString(),
          },
          getDataDir(),
        );
      } catch {
        /* ignore */
      }
      const { getApiStatus } = getMods().maoyan;
      // 登录页已完成 detail 验签时，禁止立刻再 force 无头验签（换机易把票房服务打崩）
      if (!result.detailApiReady) {
        const { forceBackgroundVerify } = require("./lib/session-status");
        void getApiStatus().then((status) => {
          if (status.apiBase) forceBackgroundVerify(status.apiBase, require("./maoyan-service").getDataDir());
        });
      }
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
    // 彻底关闭 Electron 默认 File/Edit/View/Window/Help 菜单
    Menu.setApplicationMenu(null);
    ensureSplashVersionIpc();
    const appVersion = readAppVersionShort();
    const splashWindow = createStartupSplash(appVersion);
    splashController = createSplashController(splashWindow);
    splashController.send({ phase: "starting", message: "正在启动…", percent: 3, showBar: true });
    bindSplashReady(splashWindow, splashController);

    const lightConfig = loadLightConfig();
    const { UpdateManager } = require("./lib/update/manager");
    updateManager = new UpdateManager(lightConfig);

    const SPLASH_MAX_MS = 20_000;
    setTimeout(() => {
      if (!splashController) return;
      console.warn("启动页超时，强制进入主界面");
      splashController.close();
      splashController = null;
    }, SPLASH_MAX_MS);

    splashController.send({ phase: "loading", message: "正在加载主界面…", percent: 40, showBar: true });

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    initClientLogger({ appVersion: displayVersion(pkg.version).replace(/^v/, "") });
    if (lightConfig.remoteAdminUrl) {
      startClientLogUpload(lightConfig.remoteAdminUrl);
    }
    const { getRealExecutablePath, installDir } = require("./lib/update/paths");
    const exePath = getRealExecutablePath();
    const installPath = installDir();
    const userDataPath = app.getPath("userData");
    const appPath = app.getAppPath();
    console.log(`电影实时票房榜 ${displayVersion(pkg.version)} 启动`);
    console.log(`软件路径: ${exePath}`);
    console.log(`安装目录: ${installPath}`);
    console.log(`数据目录: ${userDataPath}`);
    console.log(`程序目录: ${appPath}`);
    report("info", "startup", `软件路径=${exePath}`);
    report("info", "startup", `安装目录=${installPath}`);
    report("info", "startup", `数据目录=${userDataPath}`);
    report("info", "startup", `程序目录=${appPath}`);

    registerIpcHandlers();

    const config = loadConfig();
    const startupT0 = Date.now();
    const logStartup = (stage) => {
      console.log("[STARTUP_TIMING]", `${stage} +${Date.now() - startupT0}ms`);
    };
    logStartup("service_start");
    void startMaoyanService().then((status) => {
      logStartup(status?.ready ? "service_ready" : "service_not_ready");
    });
    createWindow({
      onReadyToShow: () => {
        logStartup("main_window_visible");
        startBackgroundServices(config);
      },
    });
    logStartup("main_window_create");

    // A: 更新检查放到后台，不阻塞主窗口首屏
    setImmediate(() => {
      void (async () => {
        try {
          const updated = await checkAndDownloadUpdate(updateManager, {
            send: (payload) => splashController?.send?.(payload),
          });
          if (updated) return;
        } catch (error) {
          console.warn("后台更新检查失败:", error.message);
          updateManager?.endJob?.();
        }
      })();
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
      try {
        mods.remoteSync?.stopRemoteSync?.();
      } catch {
        /* ignore */
      }
      try {
        mods.adminServer?.stopAdminServer?.();
      } catch {
        /* ignore */
      }
      try {
        mods.maoyan?.shutdownMaoyanService?.();
      } catch {
        /* ignore */
      }
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
