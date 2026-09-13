const fs = require("fs");
const {
  storageStateLooksLoggedIn,
  storageFileLooksLoggedIn,
  loginFingerprint,
} = require("./storage-auth");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SAVE_INTERVAL_MS = 1500;
const LOGIN_POLL_MS = 800;
const STABLE_LOGIN_HITS = 2;
const AUTO_CLOSE_DELAY_MS = 600;

const DASHBOARD_VERIFY_URL =
  "https://piaofang.maoyan.com/i/api/dashboard-ajax/movie?orderType=0&channelId=40009&sVersion=2&WuKongReady=h5";

async function waitForBrowserClose(browser, timeoutMs = LOGIN_TIMEOUT_MS) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("login timeout")), timeoutMs);
    browser.once("disconnected", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * 在浏览器上下文中请求大盘接口，验证猫眼账号会话是否有效。
 * 普通设备/追踪 Cookie 无法通过此检查。
 */
async function verifyLoginInContext(context) {
  let page;
  let created = false;
  try {
    const pages = context.pages();
    page = pages.length ? pages[0] : null;
    if (!page) {
      page = await context.newPage();
      created = true;
      await page.goto("https://piaofang.maoyan.com/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
          return { ok: false, status: resp.status };
        }
        const data = await resp.json();
        const list = data?.movieList?.list;
        if (Array.isArray(list) && list.length > 0) {
          return { ok: true };
        }
        return { ok: false, reason: "empty_movie_list" };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
      }
    }, DASHBOARD_VERIFY_URL);

    return result.ok === true;
  } catch {
    return false;
  } finally {
    if (created && page) {
      await page.close().catch(() => {});
    }
  }
}

async function persistLoginState(context, storageStatePath) {
  await context.storageState({ path: storageStatePath });
  const verified = await verifyLoginInContext(context);
  if (!verified) {
    throw new Error("login_not_verified");
  }
  if (!storageFileLooksLoggedIn(storageStatePath)) {
    throw new Error("login cookies missing");
  }
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

async function waitForBrowserLoginAndSave(context, browser, storageStatePath, options = {}) {
  const requireFreshLogin = options.requireFreshLogin === true;
  let baselineFingerprint = "";
  try {
    baselineFingerprint = loginFingerprint(await context.storageState());
  } catch {
    baselineFingerprint = "";
  }

  let saveInterval = null;
  let pollTimer = null;
  let loginTimeout = null;
  let settled = false;
  let stableHits = 0;
  let lastVerified = false;

  const stopTimers = () => {
    if (saveInterval) clearInterval(saveInterval);
    saveInterval = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (loginTimeout) clearTimeout(loginTimeout);
    loginTimeout = null;
  };

  const checkVerifiedLogin = async () => {
    const state = await context.storageState();
    if (!loginEstablishedDuringSession(state, baselineFingerprint, requireFreshLogin)) {
      return false;
    }
    return verifyLoginInContext(context);
  };

  saveInterval = setInterval(async () => {
    try {
      if (await checkVerifiedLogin()) {
        await context.storageState({ path: storageStatePath });
      }
    } catch {
      /* browser may be closing */
    }
  }, SAVE_INTERVAL_MS);

  const waitForStableLogin = new Promise((resolve, reject) => {
    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const verified = await checkVerifiedLogin();
        if (verified) {
          stableHits += 1;
          lastVerified = true;
          if (stableHits >= STABLE_LOGIN_HITS) {
            settled = true;
            resolve("logged_in");
          }
        } else {
          stableHits = 0;
          lastVerified = false;
        }
      } catch {
        stableHits = 0;
        lastVerified = false;
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

    if (reason === "logged_in") {
      await persistLoginState(context, storageStatePath);
      await new Promise((resolve) => setTimeout(resolve, AUTO_CLOSE_DELAY_MS));
      await closeLoginSession(context, browser);
      return { ok: true, loggedIn: true, autoClosed: true };
    }

    if (lastVerified || (await checkVerifiedLogin().catch(() => false))) {
      try {
        await persistLoginState(context, storageStatePath);
        return { ok: true, loggedIn: true, autoClosed: false };
      } catch (error) {
        return {
          ok: false,
          code: "login_failed",
          detail: error.message === "login_not_verified"
            ? "未检测到有效猫眼登录状态，请重新登录"
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
  }
}

function cleanupInvalidLoginState(storageStatePath) {
  try {
    if (fs.existsSync(storageStatePath)) fs.unlinkSync(storageStatePath);
  } catch {
    /* ignore */
  }
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  DASHBOARD_VERIFY_URL,
  waitForBrowserClose,
  verifyLoginInContext,
  persistLoginState,
  waitForBrowserLoginAndSave,
  cleanupInvalidLoginState,
};
