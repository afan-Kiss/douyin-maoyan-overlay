const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const { ensureChromePath, clearChromePath, validateChromeExecutable } = require("./browser-path");
const { launchLoginBrowser, safeKillProcess } = require("./chrome-launcher");
const { reportError } = require("./client-logger");
const {
  waitForBrowserLoginAndSave,
  cleanupInvalidLoginState,
} = require("./login-browser");
const { writeLoginLock, clearLoginLock } = require("./login-lock");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const BOX_PAGE = (movieId) =>
  `https://piaofang.maoyan.com/i/imovie/${movieId}/box?barTheme=592828`;

const loginEvents = new EventEmitter();
loginEvents.setMaxListeners(20);

let loginRunning = false;
let pickInProgress = false;

function formatLaunchError(error) {
  let msg = String(error?.message || error || "未知错误");
  for (const marker of ["Browser logs:", "Call log:"]) {
    const idx = msg.indexOf(marker);
    if (idx > 0) msg = msg.slice(0, idx).trim();
  }
  msg = msg.split(/\r?\n/)[0] || msg;
  return msg
    .replace(/playwright/gi, "浏览器引擎")
    .replace(/browserType\.launch:\s*/gi, "")
    .replace(/executable/i, "可执行文件")
    .trim();
}

function emitLoginResult(result) {
  loginEvents.emit("result", result);
}

function onLoginResult(callback) {
  loginEvents.on("result", callback);
  return () => loginEvents.off("result", callback);
}

function suspendAlwaysOnTop(parentWindow) {
  if (!parentWindow || parentWindow.isDestroyed()) return null;
  const wasOnTop = parentWindow.isAlwaysOnTop();
  if (wasOnTop) parentWindow.setAlwaysOnTop(false);
  return wasOnTop ? parentWindow : null;
}

function restoreAlwaysOnTop(parentWindow) {
  if (!parentWindow || parentWindow.isDestroyed()) return;
  parentWindow.setAlwaysOnTop(true);
}

function resetLoginProfile(profileDir, storageState) {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  cleanupInvalidLoginState(storageState);
}

/**
 * 对齐弹幕扫码：复用启动时的唯一标签，绝不 newContext / 绝不批量关页（会闪标签）。
 */
async function openLoginPage(launched, loginUrl) {
  const browser = launched.browser || launched.context?.browser?.() || null;
  const context =
    launched.context ||
    (browser?.contexts?.()?.[0] ?? null);
  if (!context) {
    throw new Error("浏览器上下文不可用");
  }

  let page = launched.page || null;
  if (!page || page.isClosed?.()) {
    const pages = context.pages().filter((p) => {
      try {
        return p && !p.isClosed();
      } catch {
        return false;
      }
    });
    page = pages[0] || null;
  }

  // 仅在完全没有标签时才 newPage（正常 CDP 启动已带目标 URL）
  if (!page) {
    page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  } else {
    let current = "";
    try {
      current = String(page.url() || "");
    } catch {
      current = "";
    }
    const needsGoto =
      !current ||
      /about:blank|^chrome:\/\/|^chrome-error:\/\//i.test(current) ||
      (!/maoyan\.com|meituan\.com/i.test(current) && current !== loginUrl);
    if (needsGoto) {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    }
  }

  await page.bringToFront().catch(() => {});
  return {
    context,
    browser: browser || context.browser(),
    page,
    child: launched.child || null,
  };
}

async function closeLoginBrowser(session) {
  if (!session) return;
  // 先断 CDP，再杀进程；不要逐个关标签（会闪）
  try {
    if (session.browser) await session.browser.close();
  } catch {
    /* already closed */
  }
  try {
    if (session.context && session.context !== session.browser) {
      await session.context.close();
    }
  } catch {
    /* already closed */
  }
  if (session.child && !session.child.killed) {
    safeKillProcess(session.child);
  }
}

async function runMaoyanLogin(dataDir, options = {}) {
  if (loginRunning) {
    return {
      ok: false,
      code: "login_in_progress",
      detail: "登录浏览器已在打开中，请先完成登录或关闭浏览器窗口",
    };
  }
  if (pickInProgress) {
    return { ok: false, code: "login_in_progress", detail: "正在选择浏览器，请稍候…" };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const storageState = path.join(dataDir, "browser_state.json");
  const profileDir = path.join(dataDir, "login-profile");
  const parentWindow = options.parentWindow || null;
  const relogin = options.relogin === true;

  resetLoginProfile(profileDir, storageState);

  let chromePath;
  pickInProgress = true;
  try {
    chromePath = await ensureChromePath(dataDir, { parentWindow });
  } catch (error) {
    return {
      ok: false,
      code: "browser_launch_failed",
      detail: `选择浏览器失败: ${error.message}`,
    };
  } finally {
    pickInProgress = false;
  }

  if (!chromePath) {
    return {
      ok: false,
      code: "chrome_not_found",
      detail: "未找到浏览器。请安装 Google Chrome，或点击登录后手动选择 chrome.exe",
    };
  }

  loginRunning = true;
  writeLoginLock(dataDir);
  const restoreOnTopWindow = suspendAlwaysOnTop(parentWindow);
  let session = null;

  try {
    const loginUrl = BOX_PAGE("1462628");
    const launched = await launchLoginBrowser(chromePath, profileDir, {
      userAgent: USER_AGENT,
      startUrl: loginUrl,
    });
    session = await openLoginPage(launched, loginUrl);

    (async () => {
      let emitPayload = null;
      try {
        const result = await waitForBrowserLoginAndSave(session.context, session.browser, storageState, {
          requireFreshLogin: true,
          dataDir,
          childChrome: session.child || null,
        });
        const detailReady = Boolean(result.detailApiReady || result.liveDetailApiReady);
        const { storageFileLooksLoggedIn } = require("./storage-auth");
        const identityOk = storageFileLooksLoggedIn(storageState);
        // 明细已通，或已有强身份 Cookie（签名可延后抓）：算登录成功
        // 禁止仅 tracking Cookie + loginCookieReady 冒充成功
        if (result.ok && (detailReady || (result.loginCookieReady && identityOk))) {
          console.log("猫眼登录信息已保存");
          try {
            const { mergeSessionStatus } = require("./session-status");
            mergeSessionStatus({
              storageStateExists: true,
              identityCookieExists: identityOk,
              loginCookieReady: true,
              detailApiReady: detailReady,
              productionDetailReady: Boolean(result.productionDetailReady || detailReady),
              browserSessionVerified: detailReady,
              signatureReady: detailReady,
              accountLoggedIn: true,
              sessionUsable: detailReady,
              loginRequired: false,
              lastVerifyError: detailReady ? null : result.lastVerifyError || "mtgsig_deferred",
              lastVerifyAt: new Date().toISOString(),
            });
          } catch (error) {
            console.warn("登录成功后更新会话状态失败:", error?.message || error);
          }
          emitPayload = {
            ok: true,
            detailApiReady: detailReady,
            loginCookieReady: true,
            accountLoggedIn: true,
            loggedIn: true,
            deferredDetail: !detailReady,
          };
        } else if (result.ok && result.loginCookieReady && !identityOk) {
          cleanupInvalidLoginState(storageState);
          emitPayload = {
            ok: false,
            code: "login_incomplete",
            detail: "未检测到猫眼账号登录态，请在打开的浏览器里完成登录后再试",
          };
        } else {
          cleanupInvalidLoginState(storageState);
          emitPayload =
            result.ok === false
              ? result
              : {
                  ok: false,
                  code: "login_failed",
                  detail: "未检测到有效猫眼登录状态，请重新登录",
                };
        }
      } catch (error) {
        console.warn("猫眼登录失败:", error.message);
        cleanupInvalidLoginState(storageState);
        emitPayload = {
          ok: false,
          code: error?.code === "login_timeout" ? "login_timeout" : "login_failed",
          detail: error?.message || "登录失败",
        };
      } finally {
        await closeLoginBrowser(session);
        clearLoginLock(dataDir);
        loginRunning = false;
        restoreAlwaysOnTop(restoreOnTopWindow);
        if (emitPayload) emitLoginResult(emitPayload);
      }
    })();

    return {
      ok: true,
      pending: true,
      browserPath: chromePath,
      message: "已打开票房页，若出现登录页请完成猫眼账号登录，成功后窗口将自动关闭",
    };
  } catch (error) {
    clearLoginLock(dataDir);
    loginRunning = false;
    restoreAlwaysOnTop(restoreOnTopWindow);
    await closeLoginBrowser(session);
    // 仅在可执行文件确实无效时清路径；不要把「stub 退出误判」搞成反复重选官方浏览器
    if (!validateChromeExecutable(chromePath)) {
      clearChromePath(dataDir);
    }
    reportError("login", error, { chromePath });
    console.warn("打开登录浏览器失败:", error.message);
    const detail =
      `打开浏览器失败: ${formatLaunchError(error)}。` +
      "请先关掉所有登录用 Chrome 窗口后，再点一次「登录」。若仍失败，可手动选择本机的 chrome.exe。";
    emitLoginResult({
      ok: false,
      code: "browser_launch_failed",
      detail,
    });
    return {
      ok: false,
      code: "browser_launch_failed",
      detail,
    };
  }
}

function isLoginRunning() {
  return loginRunning;
}

module.exports = {
  runMaoyanLogin,
  isLoginRunning,
  onLoginResult,
  emitLoginResult,
};
