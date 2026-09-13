import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "node:async_hooks";
import { STORAGE_STATE, getChromeExecutable } from "./config.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { storageFileExists, storageFileLooksLoggedIn } = require("../../lib/storage-auth.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_CHARS = 50000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const API_NAMES = {
  getBoxShow: "日期票房",
  getBoxShowna: "全球票房",
  getPredictionBox: "预测票房",
  getTechData: "下映时间",
  getWantData: "想看数据",
  dashboard: "大盘数据",
  refresh: "刷新签名",
  unknown: "未知接口",
};

let lastSignatureSuccessAt = null;
let lastSignatureError = null;
let lastDashboardSuccessAt = null;

function getDataDir() {
  return process.env.MAOYAN_DATA_DIR || path.join(__dirname, "..", "..", "data");
}

function getLogFilePath() {
  const dir = path.join(getDataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "server.log");
}

function rotateLogIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_BYTES) return;
    const rotated = `${filePath}.1`;
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    fs.renameSync(filePath, rotated);
  } catch {
    /* ignore rotation errors */
  }
}

function sanitizeForLog(text) {
  return String(text || "")
    .replace(/(Cookie|mtgsig|signKey|token)=[^;\s]+/gi, "$1=[redacted]")
    .replace(/"mtgsig"\s*:\s*"[^"]+"/gi, '"mtgsig":"[redacted]"');
}

function writeFileLog(text) {
  try {
    const filePath = getLogFilePath();
    rotateLogIfNeeded(filePath);
    fs.appendFileSync(filePath, `${text}\n`, "utf-8");
  } catch {
    /* file log must not break service */
  }
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatSeconds(ms) {
  if (ms < 1000) return `${ms}毫秒`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

function apiLabel(api) {
  return API_NAMES[api] || api || "未知接口";
}

function translateSig(value) {
  if (!value) return "";
  if (value === "mem") return "签名从内存读取";
  if (value === "disk") return "签名从本地读取";
  if (value === "expired") return "签名已过期";
  if (value === "force") return "强制刷新签名";
  if (value === "browser") return "浏览器新抓的签名";
  if (value.startsWith("capture(")) {
    const inner = value.slice(8, -1);
    return `刚抓了签名（${inner.replace(/s\b/g, "秒")}）`;
  }
  return value;
}

function translateData(value) {
  if (!value) return "";
  if (value === "cache" || value === "cache-90s") return "用了90秒内的数据缓存";
  if (value === "fresh") return "刚拉的新数据";
  return value;
}

function translateMode(value) {
  if (!value) return "";
  if (value === "proto") return "直连猫眼";
  if (value === "browser") return "浏览器拉的";
  return value;
}

function translateTag(tag) {
  const map = {
    dedup: "合并了重复请求",
    "403-retry": "被拒后自动重试",
    "401-retry": "登录失效后重试",
    "browser-fallback": "直连失败改浏览器拉",
    "sig-fail": "签名失败",
  };
  return map[tag] || tag;
}

class RequestContext {
  constructor(meta = {}) {
    this.api = meta.api || meta.route || "unknown";
    this.movieId = meta.movieId ? String(meta.movieId) : "";
    this.boxLevel = meta.boxLevel ? String(meta.boxLevel) : "";
    this.start = Date.now();
    this.upstream = 0;
    this.inflight = false;
    this.sig = "";
    this.data = "";
    this.mode = "";
    this.tags = [];
    this.ok = true;
    this.failReason = "";
    this.failDetail = "";
  }

  tag(name) {
    if (name && !this.tags.includes(name)) this.tags.push(name);
  }

  setSig(value) {
    if (value) this.sig = value;
  }

  setData(value) {
    if (value) this.data = value;
  }

  setMode(value) {
    if (value) this.mode = value;
  }

  setFail(reason, detail = "") {
    this.ok = false;
    this.failReason = reason || this.failReason;
    this.failDetail = detail || this.failDetail;
  }
}

class Logger {
  constructor() {
    this.totalChars = 0;
    this.als = new AsyncLocalStorage();
    this._sigSession = null;
    this._sigBuffer = [];
  }

  _emit(text, { indent = false } = {}) {
    const prefix = indent ? "    " : `[${nowText()}] `;
    const line = `${prefix}${text}`;
    const add = line.length + 1;
    const safeLine = sanitizeForLog(line);

    if (this.totalChars + add > MAX_CHARS) {
      console.clear();
      this.totalChars = 0;
      const tip = `[${nowText()}] 日志太多了，已自动清空`;
      console.log(tip);
      writeFileLog(tip);
      this.totalChars = tip.length + 1;
    }

    console.log(line);
    writeFileLog(safeLine);
    this.totalChars += add;
  }

  _ctx() {
    return this.als.getStore();
  }

  beginReq(meta) {
    return new RequestContext(meta);
  }

  runReq(ctx, fn) {
    return this.als.run(ctx, fn);
  }

  endReq(ctx) {
    if (!ctx) return;
    const ms = Date.now() - ctx.start;
    const name = apiLabel(ctx.api);
    const status = ctx.ok ? "成功" : "失败";

    const parts = [`【${name}】`];
    if (ctx.movieId) parts.push(`电影${ctx.movieId}`);
    if (ctx.boxLevel) parts.push(`维度${ctx.boxLevel}`);
    parts.push(status);
    parts.push(`用时${formatSeconds(ms)}`);

    if (ctx.upstream > 0) {
      parts.push(`请求猫眼${ctx.upstream}次`);
    } else if (ctx.ok) {
      parts.push("未请求猫眼");
    }

    const extras = [];
    const sigText = translateSig(ctx.sig);
    const dataText = translateData(ctx.data);
    const modeText = translateMode(ctx.mode);
    if (sigText) extras.push(sigText);
    if (dataText) extras.push(dataText);
    if (modeText) extras.push(modeText);
    if (ctx.inflight) extras.push(translateTag("dedup"));
    for (const tag of ctx.tags) {
      const t = translateTag(tag);
      if (t && !extras.includes(t)) extras.push(t);
    }

    if (extras.length) {
      parts.push(extras.join("，"));
    }

    this._emit(parts.join("，"));

    if (!ctx.ok && (ctx.failReason || ctx.failDetail)) {
      const detail = [ctx.failReason, ctx.failDetail].filter(Boolean).join("，");
      this._emit(`原因：${detail}`, { indent: true });
    }
  }

  reqUpstream() {
    const ctx = this._ctx();
    if (ctx) ctx.upstream += 1;
  }

  reqInflight() {
    const ctx = this._ctx();
    if (ctx) ctx.inflight = true;
  }

  reqSig(value) {
    const ctx = this._ctx();
    if (ctx) ctx.setSig(value);
  }

  reqData(value) {
    const ctx = this._ctx();
    if (ctx) ctx.setData(value);
  }

  reqMode(value) {
    const ctx = this._ctx();
    if (ctx) ctx.setMode(value);
  }

  reqTag(name) {
    const ctx = this._ctx();
    if (ctx) ctx.tag(name);
  }

  reqFail(reason, detail = "") {
    const ctx = this._ctx();
    if (ctx) {
      ctx.setFail(reason, detail);
      return;
    }
    this._emit(`失败：${reason}${detail ? `，${detail}` : ""}`);
  }

  sigBegin(movieId, reason, extra = {}) {
    const parts = [];
    if (movieId && movieId !== "大盘") parts.push(`电影${movieId}`);
    else if (movieId === "大盘") parts.push("大盘");
    if (extra.boxLevel) parts.push(`维度${extra.boxLevel}`);
    const who = parts.length ? parts.join("") : "系统";
    this._sigSession = { movieId, start: Date.now() };
    this._sigBuffer = [`开始给${who}更新签名：${reason}`];
  }

  sigStep(text) {
    if (this._sigSession) this._sigBuffer.push(text);
  }

  sigEnd(ok, detail = "") {
    const ms = this._sigSession
      ? ((Date.now() - this._sigSession.start) / 1000).toFixed(1)
      : "?";
    const ctx = this._ctx();

    if (ok) {
      lastSignatureSuccessAt = new Date().toISOString();
      lastSignatureError = null;
      const summary = detail ? `用时${ms}秒，${detail}` : `用时${ms}秒`;
      if (ctx) {
        ctx.setSig(`capture(${summary})`);
      } else {
        this._emit(`签名更新完成，${summary}`);
      }
    } else {
      lastSignatureError = detail || "签名更新失败";
      for (const line of this._sigBuffer) {
        this._emit(`签名：${line}`);
      }
      const tail = detail ? `，${detail}` : "";
      this._emit(`签名更新失败，用时${ms}秒${tail}`);
      if (ctx) ctx.tag("sig-fail");
    }

    this._sigSession = null;
    this._sigBuffer = [];
  }

  sigFail(reason) {
    this.sigStep(reason);
    this.sigEnd(false, reason);
  }

  markDashboardSuccess() {
    lastDashboardSuccessAt = new Date().toISOString();
  }

  start(port) {
    this._emit(`服务已启动，地址：http://127.0.0.1:${port}`);
    this._emit(`日志文件：${getLogFilePath()}`);
    this._emit(`日期票房示例：http://127.0.0.1:${port}/i/api/movie/getBoxShow?movieId=电影编号&boxLevel=1`);
  }

  manualRefresh(movieId, boxLevel) {
    this.sigBegin(movieId, "你点了手动刷新", { boxLevel });
  }

  refreshDone() {
    this.sigEnd(true, "已保存到本地");
  }

  exit() {
    this._emit("程序已退出");
  }

  chromeOk(chromePath = "") {
    this._emit(chromePath ? `浏览器已就绪：${chromePath}` : "浏览器已就绪");
  }

  chromeMissing() {
    this._emit("没找到浏览器，请在 config.ini 里填写浏览器路径");
  }

  depsMissing() {
    this._emit("程序不完整，请重新复制整个文件夹");
  }

  portStillBusy(port) {
    this._emit(`端口 ${port} 仍被占用，请先关掉占用它的程序`);
  }

  info(text) {
    this._emit(String(text));
  }

  error(text, err) {
    const msg = err?.stack || err?.message || "";
    this._emit(`${text}${msg ? `：${sanitizeForLog(msg)}` : ""}`);
  }

  onRequest() {}
  onApiRequest() {}
  cacheHit() {
    this.reqData("cache");
  }
  cacheDisk() {
    this.reqSig("disk");
  }
  sigExpired() {
    this.reqSig("expired");
  }
  forceRefresh() {
    this.reqSig("force");
  }
  protocolOk() {
    this.reqMode("proto");
  }
  browserStart(movieId) {
    if (!this._sigSession) {
      this.sigBegin(movieId, "签名过期或没有签名", {});
    }
    this.sigStep("正在打开浏览器抓签名");
  }
  retry(attempt) {
    this.sigStep(`第 ${attempt} 次重试抓签名`);
  }
  sigOk() {
    this.sigStep("签名抓到了，已保存");
  }
  denied() {
    this.reqTag("403-retry");
  }
  fetchOk() {
    this.reqData("fresh");
  }
  fetchFail(reason, detail = "") {
    this.reqFail(reason, detail);
  }
}

const NON_RETRYABLE_SIG_ERRORS = new Set([
  "chrome_not_found",
  "login_in_progress",
  "login_required",
  "browser_launch_failed",
]);

export function explainError(e) {
  const name = String(e?.name || "");
  const msg = String(e?.message || "");

  if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
    return "等待太久超时了，请稍后再试";
  }
  if (/net::|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return "连不上猫眼服务器，请检查网络";
  }
  if (/Target page|browser has been closed|Browser closed/i.test(msg)) {
    return "浏览器意外关闭了，请再试一次";
  }
  if (/ENOENT|EBUSY|EACCES|EPERM/i.test(msg)) {
    return "读写本地文件失败，请检查程序文件夹权限";
  }
  if (/Invalid URL|URL/i.test(msg)) {
    return "请求地址有误，将自动重新抓签名";
  }
  if (msg.includes("sig_capture_failed") || msg.includes("签名")) {
    return "没抓到有效签名，请先完成猫眼登录（可点击右上角登录）";
  }
  if (msg.length > 0 && msg.length < 80 && !/[a-z]{5,}/i.test(msg)) {
    return msg;
  }
  if (msg.length > 0 && msg.length < 120) {
    return msg.replace(/playwright/gi, "浏览器").replace(/chrome/gi, "浏览器");
  }
  return "程序运行出错，请重启服务再试";
}

export function isNonRetryableSigError(error) {
  const msg = String(error?.message || error || "");
  return NON_RETRYABLE_SIG_ERRORS.has(msg);
}

export function buildDiagnostics() {
  const chromePath = getChromeExecutable();
  const chromeFound = Boolean(chromePath);
  const chromePathValid = chromeFound && fs.existsSync(chromePath);
  const loginStateExists = storageFileExists(STORAGE_STATE);
  const loginVerified = storageFileLooksLoggedIn(STORAGE_STATE);
  const loginLock = fs.existsSync(path.join(getDataDir(), "login.lock"));

  return {
    serviceReady: true,
    chromeFound,
    chromePathValid,
    chromePath: chromePathValid ? chromePath : "",
    loginStateExists,
    loginVerified,
    loginInProgress: loginLock,
    browserLaunchAvailable: chromePathValid && !loginLock,
    signatureAvailable: Boolean(lastSignatureSuccessAt),
    lastSignatureSuccessAt,
    lastSignatureError,
    lastDashboardSuccessAt,
  };
}

export const log = new Logger();

export function resolveApiName(req) {
  const reqPath = req.path || "";
  if (reqPath.includes("getBoxShowna")) return "getBoxShowna";
  if (reqPath.includes("getPredictionBox")) return "getPredictionBox";
  if (reqPath.includes("getTechData")) return "getTechData";
  if (reqPath.includes("getWantData")) return "getWantData";
  if (reqPath.includes("getBoxShow") || reqPath.includes("boxshow")) return "getBoxShow";
  if (reqPath.includes("dashboard")) return "dashboard";
  if (reqPath.includes("refresh")) return "refresh";
  return "unknown";
}

export function requestLogMiddleware(req, res, next) {
  if (req.path === "/health" || req.path === "/api/refresh") {
    next();
    return;
  }

  const ctx = log.beginReq({
    route: req.path,
    api: resolveApiName(req),
    movieId: req.query.movieId || req.query.movie_id,
    boxLevel: req.query.boxLevel || req.query.box_level,
  });

  log.runReq(ctx, () => {
    res.on("finish", () => {
      if (res.statusCode >= 400 && ctx.ok) {
        ctx.setFail(`服务器返回错误`, `状态码 ${res.statusCode}`);
      }
      log.endReq(ctx);
    });
    next();
  });
}
