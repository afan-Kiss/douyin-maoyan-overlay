const path = require("path");
const http = require("http");
const { storageFileExists, storageFileLooksLoggedIn } = require("./storage-auth");

const SUCCESS_TTL_MS = 5 * 60 * 1000;
const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000, 300_000];

const EMPTY_STATUS = {
  storageStateExists: false,
  identityCookieExists: false,
  accountLoggedIn: false,
  browserSessionReady: false,
  browserSessionVerified: false,
  signatureReady: false,
  detailApiReady: false,
  dashboardAvailable: false,
  verifyMovieId: null,
  verifyMovieName: null,
  verifySource: null,
  signatureCaptured: false,
  signatureSource: null,
  detailHttpStatus: null,
  detailPayloadValid: false,
  lastVerifyAt: null,
  lastVerifyError: null,
  verifyPending: false,
  verifyFailureCount: 0,
  nextVerifyAt: null,
};

let cachedStatus = { ...EMPTY_STATUS };
let verifyRunning = false;
let lastApiBase = "";
let nextVerifyAtMs = 0;
let verifyFailureCount = 0;

function readSyncStatus(dataDir) {
  const file = path.join(dataDir, "browser_state.json");
  return {
    storageStateExists: storageFileExists(file),
    identityCookieExists: storageFileLooksLoggedIn(file),
  };
}

function computeAccountLoggedIn(partial = {}) {
  const identity =
    partial.identityCookieExists ??
    cachedStatus.identityCookieExists;
  const detail = partial.detailApiReady ?? cachedStatus.detailApiReady;
  return Boolean(identity) && Boolean(detail);
}

function mergeSessionStatus(partial = {}) {
  cachedStatus = {
    ...cachedStatus,
    ...partial,
    lastVerifyAt: partial.lastVerifyAt || cachedStatus.lastVerifyAt || new Date().toISOString(),
    verifyFailureCount,
    nextVerifyAt: nextVerifyAtMs ? new Date(nextVerifyAtMs).toISOString() : cachedStatus.nextVerifyAt,
  };
  cachedStatus.accountLoggedIn = computeAccountLoggedIn(partial);
  return getSessionStatus();
}

function getSessionStatus(dataDir) {
  const sync = dataDir ? readSyncStatus(dataDir) : {};
  return {
    ...cachedStatus,
    ...sync,
    accountLoggedIn: computeAccountLoggedIn(sync),
    verifyPending: verifyRunning,
    verifyFailureCount,
    nextVerifyAt: nextVerifyAtMs ? new Date(nextVerifyAtMs).toISOString() : cachedStatus.nextVerifyAt,
  };
}

function resetSessionStatus() {
  cachedStatus = { ...EMPTY_STATUS };
  verifyRunning = false;
  nextVerifyAtMs = 0;
  verifyFailureCount = 0;
  lastApiBase = "";
}

function markVerifySuccess() {
  verifyFailureCount = 0;
  nextVerifyAtMs = Date.now() + SUCCESS_TTL_MS;
}

function markVerifyFailure() {
  verifyFailureCount += 1;
  const backoff = BACKOFF_SCHEDULE_MS[Math.min(verifyFailureCount - 1, BACKOFF_SCHEDULE_MS.length - 1)];
  nextVerifyAtMs = Date.now() + backoff;
}

function shouldScheduleVerify(apiBase, options = {}) {
  if (!apiBase) return false;
  if (options.force) return true;
  if (verifyRunning) return false;

  const now = Date.now();
  if (now < nextVerifyAtMs) return false;

  if (cachedStatus.detailApiReady && cachedStatus.lastVerifyAt) {
    const age = now - new Date(cachedStatus.lastVerifyAt).getTime();
    if (age < SUCCESS_TTL_MS) return false;
  }

  return true;
}

function applySessionApiError(code) {
  const normalized = String(code || "").trim();
  const patch = { lastVerifyAt: new Date().toISOString() };

  if (["login_required", "upstream_401", "401"].includes(normalized)) {
    patch.detailApiReady = false;
    patch.browserSessionVerified = false;
    patch.signatureReady = false;
    patch.accountLoggedIn = false;
    patch.lastVerifyError = normalized;
    markVerifyFailure();
    nextVerifyAtMs = Math.min(nextVerifyAtMs || Date.now(), Date.now() + BACKOFF_SCHEDULE_MS[0]);
    return mergeSessionStatus(patch);
  }

  if (["upstream_403", "sig_capture_failed", "403"].includes(normalized)) {
    patch.signatureReady = false;
    patch.detailApiReady = false;
    patch.lastVerifyError = normalized;
    markVerifyFailure();
    nextVerifyAtMs = Math.min(nextVerifyAtMs || Date.now(), Date.now() + BACKOFF_SCHEDULE_MS[0]);
    return mergeSessionStatus(patch);
  }

  return getSessionStatus();
}

function fetchJson(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("verify_timeout"));
    });
  });
}

function scheduleBackgroundVerify(apiBase, dataDir, options = {}) {
  if (!shouldScheduleVerify(apiBase, options)) return;
  lastApiBase = apiBase;
  verifyRunning = true;

  setImmediate(async () => {
    try {
      const url = `${String(apiBase).replace(/\/$/, "")}/api/verify-capabilities${options.force ? "?force=1" : ""}`;
      const result = await fetchJson(url, 120000);
      if (result.detailApiReady) {
        markVerifySuccess();
      } else {
        markVerifyFailure();
      }
      mergeSessionStatus({
        ...result,
        lastVerifyAt: result.lastVerifyAt || new Date().toISOString(),
        verifyFailureCount,
        nextVerifyAt: new Date(nextVerifyAtMs).toISOString(),
      });
    } catch (error) {
      markVerifyFailure();
      mergeSessionStatus({
        detailApiReady: false,
        browserSessionVerified: false,
        signatureReady: false,
        dashboardAvailable: false,
        lastVerifyError: String(error?.message || error || "verify_failed"),
        lastVerifyAt: new Date().toISOString(),
        verifyFailureCount,
        nextVerifyAt: new Date(nextVerifyAtMs).toISOString(),
        ...(dataDir ? readSyncStatus(dataDir) : {}),
      });
    } finally {
      verifyRunning = false;
    }
  });
}

function forceBackgroundVerify(apiBase, dataDir) {
  nextVerifyAtMs = 0;
  scheduleBackgroundVerify(apiBase, dataDir, { force: true });
}

/** 仅当 detail API 已验证且存在身份 Cookie 时视为可用会话 */
function isVerifiedSession(dataDir) {
  const status = getSessionStatus(dataDir);
  return Boolean(status.detailApiReady && status.identityCookieExists);
}

module.exports = {
  EMPTY_STATUS,
  SUCCESS_TTL_MS,
  readSyncStatus,
  mergeSessionStatus,
  getSessionStatus,
  resetSessionStatus,
  scheduleBackgroundVerify,
  forceBackgroundVerify,
  applySessionApiError,
  isVerifiedSession,
};
