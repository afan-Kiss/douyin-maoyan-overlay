const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getRealExecutablePath } = require("./update/paths");

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_NAME = "MaoyanOverlay";

function resolveLaunchTarget() {
  const exe = getRealExecutablePath();
  const name = path.basename(exe).toLowerCase();
  if (name.includes("maoyanoverlay")) {
    return { command: `"${exe}"`, label: exe };
  }
  const startBat = path.join(process.cwd(), "start.bat");
  if (fs.existsSync(startBat)) {
    return { command: `"${startBat}"`, label: startBat };
  }
  return { command: `"${exe}"`, label: exe };
}

function queryAutoStart() {
  if (process.platform !== "win32") return { enabled: false, command: "" };
  const result = spawnSync(
    "reg",
    ["query", REG_KEY, "/v", APP_NAME],
    { encoding: "utf-8", windowsHide: true },
  );
  if (result.status !== 0) return { enabled: false, command: "" };
  const match = String(result.stdout || "").match(/REG_SZ\s+(.*)$/m);
  return { enabled: Boolean(match), command: match ? match[1].trim() : "" };
}

function enableAutoStart() {
  if (process.platform !== "win32") return { ok: false, reason: "仅支持 Windows" };
  const target = resolveLaunchTarget();
  const result = spawnSync(
    "reg",
    ["add", REG_KEY, "/v", APP_NAME, "/t", "REG_SZ", "/d", target.command, "/f"],
    { encoding: "utf-8", windowsHide: true },
  );
  if (result.status !== 0) {
    return { ok: false, reason: result.stderr || "注册表写入失败" };
  }
  return { ok: true, command: target.command, label: target.label };
}

function disableAutoStart() {
  if (process.platform !== "win32") return { ok: false, reason: "仅支持 Windows" };
  const result = spawnSync(
    "reg",
    ["delete", REG_KEY, "/v", APP_NAME, "/f"],
    { encoding: "utf-8", windowsHide: true },
  );
  if (result.status !== 0 && !String(result.stderr || "").includes("找不到")) {
    return { ok: false, reason: result.stderr || "注册表删除失败" };
  }
  return { ok: true };
}

function ensureAutoStart() {
  const current = queryAutoStart();
  const target = resolveLaunchTarget();
  if (current.enabled) {
    const normalizedCurrent = (current.command || "").replace(/"/g, "").trim().toLowerCase();
    const normalizedTarget = (target.command || "").replace(/"/g, "").trim().toLowerCase();
    if (normalizedCurrent === normalizedTarget) {
      return { ok: true, already: true, command: current.command };
    }
  }
  return enableAutoStart();
}

module.exports = {
  APP_NAME,
  queryAutoStart,
  enableAutoStart,
  disableAutoStart,
  ensureAutoStart,
};
