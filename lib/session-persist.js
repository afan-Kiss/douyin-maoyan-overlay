const fs = require("fs");
const path = require("path");
const {
  loginFingerprint,
  readStorageStateSafe,
} = require("./storage-auth");

const SNAPSHOT_VERSION = 1;
const SESSION_PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_FILE = "session_capability.json";

const PERSIST_FIELDS = [
  "detailApiReady",
  "signatureReady",
  "browserSessionVerified",
  "detailPayloadValid",
  "signatureCaptured",
  "loginRequired",
  "verifyMovieId",
  "verifyMovieName",
  "verifySource",
  "signatureSource",
  "detailHttpStatus",
  "lastVerifyError",
  "dashboardAvailable",
];

function sessionCapabilityPath(dataDir) {
  return path.join(dataDir, SNAPSHOT_FILE);
}

function readLoginFingerprint(dataDir) {
  const state = readStorageStateSafe(path.join(dataDir, "browser_state.json"));
  if (!state) return "";
  return loginFingerprint(state);
}

function pickCapabilityFields(source = {}) {
  const out = {};
  for (const key of PERSIST_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function buildSessionSnapshot(dataDir, partial = {}) {
  const capability = pickCapabilityFields(partial.capability || partial);
  return {
    version: SNAPSHOT_VERSION,
    savedAt: partial.savedAt || new Date().toISOString(),
    loginFingerprint: partial.loginFingerprint || readLoginFingerprint(dataDir),
    lastSignatureSuccessAt: partial.lastSignatureSuccessAt || null,
    lastDetailApiSuccessAt: partial.lastDetailApiSuccessAt || null,
    lastDashboardSuccessAt: partial.lastDashboardSuccessAt || null,
    capability,
  };
}

function saveSessionCapability(dataDir, partial = {}) {
  if (!dataDir) return null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const snapshot = buildSessionSnapshot(dataDir, partial);
    fs.writeFileSync(
      sessionCapabilityPath(dataDir),
      JSON.stringify(snapshot, null, 2),
      "utf-8",
    );
    return snapshot;
  } catch {
    return null;
  }
}

function loadSessionCapability(dataDir) {
  if (!dataDir) return null;
  try {
    const filePath = sessionCapabilityPath(dataDir);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

function fingerprintMatches(dataDir, snapshot) {
  const saved = String(snapshot?.loginFingerprint || "");
  const current = readLoginFingerprint(dataDir);
  // 双方都没有身份 Cookie 时不视为同一会话，避免空指纹误匹配旧快照
  if (!saved && !current) return false;
  if (!saved) return true;
  if (!current) return false;
  return saved === current;
}

function isTimestampFresh(iso, maxAgeMs) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < maxAgeMs;
}

function isPersistedSessionUsable(dataDir, maxAgeMs = SESSION_PERSIST_TTL_MS) {
  const snapshot = loadSessionCapability(dataDir);
  if (!snapshot) return false;
  if (!fingerprintMatches(dataDir, snapshot)) return false;
  const cap = snapshot.capability || {};
  if (!cap.detailApiReady || !cap.detailPayloadValid || !cap.signatureReady) return false;
  if (cap.loginRequired) return false;
  const anchor =
    snapshot.lastDetailApiSuccessAt || snapshot.savedAt || null;
  return isTimestampFresh(anchor, maxAgeMs);
}

function newestSignatureTimestamp(sessionCacheDir) {
  if (!sessionCacheDir || !fs.existsSync(sessionCacheDir)) return null;
  let newest = null;
  let newestMs = 0;
  try {
    for (const name of fs.readdirSync(sessionCacheDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(sessionCacheDir, name), "utf-8"),
        );
        if (!raw?.headers?.mtgsig) continue;
        const at = raw.captured_at ? new Date(raw.captured_at).getTime() : 0;
        if (at > newestMs) {
          newestMs = at;
          newest = raw.captured_at;
        }
      } catch {
        /* ignore bad cache file */
      }
    }
  } catch {
    /* ignore */
  }
  return newest;
}

function clearSessionCapability(dataDir) {
  if (!dataDir) return;
  try {
    const filePath = sessionCapabilityPath(dataDir);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

module.exports = {
  SNAPSHOT_FILE,
  SESSION_PERSIST_TTL_MS,
  sessionCapabilityPath,
  buildSessionSnapshot,
  saveSessionCapability,
  loadSessionCapability,
  isPersistedSessionUsable,
  newestSignatureTimestamp,
  clearSessionCapability,
  fingerprintMatches,
};
