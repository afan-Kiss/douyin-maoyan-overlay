const fs = require("fs");
const path = require("path");
const {
  storageStateLooksLoggedIn,
  storageFileLooksLoggedIn,
  loginFingerprint,
} = require("./storage-auth");
const {
  verifyCapabilitiesInContext,
  DASHBOARD_VERIFY_URL,
} = require("./session-capability");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 800;
const STABLE_LOGIN_HITS = 2;
const AUTO_CLOSE_DELAY_MS = 600;

let loginVerifyInflight = null;

async function waitForBrowserClose(browser, timeoutMs = LOGIN_TIMEOUT_MS) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("login timeout")), timeoutMs);
    browser.once("disconnected", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function pendingStoragePath(storageStatePath) {
  const dir = path.dirname(storageStatePath);
  const base = path.basename(storageStatePath, ".json");
  return path.join(dir, `${base}.pending.json`);
}

function backupStoragePath(storageStatePath) {
  const dir = path.dirname(storageStatePath);
  const base = path.basename(storageStatePath, ".json");
  return path.join(dir, `${base}.backup.json`);
}

function commitPendingStorageState(storageStatePath) {
  const pendingPath = pendingStoragePath(storageStatePath);
  const backupPath = backupStoragePath(storageStatePath);
  if (!fs.existsSync(pendingPath)) {
    throw new Error("pending login state missing");
  }

  let backupCreated = false;
  try {
    if (fs.existsSync(storageStatePath)) {
      fs.copyFileSync(storageStatePath, backupPath);
      backupCreated = true;
    }
    if (fs.existsSync(storageStatePath)) {
      fs.unlinkSync(storageStatePath);
    }
    fs.renameSync(pendingPath, storageStatePath);
    if (backupCreated && fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch (error) {
    try {
      if (backupCreated && fs.existsSync(backupPath)) {
        if (fs.existsSync(storageStatePath)) {
          try {
            fs.unlinkSync(storageStatePath);
          } catch {
            /* partial promote */
          }
        }
        fs.renameSync(backupPath, storageStatePath);
      }
    } catch {
      /* rollback failed */
    }
    throw error;
  }
}

function discardPendingStorageState(storageStatePath) {
  const pendingPath = pendingStoragePath(storageStatePath);
  try {
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
  } catch {
    /* ignore */
  }
}

async function persistLoginState(context, storageStatePath) {
  const capabilities = await verifyCapabilitiesInContext(context);
  if (!capabilities.detailApiReady) {
    throw new Error("detail_api_not_ready");
  }
  if (!storageStateLooksLoggedIn(await context.storageState())) {
    throw new Error("login cookies missing");
  }

  const pendingPath = pendingStoragePath(storageStatePath);
  discardPendingStorageState(storageStatePath);
  await context.storageState({ path: pendingPath });
  if (!storageFileLooksLoggedIn(pendingPath)) {
    discardPendingStorageState(storageStatePath);
    throw new Error("login cookies missing");
  }

  const recheck = await verifyCapabilitiesInContext(context);
  if (!recheck.detailApiReady) {
    discardPendingStorageState(storageStatePath);
    throw new Error("detail_api_not_ready");
  }

  commitPendingStorageState(storageStatePath);
  return recheck;
}

async function closeLoginSession(context, browser) {
  try {
    await context.close();
  } catch {
    /* already closed */
  }
  try {
    await browser.close();
  } catch {
    /* already closed */
  }
}

function loginEstablishedDuringSession(state, baselineFingerprint, requireFreshLogin) {
  if (!storageStateLooksLoggedIn(state)) return false;
  if (!requireFreshLogin) return true;
  return loginFingerprint(state) !== baselineFingerprint;
}

async function runLoginVerifySingleflight(fn) {
  if (loginVerifyInflight) {
    console.log("LOGIN_VERIFY_DEDUP");
    return loginVerifyInflight;
  }
  console.log("LOGIN_VERIFY_START");
  loginVerifyInflight = (async () => {
    try {
      return await fn();
    } finally {
      console.log("LOGIN_VERIFY_END");
      loginVerifyInflight = null;
    }
  })();
  return loginVerifyInflight;
}

async function waitForBrowserLoginAndSave(context, browser, storageStatePath, options = {}) {
  const requireFreshLogin = options.requireFreshLogin === true;
  let baselineFingerprint = "";
  try {
    baselineFingerprint = loginFingerprint(await context.storageState());
  } catch {
    baselineFingerprint = "";
  }

  let pollTimer = null;
  let loginTimeout = null;
  let settled = false;
  let stableHits = 0;
  let lastCapabilities = null;

  const stopTimers = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (loginTimeout) clearTimeout(loginTimeout);
    loginTimeout = null;
  };

  const checkVerifiedLogin = async () =>
    runLoginVerifySingleflight(async () => {
      const state = await context.storageState();
      if (!loginEstablishedDuringSession(state, baselineFingerprint, requireFreshLogin)) {
        return null;
      }
      const capabilities = await verifyCapabilitiesInContext(context);
      if (capabilities.detailApiReady) {
        lastCapabilities = capabilities;
      }
      return capabilities.detailApiReady ? capabilities : null;
    });

  const waitForStableLogin = new Promise((resolve, reject) => {
    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const capabilities = await checkVerifiedLogin();
        if (capabilities) {
          stableHits += 1;
          if (stableHits >= STABLE_LOGIN_HITS) {
            settled = true;
            resolve(capabilities);
          }
        } else {
          stableHits = 0;
        }
      } catch {
        stableHits = 0;
      }
    }, LOGIN_POLL_MS);

    loginTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("login timeout"), { code: "login_timeout" }));
    }, LOGIN_TIMEOUT_MS);
  });

  const waitForManualClose = waitForBrowserClose(browser, LOGIN_TIMEOUT_MS)
    .then(() => {
      if (!settled) settled = true;
      return "manual_close";
    })
    .catch((error) => {
      if (!settled) settled = true;
      throw error;
    });

  try {
    const reason = await Promise.race([waitForStableLogin, waitForManualClose]);
    stopTimers();

    if (reason !== "manual_close" && reason?.detailApiReady) {
      const capabilities = await persistLoginState(context, storageStatePath);
      await new Promise((resolve) => setTimeout(resolve, AUTO_CLOSE_DELAY_MS));
      await closeLoginSession(context, browser);
      return {
        ok: true,
        detailApiReady: true,
        accountLoggedIn: capabilities.accountLoggedIn,
        autoClosed: true,
      };
    }

    const finalCapabilities = (await checkVerifiedLogin().catch(() => null)) || lastCapabilities;
    if (finalCapabilities?.detailApiReady) {
      try {
        const capabilities = await persistLoginState(context, storageStatePath);
        return {
          ok: true,
          detailApiReady: true,
          accountLoggedIn: capabilities.accountLoggedIn,
          autoClosed: false,
        };
      } catch (error) {
        return {
          ok: false,
          code: "login_failed",
          detail:
            error.message === "detail_api_not_ready"
              ? "详细票房接口未就绪，请确认已完成猫眼登录并重试"
              : error.message || "保存登录状态失败",
        };
      }
    }

    return {
      ok: false,
      code: "login_cancelled",
      detail: "未完成登录",
    };
  } catch (error) {
    const code = error?.code === "login_timeout" ? "login_timeout" : "login_failed";
    return {
      ok: false,
      code,
      detail:
        code === "login_timeout"
          ? "登录超时，请重新点击登录"
          : error?.message || "登录失败",
    };
  } finally {
    stopTimers();
    discardPendingStorageState(storageStatePath);
  }
}

function cleanupInvalidLoginState(storageStatePath) {
  discardPendingStorageState(storageStatePath);
}

function _resetLoginVerifyInflight() {
  loginVerifyInflight = null;
}

function _getLoginVerifyInflight() {
  return loginVerifyInflight;
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  DASHBOARD_VERIFY_URL,
  waitForBrowserClose,
  verifyCapabilitiesInContext,
  persistLoginState,
  waitForBrowserLoginAndSave,
  cleanupInvalidLoginState,
  pendingStoragePath,
  backupStoragePath,
  commitPendingStorageState,
  discardPendingStorageState,
  runLoginVerifySingleflight,
  _resetLoginVerifyInflight,
  _getLoginVerifyInflight,
};
