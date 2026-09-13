const fs = require("fs");
const path = require("path");

const { APP_DIR_NAME } = require("./paths");

function statePath() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
  return path.join(base, APP_DIR_NAME, "update-installed.json");
}

function readInstallState() {
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeInstallState(payload) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    version: String(payload.version || ""),
    sha256: String(payload.sha256 || "").toLowerCase(),
    exePath: String(payload.exePath || ""),
    fileSize: Number(payload.fileSize) || 0,
    updatedAt: Date.now(),
  };
  if (payload.lastFailedSha256 !== undefined) {
    next.lastFailedSha256 = String(payload.lastFailedSha256 || "").toLowerCase();
    next.failedAttempts = Number(payload.failedAttempts || 0);
    next.lastFailedAt = Number(payload.lastFailedAt || 0);
  } else {
    const prev = readInstallState();
    if (prev?.lastFailedSha256) next.lastFailedSha256 = prev.lastFailedSha256;
    if (prev?.failedAttempts) next.failedAttempts = prev.failedAttempts;
    if (prev?.lastFailedAt) next.lastFailedAt = prev.lastFailedAt;
  }
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

function rememberInstalledRelease({ version, sha256, exePath, fileSize = 0 }) {
  const hash = String(sha256 || "").trim().toLowerCase();
  if (!hash) return;
  writeInstallState({ version, sha256: hash, exePath, fileSize });
}

function normalizeStateVersion(version) {
  const raw = String(version || "").trim().replace(/^[vV]+/, "");
  const parts = raw.split(".").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return `${parts[0]}.0`;
  if (parts.length >= 3 && parts.slice(2).every((p) => p === "0")) {
    return `${parts[0]}.${parts[1]}`;
  }
  return parts.join(".");
}

function isInstalledRelease(sha256) {
  const hash = String(sha256 || "").trim().toLowerCase();
  if (!hash) return false;
  const state = readInstallState();
  return String(state?.sha256 || "").toLowerCase() === hash;
}

function isInstalledVersion(version) {
  const want = normalizeStateVersion(version);
  if (!want) return false;
  const state = readInstallState();
  return normalizeStateVersion(state?.version) === want;
}

function rememberInstalledVersion(version, sha256 = "", fileSize = 0) {
  const ver = normalizeStateVersion(version);
  if (!ver) return;
  const prev = readInstallState() || {};
  writeInstallState({
    version: ver,
    sha256: String(sha256 || prev.sha256 || "").toLowerCase(),
    exePath: prev.exePath || "",
    fileSize: Number(fileSize) || Number(prev.fileSize) || 0,
  });
}

function isInstalledReleaseMeta(sha256, fileSize = 0) {
  const hash = String(sha256 || "").trim().toLowerCase();
  if (!hash) return false;
  const state = readInstallState();
  if (String(state?.sha256 || "").toLowerCase() !== hash) return false;
  const expectedSize = Number(fileSize) || 0;
  const savedSize = Number(state?.fileSize) || 0;
  if (expectedSize > 0 && savedSize > 0 && expectedSize !== savedSize) return false;
  return true;
}

function recordFailedAttempt(sha256) {
  const hash = String(sha256 || "").trim().toLowerCase();
  if (!hash) return;
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = readInstallState() || {};
  if (String(state.lastFailedSha256 || "").toLowerCase() === hash) {
    state.failedAttempts = Number(state.failedAttempts || 0) + 1;
  } else {
    state.failedAttempts = 1;
    state.lastFailedSha256 = hash;
  }
  state.lastFailedAt = Date.now();
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function shouldBackoffDownload(sha256, maxAttempts = 3, windowMs = 10 * 60 * 1000) {
  const hash = String(sha256 || "").trim().toLowerCase();
  if (!hash) return false;
  if (isInstalledRelease(hash)) return true;
  const state = readInstallState();
  if (String(state?.lastFailedSha256 || "").toLowerCase() !== hash) return false;
  const attempts = Number(state.failedAttempts || 0);
  const age = Date.now() - Number(state.lastFailedAt || 0);
  return attempts >= maxAttempts && age < windowMs;
}

module.exports = {
  readInstallState,
  rememberInstalledRelease,
  rememberInstalledVersion,
  isInstalledRelease,
  isInstalledReleaseMeta,
  isInstalledVersion,
  recordFailedAttempt,
  shouldBackoffDownload,
};
