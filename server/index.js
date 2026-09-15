import fs from "fs";
import http from "http";
import path from "path";
import express from "express";
import {
  DIR,
  DATA_DIR,
  SESSION_CACHE_DIR,
  ensureConfigTemplate,
  getApiPort,
  getChromeExecutable,
} from "./lib/config.js";
import { log, requestLogMiddleware, explainError, buildDiagnostics } from "./lib/logger.js";
import { runCapabilityVerify } from "./lib/capability-verify.js";
import { applyApiErrorToCapability, getLastCapabilityVerify } from "./lib/capability-state.js";
import { isPortListening } from "./lib/port.js";
import { UpstreamError, manager } from "./lib/sigManager.js";
import { buildRankSnapshotFromRawList } from "./lib/dashboard-rank.js";

ensureConfigTemplate();

function parseBoxLevel(value) {
  const n = parseInt(String(value ?? "1"), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(99, n));
}

function parseMovieQuery(req) {
  const q = req.query;
  return {
    movieId: String(q.movieId || q.movie_id || "1462628").trim(),
    boxLevel: parseBoxLevel(q.boxLevel ?? q.box_level),
    forceRefresh: q.force_refresh === "true" || q.forceRefresh === "true",
  };
}

function parseDisplayLimit(query = {}) {
  const raw = query.displayLimit ?? query.topCount ?? query.limit ?? 0;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, 20);
}

function trimDashboardPayload(data, limit) {
  if (!limit || !data?.movieList?.list) return data;
  const list = data.movieList.list;
  if (list.length <= limit) return data;
  return {
    ...data,
    movieList: {
      ...data.movieList,
      list: list.slice(0, limit),
    },
  };
}

function saveDashboardSnapshot(data, meta = {}) {
  try {
    const dir = path.join(DATA_DIR, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const { rankings, ...restMeta } = meta;
    const payload = {
      savedAt: new Date().toISOString(),
      rankings: Array.isArray(rankings) ? rankings : [],
      ...restMeta,
      data,
    };
    fs.writeFileSync(
      path.join(dir, "last-dashboard.json"),
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  } catch {
    /* 快照失败不阻塞接口 */
  }
}

function buildApiErrorPayload(e) {
  if (e instanceof UpstreamError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    if (e.status === 403) {
      return {
        status,
        code: "upstream_403",
        detail: "猫眼拒绝了请求，可能是签名失效或触发风控",
        retryable: true,
        action: "refresh",
      };
    }
    if (e.status === 401) {
      return {
        status,
        code: "upstream_401",
        detail: "猫眼登录状态已失效，请重新登录",
        retryable: false,
        action: "login",
      };
    }
    if (e.status === 502 && e.message === "network_failed") {
      return {
        status,
        code: "network_failed",
        detail: "连不上猫眼服务器，请检查网络",
        retryable: true,
        action: null,
      };
    }
    if (e.message === "bad_json") {
      return {
        status,
        code: "internal_error",
        detail: "猫眼返回了无法解析的数据",
        retryable: true,
        action: null,
      };
    }
    return {
      status,
      code: "upstream_failed",
      detail: `猫眼返回错误，状态码 ${e.status}`,
      retryable: true,
      action: null,
    };
  }

  const msg = String(e?.message || "");
  const map = {
    movie_id_required: {
      status: 400,
      code: "movie_id_required",
      detail: "电影编号不能为空",
      retryable: false,
      action: null,
    },
    chrome_not_found: {
      status: 500,
      code: "chrome_not_found",
      detail: "找不到浏览器，请检查 config.ini 配置或安装 Google Chrome",
      retryable: false,
      action: null,
    },
    browser_launch_failed: {
      status: 500,
      code: "browser_launch_failed",
      detail: explainError(e),
      retryable: false,
      action: null,
    },
    login_required: {
      status: 401,
      code: "login_required",
      detail: "猫眼登录状态已失效，请重新登录",
      retryable: false,
      action: "login",
    },
    login_in_progress: {
      status: 503,
      code: "login_in_progress",
      detail: "登录窗口正在打开，请完成登录后再试",
      retryable: true,
      action: "wait",
    },
    sig_capture_failed: {
      status: 500,
      code: "sig_capture_failed",
      detail: explainError(e?.cause) || "签名获取失败，请刷新浏览器签名或重新登录",
      retryable: true,
      action: "refresh",
    },
    dashboard_timeout: {
      status: 504,
      code: "timeout",
      detail: "大盘数据请求超时，请稍后再试",
      retryable: true,
      action: null,
    },
  };

  if (map[msg]) return map[msg];

  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout/i.test(msg)) {
    return {
      status: 504,
      code: "timeout",
      detail: explainError(e),
      retryable: true,
      action: null,
    };
  }

  return {
    status: 500,
    code: "internal_error",
    detail: explainError(e) || "服务内部出错，请稍后再试",
    retryable: false,
    action: null,
  };
}

function sendApiError(res, e) {
  const payload = buildApiErrorPayload(e);
  log.reqFail(payload.code, payload.detail);
  applyApiErrorToCapability(payload.code);
  res.status(payload.status).json({
    code: payload.code,
    detail: payload.detail,
    retryable: payload.retryable,
    action: payload.action,
  });
}

async function handleBoxShow(req, res) {
  const { movieId, boxLevel, forceRefresh } = parseMovieQuery(req);

  if (!movieId) {
    res.status(400).json({
      code: "movie_id_required",
      detail: "电影编号不能为空",
      retryable: false,
      action: null,
    });
    return;
  }

  try {
    const data = await manager.fetch(movieId, boxLevel, { forceRefresh });
    res.json(data);
  } catch (e) {
    sendApiError(res, e);
  }
}

function createBrowserApiHandler(apiName, apiPath) {
  return async (req, res) => {
    const movieId = String(req.query.movieId || req.query.movie_id || "").trim();
    const forceRefresh =
      req.query.force_refresh === "true" || req.query.forceRefresh === "true";

    if (!movieId) {
      res.status(400).json({
        code: "movie_id_required",
        detail: "电影编号不能为空",
        retryable: false,
        action: null,
      });
      return;
    }

    try {
      const data = await manager.fetchBrowserApi({
        movieId,
        apiPath,
        query: { ...req.query },
        forceRefresh,
      });
      res.json(data);
    } catch (e) {
      sendApiError(res, e);
    }
  };
}

async function handleDashboardMovie(req, res) {
  const forceRefresh =
    req.query.force_refresh === "true" || req.query.forceRefresh === "true";
  const timeoutMs = 55000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const data = await manager.fetchDashboardMovie(
      { ...req.query },
      { forceRefresh, signal: controller.signal },
    );
    // 大盘列表必须完整来自猫眼，禁止服务端先截断再排序（否则累计高但当日占比低的片会丢）
    const payload = data;
    const rankings = buildRankSnapshotFromRawList(data?.movieList?.list || [], 5);
    saveDashboardSnapshot(payload, {
      displayLimit: 0,
      movieCount: payload?.movieList?.list?.length || 0,
      rankingCount: rankings.length,
      rankings,
      dataSource: "maoyan-dashboard-ajax",
      query: { ...req.query },
    });
    res.json(payload);
  } catch (e) {
    if (controller.signal.aborted && e?.name !== "TimeoutError") {
      const err = new Error("dashboard_timeout");
      err.name = "TimeoutError";
      sendApiError(res, err);
      return;
    }
    sendApiError(res, e);
  } finally {
    clearTimeout(timer);
  }
}

function ensureRuntime() {
  const depRoots = [
    path.join(DIR, "node_modules"),
    path.join(DIR, "..", "node_modules"),
  ];
  for (const part of String(process.env.NODE_PATH || "").split(path.delimiter)) {
    const trimmed = part.trim();
    if (trimmed) depRoots.push(trimmed);
  }
  const hasDeps = depRoots.some(
    (root) =>
      fs.existsSync(path.join(root, "express")) &&
      fs.existsSync(path.join(root, "playwright"))
  );
  if (!hasDeps) {
    log.depsMissing();
    return false;
  }

  fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });

  const chrome = getChromeExecutable();
  if (chrome && fs.existsSync(chrome)) {
    log.chromeOk();
  } else {
    log.chromeMissing();
    log.info("可在 config.ini 里手动填写浏览器路径");
  }
  return true;
}

function installProcessGuards() {
  process.on("unhandledRejection", (error) => {
    log.error("后台任务未捕获异常", error);
  });
  process.on("uncaughtException", (error) => {
    log.error("服务未捕获异常", error);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerRoutes(app, method, paths, handler) {
  for (const route of paths) {
    app[method](route, handler);
  }
}

let serverRef = null;

async function main() {
  if (!ensureRuntime()) {
    process.exit(1);
  }

  installProcessGuards();

  const app = express();
  const PORT = getApiPort();

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(requestLogMiddleware);

  log.info(`检查端口 ${PORT}...`);
  if (await isPortListening(PORT)) {
    const healthUrl = `http://127.0.0.1:${PORT}/health`;
    const reused = await new Promise((resolve) => {
      const req = http.get(healthUrl, { timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
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
    if (reused) {
      log.info(`端口 ${PORT} 已有猫眼服务在运行，复用现有实例`);
      return;
    }
    log.portStillBusy(PORT);
    process.exit(1);
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, dataDir: DATA_DIR });
  });

  app.get("/health/ready", (_req, res) => {
    const diagnostics = buildDiagnostics(manager.hasFreshSignature());
    res.json({
      ok: diagnostics.serviceReady && diagnostics.chromePathValid,
      ...diagnostics,
    });
  });

  app.get("/api/diagnostics", (_req, res) => {
    res.json(buildDiagnostics(manager.hasFreshSignature()));
  });

  app.get("/api/capability-status", (_req, res) => {
    res.json(getLastCapabilityVerify());
  });

  app.get("/api/verify-capabilities", async (req, res) => {
    try {
      const force = req.query.force === "1" || req.query.force === "true";
      const result = await runCapabilityVerify({ force });
      res.json(result);
    } catch (e) {
      sendApiError(res, e);
    }
  });

  const boxShowPaths = [
    "/api/boxshow",
    "/api/movie/getBoxShow",
    "/i/api/movie/getBoxShow",
  ];
  registerRoutes(app, "get", boxShowPaths, handleBoxShow);
  registerRoutes(app, "post", boxShowPaths, handleBoxShow);

  const browserApis = [
    { name: "预测票房", path: "/i/api/movie/getPredictionBox" },
    { name: "全球票房", path: "/i/api/movie/getBoxShowna" },
    { name: "下映时间", path: "/i/api/movie/getTechData" },
    { name: "想看数据", path: "/i/api/movie/getWantData" },
  ];

  for (const api of browserApis) {
    const handler = createBrowserApiHandler(api.name, api.path);
    const shortPath = api.path.replace(/^\/i/, "");
    registerRoutes(app, "get", [api.path, shortPath], handler);
    registerRoutes(app, "post", [api.path, shortPath], handler);
  }

  const dashboardPaths = [
    "/i/api/dashboard-ajax/movie",
    "/api/dashboard-ajax/movie",
  ];
  registerRoutes(app, "get", dashboardPaths, handleDashboardMovie);
  registerRoutes(app, "post", dashboardPaths, handleDashboardMovie);

  app.post("/api/refresh", handleRefresh);
  app.get("/api/refresh", handleRefresh);

  async function handleRefresh(req, res) {
    const movieId = String(req.query.movie_id || req.query.movieId || "1462628").trim();
    const boxLevel = parseBoxLevel(req.query.box_level ?? req.query.boxLevel);

    log.manualRefresh(movieId, boxLevel);

    try {
      await manager.refresh(movieId, boxLevel);
      log.refreshDone();
      res.json({ ok: true });
    } catch (e) {
      log.sigFail(explainError(e));
      sendApiError(res, e);
    }
  }

  app.use((req, res) => {
    res.status(404).json({
      code: "not_found",
      detail: `接口不存在: ${req.method} ${req.path}`,
      retryable: false,
      action: null,
    });
  });

  app.use((err, _req, res, _next) => {
    log.reqFail("服务内部错误", "程序内部出错");
    if (!res.headersSent) {
      res.status(500).json({
        code: "internal_error",
        detail: "服务内部出错，请稍后再试",
        retryable: false,
        action: null,
      });
    }
  });

  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, "127.0.0.1", () => {
      log.start(PORT);
      resolve(server);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        log.portStillBusy(PORT);
        reject(err);
        return;
      }
      log.info("启动失败，请检查端口和配置");
      reject(err);
    });

    serverRef = server;
  });
}

function shutdown() {
  log.exit();
  manager.destroy();
  if (serverRef) {
    serverRef.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(() => {
  process.exit(1);
});
