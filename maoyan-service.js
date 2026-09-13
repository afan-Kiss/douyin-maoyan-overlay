const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { getRealExecutablePath } = require("./lib/update/paths");
const {
  getSessionStatus,
  scheduleBackgroundVerify,
  forceBackgroundVerify,
  syncSessionStatusFromServer,
  isVerifiedSession,
} = require("./lib/session-status");

const SERVER_DIR = path.join(__dirname, "server");
const LEGACY_DATA_DIR = path.join(__dirname, "data");
const CONFIG_INI = () => path.join(getDataDir(), "config.ini");

let maoyanProcess = null;
let startedByUs = false;
let ensurePromise = null;
let apiStatus = { ready: false, error: "", apiBase: "http://127.0.0.1:8765" };
let lastHealthCheckAt = 0;
let lastHealthCheckOk = false;
let healthCheckPromise = null;
let consecutiveHealthFails = 0;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_FAIL_THRESHOLD = 2;

let _spawnImpl = spawn;
let _checkHealthImpl = null;
let _testWaitForPidGoneFn = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isElectronPackaged() {
  try {
    const { app } = require("electron");
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

function getDataDir() {
  if (process.env.MAOYAN_DATA_DIR) {
    return process.env.MAOYAN_DATA_DIR;
  }

  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "maoyan-data");
    }
  } catch {
    /* not in electron */
  }

  const local = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (local) {
    return path.join(local, "MaoyanOverlay", "maoyan-data");
  }
  return LEGACY_DATA_DIR;
}

function migrateLegacyDataDir() {
  const target = getDataDir();
  if (target === LEGACY_DATA_DIR) return;
  try {
    fs.mkdirSync(target, { recursive: true });
    const legacyState = path.join(LEGACY_DATA_DIR, "browser_state.json");
    const targetState = path.join(target, "browser_state.json");
    if (fs.existsSync(legacyState) && !fs.existsSync(targetState)) {
      fs.copyFileSync(legacyState, targetState);
    }
    const legacyIni = path.join(LEGACY_DATA_DIR, "config.ini");
    const targetIni = path.join(target, "config.ini");
    if (fs.existsSync(legacyIni) && !fs.existsSync(targetIni)) {
      fs.copyFileSync(legacyIni, targetIni);
    }
  } catch {
    /* 迁移失败不阻塞启动 */
  }
}

function resolveNodeBin() {
  const candidates = [
    process.env.npm_node_execpath,
    process.env.NODE_BINARY,
    "node",
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin === "node") return bin;
    if (fs.existsSync(bin)) return bin;
  }
  return "node";
}

function isElectronMain() {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return false;
  try {
    const { app } = require("electron");
    return Boolean(app && typeof app.getPath === "function");
  } catch {
    return false;
  }
}

function getPackagedResourceRoots() {
  try {
    const { app } = require("electron");
    if (!app?.isPackaged) return null;
    const appPath = app.getAppPath();
    const unpackedRoot = appPath.endsWith(".asar")
      ? `${appPath.slice(0, -".asar".length)}.asar.unpacked`
      : appPath;
    return {
      appPath,
      unpackedRoot,
      nodeModules: path.join(appPath, "node_modules"),
    };
  } catch {
    return null;
  }
}

function resolveRuntime(serverDir) {
  const dir = serverDir || resolveMaoyanDir() || SERVER_DIR;
  const indexJs = path.join(dir, "index.js");
  const packaged = getPackagedResourceRoots();
  if (isElectronPackaged() && packaged) {
    const bin = getRealExecutablePath();
    return {
      bin,
      args: [indexJs],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PORTABLE_EXECUTABLE_FILE: process.env.PORTABLE_EXECUTABLE_FILE || bin,
        NODE_PATH: packaged.nodeModules,
      },
    };
  }
  const nodeBin = resolveNodeBin();
  return {
    bin: nodeBin,
    args: [indexJs],
    env: {},
  };
}

function readServerPort() {
  try {
    const configPath = CONFIG_INI();
    if (!fs.existsSync(configPath)) return 8765;
    const text = fs.readFileSync(configPath, "utf-8");
    const portMatch = text.match(/^\s*port\s*=\s*(\d+)\s*$/im);
    if (portMatch) {
      const port = Number(portMatch[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  } catch {
    /* use default */
  }
  return 8765;
}

function buildApiBase(config) {
  const port = readServerPort();
  const raw = String(config?.apiBase || "http://127.0.0.1:8765").replace(/\/$/, "");
  try {
    const url = new URL(raw);
    url.hostname = "127.0.0.1";
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

function resolveMaoyanDir() {
  const packaged = getPackagedResourceRoots();
  const candidates = packaged
    ? [path.join(packaged.unpackedRoot, "server"), SERVER_DIR]
    : [SERVER_DIR];
  for (const dir of candidates) {
    const indexFile = path.join(dir, "index.js");
    const libDir = path.join(dir, "lib");
    if (fs.existsSync(indexFile) && fs.existsSync(libDir)) {
      return dir;
    }
  }
  return null;
}

function hasServerDeps() {
  const packaged = getPackagedResourceRoots();
  const roots = [
    path.join(__dirname, "node_modules"),
    path.join(SERVER_DIR, "node_modules"),
  ];
  if (packaged) roots.unshift(packaged.nodeModules);
  return roots.some(
    (root) =>
      fs.existsSync(path.join(root, "express")) &&
      fs.existsSync(path.join(root, "playwright")),
  );
}

function isMaoyanLoggedIn() {
  return isVerifiedSession(getDataDir());
}

function getMaoyanSessionStatus() {
  return getSessionStatus(getDataDir());
}

function parsePortFromApiBase(apiBase) {
  try {
    const url = new URL(apiBase);
    return Number(url.port) || 8765;
  } catch {
    return 8765;
  }
}

function isPortListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function findListeningPids(port) {
  if (process.platform !== "win32") return [];
  return new Promise((resolve) => {
    const child = _spawnImpl("netstat", ["-ano"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", () => {
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING") || !line.includes(`:${port}`)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
    child.on("error", () => resolve([]));
  });
}

async function killListenersOnPort(port, exceptPid = 0) {
  const pids = await findListeningPids(port);
  let killed = false;
  for (const pid of pids) {
    if (pid === exceptPid || pid === process.pid) continue;
    try {
      if (process.platform === "win32") {
        _spawnImpl("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
      killed = true;
    } catch {
      /* ignore */
    }
  }
  if (killed) await sleep(600);
}

async function recoverStalePort(apiBase) {
  const port = parsePortFromApiBase(apiBase);
  if (!(await isPortListening(port))) return;
  if (await checkHealth(apiBase)) return;
  const exceptPid = maoyanProcess?.pid || 0;
  await killListenersOnPort(port, exceptPid);
}

function checkHealth(apiBase) {
  if (_checkHealthImpl) return _checkHealthImpl(apiBase);
  return new Promise((resolve) => {
    const url = `${apiBase}/health`;
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && data.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function handleMaoyanChildExit(child, code) {
  if (maoyanProcess !== child) return;
  maoyanProcess = null;
  if (startedByUs) {
    startedByUs = false;
    apiStatus.ready = false;
    if (code !== 0 && code !== null) {
      apiStatus.error = `票房服务异常退出 (code ${code})`;
    }
  }
}

function getServerLogPath() {
  const dir = path.join(getDataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "service-spawn.log");
}

function pipeChildLogs(child) {
  const logPath = getServerLogPath();
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const write = (chunk, label) => {
    const text = String(chunk || "").trim();
    if (!text) return;
    stream.write(`[${new Date().toISOString()}] [${label}] ${text}\n`);
  };
  child.stdout?.on("data", (chunk) => write(chunk, "stdout"));
  child.stderr?.on("data", (chunk) => write(chunk, "stderr"));
  child.on("close", () => stream.end());
}

function startMaoyanProcess(dir) {
  const runtime = resolveRuntime(dir);
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(spawnTimer);
      fn(value);
    };

    const spawnTimer = setTimeout(() => {
      finish(reject, new Error("票房服务进程启动超时"));
    }, 15_000);

    const child = _spawnImpl(runtime.bin, runtime.args, {
      cwd: dataDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...runtime.env,
        MAOYAN_DATA_DIR: dataDir,
        npm_node_execpath: runtime.bin,
      },
    });

    child.on("error", (error) => finish(reject, error));
    child.on("spawn", () => {
      pipeChildLogs(child);
      maoyanProcess = child;
      startedByUs = true;
      finish(resolve, child);
    });

    child.on("exit", (code) => {
      handleMaoyanChildExit(child, code);
    });
  });
}

async function waitForPidGone(pid, timeoutMs = 10000) {
  if (_testWaitForPidGoneFn) {
    return _testWaitForPidGoneFn(pid, timeoutMs);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pid) return true;
    const alive = await new Promise((resolve) => {
      try {
        process.kill(pid, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    if (!alive) return true;
    await sleep(100);
  }
  return false;
}

function shutdownMaoyanService() {
  if (!startedByUs || !maoyanProcess || maoyanProcess.killed) return;

  const pid = maoyanProcess.pid;

  try {
    maoyanProcess.kill("SIGTERM");
  } catch {
    /* noop */
  }

  if (process.platform === "win32" && pid) {
    try {
      _spawnImpl("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* noop */
    }
  }

  maoyanProcess = null;
  startedByUs = false;
}

async function shutdownMaoyanServiceAndWait(timeoutMs = 10000) {
  if (!startedByUs || !maoyanProcess) return true;

  const child = maoyanProcess;
  const pid = child.pid;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      /* noop */
    }
    if (process.platform === "win32" && pid) {
      try {
        _spawnImpl("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* noop */
      }
    }
    setTimeout(done, timeoutMs);
  });

  const gone = await waitForPidGone(pid, timeoutMs);
  if (gone) {
    if (maoyanProcess === child) {
      maoyanProcess = null;
      startedByUs = false;
      apiStatus.ready = false;
    }
    return true;
  }

  apiStatus.ready = false;
  apiStatus.error = "旧票房服务进程未能退出，请稍后重试";
  return false;
}

async function waitForHealth(apiBase, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    if (await checkHealth(apiBase)) return true;
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 1000);
  }
  return false;
}

async function ensureMaoyanService(config) {
  if (ensurePromise) return ensurePromise;

  ensurePromise = ensureMaoyanServiceInner(config).finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

async function ensureMaoyanServiceInner(config) {
  migrateLegacyDataDir();
  const apiBase = buildApiBase(config);
  apiStatus = { ready: false, error: "", apiBase, ...getMaoyanSessionStatus() };

  if (!hasServerDeps()) {
    apiStatus.error = "缺少依赖，请运行 setup.bat 完成安装";
    return apiStatus;
  }

  if (await checkHealth(apiBase)) {
    apiStatus.ready = true;
    Object.assign(apiStatus, getMaoyanSessionStatus());
    scheduleBackgroundVerify(apiBase, getDataDir());
    return apiStatus;
  }

  await recoverStalePort(apiBase);
  if (await checkHealth(apiBase)) {
    apiStatus.ready = true;
    Object.assign(apiStatus, getMaoyanSessionStatus());
    scheduleBackgroundVerify(apiBase, getDataDir());
    return apiStatus;
  }

  if (maoyanProcess) {
    const stopped = await shutdownMaoyanServiceAndWait();
    if (!stopped) {
      apiStatus.error = "旧票房服务进程未能退出，请稍后重试";
      return apiStatus;
    }
  }

  const maoyanDir = resolveMaoyanDir();
  if (!maoyanDir) {
    apiStatus.error = "内置票房服务缺失，请重新安装软件";
    return apiStatus;
  }

  try {
    await startMaoyanProcess(maoyanDir);
  } catch (e) {
    apiStatus.error = `启动票房服务失败: ${e.message}`;
    return apiStatus;
  }

  const ok = await waitForHealth(apiBase, 30000);
  if (ok) {
    apiStatus.ready = true;
    apiStatus.error = "";
    Object.assign(apiStatus, getMaoyanSessionStatus());
    scheduleBackgroundVerify(apiBase, getDataDir());
  } else {
    apiStatus.error = "票房服务启动超时，请检查端口占用或 Chrome 是否可用";
    await shutdownMaoyanServiceAndWait();
  }

  return apiStatus;
}

function spawnLoginProcess(dataDir, runtime) {
  const useAutoLogin = isElectronPackaged() || process.env.MAOYAN_LOGIN_AUTO === "1";
  const serverDir = resolveMaoyanDir() || SERVER_DIR;
  const loginJs = path.join(serverDir, "login.js");

  return new Promise((resolve) => {
    const child = spawn(runtime.bin, [loginJs], {
      cwd: dataDir,
      detached: true,
      stdio: useAutoLogin ? "ignore" : "inherit",
      windowsHide: useAutoLogin,
      env: {
        ...process.env,
        ...runtime.env,
        MAOYAN_DATA_DIR: dataDir,
        ...(useAutoLogin ? { MAOYAN_LOGIN_AUTO: "1" } : {}),
      },
    });
    child.on("error", (error) => {
      resolve({ ok: false, error: `启动登录窗口失败: ${error.message}` });
    });
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function startMaoyanLogin(options = {}) {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  if (isElectronMain()) {
    const { runMaoyanLogin } = require("./lib/maoyan-login");
    return runMaoyanLogin(dataDir, options);
  }

  const runtime = resolveRuntime(resolveMaoyanDir());
  return spawnLoginProcess(dataDir, runtime);
}

async function runThrottledHealthCheck(apiBase) {
  const now = Date.now();
  if (now - lastHealthCheckAt < HEALTH_CHECK_INTERVAL_MS) {
    return lastHealthCheckOk;
  }
  if (healthCheckPromise) return healthCheckPromise;

  healthCheckPromise = checkHealth(apiBase)
    .then((alive) => {
      lastHealthCheckAt = Date.now();
      lastHealthCheckOk = alive;
      if (alive) {
        consecutiveHealthFails = 0;
        void syncSessionStatusFromServer(apiBase);
      } else {
        consecutiveHealthFails += 1;
      }
      return alive;
    })
    .finally(() => {
      healthCheckPromise = null;
    });

  return healthCheckPromise;
}

async function getApiStatus() {
  const session = getMaoyanSessionStatus();
  if (apiStatus.ready) {
    const alive = await runThrottledHealthCheck(apiStatus.apiBase);
    if (!alive && consecutiveHealthFails >= HEALTH_FAIL_THRESHOLD) {
      apiStatus.ready = false;
      apiStatus.error = "票房服务已断开，正在尝试恢复…";
    } else if (alive && !session.detailApiReady && !session.verifyPending) {
      scheduleBackgroundVerify(apiStatus.apiBase, getDataDir());
    }
  }
  return { ...apiStatus, ...getMaoyanSessionStatus() };
}

function _testResetMaoyanState() {
  maoyanProcess = null;
  startedByUs = false;
  ensurePromise = null;
  apiStatus = { ready: false, error: "", apiBase: "http://127.0.0.1:8765" };
  lastHealthCheckAt = 0;
  lastHealthCheckOk = false;
  healthCheckPromise = null;
  consecutiveHealthFails = 0;
  _spawnImpl = spawn;
  _checkHealthImpl = null;
  _testWaitForPidGoneFn = null;
}

function _testGetState() {
  return {
    maoyanProcess,
    startedByUs,
    apiStatus: { ...apiStatus },
    ensurePromise: Boolean(ensurePromise),
  };
}

function _testSetState(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "maoyanProcess")) {
    maoyanProcess = patch.maoyanProcess;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "startedByUs")) {
    startedByUs = patch.startedByUs;
  }
  if (patch.apiStatus) {
    apiStatus = { ...apiStatus, ...patch.apiStatus };
  }
}

function _testHandleChildExit(child, code) {
  handleMaoyanChildExit(child, code);
}

function _testSetSpawn(fn) {
  _spawnImpl = fn || spawn;
}

function _testSetCheckHealth(fn) {
  _checkHealthImpl = fn || null;
}

function _testSetWaitForPidGone(fn) {
  _testWaitForPidGoneFn = fn || null;
}

module.exports = {
  ensureMaoyanService,
  getApiStatus,
  shutdownMaoyanService,
  shutdownMaoyanServiceAndWait,
  checkHealth,
  isMaoyanLoggedIn,
  getMaoyanSessionStatus,
  startMaoyanLogin,
  buildApiBase,
  getDataDir,
  handleMaoyanChildExit,
  _testResetMaoyanState,
  _testGetState,
  _testSetState,
  _testHandleChildExit,
  _testSetSpawn,
  _testSetCheckHealth,
  _testSetWaitForPidGone,
  DATA_DIR: LEGACY_DATA_DIR,
  SERVER_DIR,
};
