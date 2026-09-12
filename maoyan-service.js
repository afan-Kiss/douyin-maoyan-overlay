const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "server");
const LEGACY_DATA_DIR = path.join(__dirname, "data");
const CONFIG_INI = () => path.join(getDataDir(), "config.ini");

let maoyanProcess = null;
let startedByUs = false;
let ensurePromise = null;
let apiStatus = { ready: false, error: "", apiBase: "http://127.0.0.1:8765" };

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

function resolveCmdExe() {
  const comspec = String(process.env.ComSpec || "").trim();
  if (comspec) {
    try {
      if (fs.existsSync(comspec)) return comspec;
    } catch {
      /* ignore */
    }
  }
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const fallback = path.join(systemRoot, "System32", "cmd.exe");
  if (fs.existsSync(fallback)) return fallback;
  return "cmd.exe";
}

function resolveRuntime() {
  if (isElectronPackaged()) {
    return {
      bin: process.execPath,
      args: ["index.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const nodeBin = resolveNodeBin();
  return {
    bin: nodeBin,
    args: ["index.js"],
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
  const indexFile = path.join(SERVER_DIR, "index.js");
  const libDir = path.join(SERVER_DIR, "lib");
  if (fs.existsSync(indexFile) && fs.existsSync(libDir)) {
    return SERVER_DIR;
  }
  return null;
}

function hasServerDeps() {
  const roots = [
    path.join(__dirname, "node_modules"),
    path.join(SERVER_DIR, "node_modules"),
  ];
  return roots.some(
    (root) =>
      fs.existsSync(path.join(root, "express")) &&
      fs.existsSync(path.join(root, "playwright")),
  );
}

function isMaoyanLoggedIn() {
  try {
    const file = path.join(getDataDir(), "browser_state.json");
    if (!fs.existsSync(file)) return false;
    const stat = fs.statSync(file);
    return stat.size > 10;
  } catch {
    return false;
  }
}

function checkHealth(apiBase) {
  if (_checkHealthImpl) return _checkHealthImpl(apiBase);
  return new Promise((resolve) => {
    const url = `${apiBase}/health`;
    const req = http.get(url, { timeout: 4000 }, (res) => {
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

function startMaoyanProcess(dir) {
  const runtime = resolveRuntime();
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = _spawnImpl(runtime.bin, runtime.args, {
      cwd: dir,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ...runtime.env,
        MAOYAN_DATA_DIR: dataDir,
        npm_node_execpath: runtime.bin,
      },
    });

    child.on("error", reject);
    child.on("spawn", () => {
      maoyanProcess = child;
      startedByUs = true;
      resolve(child);
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

async function waitForHealth(apiBase, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(apiBase)) return true;
    await sleep(1000);
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
  apiStatus = { ready: false, error: "", apiBase, loggedIn: isMaoyanLoggedIn() };

  if (!hasServerDeps()) {
    apiStatus.error = "缺少依赖，请运行 setup.bat 完成安装";
    return apiStatus;
  }

  if (await checkHealth(apiBase)) {
    apiStatus.ready = true;
    apiStatus.loggedIn = isMaoyanLoggedIn();
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

  const ok = await waitForHealth(apiBase, 90000);
  if (ok) {
    apiStatus.ready = true;
    apiStatus.error = "";
    apiStatus.loggedIn = isMaoyanLoggedIn();
  } else {
    apiStatus.error = "票房服务启动超时，请检查端口占用或 Chrome 是否可用";
    await shutdownMaoyanServiceAndWait();
  }

  return apiStatus;
}

function quoteCmdPath(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function startMaoyanLogin() {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = resolveRuntime();

  if (process.platform === "win32") {
    const envLines = [
      `set "MAOYAN_DATA_DIR=${dataDir.replace(/"/g, '""')}"`,
      runtime.env.ELECTRON_RUN_AS_NODE ? 'set "ELECTRON_RUN_AS_NODE=1"' : null,
      `${quoteCmdPath(runtime.bin)} login.js`,
    ]
      .filter(Boolean)
      .join(" && ");
    const cmdLine = `title 猫眼登录 && ${envLines}`;

    const cmdExe = resolveCmdExe();
    const child = spawn(cmdExe, ["/c", "start", "cmd", "/k", cmdLine], {
      cwd: SERVER_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: {
        ...process.env,
        ComSpec: cmdExe,
        SystemRoot: process.env.SystemRoot || process.env.windir || "C:\\Windows",
        ...runtime.env,
        MAOYAN_DATA_DIR: dataDir,
      },
    });
    child.unref();
    return { ok: true };
  }

  const child = spawn(runtime.bin, ["login.js"], {
    cwd: SERVER_DIR,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ...runtime.env,
      MAOYAN_DATA_DIR: dataDir,
    },
  });
  child.unref();
  return { ok: true };
}

async function getApiStatus() {
  const loggedIn = isMaoyanLoggedIn();
  if (apiStatus.ready) {
    const alive = await checkHealth(apiStatus.apiBase);
    if (!alive) {
      apiStatus.ready = false;
      apiStatus.error = "票房服务已断开，正在尝试恢复…";
      if (startedByUs && maoyanProcess) {
        await shutdownMaoyanServiceAndWait();
      }
    }
  }
  return { ...apiStatus, loggedIn };
}

function _testResetMaoyanState() {
  maoyanProcess = null;
  startedByUs = false;
  ensurePromise = null;
  apiStatus = { ready: false, error: "", apiBase: "http://127.0.0.1:8765" };
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
