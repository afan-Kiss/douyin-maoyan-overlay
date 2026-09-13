const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const { ensureChromePath, clearChromePath } = require("./browser-path");
const { launchLoginBrowser } = require("./chrome-launcher");
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

function resetLoginProfile(profileDir, storageState, relogin) {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (relogin) {
    cleanupInvalidLoginState(storageState);
  }
}

async function openLoginPage(launched, loginUrl) {
  if (launched.mode === "persistent") {
    const context = launched.context;
    const browser = launched.browser || context.browser();
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.bringToFront().catch(() => {});
    return { context, browser, page, child: null };
  }

  const browser = launched.browser;
  const context = await browser.newContext({ locale: "zh-CN", userAgent: USER_AGENT });
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.bringToFront().catch(() => {});
  return { context, browser, page, child: launched.child || null };
}

async function closeLoginBrowser(session) {
  if (!session) return;
  try {
    await session.context.close();
  } catch {
    /* already closed */
  }
  try {
    if (session.browser) await session.browser.close();
  } catch {
    /* already closed */
  }
  if (session.child && !session.child.killed) {
    session.child.kill();
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

  resetLoginProfile(profileDir, storageState, relogin);

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
    });
    session = await openLoginPage(launched, loginUrl);

    (async () => {
      let result;
      try {
        result = await waitForBrowserLoginAndSave(session.context, session.browser, storageState, {
          requireFreshLogin: true,
        });
        if (result.ok && result.detailApiReady) {
          console.log("猫眼登录信息已保存");
          emitLoginResult({
            ok: true,
            detailApiReady: true,
            accountLoggedIn: result.accountLoggedIn,
          });
        } else {
          cleanupInvalidLoginState(storageState);
          emitLoginResult(
            result.ok === false
              ? result
              : {
                  ok: false,
                  code: "login_failed",
                  detail: "未检测到有效猫眼登录状态，请重新登录",
                },
          );
        }
      } catch (error) {
        console.warn("猫眼登录失败:", error.message);
        cleanupInvalidLoginState(storageState);
        emitLoginResult({
          ok: false,
          code: error?.code === "login_timeout" ? "login_timeout" : "login_failed",
          detail: error?.message || "登录失败",
        });
      } finally {
        await closeLoginBrowser(session);
        clearLoginLock(dataDir);
        loginRunning = false;
        restoreAlwaysOnTop(restoreOnTopWindow);
      }
    })();

    return {
      ok: true,
      pending: true,
      browserPath: chromePath,
      message: "已打开浏览器，请完成登录，成功后窗口将自动关闭",
    };
  } catch (error) {
    clearLoginLock(dataDir);
    loginRunning = false;
    restoreAlwaysOnTop(restoreOnTopWindow);
    await closeLoginBrowser(session);
    clearChromePath(dataDir);
    reportError("login", error, { chromePath });
    console.warn("打开登录浏览器失败:", error.message);
    const detail =
      `打开浏览器失败: ${formatLaunchError(error)}。` +
      "已清除保存的浏览器路径，请重新点击「登录」并选择官方 Google Chrome";
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
