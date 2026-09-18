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
let _healthCheckIntervalMs = HEALTH_CHECK_INTERVAL_MS;
const HEALTH_FAIL_THRESHOLD = 2;

let _spawnImpl = spawn;
let _checkHealthImpl = null;
let _portListeningImpl = null;
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

function isElectronMain() {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return false;
  try {
    const { app } = require("electron");
    return Boolean(app && typeof app.getPath === "function");
  } catch {
    return false;
  }
}

function listDataDirCandidates() {
  const roaming = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA || roaming;
  const candidates = [];

  try {
    const pkg = require("./package.json");
    const productName = pkg.build?.productName || "MaoyanOverlay";
    candidates.push(path.join(roaming, productName, "maoyan-data"));
  } catch {
    candidates.push(path.join(roaming, "MaoyanOverlay", "maoyan-data"));
  }

  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      candidates.push(path.join(app.getPath("userData"), "maoyan-data"));
    }
  } catch {
    /* not in electron */
  }

  candidates.push(path.join(local, "MaoyanOverlay", "maoyan-data"));
  candidates.push(path.join(roaming, "douyin-maoyan-overlay", "maoyan-data"));

  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

function pickCanonicalDataDir(candidates = listDataDirCandidates()) {
  let best = "";
  let bestMtime = 0;
  for (const dir of candidates) {
    const stateFile = path.join(dir, "browser_state.json");
    try {
      if (!fs.existsSync(stateFile)) continue;
      const mtime = fs.statSync(stateFile).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = dir;
      }
    } catch {
      /* ignore unreadable candidate */
    }
  }
  if (best) return best;
  return candidates[0] || LEGACY_DATA_DIR;
}

function getDataDir() {
  if (process.env.MAOYAN_DATA_DIR) {
    return process.env.MAOYAN_DATA_DIR;
  }
  return pickCanonicalDataDir();
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
    process.env.NODE_BINARY,
    process.env.npm_node_execpath,
    process.platform === "win32"
      ? path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe")
      : "",
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe")
      : "",
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin === "node") continue;
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* ignore */
    }
  }

  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("child_process");
      const out = String(execFileSync("where", ["node"], { encoding: "utf-8", timeout: 3000, windowsHide: true }))
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* ignore */
    }
  }

  return "node";
}

function getPackagedResourceRoots() {
  try {
    const { app } = require("electron");
    if (!app?.isPackaged) return null;
    const appPath = app.getAppPath();
    const resourcesPath =
      typeof process.resourcesPath === "string" && process.resourcesPath
        ? process.resourcesPath
        : path.dirname(appPath);
    const unpackedRoot = appPath.endsWith(".asar")
      ? `${appPath.slice(0, -".asar".length)}.asar.unpacked`
      : appPath;
    return {
      appPath,
      resourcesPath,
      unpackedRoot,
      runtimeRoot: path.join(resourcesPath, "maoyan"),
      nodeModules: path.join(appPath, "node_modules"),
    };
  } catch {
    return null;
  }
}

function resolveFsNodeModules(packaged) {
  const candidates = [
    packaged ? path.join(packaged.runtimeRoot || "", "node_modules") : "",
    packaged ? path.join(packaged.resourcesPath || "", "app.asar.unpacked", "node_modules") : "",
    packaged ? path.join(packaged.unpackedRoot, "node_modules") : "",
    path.join(__dirname, "node_modules"),
    path.join(SERVER_DIR, "node_modules"),
  ].filter(Boolean);
  for (const root of candidates) {
    if (
      fs.existsSync(path.join(root, "express")) &&
      fs.existsSync(path.join(root, "playwright")) &&
      !String(root).includes(".asar" + path.sep) &&
      !String(root).endsWith(".asar")
    ) {
      return root;
    }
  }
  return "";
}

function resolveRuntime(serverDir) {
  const dir = serverDir || resolveMaoyanDir() || SERVER_DIR;
  const indexJs = path.join(dir, "index.js");
  const packaged = getPackagedResourceRoots();
  const systemNode = resolveNodeBin();
  const fsModules = resolveFsNodeModules(packaged);

  // 优先系统 Node + 真实磁盘上的 node_modules（避免再开一份 Electron 当 Node）
  if (systemNode && systemNode !== "node" && fsModules) {
    return {
      bin: systemNode,
      args: [indexJs],
      env: {
        NODE_PATH: fsModules,
        PORTABLE_EXECUTABLE_FILE:
          process.env.PORTABLE_EXECUTABLE_FILE || (packaged ? getRealExecutablePath() : ""),
      },
    };
  }

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

  return {
    bin: systemNode || "node",
    args: [indexJs],
    env: fsModules ? { NODE_PATH: fsModules } : {},
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
  const candidates = [];
  if (packaged?.runtimeRoot) {
    candidates.push(path.join(packaged.runtimeRoot, "server"));
  }
  if (packaged?.unpackedRoot) {
    candidates.push(path.join(packaged.unpackedRoot, "server"));
  }
  candidates.push(SERVER_DIR);
  for (const dir of candidates) {
    const indexFile = path.join(dir, "index.js");
    const libDir = path.join(dir, "lib");
    // runtime 布局：maoyan/server + maoyan/lib；旧 unpacked：server + ../lib
    const siblingLib = path.join(path.dirname(dir), "lib");
    const hasLib = fs.existsSync(libDir) || fs.existsSync(siblingLib);
    // 换机必炸点：缺少 dashboard-rank 时进程秒退，界面一直加载中
    const hasRank =
      fs.existsSync(path.join(dir, "lib", "dashboard-rank.js")) ||
      fs.existsSync(path.join(path.dirname(dir), "ui", "dashboard-rank.js")) ||
      fs.existsSync(path.join(__dirname, "ui", "dashboard-rank.js"));
    if (fs.existsSync(indexFile) && hasLib && hasRank) {
      return dir;
    }
  }
  return null;
}

function reportServiceIssue(message) {
  const text = String(message || "").trim();
  if (!text) return;
  try {
    const { report } = require("./lib/client-logger");
    report("error", "service", text.slice(0, 500));
  } catch {
    /* ignore */
  }
  try {
    console.error(text);
  } catch {
    /* ignore */
  }
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
  if (_portListeningImpl) return _portListeningImpl(port, host);
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
  const expectedDataDir = getDataDir();
  if (await checkHealth(apiBase, expectedDataDir)) return;
  const exceptPid = maoyanProcess?.pid || 0;
  await killListenersOnPort(port, exceptPid);
}

function healthResponseMatches(data, expectedDataDir) {
  if (!data || data.ok !== true) return false;
  if (!expectedDataDir) return true;
  if (!data.dataDir) return false;
  try {
    return path.resolve(String(data.dataDir)) === path.resolve(String(expectedDataDir));
  } catch {
    return false;
  }
}

function checkHealth(apiBase, expectedDataDir) {
  if (_checkHealthImpl) return _checkHealthImpl(apiBase, expectedDataDir);
  const dataDir = expectedDataDir || getDataDir();
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
          resolve(res.statusCode === 200 && healthResponseMatches(data, dataDir));
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

/** 服务就绪后在后台预热大盘缓存，缩短首屏等待（与 ui/maoyan-api DASHBOARD_PARAMS 一致） */
function warmDashboardCache(apiBase) {
  const base = String(apiBase || "").trim();
  if (!base) return;
  const qs = new URLSearchParams({
    orderType: "0",
    uuid: "",
    timeStamp: "",
    "User-Agent": "",
    index: "240",
    channelId: "40009",
    sVersion: "2",
    signKey: "",
    WuKongReady: "h5",
  });
  const url = `${base}/i/api/dashboard-ajax/movie?${qs}`;
  const req = http.get(url, { timeout: 90000 }, (res) => {
    res.resume();
  });
  req.on("error", () => {});
  req.on("timeout", () => {
    req.destroy();
  });
}

let autoRestartTimer = null;
let autoRestartAttempts = 0;
const AUTO_RESTART_WINDOW_MS = 60_000;
const AUTO_RESTART_MAX = 3;
let autoRestartWindowStartedAt = 0;

function handleMaoyanChildExit(child, code) {
  if (maoyanProcess !== child) return;
  maoyanProcess = null;
  if (startedByUs) {
    startedByUs = false;
    apiStatus.ready = false;
    if (code !== 0 && code !== null) {
      const detail = summarizeChildCrash(child);
      apiStatus.error = detail
        ? `票房服务异常退出 (code ${code}): ${detail}`
        : `票房服务异常退出 (code ${code})`;
      reportServiceIssue(apiStatus.error);
      scheduleAutoRestartService();
    }
  }
}

function scheduleAutoRestartService() {
  const now = Date.now();
  if (!autoRestartWindowStartedAt || now - autoRestartWindowStartedAt > AUTO_RESTART_WINDOW_MS) {
    autoRestartWindowStartedAt = now;
    autoRestartAttempts = 0;
  }
  if (autoRestartAttempts >= AUTO_RESTART_MAX) {
    reportServiceIssue("票房服务反复崩溃，已停止自动重启，请重启软件");
    return;
  }
  if (autoRestartTimer) return;
  autoRestartAttempts += 1;
  const delay = 1500 * autoRestartAttempts;
  reportServiceIssue(`票房服务将在 ${delay}ms 后自动重启（第 ${autoRestartAttempts} 次）`);
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null;
    ensureMaoyanService({
      apiBase: apiStatus.apiBase || "http://127.0.0.1:8765",
    }).catch((error) => {
      reportServiceIssue(`票房服务自动重启失败: ${error?.message || error}`);
    });
  }, delay);
}

function getServerLogPath() {
  const dir = path.join(getDataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "service-spawn.log");
}

function summarizeChildCrash(child) {
  const raw = String(child?.__stderrBuf || child?.__stdoutBuf || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const moduleMiss = raw.match(/Cannot find module '[^']+'/i);
  if (moduleMiss) return moduleMiss[0];
  return raw.slice(0, 180);
}

function pipeChildLogs(child) {
  const logPath = getServerLogPath();
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  child.__stderrBuf = "";
  child.__stdoutBuf = "";
  const write = (chunk, label) => {
    const text = String(chunk || "");
    if (label === "stderr") {
      child.__stderrBuf = (child.__stderrBuf + text).slice(-4000);
    } else {
      child.__stdoutBuf = (child.__stdoutBuf + text).slice(-4000);
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    stream.write(`[${new Date().toISOString()}] [${label}] ${trimmed}\n`);
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

    // 立刻挂日志：换机缺文件时进程会秒退，晚挂会丢 stderr
    pipeChildLogs(child);

    child.on("error", (error) => finish(reject, error));
    child.on("spawn", () => {
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
  const expectedDataDir = getDataDir();
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    if (await checkHealth(apiBase, expectedDataDir)) return true;
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
  console.log("[MAOYAN_SERVICE]", {
    stage: "ensure_start",
    apiBase,
    dataDir: getDataDir(),
  });

  if (!hasServerDeps()) {
    apiStatus.error = isElectronPackaged()
      ? "内置依赖缺失，请重新安装或更新软件"
      : "缺少依赖，请在项目目录运行 npm run setup 完成安装";
    reportServiceIssue(apiStatus.error);
    console.log("[MAOYAN_SERVICE]", { stage: "ensure_fail", reason: "missing_deps", apiBase });
    return apiStatus;
  }

  const ownDataDir = getDataDir();
  if (await checkHealth(apiBase, ownDataDir)) {
    apiStatus.ready = true;
    Object.assign(apiStatus, getMaoyanSessionStatus());
    warmDashboardCache(apiBase);
    console.log("[MAOYAN_SERVICE]", {
      stage: "ready",
      apiBase,
      reused: true,
      detailApiReady: Boolean(apiStatus.detailApiReady),
      loginRequired: Boolean(apiStatus.loginRequired),
    });
    console.log("[MAOYAN_API]", { stage: "health_ok", apiBase });
    // 延后验签，先让首屏大盘出来（避免启动瞬间再起无头 Chrome）
    setTimeout(() => scheduleBackgroundVerify(apiBase, ownDataDir, { startup: true }), 12000);
    return apiStatus;
  }

  await recoverStalePort(apiBase);
  if (await checkHealth(apiBase, ownDataDir)) {
    apiStatus.ready = true;
    Object.assign(apiStatus, getMaoyanSessionStatus());
    warmDashboardCache(apiBase);
    setTimeout(() => scheduleBackgroundVerify(apiBase, getDataDir(), { startup: true }), 12000);
    return apiStatus;
  }

  if (maoyanProcess) {
    const stopped = await shutdownMaoyanServiceAndWait();
    if (!stopped) {
      apiStatus.error = "旧票房服务进程未能退出，请稍后重试";
      reportServiceIssue(apiStatus.error);
      return apiStatus;
    }
  }

  const maoyanDir = resolveMaoyanDir();
  if (!maoyanDir) {
    apiStatus.error = "内置票房服务缺失（缺少服务文件），请重新下载最新版软件";
    reportServiceIssue(apiStatus.error);
    return apiStatus;
  }

  let child = null;
  try {
    child = await startMaoyanProcess(maoyanDir);
  } catch (e) {
    apiStatus.error = `启动票房服务失败: ${e.message}`;
    reportServiceIssue(apiStatus.error);
    return apiStatus;
  }

  const ok = await waitForHealth(apiBase, 30000);
  if (ok) {
    apiStatus.ready = true;
    apiStatus.error = "";
    Object.assign(apiStatus, getMaoyanSessionStatus());
    warmDashboardCache(apiBase);
    console.log("[MAOYAN_SERVICE]", {
      stage: "ready",
      apiBase,
      reused: false,
      detailApiReady: Boolean(apiStatus.detailApiReady),
      loginRequired: Boolean(apiStatus.loginRequired),
    });
    console.log("[MAOYAN_API]", { stage: "health_ok", apiBase });
    setTimeout(() => scheduleBackgroundVerify(apiBase, getDataDir(), { startup: true }), 12000);
  } else {
    const crash = summarizeChildCrash(child);
    if (!maoyanProcess) {
      apiStatus.error =
        crash ||
        apiStatus.error ||
        "票房服务进程已退出，请重启软件；若刚换电脑请确认已安装 Google Chrome 或 Edge";
    } else if (crash) {
      apiStatus.error = `票房服务未能就绪: ${crash}`;
    } else {
      apiStatus.error = "票房服务启动超时，请检查端口占用或浏览器是否可用";
    }
    reportServiceIssue(apiStatus.error);
    console.log("[MAOYAN_SERVICE]", {
      stage: "ensure_fail",
      apiBase,
      error: apiStatus.error,
    });
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
  if (now - lastHealthCheckAt < _healthCheckIntervalMs) {
    return lastHealthCheckOk;
  }
  if (healthCheckPromise) return healthCheckPromise;

  healthCheckPromise = checkHealth(apiBase, getDataDir())
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
  _portListeningImpl = null;
  _healthCheckIntervalMs = HEALTH_CHECK_INTERVAL_MS;
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

function _testSetPortListening(fn) {
  _portListeningImpl = fn || null;
}

function _testSetHealthCheckInterval(ms) {
  _healthCheckIntervalMs = Number(ms) || HEALTH_CHECK_INTERVAL_MS;
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
  healthResponseMatches,
  recoverStalePort,
  isMaoyanLoggedIn,
  getMaoyanSessionStatus,
  startMaoyanLogin,
  buildApiBase,
  getDataDir,
  listDataDirCandidates,
  pickCanonicalDataDir,
  handleMaoyanChildExit,
  _testResetMaoyanState,
  _testGetState,
  _testSetState,
  _testHandleChildExit,
  _testSetSpawn,
  _testSetCheckHealth,
  _testSetPortListening,
  _testSetHealthCheckInterval,
  _testSetWaitForPidGone,
  DATA_DIR: LEGACY_DATA_DIR,
  SERVER_DIR,
};
