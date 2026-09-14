const fs = require("fs");
const path = require("path");
const {
  storageStateLooksLoggedIn,
  storageFileLooksLoggedIn,
  storageStateHasPersistableCookies,
  getMaoyanCookies,
  summarizeCookieNames,
  loginFingerprint,
  cookiesToStorageState,
} = require("./storage-auth");
const {
  verifyCapabilitiesInLiveContext,
  isMaoyanLoginRedirect,
  verifyDetailOnBoxPage,
  FALLBACK_VERIFY_MOVIE_ID,
  DASHBOARD_VERIFY_URL,
} = require("./session-capability");
const { report } = require("./client-logger");
const { safeKillProcess, safeKillPid, killProcessesOnPort } = require("./chrome-launcher");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 2500;
const STABLE_LOGIN_HITS = 1;
const AUTO_CLOSE_DELAY_MS = 400;
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const DIAG_LOG_EVERY_MS = 8000;
const BOX_NAV_RETRY_EVERY_MS = 45000;
const SOFT_RELOAD_RETRY_EVERY_MS = 35000;
const COOKIE_ONLY_AFTER_MS = 40000;

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

/** 登录页已抓到的 mtgsig 立刻写入 session_cache，避免换机后 /api/refresh 再无头抓签失败 */
function persistLoginCapturedSignature(dataDir, capabilities = {}) {
  const headers = capabilities?.signatureHeaders;
  const mtgsig = headers?.mtgsig;
  if (!dataDir || !mtgsig) return false;
  const movieId = String(capabilities.verifyMovieId || FALLBACK_VERIFY_MOVIE_ID);
  const boxLevel = "1";
  const cacheDir = path.join(dataDir, "session_cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, `${movieId}_${boxLevel}.json`);
  const payload = {
    url:
      capabilities.signatureUrl ||
      `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=${movieId}&boxLevel=${boxLevel}&yodaReady=h5&csecplatform=4&csecversion=4.3.0`,
    method: "GET",
    query: {
      movieId,
      boxLevel,
      yodaReady: "h5",
      csecplatform: "4",
      csecversion: "4.3.0",
    },
    headers: { ...headers },
    captured_at: new Date().toISOString(),
    // sigManager.loadEntryFromFile 只接受 source=browser
    source: "browser",
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
  report("info", "login", `login_sig_cached movieId=${movieId} source=${capabilities.signatureSource || "login_browser"}`);
  return true;
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

/**
 * 对齐弹幕扫码：只用 cookies() 读登录态。
 * 禁止轮询调用 context.storageState()——Playwright 会临时开标签再关掉，造成闪动。
 */
const COOKIE_READ_URLS = [
  "https://piaofang.maoyan.com",
  "https://passport.maoyan.com",
  "https://www.maoyan.com",
  "https://meituan.com",
];

async function readContextState(context) {
  let cookies = [];
  try {
    cookies = await context.cookies(COOKIE_READ_URLS);
  } catch {
    cookies = await context.cookies();
  }
  return cookiesToStorageState(cookies);
}

/** 登录成功落盘时抓全量 storageState（含 origins/localStorage），仅调用一次 */
async function readContextStateForPersist(context) {
  try {
    const full = await context.storageState();
    if (full?.cookies?.length) return full;
  } catch {
    /* fallback */
  }
  return readContextState(context);
}

async function writeContextStateFile(context, filePath) {
  const state = await readContextState(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  return state;
}

async function verifyLiveLoginCapabilities(context, options = {}) {
  return verifyCapabilitiesInLiveContext(context, {
    ...options,
    noNavigation: true,
    noDashboardNavigation: true,
    checkDashboard: false,
  });
}

async function readLivePageLocation(context) {
  const pages = (context.pages?.() || []).filter((p) => {
    try {
      return p && !p.isClosed();
    } catch {
      return false;
    }
  });
  if (!pages.length) return { host: "", path: "", href: "", page: null };

  let page = pages[0];
  for (const candidate of pages) {
    try {
      const url = candidate.url();
      if (/piaofang\.maoyan\.com/i.test(url)) {
        page = candidate;
        break;
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const href = String(page.url() || "");
    const u = new URL(href);
    return { host: u.hostname, path: u.pathname, href, page };
  } catch {
    return { host: "", path: "", href: "", page };
  }
}

/**
 * 在用户当前标签页抓 mtgsig（不新开标签）。
 * 已在 box 页则纯 fetch；在票房域其它页允许一次 goto box（登录完成后仅一次跳转）。
 */
async function captureDetailOnLivePage(context) {
  const loc = await readLivePageLocation(context);
  if (!loc.page) {
    return { detailApiReady: false, lastVerifyError: "no_live_page" };
  }
  if (!loc.host || isMaoyanLoginRedirect(loc.host, loc.path)) {
    return { detailApiReady: false, loginRequired: true, lastVerifyError: "login_required" };
  }
  if (!String(loc.host).includes("piaofang")) {
    return { detailApiReady: false, lastVerifyError: "waiting_piaofang_page" };
  }

  const alreadyOnBox = /\/imovie\/\d+\/box|\/box/i.test(loc.path);
  const detail = await verifyDetailOnBoxPage(loc.page, FALLBACK_VERIFY_MOVIE_ID, "1", {
    noNavigation: alreadyOnBox,
  });
  return detail;
}

async function persistLoginState(context, storageStatePath, options = {}) {
  const allowCookieOnly = options.allowCookieOnly === true;
  const preVerified = options.preVerifiedCapabilities;

  let capabilities = preVerified;
  if (!allowCookieOnly && !capabilities?.detailApiReady) {
    capabilities = await verifyLiveLoginCapabilities(context, {
      dataDir: options.dataDir || path.dirname(storageStatePath),
    });
  }
  if (!allowCookieOnly && !capabilities?.detailApiReady) {
    throw new Error("detail_api_not_ready");
  }

  const state = await readContextStateForPersist(context);
  const hasIdentity = storageStateLooksLoggedIn(state);
  const detailReady = Boolean(capabilities?.detailApiReady);
  const maoyanCookieCount = getMaoyanCookies(state).length;
  // detail API 已通 = 浏览器内会话有效，允许落盘（含 origins/localStorage）
  const canPersist =
    detailReady || hasIdentity || (allowCookieOnly && maoyanCookieCount > 0 && hasIdentity);
  if (!canPersist) {
    const summary = summarizeCookieNames(state);
    report(
      "warn",
      "login",
      `persist_blocked cookies=${summary.total} identity=${summary.identityCount} names=${summary.names.join(",")}`,
    );
    throw new Error("login cookies missing");
  }

  const pendingPath = pendingStoragePath(storageStatePath);
  discardPendingStorageState(storageStatePath);
  fs.writeFileSync(pendingPath, JSON.stringify(state, null, 2), "utf-8");
  const pendingState = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
  const pendingLooksLoggedIn =
    storageStateLooksLoggedIn(pendingState) ||
    detailReady ||
    getMaoyanCookies(pendingState).length > 0;
  if (!pendingLooksLoggedIn) {
    discardPendingStorageState(storageStatePath);
    throw new Error("login cookies missing");
  }

  commitPendingStorageState(storageStatePath);

  try {
    persistLoginCapturedSignature(options.dataDir || path.dirname(storageStatePath), capabilities);
  } catch {
    /* 签名落盘失败不阻塞登录 */
  }

  try {
    const dataDir = options.dataDir || path.dirname(storageStatePath);
    const { saveSessionCapability } = require("./session-persist");
    saveSessionCapability(dataDir, {
      capability: {
        ...(capabilities || {}),
        loginCookieReady: true,
        accountLoggedIn: true,
        detailApiReady: Boolean(capabilities?.detailApiReady),
        productionDetailReady: Boolean(capabilities?.detailApiReady),
        signatureReady: Boolean(
          capabilities?.detailApiReady || capabilities?.signatureCaptured || capabilities?.signatureHeaders?.mtgsig,
        ),
        signatureCaptured: Boolean(
          capabilities?.signatureCaptured || capabilities?.signatureHeaders?.mtgsig,
        ),
        detailPayloadValid: Boolean(capabilities?.detailApiReady),
        loginRequired: false,
        lastVerifyError: capabilities?.lastVerifyError || null,
      },
      lastDetailApiSuccessAt: capabilities?.detailApiReady
        ? new Date().toISOString()
        : null,
      savedAt: new Date().toISOString(),
    });
  } catch {
    /* 持久化失败不阻塞登录落盘 */
  }

  return {
    ...(capabilities || {}),
    loginCookieReady: true,
    productionDetailReady: Boolean(capabilities?.detailApiReady),
    detailApiReady: Boolean(capabilities?.detailApiReady),
    accountLoggedIn: true,
    sessionUsable: Boolean(capabilities?.detailApiReady),
    productionError: null,
  };
}

async function closeLoginSession(context, browser, child = null, options = {}) {
  const debugPort = Number(options.debugPort) || 0;
  const browserPids = Array.isArray(options.browserPids) ? options.browserPids : [];

  const closeWithTimeout = async (label, fn) => {
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label}_timeout`)), BROWSER_CLOSE_TIMEOUT_MS),
        ),
      ]);
    } catch {
      /* CDP close 常在 Windows stub 场景下挂起，改走强杀 */
    }
  };

  await closeWithTimeout("browser_close", async () => {
    if (browser) await browser.close();
  });
  await closeWithTimeout("context_close", async () => {
    if (context && (!browser || context !== browser)) {
      await context.close();
    }
  });

  // 先杀已知浏览器 PID（stub 退出后真正的 chrome），再杀 spawn 子进程，最后按端口兜底
  for (const pid of browserPids) {
    safeKillPid(pid);
  }
  safeKillProcess(child);
  if (debugPort > 0) {
    killProcessesOnPort(debugPort);
  }
  report(
    "info",
    "login",
    `login_browser_closed port=${debugPort || "-"} pids=${browserPids.join(",") || "-"}`,
  );
}

function loginEstablishedDuringSession(state, baselineFingerprint, requireFreshLogin) {
  if (!storageStateLooksLoggedIn(state) && !storageStateHasPersistableCookies(state)) {
    return false;
  }
  if (!requireFreshLogin) return true;
  // 空基线（刚清 profile）时，只要有可用 Cookie 就算本轮新登录
  if (!baselineFingerprint) return true;
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
  const childChrome = options.childChrome || null;
  let baselineFingerprint = "";
  try {
    baselineFingerprint = loginFingerprint(await readContextState(context));
  } catch {
    baselineFingerprint = "";
  }

  let loginTimeout = null;
  let settled = false;
  let stableHits = 0;
  let lastCapabilities = null;
  let boxNavAttempted = false;
  let softReloadAttempted = false;
  let lastDiagAt = 0;
  let lastBoxNavAt = 0;
  let lastSoftReloadAt = 0;
  let piaofangSince = 0;

  const stopTimers = () => {
    if (loginTimeout) clearTimeout(loginTimeout);
    loginTimeout = null;
  };

  const logLoginDiag = (reason, state, loc, extra = "") => {
    const now = Date.now();
    if (now - lastDiagAt < DIAG_LOG_EVERY_MS && reason !== "detail_ready" && reason !== "cookie_only_ready") {
      return;
    }
    lastDiagAt = now;
    const summary = summarizeCookieNames(state);
    const msg = [
      `LOGIN_WAIT ${reason}`,
      `host=${loc?.host || "-"}`,
      `path=${loc?.path || "-"}`,
      `cookies=${summary.total}`,
      `identity=${summary.identityCount}`,
      `names=${summary.names.slice(0, 20).join(",") || "-"}`,
      extra,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(msg);
    report("info", "login", msg);
  };

  const checkVerifiedLogin = async () => {
    const { result, reused } = await runLoginVerifySingleflight(async () => {
      // 只用 cookies()，绝不 storageState()（会闪标签）
      const state = await readContextState(context);
      const loc = await readLivePageLocation(context);

      if (!loc.host || isMaoyanLoginRedirect(loc.host, loc.path)) {
        piaofangSince = 0;
        logLoginDiag("waiting_login_page", state, loc);
        return null;
      }
      if (!String(loc.host).includes("piaofang") || !loc.page) {
        piaofangSince = 0;
        logLoginDiag("waiting_piaofang", state, loc);
        return null;
      }

      if (!piaofangSince) piaofangSince = Date.now();

      const cookieReady =
        loginEstablishedDuringSession(state, baselineFingerprint, requireFreshLogin) ||
        storageStateHasPersistableCookies(state);

      // 关键：先以票房页 detail/mtgsig 能力为准。
      const alreadyOnBox = /\/imovie\/\d+\/box|\/box/i.test(loc.path);
      const now = Date.now();
      const allowBoxNav =
        !alreadyOnBox && (!boxNavAttempted || now - lastBoxNavAt >= BOX_NAV_RETRY_EVERY_MS);
      const allowSoftReload =
        alreadyOnBox && (!softReloadAttempted || now - lastSoftReloadAt >= SOFT_RELOAD_RETRY_EVERY_MS);

      const pageMovieMatch = String(loc.path || "").match(/\/imovie\/(\d+)/i);
      const verifyMovieId = pageMovieMatch?.[1] || FALLBACK_VERIFY_MOVIE_ID;

      let detail = await verifyDetailOnBoxPage(loc.page, verifyMovieId, "1", {
        noNavigation: true,
        allowSoftReload,
      });
      if (detail?.softReloaded) {
        softReloadAttempted = true;
        lastSoftReloadAt = now;
      }

      if (!detail.detailApiReady && allowBoxNav) {
        boxNavAttempted = true;
        lastBoxNavAt = now;
        detail = await verifyDetailOnBoxPage(loc.page, verifyMovieId, "1", {
          noNavigation: false,
          allowSoftReload: false,
        });
      }

      if (detail.detailApiReady) {
        const hasAnyMaoyanCookies = getMaoyanCookies(state).length > 0;
        if (!cookieReady && !hasAnyMaoyanCookies) {
          logLoginDiag("detail_ok_waiting_cookies", state, loc, detail.signatureSource || "");
          return null;
        }
        logLoginDiag("detail_ready", state, loc, detail.signatureSource || detail.lastVerifyError || "");
        const capabilities = {
          identityCookieExists: storageStateLooksLoggedIn(state) || storageStateHasPersistableCookies(state),
          loginCookieReady: true,
          cookieLoginReady: true,
          accountLoggedIn: true,
          detailApiReady: true,
          signatureCaptured: Boolean(detail.signatureCaptured),
          signatureHeaders: detail.signatureHeaders || null,
          signatureUrl: detail.signatureUrl || null,
          signatureSource: detail.signatureSource || null,
          verifyMovieId: detail.verifyMovieId || verifyMovieId,
          sessionUsable: true,
          lastVerifyError: null,
          allowCookieOnly: false,
        };
        lastCapabilities = capabilities;
        return capabilities;
      }

      logLoginDiag("detail_not_ready", state, loc, detail.lastVerifyError || "");

      // 已在票房域且已有强身份 Cookie：可先落盘关浏览器，签名交给本地服务后续抓取
      // 禁止仅用 tracking Cookie 走 cookie_only（会导致“登录成功”但明日/后天全空）
      if (
        cookieReady &&
        storageStateLooksLoggedIn(state) &&
        piaofangSince &&
        now - piaofangSince >= COOKIE_ONLY_AFTER_MS &&
        !isMaoyanLoginRedirect(loc.host, loc.path)
      ) {
        logLoginDiag("cookie_only_ready", state, loc, `waited=${now - piaofangSince}ms`);
        const capabilities = {
          identityCookieExists: true,
          loginCookieReady: true,
          cookieLoginReady: true,
          accountLoggedIn: true,
          detailApiReady: false,
          signatureCaptured: false,
          sessionUsable: false,
          lastVerifyError: detail.lastVerifyError || "mtgsig_deferred",
          allowCookieOnly: true,
        };
        lastCapabilities = capabilities;
        return capabilities;
      }

      return null;
    });
    return { capabilities: result, reused };
  };

  const finishLoginSave = async (preVerified) => {
    const cookieOnly = preVerified?.allowCookieOnly === true && !preVerified?.detailApiReady;
    const capabilities = await persistLoginState(context, storageStatePath, {
      dataDir,
      allowCookieOnly: cookieOnly,
      preVerifiedCapabilities: preVerified,
    });
    await new Promise((resolve) => setTimeout(resolve, AUTO_CLOSE_DELAY_MS));
    await closeLoginSession(context, browser, childChrome, {
      debugPort: options.debugPort,
      browserPids: options.browserPids,
    });

    return {
      ok: true,
      detailApiReady: Boolean(capabilities?.detailApiReady),
      productionDetailReady: Boolean(capabilities?.detailApiReady),
      liveDetailApiReady: Boolean(capabilities?.detailApiReady),
      loginCookieReady: true,
      accountLoggedIn: true,
      autoClosed: true,
      capabilities,
    };
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

    if (
      reason !== "manual_close" &&
      reason &&
      (reason.detailApiReady || reason.allowCookieOnly || reason.loginCookieReady)
    ) {
      return await finishLoginSave(reason);
    }

    const finalCheck = await checkVerifiedLogin().catch(() => ({ capabilities: null }));
    const finalCapabilities = finalCheck.capabilities || lastCapabilities;
    if (
      finalCapabilities?.detailApiReady ||
      finalCapabilities?.allowCookieOnly ||
      finalCapabilities?.loginCookieReady
    ) {
      try {
        return await finishLoginSave(finalCapabilities);
      } catch (error) {
        return {
          ok: false,
          code: "login_failed",
          detail: error.message || "保存登录状态失败",
        };
      }
    }

    return {
      ok: false,
      code: "login_cancelled",
      detail: "未完成登录",
    };
  } catch (error) {
    try {
      await closeLoginSession(context, browser, childChrome, {
        debugPort: options.debugPort,
        browserPids: options.browserPids,
      });
    } catch {
      /* ignore */
    }
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
  verifyLiveLoginCapabilities,
  persistLoginState,
  waitForBrowserLoginAndSave,
  cleanupInvalidLoginState,
  pendingStoragePath,
  backupStoragePath,
  commitPendingStorageState,
  discardPendingStorageState,
  runLoginVerifySingleflight,
  readContextState,
  writeContextStateFile,
  _resetLoginVerifyInflight,
  _getLoginVerifyInflight,
  _getStableLoginHitsForTest,
};
