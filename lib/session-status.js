const path = require("path");
const http = require("http");
const { storageFileExists, storageFileLooksLoggedIn } = require("./storage-auth");

const SUCCESS_TTL_MS = 5 * 60 * 1000;
const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000, 300_000];

const EMPTY_STATUS = {
  storageStateExists: false,
  identityCookieExists: false,
  loginCookieReady: false,
  productionDetailReady: false,
  loginRequired: false,
  accountLoggedIn: false,
  sessionUsable: false,
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

const SERVER_AUTH_FIELDS = [
  "signatureReady",
  "detailApiReady",
  "productionDetailReady",
  "browserSessionVerified",
  "loginRequired",
  "sessionUsable",
  "lastVerifyError",
  "verifyMovieId",
  "verifyMovieName",
  "verifySource",
  "signatureCaptured",
  "signatureSource",
  "detailHttpStatus",
  "detailPayloadValid",
  "dashboardAvailable",
  "lastVerifyAt",
];

let cachedStatus = { ...EMPTY_STATUS };
let verifyRunning = false;
let forceRerunRequested = false;
let lastApiBase = "";
let nextVerifyAtMs = 0;
let verifyFailureCount = 0;

function readSyncStatus(dataDir) {
  const file = path.join(dataDir, "browser_state.json");
  const identityCookieExists = storageFileLooksLoggedIn(file);
  return {
    storageStateExists: storageFileExists(file),
    identityCookieExists,
    loginCookieReady: identityCookieExists,
    accountLoggedIn: identityCookieExists,
  };
}

function deriveSessionFields(partial = {}) {
  const identity =
    partial.identityCookieExists ??
    cachedStatus.identityCookieExists;
  const detail = partial.detailApiReady ?? cachedStatus.detailApiReady;
  const loginRequired = Boolean(partial.loginRequired ?? cachedStatus.loginRequired);
  return {
    identityCookieExists: Boolean(identity),
    loginCookieReady: Boolean(identity),
    accountLoggedIn: Boolean(identity),
    productionDetailReady: Boolean(detail),
    loginRequired,
    sessionUsable: Boolean(identity && detail && !loginRequired),
  };
}

function mergeSessionStatus(partial = {}) {
  const derived = deriveSessionFields(partial);
  cachedStatus = {
    ...cachedStatus,
    ...partial,
    ...derived,
    lastVerifyAt: partial.lastVerifyAt || cachedStatus.lastVerifyAt || new Date().toISOString(),
    verifyFailureCount,
    nextVerifyAt: nextVerifyAtMs ? new Date(nextVerifyAtMs).toISOString() : cachedStatus.nextVerifyAt,
  };
  return getSessionStatus();
}

function getSessionStatus(dataDir) {
  const sync = dataDir ? readSyncStatus(dataDir) : {};
  const derived = deriveSessionFields({ ...cachedStatus, ...sync });
  return {
    ...cachedStatus,
    ...sync,
    ...derived,
    verifyPending: verifyRunning,
    verifyFailureCount,
    nextVerifyAt: nextVerifyAtMs ? new Date(nextVerifyAtMs).toISOString() : cachedStatus.nextVerifyAt,
  };
}

function resetSessionStatus() {
  cachedStatus = { ...EMPTY_STATUS };
  verifyRunning = false;
  forceRerunRequested = false;
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
  if (verifyRunning) {
    if (options.force) forceRerunRequested = true;
    return false;
  }
  if (options.force) return true;

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

  if (
    ["login_required", "upstream_401", "401", "detail_http_401", "session_expired"].includes(
      normalized,
    )
  ) {
    patch.loginRequired = true;
    patch.detailApiReady = false;
    patch.productionDetailReady = false;
    patch.browserSessionVerified = false;
    patch.signatureReady = false;
    patch.sessionUsable = false;
    patch.lastVerifyError = normalized;
    markVerifyFailure();
    nextVerifyAtMs = Math.min(nextVerifyAtMs || Date.now(), Date.now() + BACKOFF_SCHEDULE_MS[0]);
    return mergeSessionStatus(patch);
  }

  if (["upstream_403", "sig_capture_failed", "403", "detail_http_403"].includes(normalized)) {
    patch.loginRequired = false;
    patch.signatureReady = false;
    patch.detailApiReady = false;
    patch.productionDetailReady = false;
    patch.sessionUsable = false;
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

function serverStatusIsNewer(serverStatus, localStatus) {
  const serverAt = serverStatus?.lastVerifyAt
    ? new Date(serverStatus.lastVerifyAt).getTime()
    : 0;
  const localAt = localStatus?.lastVerifyAt
    ? new Date(localStatus.lastVerifyAt).getTime()
    : 0;
  return serverAt >= localAt;
}

function syncSessionStatusFromServer(apiBase) {
  if (!apiBase) return Promise.resolve(getSessionStatus());
  const url = `${String(apiBase).replace(/\/$/, "")}/api/capability-status`;
  return fetchJson(url, 5000)
    .then((serverStatus) => {
      if (!serverStatus || typeof serverStatus !== "object") return getSessionStatus();

      const patch = {};
      const newer = serverStatusIsNewer(serverStatus, cachedStatus);

      if (newer) {
        for (const field of SERVER_AUTH_FIELDS) {
          if (serverStatus[field] !== undefined) {
            patch[field] = serverStatus[field];
          }
        }
      } else {
        if (serverStatus.detailApiReady === false && cachedStatus.detailApiReady === true) {
          patch.detailApiReady = false;
          patch.productionDetailReady = false;
          patch.browserSessionVerified = false;
          patch.signatureReady =
            serverStatus.signatureReady === true ? cachedStatus.signatureReady : false;
          patch.sessionUsable = false;
        }
        if (serverStatus.signatureReady === false && cachedStatus.signatureReady === true) {
          patch.signatureReady = false;
          patch.detailApiReady = false;
          patch.productionDetailReady = false;
          patch.sessionUsable = false;
        }
        if (serverStatus.lastVerifyError) patch.lastVerifyError = serverStatus.lastVerifyError;
      }

      if (Object.keys(patch).length) {
        return mergeSessionStatus({
          ...patch,
          lastVerifyAt: serverStatus.lastVerifyAt || new Date().toISOString(),
        });
      }
      return getSessionStatus();
    })
    .catch(() => getSessionStatus());
}

function scheduleBackgroundVerify(apiBase, dataDir, options = {}) {
  if (!shouldScheduleVerify(apiBase, options)) return;
  try {
    const { isLoginLockActive } = require("./login-lock");
    if (dataDir && isLoginLockActive(dataDir)) {
      // 登录窗口打开期间禁止后台校验，避免把刚写入的 detailApiReady 打回 false
      return;
    }
  } catch {
    /* ignore */
  }
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
      await syncSessionStatusFromServer(apiBase);
    } catch (error) {
      markVerifyFailure();
      mergeSessionStatus({
        detailApiReady: false,
        productionDetailReady: false,
        browserSessionVerified: false,
        signatureReady: false,
        sessionUsable: false,
        dashboardAvailable: false,
        lastVerifyError: String(error?.message || error || "verify_failed"),
        lastVerifyAt: new Date().toISOString(),
        verifyFailureCount,
        nextVerifyAt: new Date(nextVerifyAtMs).toISOString(),
        ...(dataDir ? readSyncStatus(dataDir) : {}),
      });
    } finally {
      verifyRunning = false;
      if (forceRerunRequested) {
        forceRerunRequested = false;
        scheduleBackgroundVerify(apiBase, dataDir, { force: true });
      }
    }
  });
}

function forceBackgroundVerify(apiBase, dataDir) {
  nextVerifyAtMs = 0;
  scheduleBackgroundVerify(apiBase, dataDir, { force: true });
}

function reportSessionApiError(code) {
  return applySessionApiError(code);
}

/** 仅当 cookie + mtgsig + detail API 均已验证时视为可用会话 */
function isVerifiedSession(dataDir) {
  const status = getSessionStatus(dataDir);
  return Boolean(
    status.identityCookieExists &&
      status.signatureReady &&
      status.detailApiReady &&
      !status.loginRequired,
  );
}

function _resetVerifyState() {
  verifyRunning = false;
  forceRerunRequested = false;
}

function _getVerifyState() {
  return { verifyRunning, forceRerunRequested };
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
  reportSessionApiError,
  syncSessionStatusFromServer,
  isVerifiedSession,
  _resetVerifyState,
  _getVerifyState,
};
