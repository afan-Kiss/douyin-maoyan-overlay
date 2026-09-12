import fs from "fs";
import http from "http";
import path from "path";
import express from "express";
import {
  DIR,
  SESSION_CACHE_DIR,
  ensureConfigTemplate,
  getApiPort,
  getChromeExecutable,
} from "./lib/config.js";
import { log, requestLogMiddleware, explainError } from "./lib/logger.js";
import { isPortListening } from "./lib/port.js";
import { UpstreamError, manager } from "./lib/sigManager.js";

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

function sendApiError(res, e) {
  if (e instanceof UpstreamError) {
    const detail =
      e.status === 403
        ? "猫眼拒绝了请求，可能是签名失效或触发风控"
        : e.status === 401
          ? "登录信息失效，请在软件内点击「登录猫眼」重新登录"
          : e.status === 502 && e.message === "network_failed"
          ? "连不上猫眼服务器，请检查网络"
          : `猫眼返回错误，状态码 ${e.status}`;
    log.reqFail("拉取失败", detail);
    res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({
      detail: "拉取数据失败，请稍后再试",
    });
    return;
  }
  if (e?.message === "movie_id_required") {
    log.reqFail("参数错误", "电影编号不能为空");
    res.status(400).json({ detail: "电影编号不能为空" });
    return;
  }
  if (e?.message === "chrome_not_found") {
    log.reqFail("环境错误", "没找到浏览器，请检查 config.ini");
    res.status(500).json({ detail: "找不到浏览器，请检查 config.ini 配置" });
    return;
  }
  if (e?.message === "sig_capture_failed") {
    log.reqFail("签名失败", "没抓到有效签名，请先登录猫眼");
    res.status(500).json({ detail: "签名获取失败，请先登录猫眼" });
    return;
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    log.reqFail("超时", explainError(e));
    res.status(504).json({ detail: "请求超时，请稍后再试" });
    return;
  }
  const detail = explainError(e);
  log.reqFail("出错了", detail);
  res.status(500).json({ detail: "服务内部出错，请稍后再试" });
}

async function handleBoxShow(req, res) {
  const { movieId, boxLevel, forceRefresh } = parseMovieQuery(req);

  if (!movieId) {
    res.status(400).json({ detail: "电影编号不能为空" });
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
      res.status(400).json({ detail: "电影编号不能为空" });
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

  try {
    const data = await Promise.race([
      manager.fetchDashboardMovie({ ...req.query }, { forceRefresh }),
      new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error("dashboard_timeout");
          err.name = "TimeoutError";
          reject(err);
        }, timeoutMs);
      }),
    ]);
    res.json(data);
  } catch (e) {
    sendApiError(res, e);
  }
}

function ensureRuntime() {
  const depRoots = [
    path.join(DIR, "node_modules"),
    path.join(DIR, "..", "node_modules"),
  ];
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
  process.on("unhandledRejection", () => {
    log.info("后台任务出错，已自动拦住，服务继续运行");
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
    res.json({ ok: true });
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
      res.json({ ok: true });
    } catch {
      log.sigFail("刷新没成功，请检查浏览器配置或先登录");
      res.status(500).json({ detail: "刷新签名失败，请稍后再试" });
    }
  }

  app.use((req, res) => {
    res.status(404).json({
      detail: `接口不存在: ${req.method} ${req.path}`,
    });
  });

  app.use((err, _req, res, _next) => {
    log.reqFail("服务内部错误", "程序内部出错");
    if (!res.headersSent) {
      res.status(500).json({ detail: "服务内部出错，请稍后再试" });
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
