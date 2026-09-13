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
const { verifyProductionCapabilities } = require("./production-verify");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 800;
const STABLE_LOGIN_HITS = 2;
const AUTO_CLOSE_DELAY_MS = 600;

let loginVerifyInflight = null;
let loginVerifyExecutionId = 0;
let loginVerifyExecutionCounter = 0;

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

async function persistLoginState(context, storageStatePath, options = {}) {
  const dataDir = options.dataDir || path.dirname(storageStatePath);
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

  const production = await verifyProductionCapabilities(pendingPath, { dataDir });
  if (!production.detailApiReady) {
    discardPendingStorageState(storageStatePath);
    const err = new Error(
      production.lastVerifyError === "box_page_not_loaded" ||
        production.lastVerifyError === "mtgsig_not_captured"
        ? "HEADLESS_PATH_INCOMPATIBLE"
        : "production_detail_not_ready",
    );
    err.code =
      production.lastVerifyError === "box_page_not_loaded" ||
      production.lastVerifyError === "mtgsig_not_captured"
        ? "HEADLESS_PATH_INCOMPATIBLE"
        : "production_detail_not_ready";
    err.loginCookieReady = true;
    err.productionDetailReady = false;
    err.lastVerifyError = production.lastVerifyError;
    throw err;
  }

  commitPendingStorageState(storageStatePath);
  return {
    ...recheck,
    loginCookieReady: true,
    productionDetailReady: true,
    detailApiReady: true,
    accountLoggedIn: recheck.identityCookieExists,
    sessionUsable: true,
  };
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
    const result = await loginVerifyInflight;
    return { result, executionId: loginVerifyExecutionId, reused: true };
  }
  console.log("LOGIN_VERIFY_START");
  const executionId = ++loginVerifyExecutionCounter;
  loginVerifyExecutionId = executionId;
  loginVerifyInflight = (async () => {
    try {
      return await fn();
    } finally {
      console.log("LOGIN_VERIFY_END");
      loginVerifyInflight = null;
    }
  })();
  const result = await loginVerifyInflight;
  return { result, executionId, reused: false };
}

async function waitForBrowserLoginAndSave(context, browser, storageStatePath, options = {}) {
  const requireFreshLogin = options.requireFreshLogin === true;
  const dataDir = options.dataDir || path.dirname(storageStatePath);
  let baselineFingerprint = "";
  try {
    baselineFingerprint = loginFingerprint(await context.storageState());
  } catch {
    baselineFingerprint = "";
  }

  let loginTimeout = null;
  let settled = false;
  let stableHits = 0;
  let lastCapabilities = null;

  const stopTimers = () => {
    if (loginTimeout) clearTimeout(loginTimeout);
    loginTimeout = null;
  };

  const checkVerifiedLogin = async () => {
    const { result, reused } = await runLoginVerifySingleflight(async () => {
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
    return { capabilities: result, reused };
  };

  const waitForStableLogin = (async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!settled && Date.now() < deadline) {
      try {
        const { capabilities, reused } = await checkVerifiedLogin();
        if (capabilities) {
          if (!reused) {
            stableHits += 1;
            if (stableHits >= STABLE_LOGIN_HITS) {
              settled = true;
              return capabilities;
            }
          }
        } else {
          stableHits = 0;
        }
      } catch {
        stableHits = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    }
    if (!settled) {
      throw Object.assign(new Error("login timeout"), { code: "login_timeout" });
    }
    return null;
  })();

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
      const capabilities = await persistLoginState(context, storageStatePath, { dataDir });
      await new Promise((resolve) => setTimeout(resolve, AUTO_CLOSE_DELAY_MS));
      await closeLoginSession(context, browser);
      return {
        ok: true,
        detailApiReady: true,
        productionDetailReady: true,
        loginCookieReady: true,
        accountLoggedIn: capabilities.accountLoggedIn,
        autoClosed: true,
      };
    }

    const finalCheck = await checkVerifiedLogin().catch(() => ({ capabilities: null }));
    const finalCapabilities = finalCheck.capabilities || lastCapabilities;
    if (finalCapabilities?.detailApiReady) {
      try {
        const capabilities = await persistLoginState(context, storageStatePath, { dataDir });
        return {
          ok: true,
          detailApiReady: true,
          productionDetailReady: true,
          loginCookieReady: true,
          accountLoggedIn: capabilities.accountLoggedIn,
          autoClosed: false,
        };
      } catch (error) {
        if (error.code === "HEADLESS_PATH_INCOMPATIBLE") {
          return {
            ok: false,
            code: "HEADLESS_PATH_INCOMPATIBLE",
            loginCookieReady: true,
            productionDetailReady: false,
            detail:
              "登录浏览器验证通过，但生产签名路径（headless）不可用。这不是账号登录问题，请勿反复重新登录。",
            lastVerifyError: error.lastVerifyError,
          };
        }
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
  loginVerifyExecutionId = 0;
}

function _getLoginVerifyInflight() {
  return loginVerifyInflight;
}

function _getStableLoginHitsForTest() {
  return { STABLE_LOGIN_HITS };
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  LOGIN_POLL_MS,
  STABLE_LOGIN_HITS,
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
  _getStableLoginHitsForTest,
};
