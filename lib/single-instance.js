const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");

const APP_DIR_NAME = "MaoyanOverlay";

function getLockPath() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
  return path.join(base, APP_DIR_NAME, "instance.lock");
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath) {
  try {
    if (!fs.existsSync(lockPath)) return 0;
    return parseInt(String(fs.readFileSync(lockPath, "utf-8")).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function acquireFileLock() {
  const lockPath = getLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const existingPid = readLockPid(lockPath);
    if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
      return false;
    }
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock() {
  const lockPath = getLockPath();
  try {
    if (!fs.existsSync(lockPath)) return;
    const existingPid = readLockPid(lockPath);
    if (existingPid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
  }
}

function notifyAlreadyRunning() {
  if (!app?.whenReady) {
    process.exit(0);
    return;
  }
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: "info",
      title: "电影实时票房榜",
      message: "程序已在运行中",
      detail: "请勿重复打开。若窗口被最小化，请从任务栏切换回来。",
      buttons: ["确定"],
      noLink: true,
    });
    app.quit();
  });
}

function ensureSingleInstance({ onSecondInstance } = {}) {
  const electronApp = typeof app === "object" && app ? app : null;
  const gotElectronLock = electronApp?.requestSingleInstanceLock
    ? electronApp.requestSingleInstanceLock()
    : true;
  if (!gotElectronLock) {
    notifyAlreadyRunning();
    return false;
  }

  if (!acquireFileLock()) {
    electronApp?.releaseSingleInstanceLock?.();
    notifyAlreadyRunning();
    return false;
  }

  electronApp?.on?.("second-instance", () => {
    onSecondInstance?.();
  });

  electronApp?.on?.("before-quit", releaseFileLock);
  return true;
}

module.exports = {
  ensureSingleInstance,
  notifyAlreadyRunning,
  releaseFileLock,
};
