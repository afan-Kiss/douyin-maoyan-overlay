/**
 * 登录浏览器启动（对齐「抖音网页弹幕」扫码登录：CDP 单标签、不反复 newPage/关页）。
 * 优先 spawn Chrome + connectOverCDP；失败再回退 Playwright persistent。
 */
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const LOGIN_CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-restore-session-state",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  // Chrome 111+：允许 Playwright 等非浏览器客户端连 CDP，否则端口开了也连不上
  "--remote-allow-origins=*",
  // 不要加 AutomationControlled：Chrome 会弹黄条，且对猫眼登录无帮助
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryConnect = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error("浏览器调试端口连接超时"));
          return;
        }
        setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeKillProcess(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    child.kill();
  } catch {
    /* ignore */
  }
}

async function waitForDefaultContext(browser, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const contexts = browser.contexts();
    if (contexts.length) {
      const context = contexts[0];
      const pages = context.pages();
      if (pages.length) {
        return { context, page: pages[0] };
      }
    }
    await sleep(100);
  }
  throw new Error("浏览器未就绪（无默认标签页）");
}

/**
 * 对齐弹幕项目 rod launcher：独立 user-data-dir + remote debugging，启动时只开一个目标 URL。
 *
 * 注意：Windows 上 chrome.exe 经常是「启动器 stub」——真正浏览器起来后 stub 会退出。
 * 只要调试端口还在，就必须继续 connectOverCDP，不能把 stub 退出当成启动失败。
 */
async function launchViaCdp(chromePath, profileDir, startUrl) {
  const port = await getFreePort();
  fs.mkdirSync(profileDir, { recursive: true });

  const target = String(startUrl || "").trim() || "about:blank";
  const args = [
    `--remote-debugging-port=${port}`,
    ...LOGIN_CHROME_ARGS,
    `--user-data-dir=${profileDir}`,
    target,
  ];

  let spawnError = null;
  const child = spawn(chromePath, args, {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  // stub 退出是正常现象，仅作日志，不据此判定失败
  let stubExited = false;
  child.once("exit", () => {
    stubExited = true;
  });

  try {
    await waitForPort(port);
  } catch (error) {
    safeKillProcess(child);
    if (spawnError) {
      throw new Error(`无法启动浏览器: ${spawnError.message}`);
    }
    throw new Error(
      stubExited
        ? "浏览器未能打开调试端口（进程已退出）。请确认选择的是 chrome.exe，并关闭其它占用同一登录配置的 Chrome 窗口后重试"
        : `浏览器调试端口未就绪: ${error.message}`,
    );
  }

  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 20000,
    });
    const { context, page } = await waitForDefaultContext(browser);
    return { mode: "cdp", browser, context, page, child, debugPort: port };
  } catch (error) {
    safeKillProcess(child);
    throw new Error(`浏览器已启动但无法连接调试端口: ${String(error.message || error).split("\n")[0]}`);
  }
}

async function launchViaPersistentContext(chromePath, profileDir, userAgent, startUrl) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    locale: "zh-CN",
    userAgent: userAgent || undefined,
    viewport: null,
    args: LOGIN_CHROME_ARGS,
  });
  const browser = context.browser();
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  const target = String(startUrl || "").trim();
  if (target && target !== "about:blank") {
    const current = String(page.url() || "");
    if (/about:blank|^chrome:\/\//i.test(current) || !current) {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 120000 });
    }
  }
  return { mode: "persistent", context, browser, page, child: null };
}

/**
 * @param {string} chromePath
 * @param {string} profileDir
 * @param {{ userAgent?: string, startUrl?: string }} options
 */
async function launchLoginBrowser(chromePath, profileDir, options = {}) {
  const userAgent = options.userAgent || "";
  const startUrl = options.startUrl || "";
  const errors = [];

  // 与弹幕扫码一致：CDP 单标签优先，避免 Playwright newContext 另开窗口/闪标签
  try {
    return await launchViaCdp(chromePath, profileDir, startUrl);
  } catch (error) {
    errors.push(error);
  }

  try {
    return await launchViaPersistentContext(chromePath, profileDir, userAgent, startUrl);
  } catch (error) {
    errors.push(error);
    const last = errors[errors.length - 1];
    const first = errors[0];
    const msg = String(last?.message || last);
    const extra = String(first?.message || first);
    throw new Error(extra.split("\n")[0] || msg.split("\n")[0] || "无法启动浏览器");
  }
}

module.exports = {
  launchLoginBrowser,
  launchViaCdp,
  LOGIN_CHROME_ARGS,
  safeKillProcess,
};
