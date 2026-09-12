import fs from "fs";
import { chromium } from "playwright";
import {
  BOX_PAGE,
  BROWSER_API_CACHE_TTL,
  DASHBOARD_CACHE_TTL,
  COOKIE_FILE,
  MAX_CACHE_ENTRIES,
  SIG_TTL_SECONDS,
  STORAGE_STATE,
  UPSTREAM_TIMEOUT_MS,
  USER_AGENT,
  buildApiUrl,
  getChromeExecutable,
  loadCookieHeader,
  parseCapturedAt,
  parseCookies,
  randomTraceId,
  sessionCachePath,
  wukongSessionCachePath,
} from "./config.js";
import { log } from "./logger.js";
import {
  buildMygsig,
  generateSignKey,
  generateUid,
  randomUuid,
} from "./maoyanSign.js";

function safeRequestUrl(entry, movieId, boxLevel) {
  const raw = entry?.url;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.hostname.includes("maoyan.com")) return raw;
    } catch {
      /* fallback */
    }
  }
  return buildApiUrl(movieId, boxLevel);
}

function safeWuKongUrl(entry, apiPath, params) {
  const raw = entry?.url;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.hostname.includes("maoyan.com")) return raw;
    } catch {
      /* fallback */
    }
  }
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  return `${UPSTREAM_ORIGIN}${apiPath}?${qs}`;
}

async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new UpstreamError(502, "network_failed");
  }
}
const UPSTREAM_ORIGIN = "https://piaofang.maoyan.com";
const DASHBOARD_PAGE = "https://piaofang.maoyan.com/dashboard";
const DASHBOARD_API = "/i/api/dashboard-ajax/movie";

export class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class AsyncLock {
  constructor() {
    this._tail = Promise.resolve();
  }
  run(fn) {
    const run = this._tail.then(fn);
    this._tail = run.catch(() => {});
    return run;
  }
}

function buildRequestHeaders(entry, extra = {}) {
  const h = entry?.headers || {};
  const headers = {
    Accept: h.accept || "application/json, text/plain, */*",
    "Accept-Language": h["accept-language"] || "zh-CN,zh;q=0.9",
    "m-appkey": h["m-appkey"] || "fe_com.sankuai.movie.fe.ipro",
    "m-traceid": randomTraceId(),
    mtgsig: h.mtgsig || "",
    Referer: h.referer || BOX_PAGE(entry?.movieId),
    "User-Agent": h["user-agent"] || USER_AGENT,
    uid: extra.uid || h.uid || "",
    uuid: extra.uuid || h.uuid || "",
  };
  const cookie = extra.cookie ?? loadCookieHeader();
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

function extractFromRequest(req) {
  const h = req.headers();
  const url = req.url();
  if (h.mtgsig) {
    return { headers: { ...h }, url };
  }
  try {
    const q = new URL(url).searchParams.get("mtgsig");
    if (q) {
      return { headers: { ...h, mtgsig: q }, url };
    }
  } catch {
    return null;
  }
  return null;
}

function loadEntryFromFile(filePath, movieId, boxLevel) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const q = raw.query || {};
    if (String(q.movieId) !== String(movieId) || String(q.boxLevel) !== String(boxLevel)) {
      return null;
    }
    const headers = raw.headers || {};
    if (!headers.mtgsig) return null;
    if (raw.source !== "browser") return null;
    return {
      movieId: String(movieId),
      boxLevel: String(boxLevel),
      url: raw.url || buildApiUrl(movieId, boxLevel),
      headers,
      refreshedAt: parseCapturedAt(raw.captured_at),
      source: raw.source,
    };
  } catch {
    return null;
  }
}

function saveEntry(entry) {
  const payload = {
    url: entry.url,
    method: "GET",
    query: {
      movieId: entry.movieId,
      boxLevel: entry.boxLevel,
      yodaReady: "h5",
      csecplatform: "4",
      csecversion: "4.3.0",
    },
    headers: entry.headers,
    captured_at: new Date().toISOString(),
    source: "browser",
  };
  fs.writeFileSync(
    sessionCachePath(entry.movieId, entry.boxLevel),
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
}

function loadWuKongEntryFromFile(filePath, movieId, apiPath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (String(raw.movieId) !== String(movieId)) return null;
    if (raw.apiPath !== apiPath) return null;
    const headers = raw.headers || {};
    if (!headers.mtgsig) return null;
    return {
      movieId: String(movieId),
      apiPath,
      headers,
      url: raw.url || "",
      refreshedAt: parseCapturedAt(raw.captured_at),
      source: "browser",
    };
  } catch {
    return null;
  }
}

function saveWuKongEntry(movieId, apiPath, entry) {
  const payload = {
    movieId: String(movieId),
    apiPath,
    url: entry.url || "",
    headers: entry.headers,
    captured_at: new Date().toISOString(),
    source: "browser",
  };
  const slug = apiPath.split("/").pop();
  fs.writeFileSync(
    wukongSessionCachePath(movieId, slug),
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function buildWuKongParams(query = {}, movieId = "") {
  const sk = generateSignKey("GET", USER_AGENT);
  const clientSignKey = String(query.signKey ?? "").trim();

  const base = {
    movieId: String(movieId || query.movieId || "").trim(),
    WuKongReady: query.WuKongReady || "h5",
  };

  if (query.token !== undefined && query.token !== null) {
    base.token = String(query.token);
  }

  if (clientSignKey) {
    return {
      ...base,
      timeStamp: String(query.timeStamp ?? sk.timeStamp),
      "User-Agent": query["User-Agent"] ?? sk.encodedUA,
      index: String(query.index ?? sk.index),
      channelId: String(query.channelId ?? sk.channelId),
      sVersion: query.sVersion || "2",
      signKey: clientSignKey,
    };
  }

  return {
    ...base,
    timeStamp: String(sk.timeStamp),
    "User-Agent": sk.encodedUA,
    index: String(sk.index),
    channelId: String(query.channelId || sk.channelId),
    sVersion: query.sVersion || "2",
    signKey: sk.signKey,
  };
}

function buildDashboardParams(query = {}) {
  const channelId = Number(query.channelId || 40009);
  const indexOverride = isBlank(query.index) ? undefined : Number(query.index);
  const sk = generateSignKey("GET", USER_AGENT, channelId, indexOverride);
  const clientSignKey = String(query.signKey ?? "").trim();

  if (clientSignKey) {
    return {
      movieId: query.movieId ?? "",
      orderType: query.orderType ?? "0",
      uuid: query.uuid ?? "",
      timeStamp: String(query.timeStamp ?? sk.timeStamp),
      "User-Agent": query["User-Agent"] ?? sk.encodedUA,
      index: String(query.index ?? sk.index),
      channelId: String(query.channelId ?? sk.channelId),
      sVersion: query.sVersion || "2",
      signKey: clientSignKey,
      WuKongReady: query.WuKongReady || "h5",
    };
  }

  return {
    movieId: query.movieId ?? "",
    orderType: query.orderType ?? "0",
    uuid: isBlank(query.uuid) ? randomUuid() : String(query.uuid),
    timeStamp: String(sk.timeStamp),
    "User-Agent": sk.encodedUA,
    index: String(sk.index),
    channelId: String(query.channelId || sk.channelId),
    sVersion: query.sVersion || "2",
    signKey: sk.signKey,
    WuKongReady: query.WuKongReady || "h5",
  };
}

function wukongCacheKey(apiPath, query = {}, movieId = "") {
  const q = { ...query };
  const skip = new Set([
    "force_refresh",
    "forceRefresh",
    "signKey",
    "timeStamp",
    "index",
    "User-Agent",
    "channelId",
    "sVersion",
  ]);
  for (const key of skip) {
    delete q[key];
  }
  if (!q.movieId) {
    q.movieId = movieId;
  }
  if (!q.WuKongReady) {
    q.WuKongReady = "h5";
  }
  return stableCacheKey(apiPath, q);
}

function stableCacheKey(apiPath, query) {
  const entries = [];
  const skip = new Set(["force_refresh", "forceRefresh"]);
  for (const [key, value] of Object.entries(query || {})) {
    if (skip.has(key) || value === undefined || value === null) continue;
    entries.push([key, String(value)]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const params = new URLSearchParams(entries);
  return `${apiPath}?${params.toString()}`;
}

function dashboardCacheKey(query = {}) {
  return stableCacheKey(DASHBOARD_API, {
    movieId: String(query.movieId ?? ""),
    orderType: String(query.orderType ?? "0"),
    channelId: String(query.channelId ?? "40009"),
    sVersion: String(query.sVersion ?? "2"),
    WuKongReady: String(query.WuKongReady ?? "h5"),
  });
}

const WUKONG_API_PATHS = [
  "/i/api/movie/getPredictionBox",
  "/i/api/movie/getBoxShowna",
  "/i/api/movie/getTechData",
  "/i/api/movie/getWantData",
];

const API_ZH = {
  getBoxShow: "日期票房",
  getPredictionBox: "预测票房",
  getBoxShowna: "全球票房",
  getTechData: "下映时间",
  getWantData: "想看数据",
};

function apiZh(slug) {
  return API_ZH[slug] || slug;
}

export class SigManager {
  constructor() {
    this.ttl = SIG_TTL_SECONDS;
    this.cache = new Map();
    this.browserApiCache = new Map();
    this.refreshLock = new AsyncLock();
    this.browserLock = new AsyncLock();
    this.movieCapturePromises = new Map();
    this.movieAuthCache = new Map();
    this.inflight = new Map();
    this.wukongRefreshLocks = new Map();
    this._pruneTimer = setInterval(() => this.pruneCache(), 30 * 60 * 1000);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  destroy() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this.cache.clear();
    this.browserApiCache.clear();
    this.movieCapturePromises.clear();
    this.movieAuthCache.clear();
    this.inflight.clear();
    this.wukongRefreshLocks.clear();
  }

  rememberMovieAuth(movieId, headers = {}) {
    const uid = headers.uid || headers.UID;
    const uuid = headers.uuid || headers.UUID;
    if (!uid && !uuid) return;
    const key = String(movieId);
    const prev = this.movieAuthCache.get(key) || {};
    this.movieAuthCache.set(key, {
      uid: uid || prev.uid || "",
      uuid: uuid || prev.uuid || "",
      refreshedAt: Date.now() / 1000,
    });
  }

  pruneCache() {
    const now = Date.now() / 1000;
    for (const [key, entry] of this.cache) {
      if (!entry?.refreshedAt || now - entry.refreshedAt >= this.ttl) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }

    for (const [key, entry] of this.browserApiCache) {
      if (!entry?.refreshedAt || now - entry.refreshedAt >= BROWSER_API_CACHE_TTL) {
        this.browserApiCache.delete(key);
      }
    }
    while (this.browserApiCache.size > MAX_CACHE_ENTRIES) {
      const first = this.browserApiCache.keys().next().value;
      if (first === undefined) break;
      this.browserApiCache.delete(first);
    }
  }

  isFresh(entry, ttl = this.ttl) {
    if (!entry || !entry.refreshedAt) return false;
    return Date.now() / 1000 - entry.refreshedAt < ttl;
  }

  cacheKey(movieId, boxLevel) {
    return `${movieId}:${boxLevel}`;
  }

  loadPersisted(movieId, boxLevel) {
    return loadEntryFromFile(sessionCachePath(movieId, boxLevel), movieId, boxLevel);
  }

  loadWuKongPersisted(movieId, apiPath) {
    const slug = apiPath.split("/").pop();
    return loadWuKongEntryFromFile(
      wukongSessionCachePath(movieId, slug),
      movieId,
      apiPath
    );
  }

  wukongSigCacheKey(movieId, apiPath) {
    const slug = apiPath.split("/").pop();
    return `wukong:${movieId}:${slug}`;
  }

  getWuKongEntry(movieId, apiPath, _query, { force = false, silent = false } = {}) {
    const cacheKey = this.wukongSigCacheKey(movieId, apiPath);
    if (!force) {
      const mem = this.cache.get(cacheKey);
      if (mem && this.isFresh(mem)) {
        if (!silent) log.reqSig("mem");
        return this.enrichWuKongEntry(movieId, mem);
      }
      const disk = this.loadWuKongPersisted(movieId, apiPath);
      if (disk && this.isFresh(disk)) {
        if (!silent) log.reqSig("disk");
        this.rememberMovieAuth(movieId, disk.headers);
        const enriched = this.enrichWuKongEntry(movieId, disk);
        this.cache.set(cacheKey, enriched);
        return enriched;
      }
      if (!silent && (mem || disk)) log.reqSig("expired");
    }
    return null;
  }

  enrichWuKongEntry(movieId, entry) {
    const auth = this.resolveMovieAuthExtras(movieId);
    if (!auth.uid && !auth.uuid) return entry;
    return {
      ...entry,
      headers: {
        ...entry.headers,
        uid: auth.uid || entry.headers?.uid || "",
        uuid: auth.uuid || entry.headers?.uuid || "",
      },
    };
  }

  countWuKongSigs(movieId) {
    let n = 0;
    for (const apiPath of WUKONG_API_PATHS) {
      const cacheKey = this.wukongSigCacheKey(movieId, apiPath);
      const mem = this.cache.get(cacheKey);
      if (mem && this.isFresh(mem)) {
        n += 1;
        continue;
      }
      const disk = this.loadWuKongPersisted(movieId, apiPath);
      if (disk && this.isFresh(disk)) n += 1;
    }
    return n;
  }

  runInflight(key, fn) {
    if (this.inflight.has(key)) {
      log.reqInflight();
      return this.inflight.get(key);
    }
    const task = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  getWuKongRefreshLock(movieId) {
    const key = String(movieId);
    if (!this.wukongRefreshLocks.has(key)) {
      this.wukongRefreshLocks.set(key, new AsyncLock());
    }
    return this.wukongRefreshLocks.get(key);
  }

  saveBoxShowSigFromCapture(movieId, url, headers) {
    if (!headers?.mtgsig) return;
    try {
      const q = Object.fromEntries(new URL(url).searchParams.entries());
      const boxLevel = String(q.boxLevel || "1");
      const entry = {
        movieId: String(movieId),
        boxLevel,
        url,
        headers,
        refreshedAt: Date.now() / 1000,
        source: "browser",
      };
      this.cache.set(this.cacheKey(movieId, boxLevel), entry);
      saveEntry(entry);
      this.rememberMovieAuth(movieId, headers);
    } catch {
      /* noop */
    }
  }

  rememberMovieRequest(movieId, req) {
    if (req.method() !== "GET" || !req.url().includes("/i/api/movie/")) return;
    const got = extractFromRequest(req);
    if (!got?.headers?.mtgsig) return;
    this.rememberMovieAuth(movieId, got.headers);

    try {
      const url = new URL(req.url());
      const path = url.pathname;
      const q = Object.fromEntries(url.searchParams.entries());
      if (path.endsWith("/getBoxShow")) {
        this.saveBoxShowSigFromCapture(movieId, got.url, got.headers);
      } else {
        this.storeWuKongSig(movieId, path, q, got);
      }
    } catch {
      /* noop */
    }
    return got;
  }

  async launchBrowserContext() {
    const chromePath = getChromeExecutable();
    if (!chromePath || !fs.existsSync(chromePath)) {
      log.chromeMissing();
      throw new Error("chrome_not_found");
    }

    const browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
    });

    const ctxOpts = { userAgent: USER_AGENT, locale: "zh-CN" };
    if (fs.existsSync(STORAGE_STATE)) {
      ctxOpts.storageState = STORAGE_STATE;
    }
    const context = await browser.newContext(ctxOpts);

    if (fs.existsSync(COOKIE_FILE)) {
      try {
        const text = fs.readFileSync(COOKIE_FILE, "utf-8");
        await context.addCookies(parseCookies(text));
      } catch {
        /* noop */
      }
    }

    return { browser, context };
  }

  async closeBrowserSession(browser, context) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  async fetchInPage(page, absoluteUrl) {
    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, { credentials: "include" });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: JSON.stringify({ detail: String(e) }) };
      }
    }, absoluteUrl);

    if (!result.ok) {
      throw new UpstreamError(result.status || 502, "upstream_failed");
    }

    try {
      return JSON.parse(result.text);
    } catch {
      throw new UpstreamError(502, "bad_json");
    }
  }

  async withBrowserPage(movieId, pageUrl, fn) {
    return this.browserLock.run(async () => {
      let browser;
      let context;
      try {
        ({ browser, context } = await this.launchBrowserContext());
        const page = await context.newPage();
        try {
          log.browserStart(movieId || "大盘");
          await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
          await page.waitForTimeout(800);
          const result = await fn(page);
          try {
            await context.storageState({ path: STORAGE_STATE });
          } catch {
            /* noop */
          }
          return result;
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await this.closeBrowserSession(browser, context);
      }
    });
  }

  async captureMtgsig(movieId, boxLevel) {
    const targetSub = `movieId=${movieId}&boxLevel=${boxLevel}`;
    const captured = {};

    const remember = (req) => {
      const got = this.rememberMovieRequest(movieId, req);
      if (!got) return;
      if (!req.url().includes("getBoxShow") || !req.url().includes(targetSub)) return;
      captured.headers = got.headers;
      captured.url = got.url;
    };

    return this.browserLock.run(async () => {
      let browser;
      let context;
      try {
        ({ browser, context } = await this.launchBrowserContext());
        const page = await context.newPage();
        try {
          page.on("request", remember);
          page.on("response", (resp) => {
            if (!resp.url().includes("/i/api/movie/")) return;
            remember(resp.request());
          });

          log.browserStart(movieId);
          log.sigStep(`正在打开票房页`);
          await page.goto(BOX_PAGE(movieId), { waitUntil: "domcontentloaded", timeout: 90000 });

          let onBox = false;
          try {
            onBox = await page.evaluate(() => location.hostname.includes("piaofang"));
          } catch {
            onBox = false;
          }

          if (!onBox) {
            log.sigStep("没进到票房页，请先运行 login.bat 登录");
          }

          await page.waitForTimeout(800);

          for (let i = 0; i < 2 && !captured.headers?.mtgsig; i++) {
            if (!onBox) break;
            try {
              const urls = [
                `/i/api/movie/getBoxShow?movieId=${movieId}&boxLevel=${boxLevel}&yodaReady=h5&csecplatform=4&csecversion=4.3.0`,
              ];
              for (const apiPath of WUKONG_API_PATHS) {
                const p = buildWuKongParams(
                  apiPath === "/i/api/movie/getWantData" ? { token: "" } : {},
                  movieId
                );
                const qs = new URLSearchParams(
                  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
                );
                urls.push(`${apiPath}?${qs}`);
              }
              log.sigStep(`正在批量请求票房接口（第${i + 1}次）`);
              await page.evaluate(async (list) => {
                for (const url of list) {
                  try {
                    await fetch(url, { credentials: "include" });
                  } catch {
                    /* noop */
                  }
                }
              }, urls);
            } catch {
              break;
            }
            if (captured.headers?.mtgsig) break;
            await page.waitForTimeout(1200);
          }

          // 等待 WuKong 接口响应写入缓存（避免只抓到 getBoxShow 就结束）
          if (onBox) {
            for (let wait = 0; wait < 6 && this.countWuKongSigs(movieId) < WUKONG_API_PATHS.length; wait++) {
              await page.waitForTimeout(500);
            }
            log.sigStep(`已缓存 ${this.countWuKongSigs(movieId)}/${WUKONG_API_PATHS.length} 个扩展接口签名`);
          }

          try {
            await context.storageState({ path: STORAGE_STATE });
          } catch {
            /* noop */
          }
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await this.closeBrowserSession(browser, context);
      }

      return captured;
    });
  }

  async refresh(movieId, boxLevel) {
    movieId = String(movieId);
    boxLevel = String(boxLevel);

    let captured = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) log.retry(attempt);
      try {
        captured = await this.captureMtgsig(movieId, boxLevel);
      } catch {
        captured = null;
        log.sigStep("打开浏览器时出错了，准备重试");
      }
      if (captured?.headers?.mtgsig) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!captured?.headers?.mtgsig) {
      log.sigFail("页面没返回有效签名，请检查网络或先登录");
      throw new Error("sig_capture_failed");
    }

    const entry = {
      movieId,
      boxLevel,
      url: captured.url || buildApiUrl(movieId, boxLevel),
      headers: captured.headers,
      refreshedAt: Date.now() / 1000,
      source: "browser",
    };

    this.cache.set(this.cacheKey(movieId, boxLevel), entry);
    this.pruneCache();
    try {
      saveEntry(entry);
    } catch {
      log.sigStep("签名抓到了，但保存到本地失败");
    }
    log.sigStep(`日期票房签名已抓到，维度${boxLevel}`);
    log.sigEnd(true, "已保存到本地");
    return entry;
  }

  async getSession(movieId, boxLevel, { force = false } = {}) {
    movieId = String(movieId);
    boxLevel = String(boxLevel);
    const key = this.cacheKey(movieId, boxLevel);

    if (!force) {
      const mem = this.cache.get(key);
      if (mem && this.isFresh(mem)) {
        log.reqSig("mem");
        return mem;
      }
      const disk = this.loadPersisted(movieId, boxLevel);
      if (disk && this.isFresh(disk)) {
        log.reqSig("disk");
        this.rememberMovieAuth(movieId, disk.headers);
        this.cache.set(key, disk);
        return disk;
      }
      if (mem || disk) log.reqSig("expired");
    } else {
      log.reqSig("force");
    }

    return this.refreshLock.run(async () => {
      if (!force) {
        const mem = this.cache.get(key);
        if (mem && this.isFresh(mem)) return mem;
        const disk = this.loadPersisted(movieId, boxLevel);
        if (disk && this.isFresh(disk)) {
          this.rememberMovieAuth(movieId, disk.headers);
          this.cache.set(key, disk);
          return disk;
        }
      }
      return this.refresh(movieId, boxLevel);
    });
  }

  resolveMovieAuthExtras(movieId) {
    const extras = {};
    const auth = this.movieAuthCache.get(String(movieId));
    if (auth) {
      if (auth.uid) extras.uid = auth.uid;
      if (auth.uuid) extras.uuid = auth.uuid;
    }
    for (const boxLevel of ["1", "2", "3"]) {
      const mem = this.cache.get(this.cacheKey(movieId, boxLevel));
      const disk = this.loadPersisted(movieId, boxLevel);
      const entry =
        mem && this.isFresh(mem) ? mem : disk && this.isFresh(disk) ? disk : null;
      if (!entry?.headers) continue;
      if (!extras.uid && entry.headers.uid) extras.uid = entry.headers.uid;
      if (!extras.uuid && entry.headers.uuid) extras.uuid = entry.headers.uuid;
      if (extras.uid && extras.uuid) break;
    }
    if (!extras.uid || !extras.uuid) {
      const slugList = [
        "getBoxShow",
        "getPredictionBox",
        "getBoxShowna",
        "getTechData",
        "getWantData",
      ];
      for (const slug of slugList) {
        const file = wukongSessionCachePath(movieId, slug);
        if (!fs.existsSync(file)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
          const h = raw.headers || {};
          if (!extras.uid && h.uid) extras.uid = h.uid;
          if (!extras.uuid && h.uuid) extras.uuid = h.uuid;
        } catch {
          /* noop */
        }
        if (extras.uid && extras.uuid) break;
      }
    }
    return extras;
  }

  async requestUpstream(movieId, boxLevel, entry) {
    const url = safeRequestUrl(entry, movieId, boxLevel);
    const authExtras = this.resolveMovieAuthExtras(movieId);
    log.reqUpstream();
    return safeFetch(url, {
      headers: buildRequestHeaders(entry, authExtras),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }

  async fetch(movieId, boxLevel, { forceRefresh = false } = {}) {
    movieId = String(movieId);
    boxLevel = String(boxLevel);
    const inflightKey = `box:${movieId}:${boxLevel}:${forceRefresh ? "f" : "n"}`;
    return this.runInflight(inflightKey, async () => {
      const key = this.cacheKey(movieId, boxLevel);

      let entry = await this.getSession(movieId, boxLevel, { force: forceRefresh });
      let resp = await this.requestUpstream(movieId, boxLevel, entry);

      if (resp.status === 401 || resp.status === 403) {
        if (resp.status === 403) {
          log.denied();
        } else {
          log.reqTag("401-retry");
        }
        this.cache.delete(key);
        try {
          fs.unlinkSync(sessionCachePath(movieId, boxLevel));
        } catch {
          /* noop */
        }
        entry = await this.getSession(movieId, boxLevel, { force: true });
        resp = await this.requestUpstream(movieId, boxLevel, entry);
      }

      if (!resp.ok) {
        throw new UpstreamError(resp.status, "upstream_failed");
      }

      let data;
      try {
        data = await resp.json();
      } catch {
        throw new UpstreamError(502, "bad_json");
      }

      log.reqData("fresh");
      log.reqMode("proto");
      return data;
    });
  }

  buildQueryString(query, { skip = [] } = {}) {
    const skipSet = new Set([...skip, "force_refresh", "forceRefresh"]);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (skipSet.has(key)) continue;
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    return params.toString();
  }

  storeWuKongSig(movieId, apiPath, query, captured) {
    if (!captured?.headers?.mtgsig) return;
    const authExtras = this.resolveMovieAuthExtras(movieId);
    const headers = { ...captured.headers };
    if (!headers.uid && authExtras.uid) headers.uid = authExtras.uid;
    if (!headers.uuid && authExtras.uuid) headers.uuid = authExtras.uuid;
    if (!headers["m-appkey"]) headers["m-appkey"] = "fe_com.sankuai.movie.fe.ipro";

    const entry = {
      movieId: String(movieId),
      headers,
      url: captured.url || "",
      refreshedAt: Date.now() / 1000,
      source: "browser",
    };
    const cacheKey = this.wukongSigCacheKey(movieId, apiPath);
    this.cache.set(cacheKey, entry);
    saveWuKongEntry(movieId, apiPath, entry);
  }

  async captureApiMtgsig(movieId, apiPath, params, query = {}) {
    const movieKey = String(movieId);
    if (this.movieCapturePromises.has(movieKey)) {
      await this.movieCapturePromises.get(movieKey);
      const cached = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
      if (cached) {
        return { headers: cached.headers, url: cached.url };
      }
    }

    const disk = this.loadWuKongPersisted(movieId, apiPath);
    if (disk && this.isFresh(disk)) {
      const enriched = this.enrichWuKongEntry(movieId, disk);
      this.cache.set(this.wukongSigCacheKey(movieId, apiPath), enriched);
      return { headers: enriched.headers, url: enriched.url };
    }

    const task = this._captureApiMtgsig(movieId, apiPath, params, query);
    this.movieCapturePromises.set(movieKey, task);
    try {
      return await task;
    } finally {
      this.movieCapturePromises.delete(movieKey);
    }
  }

  async _captureApiMtgsig(movieId, apiPath, params, query = {}) {
    const apiNeedle = apiPath.split("/").pop();
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString();
    const absoluteUrl = `${UPSTREAM_ORIGIN}${apiPath}?${qs}`;
    const captured = {};

    const remember = (req) => {
      const got = this.rememberMovieRequest(movieId, req);
      if (!got) return;
      if (req.url().includes(apiNeedle)) {
        captured.headers = got.headers;
        captured.url = got.url;
      }
    };

    return this.browserLock.run(async () => {
      let browser;
      let context;
      try {
        ({ browser, context } = await this.launchBrowserContext());
        const page = await context.newPage();
        try {
          page.on("request", remember);
          page.on("response", (resp) => {
            if (!resp.url().includes("/i/api/movie/")) return;
            remember(resp.request());
          });

          log.browserStart(movieId);
          log.sigStep(`正在打开票房页`);
          await page.goto(BOX_PAGE(movieId), { waitUntil: "domcontentloaded", timeout: 90000 });

          let onBox = false;
          try {
            onBox = await page.evaluate(() => location.hostname.includes("piaofang"));
          } catch {
            onBox = false;
          }

          if (!onBox) {
            log.sigStep("没进到票房页，请先运行 login.bat 登录");
            return captured;
          }

          await page.waitForTimeout(800);

          for (let i = 0; i < 2 && !captured.headers?.mtgsig; i++) {
            try {
              const urls = [absoluteUrl];
              for (const path of WUKONG_API_PATHS) {
                if (path === apiPath) continue;
                const p = buildWuKongParams(
                  path === "/i/api/movie/getWantData" ? { token: "" } : {},
                  movieId
                );
                const u = `${UPSTREAM_ORIGIN}${path}?${new URLSearchParams(
                  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
                )}`;
                urls.push(u);
              }
              log.sigStep(`正在请求${apiZh(apiNeedle)}等接口（第${i + 1}次）`);
              await page.evaluate(async (list) => {
                for (const url of list) {
                  try {
                    await fetch(url, { credentials: "include" });
                  } catch {
                    /* noop */
                  }
                }
              }, urls);
            } catch {
              break;
            }
            if (captured.headers?.mtgsig) break;
            await page.waitForTimeout(1200);
          }

          if (captured.headers?.mtgsig) {
            this.storeWuKongSig(movieId, apiPath, query, captured);
            log.sigStep(`${apiZh(apiNeedle)}签名已抓到`);
            log.sigEnd(true, "已保存到本地");
          }

          this.pruneCache();
          try {
            await context.storageState({ path: STORAGE_STATE });
          } catch {
            /* noop */
          }
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await this.closeBrowserSession(browser, context);
      }

      return captured;
    });
  }

  async requestWuKongUpstream(apiPath, params, entry) {
    const url = safeWuKongUrl(entry, apiPath, params);
    const authExtras = this.resolveMovieAuthExtras(params.movieId);
    log.reqUpstream();
    return safeFetch(url, {
      headers: buildRequestHeaders(
        {
          movieId: params.movieId,
          headers: entry?.headers || {},
        },
        authExtras
      ),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }

  async warmMovieSigs(movieId, { force = false } = {}) {
    const movieKey = String(movieId);
    const run = this.getSession(movieId, "1", { force });
    this.movieCapturePromises.set(movieKey, run);
    try {
      await run;
    } finally {
      this.movieCapturePromises.delete(movieKey);
    }
  }

  async fetchWuKongWithSig(movieId, apiPath, params, query, { forceRefresh = false } = {}) {
    const cacheKey = this.wukongSigCacheKey(movieId, apiPath);

    const ensureEntry = async () => {
      let entry = forceRefresh ? null : this.getWuKongEntry(movieId, apiPath, query);
      if (entry) return entry;

      const movieKey = String(movieId);
      if (this.movieCapturePromises.has(movieKey)) {
        await this.movieCapturePromises.get(movieKey);
        entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (entry) return entry;
      }

      return this.getWuKongRefreshLock(movieId).run(async () => {
        entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (entry) return entry;

        await this.warmMovieSigs(movieId, { force: forceRefresh });
        entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (entry) {
          log.reqSig("browser");
          return entry;
        }

        let captured = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) log.retry(attempt);
          captured = await this.captureApiMtgsig(movieId, apiPath, params, query);
          if (captured.headers?.mtgsig) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        if (!captured?.headers?.mtgsig) {
          log.sigFail("页面没返回有效签名，请检查网络或先登录");
          throw new Error("sig_capture_failed");
        }

        entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (!entry) {
          entry = {
            movieId,
            headers: captured.headers,
            url: captured.url,
            refreshedAt: Date.now() / 1000,
            source: "browser",
          };
          this.cache.set(cacheKey, entry);
          saveWuKongEntry(movieId, apiPath, entry);
        }
        this.pruneCache();
        return entry;
      });
    };

    const recaptureEntry = async () => {
      return this.getWuKongRefreshLock(movieId).run(async () => {
        this.cache.delete(cacheKey);
        const slug = apiPath.split("/").pop();
        try {
          fs.unlinkSync(wukongSessionCachePath(movieId, slug));
        } catch {
          /* noop */
        }

        const boxKey = this.cacheKey(movieId, "1");
        this.cache.delete(boxKey);
        for (const api of WUKONG_API_PATHS) {
          this.cache.delete(this.wukongSigCacheKey(movieId, api));
        }
        try {
          fs.unlinkSync(sessionCachePath(movieId, "1"));
        } catch {
          /* noop */
        }

        await this.warmMovieSigs(movieId, { force: true });
        let entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (entry) return entry;

        let captured = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) log.retry(attempt);
          captured = await this.captureApiMtgsig(movieId, apiPath, params, query);
          if (captured.headers?.mtgsig) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        if (!captured?.headers?.mtgsig) {
          throw new Error("sig_capture_failed");
        }

        entry = this.getWuKongEntry(movieId, apiPath, query, { silent: true });
        if (!entry) {
          entry = {
            movieId,
            headers: captured.headers,
            url: captured.url,
            refreshedAt: Date.now() / 1000,
            source: "browser",
          };
          this.cache.set(cacheKey, entry);
          saveWuKongEntry(movieId, apiPath, entry);
        }
        return entry;
      });
    };

    let entry = await ensureEntry();
    let resp = await this.requestWuKongUpstream(apiPath, params, entry);

    if (resp.status === 401) {
      const auth = this.resolveMovieAuthExtras(movieId);
      if (auth.uid) {
        entry = this.enrichWuKongEntry(movieId, entry);
        resp = await this.requestWuKongUpstream(apiPath, params, entry);
      }
    }

    if (resp.status === 401 || resp.status === 403) {
      if (resp.status === 403) {
        log.denied();
      } else {
        log.reqTag("401-retry");
      }
      entry = await recaptureEntry();
      resp = await this.requestWuKongUpstream(apiPath, params, entry);
    }

    if (!resp.ok) {
      throw new UpstreamError(resp.status, "upstream_failed");
    }

    try {
      const data = await resp.json();
      log.reqData("fresh");
      log.reqMode("proto");
      return data;
    } catch {
      throw new UpstreamError(502, "bad_json");
    }
  }

  async fetchBrowserApi({ movieId, apiPath, query = {}, forceRefresh = false }) {
    movieId = String(movieId || query.movieId || "").trim();
    if (!movieId) {
      throw new Error("movie_id_required");
    }

    const params = buildWuKongParams(query, movieId);
    const cacheKey = wukongCacheKey(apiPath, query, movieId);
    const inflightKey = `wukong-data:${cacheKey}:${forceRefresh ? "f" : "n"}`;

    return this.runInflight(inflightKey, async () => {
      if (!forceRefresh) {
        const cached = this.browserApiCache.get(cacheKey);
        if (cached && this.isFresh(cached, BROWSER_API_CACHE_TTL)) {
          log.reqData("cache-90s");
          return cached.data;
        }
      }

      const data = await this.fetchWuKongWithSig(movieId, apiPath, params, query, {
        forceRefresh,
      });

      this.browserApiCache.set(cacheKey, {
        data,
        refreshedAt: Date.now() / 1000,
      });
      this.pruneCache();
      return data;
    });
  }

  async fetchDashboardMovie(query = {}, { forceRefresh = false } = {}) {
    const params = buildDashboardParams(query);
    const cacheKey = dashboardCacheKey(query);
    const inflightKey = `dash:${cacheKey}:${forceRefresh ? "f" : "n"}`;

    return this.runInflight(inflightKey, async () => {
      if (!forceRefresh) {
        const cached = this.browserApiCache.get(cacheKey);
        if (cached && this.isFresh(cached, DASHBOARD_CACHE_TTL)) {
          log.reqData(`cache-${DASHBOARD_CACHE_TTL}s`);
          return cached.data;
        }
      }

      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      ).toString();

      const requestOnce = async (extraHeaders = {}) => {
        log.reqUpstream();
        return safeFetch(`${UPSTREAM_ORIGIN}${DASHBOARD_API}?${qs}`, {
          headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: DASHBOARD_PAGE,
            "User-Agent": USER_AGENT,
            ...extraHeaders,
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      };

      const cookie = loadCookieHeader();
      const baseHeaders = cookie ? { Cookie: cookie } : {};

      let resp = await requestOnce(baseHeaders);
      if (!resp.ok && (resp.status === 403 || resp.status === 401)) {
        const mygsig = buildMygsig({ ...params, path: DASHBOARD_API });
        resp = await requestOnce({ ...baseHeaders, mygsig, uid: generateUid() });
      }

      if (resp.ok) {
        log.reqMode("proto");
      }

      if (!resp.ok) {
        log.reqTag("browser-fallback");
        const data = await this.withBrowserPage("", DASHBOARD_PAGE, async (page) => {
          return this.fetchInPage(page, `${UPSTREAM_ORIGIN}${DASHBOARD_API}?${qs}`);
        });
        this.browserApiCache.set(cacheKey, {
          data,
          refreshedAt: Date.now() / 1000,
        });
        this.pruneCache();
        log.reqData("fresh");
        log.reqMode("browser");
        return data;
      }

      let data;
      try {
        data = await resp.json();
      } catch {
        throw new UpstreamError(502, "bad_json");
      }

      this.browserApiCache.set(cacheKey, {
        data,
        refreshedAt: Date.now() / 1000,
      });
      this.pruneCache();
      log.reqData("fresh");
      return data;
    });
  }
}

export const manager = new SigManager();
