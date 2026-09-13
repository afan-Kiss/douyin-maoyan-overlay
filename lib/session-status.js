const path = require("path");
const http = require("http");
const { storageFileExists, storageFileLooksLoggedIn } = require("./storage-auth");

const EMPTY_STATUS = {
  storageStateExists: false,
  identityCookieExists: false,
  accountLoggedIn: false,
  browserSessionReady: false,
  browserSessionVerified: false,
  signatureReady: false,
  detailApiReady: false,
  dashboardAvailable: false,
  lastVerifyAt: null,
  lastVerifyError: null,
  verifyPending: false,
};

let cachedStatus = { ...EMPTY_STATUS };
let verifyRunning = false;
let lastApiBase = "";

function readSyncStatus(dataDir) {
  const file = path.join(dataDir, "browser_state.json");
  return {
    storageStateExists: storageFileExists(file),
    identityCookieExists: storageFileLooksLoggedIn(file),
  };
}

function mergeSessionStatus(partial = {}) {
  cachedStatus = {
    ...cachedStatus,
    ...partial,
    lastVerifyAt: partial.lastVerifyAt || cachedStatus.lastVerifyAt || new Date().toISOString(),
  };
  cachedStatus.accountLoggedIn =
    Boolean(cachedStatus.identityCookieExists) && Boolean(cachedStatus.detailApiReady);
  return getSessionStatus();
}

function getSessionStatus(dataDir) {
  const sync = dataDir ? readSyncStatus(dataDir) : {};
  return {
    ...cachedStatus,
    ...sync,
    accountLoggedIn:
      Boolean(sync.identityCookieExists ?? cachedStatus.identityCookieExists) &&
      Boolean(cachedStatus.detailApiReady),
    verifyPending: verifyRunning,
  };
}

function resetSessionStatus() {
  cachedStatus = { ...EMPTY_STATUS };
  verifyRunning = false;
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

function scheduleBackgroundVerify(apiBase, dataDir) {
  if (!apiBase || verifyRunning) return;
  if (apiBase === lastApiBase && cachedStatus.detailApiReady) return;
  lastApiBase = apiBase;
  verifyRunning = true;

  setImmediate(async () => {
    try {
      const url = `${String(apiBase).replace(/\/$/, "")}/api/verify-capabilities`;
      const result = await fetchJson(url, 60000);
      mergeSessionStatus({
        ...result,
        lastVerifyAt: result.lastVerifyAt || new Date().toISOString(),
      });
    } catch (error) {
      mergeSessionStatus({
        detailApiReady: false,
        browserSessionVerified: false,
        signatureReady: false,
        dashboardAvailable: false,
        lastVerifyError: String(error?.message || error || "verify_failed"),
        lastVerifyAt: new Date().toISOString(),
        ...(dataDir ? readSyncStatus(dataDir) : {}),
      });
    } finally {
      verifyRunning = false;
    }
  });
}

/** 仅当 detail API 已验证且存在身份 Cookie 时视为可用会话（非文件假登录） */
function isVerifiedSession(dataDir) {
  const status = getSessionStatus(dataDir);
  return Boolean(status.detailApiReady && status.identityCookieExists);
}

module.exports = {
  EMPTY_STATUS,
  readSyncStatus,
  mergeSessionStatus,
  getSessionStatus,
  resetSessionStatus,
  scheduleBackgroundVerify,
  isVerifiedSession,
};
