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

function waitForPort(port, timeoutMs = 20000) {
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

async function launchViaPersistentContext(chromePath, profileDir, userAgent) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    locale: "zh-CN",
    userAgent,
    viewport: null,
    args: LOGIN_CHROME_ARGS,
  });
  return { mode: "persistent", context, browser: context.browser(), child: null };
}

async function launchViaPlaywright(chromePath, userAgent) {
  const attempts = [
    {
      args: LOGIN_CHROME_ARGS,
    },
    {
      ignoreDefaultArgs: true,
      args: [
        ...LOGIN_CHROME_ARGS,
        "--disable-blink-features=AutomationControlled",
      ],
    },
    {
      ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
      args: LOGIN_CHROME_ARGS,
    },
  ];

  let lastError = null;
  for (const options of attempts) {
    try {
      const browser = await chromium.launch({
        headless: false,
        executablePath: chromePath,
        ...options,
      });
      return { mode: "ephemeral", browser, context: null, child: null };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法启动浏览器");
}

async function launchViaCdp(chromePath, profileDir) {
  const port = await getFreePort();
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    ...LOGIN_CHROME_ARGS,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  await waitForPort(port).catch(async (error) => {
    if (!exited) child.kill();
    throw error;
  });

  if (exited) {
    throw new Error("浏览器进程启动后立即退出，请安装官方 Google Chrome");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return { mode: "cdp", browser, context: null, child };
}

async function launchLoginBrowser(chromePath, profileDir, options = {}) {
  const userAgent = options.userAgent || "";
  const errors = [];

  try {
    return await launchViaPersistentContext(chromePath, profileDir, userAgent);
  } catch (error) {
    errors.push(error);
  }

  try {
    return await launchViaPlaywright(chromePath, userAgent);
  } catch (error) {
    errors.push(error);
  }

  try {
    return await launchViaCdp(chromePath, profileDir);
  } catch (error) {
    errors.push(error);
    const last = errors[errors.length - 1];
    const first = errors[0];
    const msg = String(last?.message || last);
    const extra = String(first?.message || first);
    throw new Error(
      msg.includes("立即退出")
        ? msg
        : extra.split("\n")[0] || msg.split("\n")[0] || "无法启动浏览器",
    );
  }
}

module.exports = {
  launchLoginBrowser,
};
