const fs = require("fs");
const path = require("path");

const { APP_DIR_NAME, installDir, installedExeName } = require("./paths");

function appDataDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
  return path.join(base, APP_DIR_NAME);
}

function pendingUpdatePath() {
  return path.join(appDataDir(), "update-pending.json");
}

function healthOkPath(token) {
  return path.join(appDataDir(), `update-health-${token}.json`);
}

function ensureAppDataDir() {
  fs.mkdirSync(appDataDir(), { recursive: true });
}

function writePendingUpdate(payload) {
  ensureAppDataDir();
  const data = {
    token: String(payload.token || ""),
    installDir: path.resolve(payload.installDir || installDir()),
    exeName: String(payload.exeName || installedExeName()),
    targetVersion: String(payload.targetVersion || ""),
    createdAt: Date.now(),
  };
  fs.writeFileSync(pendingUpdatePath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return data;
}

function readPendingUpdate() {
  try {
    const file = pendingUpdatePath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function clearPendingUpdate() {
  try {
    fs.unlinkSync(pendingUpdatePath());
  } catch {
    /* ignore */
  }
}

function writeHealthOk(token, extra = {}) {
  if (!token) return;
  ensureAppDataDir();
  const data = {
    ok: true,
    token: String(token),
    confirmedAt: Date.now(),
    ...extra,
  };
  fs.writeFileSync(healthOkPath(token), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function readHealthOk(token) {
  if (!token) return null;
  try {
    const file = healthOkPath(token);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function cleanupHealthArtifact(token) {
  if (!token) return;
  try {
    fs.unlinkSync(healthOkPath(token));
  } catch {
    /* ignore */
  }
}

/**
 * 新版在 ready-to-show 且核心初始化无异常后调用，确认更新健康并清理 .bak。
 */
function confirmUpdateHealth() {
  const pending = readPendingUpdate();
  if (!pending?.token) return false;

  const dir = pending.installDir || installDir();
  const exeName = pending.exeName || installedExeName();
  const bak = path.join(dir, `${exeName}.bak`);

  writeHealthOk(pending.token, {
    installDir: dir,
    exeName,
    targetVersion: pending.targetVersion || "",
  });
  const { cleanupSuccessfulUpdateBackup } = require("./apply");
  cleanupSuccessfulUpdateBackup(dir, exeName);
  clearPendingUpdate();
  cleanupHealthArtifact(pending.token);
  return true;
}

function generateHealthToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  appDataDir,
  pendingUpdatePath,
  healthOkPath,
  writePendingUpdate,
  readPendingUpdate,
  clearPendingUpdate,
  writeHealthOk,
  readHealthOk,
  confirmUpdateHealth,
  generateHealthToken,
};
