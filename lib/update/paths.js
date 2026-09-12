const fs = require("fs");
const path = require("path");

const APP_DIR_NAME = "MaoyanOverlay";
const DEFAULT_EXE_NAME = "MaoyanOverlay.exe";

/**
 * Portable 单文件运行时 process.execPath 指向临时解压目录，
 * 真实桌面 EXE 由 electron-builder 注入 PORTABLE_EXECUTABLE_FILE。
 */
function getRealExecutablePath() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (portable) {
    try {
      if (fs.existsSync(portable)) return portable;
    } catch {
      /* ignore */
    }
  }
  return process.execPath;
}

function installDir() {
  try {
    const exe = getRealExecutablePath();
    const parent = path.dirname(exe);
    if (parent) return parent;
  } catch {
    /* ignore */
  }
  return process.cwd();
}

function updatesDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
  return path.join(base, APP_DIR_NAME, "updates");
}

function installedExeName() {
  try {
    return path.basename(getRealExecutablePath()) || DEFAULT_EXE_NAME;
  } catch {
    return DEFAULT_EXE_NAME;
  }
}

function isPackagedApp() {
  if (process.env.MAOYAN_FORCE_UPDATE === "1") return true;
  if (process.defaultApp) return false;
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (portable && fs.existsSync(portable)) return true;
  const name = installedExeName().toLowerCase();
  if (name.includes("maoyanoverlay")) return true;
  if (name === "electron.exe") return false;
  const dir = installDir().toLowerCase();
  return dir.includes("maoyanoverlay") || dir.includes(`${path.sep}dist${path.sep}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_EXE_NAME,
  getRealExecutablePath,
  installDir,
  updatesDir,
  installedExeName,
  isPackagedApp,
  ensureDir,
};
