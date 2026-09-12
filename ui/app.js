import {
  fetchDashboard,
  parseDashboard,
  injectFontStyle,
  decodeBoxFromHtml,
  enrichMovies,
  enrichMoviesLight,
  enrichMoviesQuick,
  estimateSpeedMetrics,
} from "./maoyan-api.js";
import { applyOverlaySettings } from "./settings-applier.js";
import { renderDashboard } from "./dashboard-view.js";
import { initTrailerPlayer, syncTrailerWithRanking } from "./trailer-player.js";
import { loadMovieMedia, applyMediaToMovies } from "./data/movie-media.js";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const headerTimeEl = $("header-time");

const DESIGN_W = 1080;
const DESIGN_H = 1920;

let config = {};
let pollTimer = null;
let retryTimer = null;
let loginWatchTimer = null;
let clockTimer = null;
let viewportBound = false;
let refreshing = false;
let hasDisplayedData = false;
let pollCount = 0;
let lastFullEnrich = 0;
let enrichGeneration = 0;
let enrichingBackground = false;

const speedSnapshots = new Map();
const lastGoodMovies = new Map();
const lastGoodNation = {};
let latestMovies = [];
let latestSpeedMap = {};
let latestParsed = null;
let pollGeneration = 0;
let FULL_ENRICH_INTERVAL_MS = 60000;
let movieCatalog = [];

const PRESERVE_MOVIE_FIELDS = [
  "todayBoxHtml",
  "todayUnit",
  "boxRate",
  "showCountRate",
  "avgSeatView",
  "sumBoxDesc",
  "mainlandBox",
  "hmtBox",
  "overseasBox",
  "dynamicForecast",
  "totalForecast",
  "hourSpeedText",
  "dailyIncrease",
  "yesterdayTotal",
  "yesterdaySamePeriodText",
  "yesterdayHourSpeedText",
  "totalViews",
  "endDate",
  "remainingDays",
  "moviePoster",
  "posterUrl",
  "trailerSrc",
  "trailerTagline",
  "trailerRelease",
];

function fitViewport() {
  const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  document.documentElement.style.setProperty("--viewport-scale", String(scale));
}

function bindViewport() {
  if (viewportBound) return;
  viewportBound = true;
  window.addEventListener("resize", fitViewport, { passive: true });
  fitViewport();
}

function startClock() {
  const tick = () => {
    if (!headerTimeEl) return;
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const h = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    headerTimeEl.textContent = `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  };
  tick();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

function setStatus(type, text) {
  if (!statusEl) return;
  statusEl.className = `status status--${type}`;
  statusEl.textContent = text;
  statusEl.style.display = type === "ok" ? "none" : "block";
}

function isEmptyField(val) {
  if (val == null) return true;
  const text = String(val).trim();
  return !text || text === "--" || text === "-";
}

function updateMovieCache(key, movie) {
  const prev = lastGoodMovies.get(key) || {};
  const next = { ...prev };
  for (const [field, val] of Object.entries(movie)) {
    if (field === "rank" || field === "name" || field === "movieId") {
      next[field] = val;
      continue;
    }
    if (field === "todayBox") {
      if (val > 0) next[field] = val;
      continue;
    }
    if (!isEmptyField(val)) next[field] = val;
  }
  lastGoodMovies.set(key, next);
}

function preferNonEmptyFields(...sources) {
  const result = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, val] of Object.entries(source)) {
      if (val === undefined) continue;
      if (key === "todayBox") {
        if (val > 0) result[key] = val;
        continue;
      }
      if (!isEmptyField(val)) result[key] = val;
    }
  }
  return result;
}

function stabilizeMovie(movie) {
  const key = String(movie.movieId);
  const prev = lastGoodMovies.get(key) || {};
  const stable = { ...movie };

  for (const field of PRESERVE_MOVIE_FIELDS) {
    if (isEmptyField(stable[field])) {
      const cached = prev[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }

  stable.rank = movie.rank;
  stable.name = movie.name;
  stable.movieId = movie.movieId;

  if (stable.todayBox <= 0 && stable.todayBoxHtml) {
    const decoded = decodeBoxFromHtml(stable.todayBoxHtml, stable.todayUnit);
    if (decoded > 0) stable.todayBox = decoded;
    else if (prev.todayBox > 0) stable.todayBox = prev.todayBox;
  } else if (stable.todayBox <= 0 && prev.todayBox > 0) {
    stable.todayBox = prev.todayBox;
  }

  updateMovieCache(key, stable);
  return stable;
}

function stabilizeNation(nation) {
  const stable = { ...nation };
  for (const field of ["todayBoxHtml", "todayUnit", "showCountDesc", "viewCountDesc"]) {
    if (isEmptyField(stable[field])) {
      const cached = lastGoodNation[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }
  if (!stable.todayBoxHtml && lastGoodNation.todayBoxHtml) {
    stable.todayBoxHtml = lastGoodNation.todayBoxHtml;
    stable.todayUnit = stable.todayUnit || lastGoodNation.todayUnit;
  }
  if (stable.todayBox <= 0 && lastGoodNation.todayBox > 0) {
    stable.todayBox = lastGoodNation.todayBox;
  }
  for (const field of ["todayBoxHtml", "todayUnit", "showCountDesc", "viewCountDesc"]) {
    if (!isEmptyField(stable[field])) lastGoodNation[field] = stable[field];
  }
  if (stable.todayBox > 0) lastGoodNation.todayBox = stable.todayBox;
  return stable;
}

function mergeEnrichedMovies(baseMovies, enrichedMovies, speed = {}) {
  const enrichMap = new Map(enrichedMovies.map((m) => [String(m.movieId), m]));
  return enrichMoviesQuick(baseMovies, speed).map((movie) => {
    const enriched = enrichMap.get(String(movie.movieId));
    if (!enriched) return stabilizeMovie(movie);
    const merged = preferNonEmptyFields(enriched, movie);
    merged.rank = movie.rank;
    merged.name = movie.name;
    merged.movieId = movie.movieId;
    if (!isEmptyField(movie.todayBoxHtml)) {
      merged.todayBoxHtml = movie.todayBoxHtml;
      merged.todayUnit = movie.todayUnit || merged.todayUnit;
    }
    if (movie.todayBox > 0) merged.todayBox = movie.todayBox;
    if (!isEmptyField(movie.boxRate)) merged.boxRate = movie.boxRate;
    if (!isEmptyField(movie.showCountRate)) merged.showCountRate = movie.showCountRate;
    if (!isEmptyField(movie.avgSeatView)) merged.avgSeatView = movie.avgSeatView;
    if (!isEmptyField(movie.sumBoxDesc)) merged.sumBoxDesc = movie.sumBoxDesc;
    return stabilizeMovie(merged);
  });
}

function buildSpeedMap(movies) {
  const now = Date.now();
  const map = {};
  for (const movie of movies) {
    const key = String(movie.movieId);
    const prev = speedSnapshots.get(key);
    const box = movie.todayBox > 0 ? movie.todayBox : decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (prev && box > 0) {
      map[key] = estimateSpeedMetrics(key, box, prev, now - prev.at);
    }
    if (box > 0) {
      speedSnapshots.set(key, {
        box,
        at: now,
        forecast: map[key]?.estimatedDayForecast || prev?.forecast || 0,
      });
    }
  }
  return map;
}

function render(movies, nation, parsed, isUpdating = false) {
  const enriched = applyMediaToMovies(movies, movieCatalog);
  renderDashboard(enriched, nation, parsed || latestParsed || {}, { isUpdating });
  syncTrailerWithRanking(enriched, movieCatalog);
}

function scheduleBackgroundEnrich(parsed, speed) {
  if (enrichingBackground) return;

  const now = Date.now();
  const needFull = pollCount === 1 || now - lastFullEnrich >= FULL_ENRICH_INTERVAL_MS;
  const gen = ++enrichGeneration;
  enrichingBackground = true;

  (async () => {
    try {
      const loggedIn = await window.overlay?.isLoggedIn?.();
      const enrichOpts = {
        concurrency: config.enrichConcurrency || 2,
        todayStr: parsed.calendar?.today || "",
        speed,
        trendLimit: config.trendLimit || 5,
        enableExtraApis: Boolean(loggedIn),
      };

      const task = needFull
        ? enrichMovies(config.apiBase, parsed.movies, enrichOpts)
        : enrichMoviesLight(config.apiBase, parsed.movies, enrichOpts);

      const enriched = await Promise.race([
        task,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("enrich_timeout")), 30000)
        ),
      ]);

      if (gen !== enrichGeneration) return;

      const baseMovies = latestMovies.length ? latestMovies : parsed.movies;
      const currentSpeed = buildSpeedMap(baseMovies);
      const movies = mergeEnrichedMovies(baseMovies, enriched, currentSpeed);
      render(movies, stabilizeNation(parsed.nation), parsed);
      if (needFull) lastFullEnrich = Date.now();
    } catch (err) {
      console.warn("后台补充字段失败", err);
    } finally {
      if (gen === enrichGeneration) enrichingBackground = false;
    }
  })();
}

function scheduleDecodeRetry() {
  if (!latestMovies.length) return;
  setTimeout(() => {
    const needsRetry = latestMovies.some(
      (m) => m.todayBoxHtml && (m.todayBox <= 0)
    );
    if (!needsRetry) return;
    const movies = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
    render(movies, stabilizeNation(latestParsed?.nation), latestParsed);
  }, 600);
}

async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  pollCount += 1;

  const showUpdating = hasDisplayedData;
  if (showUpdating) {
    render(
      latestMovies.map(stabilizeMovie),
      stabilizeNation(latestParsed?.nation),
      latestParsed,
      true
    );
  }

  try {
    const apiStatus = await window.overlay?.getApiStatus?.();
    if (apiStatus && !apiStatus.ready) {
      const recovered = await window.overlay?.ensureApi?.();
      if (recovered?.apiBase) config.apiBase = recovered.apiBase;
      if (!recovered?.ready) {
        if (!hasDisplayedData) setStatus("loading", "票房服务断开，正在自动恢复…");
        return;
      }
    }

    const raw = await fetchDashboard(config.apiBase);
    await injectFontStyle(raw.fontStyle);

    const parsed = parseDashboard(raw, config.topCount || 10);
    latestParsed = parsed;

    if (!parsed.movies.length) {
      if (!hasDisplayedData) setStatus("loading", "等待票房数据…");
      return;
    }

    pollGeneration += 1;
    latestMovies = parsed.movies;
    const speed = buildSpeedMap(parsed.movies);
    latestSpeedMap = speed;
    const movies = enrichMoviesQuick(parsed.movies, speed).map(stabilizeMovie);
    const nation = stabilizeNation(parsed.nation);

    render(movies, nation, parsed, false);

    hasDisplayedData = true;
    setStatus("ok", "");
    scheduleBackgroundEnrich(parsed, speed);
    scheduleDecodeRetry();
    await updateLoginButton();
  } catch (e) {
    const msg = String(e.message || "");
    if (
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError") ||
      msg.includes("signal timed out") ||
      /timeout/i.test(msg)
    ) {
      if (!hasDisplayedData) setStatus("loading", "票房服务响应超时，正在自动恢复…");
      else setStatus("ok", "");
      const status = await window.overlay?.ensureApi?.();
      if (status?.apiBase) config.apiBase = status.apiBase;
    } else if (msg.includes("签名") || msg.includes("登录")) {
      await updateLoginButton(true);
      setStatus("error", "登录已过期，请点击右上角「登录」完成登录");
    } else if (!hasDisplayedData) {
      setStatus("error", msg || "拉取数据失败，正在重试…");
    } else {
      setStatus("ok", "");
    }
  } finally {
    refreshing = false;
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshData, config.pollIntervalMs || 5000);
}

function startPolling() {
  refreshData();
  restartPolling();
}

async function syncOverlaySettings() {
  const settings = await window.overlay?.getOverlaySettings?.();
  if (!settings) return;

  applyOverlaySettings(settings);
  config.pollIntervalMs = settings.pollIntervalMs;
  config.topCount = settings.topCount;
  config.enrichConcurrency = settings.enrich?.concurrency;
  config.trendLimit = settings.enrich?.trendLimit;
  FULL_ENRICH_INTERVAL_MS = settings.enrich?.fullIntervalMs || 60000;
  lastFullEnrich = 0;
  if (hasDisplayedData && pollTimer) restartPolling();
}

function startServiceRetryLoop() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(async () => {
    setStatus("loading", "正在重试启动票房服务…");
    const retry = await window.overlay?.ensureApi?.();
    if (retry?.ready) {
      clearInterval(retryTimer);
      retryTimer = null;
      if (retry.apiBase) config.apiBase = retry.apiBase;
      setStatus("loading", "服务已就绪，正在拉取票房数据…");
      startPolling();
    }
  }, 5000);
}

async function waitForApiReady() {
  setStatus("loading", "正在自动启动票房数据服务…");
  let status = await window.overlay?.getApiStatus?.();
  if (status?.ready) return status;
  status = await window.overlay?.ensureApi?.();
  if (status?.ready) return status;

  return new Promise((resolve) => {
    let off = null;
    const timeout = setTimeout(() => {
      off?.();
      resolve({ ready: false, error: "票房服务启动超时，请稍后重试" });
    }, 120000);
    off = window.overlay?.onApiReady?.((next) => {
      clearTimeout(timeout);
      off?.();
      resolve(next);
    });
  });
}

async function updateLoginButton(forceShow = false) {
  const btn = $("btn-login");
  if (!btn) return;
  const loggedIn = forceShow ? false : await window.overlay?.isLoggedIn?.();
  btn.classList.toggle("is-hidden", Boolean(loggedIn) && !forceShow);
}

async function handleLoginClick() {
  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }
  setStatus("loading", "正在打开登录窗口，请在浏览器中完成登录…");
  await window.overlay?.startLogin?.();
  setStatus("loading", "登录完成后按回车保存，软件将自动继续拉取数据");

  const deadline = Date.now() + 10 * 60 * 1000;
  loginWatchTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(loginWatchTimer);
      loginWatchTimer = null;
      setStatus("error", "登录超时，请重新点击「登录」");
      return;
    }
    const loggedIn = await window.overlay?.isLoggedIn?.();
    if (!loggedIn) return;
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
    await updateLoginButton(false);
    setStatus("loading", "登录成功，正在拉取票房数据…");
    const status = await window.overlay?.ensureApi?.();
    if (status?.apiBase) config.apiBase = status.apiBase;
    lastFullEnrich = 0;
    startPolling();
  }, 2000);
}

async function init() {
  bindViewport();
  startClock();
  movieCatalog = await loadMovieMedia();
  initTrailerPlayer();

  $("btn-login")?.addEventListener("click", handleLoginClick);

  config = (await window.overlay?.getConfig()) || {
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 5000,
    topCount: 10,
  };

  await syncOverlaySettings();
  window.overlay?.onSettingsChanged?.((settings) => {
    applyOverlaySettings(settings);
    config.pollIntervalMs = settings.pollIntervalMs;
    config.topCount = settings.topCount;
    config.enrichConcurrency = settings.enrich?.concurrency;
    config.trendLimit = settings.enrich?.trendLimit;
    FULL_ENRICH_INTERVAL_MS = settings.enrich?.fullIntervalMs || 60000;
    lastFullEnrich = 0;
    if (hasDisplayedData) {
      restartPolling();
      refreshData();
    }
  });

  await updateLoginButton();

  const apiStatus = await waitForApiReady();
  if (!apiStatus?.ready) {
    setStatus("error", apiStatus?.error || "票房服务启动失败，5 秒后自动重试…");
    startServiceRetryLoop();
    return;
  }

  if (apiStatus.apiBase) config.apiBase = apiStatus.apiBase;
  setStatus("loading", "服务已就绪，正在拉取票房数据…");
  startPolling();
}

init();
