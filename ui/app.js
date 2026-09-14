import {
  fetchDashboard,
  parseDashboard,
  injectFontStyle,
  decodeBoxFromHtml,
  enrichMovies,
  enrichMoviesQuick,
  parseBoxNum,
  estimateSpeedMetrics,
  resetApiSigWarm,
  getLastEnrichErrors,
  MaoyanApiError,
  resolveChampionBoxWan,
  resolveNationSeatMetric,
  computeMovieBoxDeltaWan,
  isUntrustedBoxDecode,
  isEncodedBoxHtml,
  boxHtmlUsesAntiScrapeFont,
  refreshMovieBoxFields,
  rerankMoviesByTodayBox,
  isMaoyanFontReady,
  DECODE_STATUS,
  traceDashboardData,
  getExtraMetrics,
  getExtraMetricsGridClass,
  buildDailyTrendItems,
  formatReleaseTag,
} from "./maoyan-api.js";
import { applyOverlaySettings, getOverlaySettings } from "./settings-applier.js";
import { bindDesignViewport } from "./viewport-fit.js";
import { formatWanForDisplay, formatWanDisplayText } from "./box-display.js";
import {
  createEnrichScheduleState,
  shouldScheduleFullEnrich,
  markFullEnrichAttempt,
  markFullEnrichSuccess,
  markFullEnrichFailure,
  resetEnrichScheduleState,
  shouldMarkFullEnrichFailure,
  FULL_ENRICH_GLOBAL_TIMEOUT_MS,
} from "./enrich-scheduler.js";

const $ = (id) => document.getElementById(id);

const raceListEl = $("race-list");
const statusEl = $("status");
const nationDeltaEl = $("nation-delta");
const nationBoxEl = $("nation-box");
const nationShowsEl = $("nation-shows");
const nationViewsEl = $("nation-views");
const nationSeatEl = $("nation-seat");
const nationSeatLabelEl = $("nation-seat-label");
const heroDateEl = $("hero-date");
const champBoxEl = $("champ-box");
const champBoxUnitEl = $("champ-box-unit");
const champBoxPillEl = $("champ-box-pill");

let config = {};
let pollTimer = null;
let retryTimer = null;
let loginWatchTimer = null;
let refreshing = false;
let hasDisplayedData = false;
let enrichAllowed = false;
let firstDashboardPainted = false;
let pendingEnrichArgs = null;
let pollCount = 0;
const enrichSchedule = createEnrichScheduleState();
let enrichGeneration = 0;
let currentEnrichController = null;
let currentEnrichPromise = null;

const cardPool = new Map();
const prevValues = new Map();
const prevBoxHtml = new Map();
const prevRankMap = new Map();
const speedSnapshots = new Map();
const lastGoodMovies = new Map();
const lastGoodNation = {};
let lastGoodCacheDay = "";
let latestMovies = [];
let latestSpeedMap = {};
let latestNation = null;
let latestParsedMeta = null;
let pollGeneration = 0;
let FULL_ENRICH_INTERVAL_MS = 60000;
const inlineDeltaTimers = new Map();
let partialDataWarning = "";

function isEmptyField(val) {
  if (val == null) return true;
  if (Array.isArray(val)) return !val.length;
  const text = String(val).trim();
  if (!text || text === "--" || text === "-") return true;
  // 猫眼未登录/专业版门闸文案，不能当票房数字渲染（会叠到冠军票房等位置）
  if (/登录猫眼|专业版即可|剩余城市|商排|请先登录|开通专业版/.test(text)) return true;
  return false;
}

const PRESERVE_MOVIE_FIELDS = [
  "todayBoxHtml",
  "todayUnit",
  "todayBoxText",
  "boxRate",
  "showCountRate",
  "avgShowView",
  "avgSeatView",
  "sumBoxDesc",
  "mainlandBox",
  "hmtBox",
  "overseasBox",
  "dynamicForecast",
  "dynamicTrend",
  "totalForecast",
  "totalTrend",
  "hourSpeedText",
  "dailyIncrease",
  "yesterdayTotal",
  "yesterdaySamePeriodText",
  "yesterdayHourSpeedText",
  "totalViews",
  "endDate",
  "remainingDays",
  "dailyTable",
  "releaseInfo",
];

const PRESERVE_MOVIE_FIELDS_SKIP_AUTO = new Set(["hourSpeedText", "yesterdayHourSpeedText"]);

function formatHourSpeedDisplay(text) {
  if (isEmptyField(text)) return "";
  const raw = String(text).trim().replace(/^¥/, "");
  return raw.includes("/h") ? raw : `${raw}/h`;
}

function formatMainlandDisplay(movie) {
  const raw = mainlandValue(movie);
  if (isEmptyField(raw)) return "--";
  const text = String(raw).trim();
  if (text.startsWith("¥")) return text;
  if (text.includes("亿") || text.includes("万")) return `¥${text}`;
  return `¥${text}`;
}

function mainlandLabel() {
  return "中国内地";
}

function formatEndDateMetric(m) {
  const hasDate = !isEmptyField(m?.endDate);
  const hasDays = !isEmptyField(m?.remainingDays);
  if (!hasDate && !hasDays) return "";
  const dateText = hasDate ? String(m.endDate).replace(/^\d{4}-/, "").trim() : "";
  const days = hasDays ? `剩${String(m.remainingDays).trim()}天` : "";
  if (dateText && days) return `${dateText} ${days}`;
  return dateText || days;
}

function formatMoneyMetric(val) {
  if (isEmptyField(val)) return "";
  const text = String(val).trim();
  if (text.startsWith("¥")) return text;
  if (text.includes("亿") || text.includes("万") || text.includes("%")) return text.includes("亿") || text.includes("万") ? `¥${text}` : text;
  return `¥${text}`;
}

function shouldPreferEncodedBox(movie) {
  if (!movie?.todayBoxHtml) return false;
  // 已有可信明文（含 lastGood 回填）：直播必须用数字，禁止改画乱码导致闪空白
  const text = String(movie.todayBoxText || "").trim();
  const amount = Number(movie.todayBox) || 0;
  if (amount > 0 && text && text !== "--" && !isUntrustedBoxDecode(text)) {
    return false;
  }
  if (amount > 0 && !isUntrustedBoxDecode(String(amount))) {
    return false;
  }
  // 字体未就绪时禁止塞乱码点，统一走缓存/“--”
  if (!isMaoyanFontReady()) return false;
  if (isEncodedBoxHtml(movie.todayBoxHtml)) return true;
  const raw = String(movie.todayBoxText || "").trim();
  return raw && raw !== "--" && isUntrustedBoxDecode(raw);
}

function formatDailyBoxDisplay(movie) {
  if (shouldPreferEncodedBox(movie)) return "";
  // 优先用猫眼原始解码文本，避免二次 toFixed(1) 把 1100 显示成怪异的 1100.1
  if (!isEmptyField(movie.todayBoxText) && movie.todayBoxText !== "--") {
    const text = String(movie.todayBoxText).trim();
    if (isUntrustedBoxDecode(text)) return "";
    const unit = movie.todayUnit || "万";
    if (text.includes("万") || text.includes("亿")) return formatMoneyMetric(text);
    return formatMoneyMetric(`${text}${unit}`);
  }
  const amount = getMovieBoxAmount(movie);
  if (amount > 0) return `¥${formatWanDisplayText(amount)}`;
  return "--";
}

const SUMMARY_COLUMN_DEFS = [
  [
    {
      key: "dynamicForecast",
      label: "动态预测",
      get: (m) => formatMoneyMetric(m.dynamicForecast),
      trend: (m) => m.dynamicTrend,
      fallbacks: [
        (m) => {
          const fc = m.dailyTable?.[0]?.forecast;
          return isEmptyField(fc) || fc === "--" ? "" : formatMoneyMetric(fc);
        },
      ],
    },
    {
      key: "endDate",
      label: "下映日期",
      get: (m) => formatEndDateMetric(m),
      fallbacks: [],
    },
    {
      key: "avgSeatView",
      label: "实时上座",
      get: (m) => m.avgSeatView,
      fallbacks: [(m) => m.dailyTable?.[0]?.avgSeatView],
    },
  ],
  [
    {
      key: "dailyBox",
      label: "实时票房",
      get: (m) => formatDailyBoxDisplay(m),
      fallbacks: [
        (m) => {
          if (!isEmptyField(m.todayBoxText) && m.todayBoxText !== "--") {
            return `¥${m.todayBoxText}${m.todayUnit || "万"}`;
          }
          return "";
        },
      ],
    },
    {
      key: "boxRate",
      label: "票房占比",
      get: (m) => m.boxRate,
      fallbacks: [(m) => m.dailyTable?.[0]?.boxRate],
    },
  ],
  [
    {
      key: "avgShowView",
      label: "场均人次",
      get: (m) => m.avgShowView,
      fallbacks: [],
    },
    {
      key: "showCountRate",
      label: "排片占比",
      get: (m) => m.showCountRate,
      fallbacks: [(m) => m.dailyTable?.[0]?.showCountRate],
    },
  ],
];

const EXTRA_SUMMARY_DEFS = [
  { key: "dailyIncrease", label: "日增", get: (m) => formatMoneyMetric(m.dailyIncrease) },
  { key: "yesterdayTotal", label: "昨日", get: (m) => formatMoneyMetric(m.yesterdayTotal) },
  {
    key: "yesterdaySamePeriod",
    label: "昨日同期",
    get: (m) => formatMoneyMetric(m.yesterdaySamePeriodText),
  },
  {
    key: "yesterdayHourSpeed",
    label: "昨日时速",
    get: (m) => formatMoneyMetric(formatHourSpeedDisplay(m.yesterdayHourSpeedText)),
  },
  { key: "totalViews", label: "总人次", get: (m) => m.totalViews },
  {
    key: "showCountDesc",
    label: "排片场次",
    get: (m) => {
      if (!isEmptyField(m.showCountDesc)) return String(m.showCountDesc).trim();
      if (m.showCount > 0) {
        return m.showCount >= 10000
          ? `${(m.showCount / 10000).toFixed(1)}万场`
          : `${m.showCount}场`;
      }
      return "";
    },
  },
  { key: "sumBoxDesc", label: "累计票房", get: (m) => formatMoneyMetric(m.sumBoxDesc) },
  { key: "sumSplitBoxDesc", label: "分账票房", get: (m) => formatMoneyMetric(m.sumSplitBoxDesc) },
  { key: "splitBoxRate", label: "分账占比", get: (m) => m.splitBoxRate },
  { key: "hmtBox", label: "港澳台", get: (m) => formatMoneyMetric(m.hmtBox) },
  { key: "overseasBox", label: "海外", get: (m) => formatMoneyMetric(m.overseasBox) },
  { key: "endDate", label: "下映日期", get: (m) => formatEndDateMetric(m) },
];

const MAX_EXTRA_SUMMARY_METRICS = 0;

function resolveMetricRaw(def, movie) {
  let raw = def.get(movie);
  if (!isEmptyField(raw)) return raw;
  if (typeof def.fallback === "function") {
    raw = def.fallback(movie);
    if (!isEmptyField(raw)) return raw;
  }
  if (Array.isArray(def.fallbacks)) {
    for (const fb of def.fallbacks) {
      raw = fb(movie);
      if (!isEmptyField(raw)) return raw;
    }
  }
  return "";
}

function metricValueSignature(def, movie) {
  const raw = resolveMetricRaw(def, movie);
  return isEmptyField(raw) ? "" : String(raw).replace(/\s+/g, "").trim();
}

function resetLastGoodIfDayChanged(calendarToday) {
  const day =
    String(calendarToday || "")
      .trim()
      .slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (lastGoodCacheDay && lastGoodCacheDay !== day) {
    lastGoodMovies.clear();
    for (const key of Object.keys(lastGoodNation)) delete lastGoodNation[key];
    speedSnapshots.clear();
  }
  lastGoodCacheDay = day;
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
      const raw = String(movie.todayBoxText || val || "");
      if (val > 0 && !isUntrustedBoxDecode(raw)) next[field] = val;
      continue;
    }
    if (field === "hourSpeed") {
      if (val > 0) next[field] = val;
      continue;
    }
    if (field === "hourSpeedFromApi") {
      if (val === true) next[field] = true;
      continue;
    }
    if (field === "hourSpeedText" || field === "yesterdayHourSpeedText") {
      if (!isEmptyField(val)) next[field] = val;
      continue;
    }
    if (field === "dailyTable") {
      if (Array.isArray(val) && val.length) next[field] = val;
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
      if (key === "todayBox" || key === "hourSpeed" || key === "yesterdayHourSpeed") {
        if (val > 0) result[key] = val;
        continue;
      }
      if (key === "hourSpeedFromApi") {
        if (val === true) result[key] = true;
        continue;
      }
      if (key === "dailyTable") {
        if (Array.isArray(val) && val.length) result[key] = val;
        continue;
      }
      if (!isEmptyField(val)) result[key] = val;
    }
  }
  return result;
}

function setStatus(type, text) {
  if (!statusEl) return;
  const showPartial = type === "ok" && partialDataWarning;
  const finalType = showPartial ? "error" : type;
  const finalText = showPartial ? partialDataWarning : text;
  statusEl.className = `status status--${finalType}`;
  statusEl.textContent = finalText;
  statusEl.style.display = finalType === "ok" ? "none" : "block";
}

function updatePartialDataWarning(errors = []) {
  if (!errors.length) {
    partialDataWarning = "";
    return;
  }
  const loginIssue = errors.find(
    (e) =>
      e.action === "login" ||
      /login|登录/.test(String(e.code)) ||
      String(e.code) === "login_required" ||
      String(e.code) === "upstream_401",
  );
  if (loginIssue) {
    partialDataWarning = "明日/后天等明细数据需要猫眼登录，请点击右上角「登录」完成账号登录";
    return;
  }
  const detail = errors[0]?.detail || "部分详细数据获取失败";
  partialDataWarning = `部分详细数据获取失败：${detail}`;
}

async function finishLoginSuccess(result = {}) {
  await updateLoginButton(false);
  resetApiSigWarm();
  partialDataWarning = "";
  await abortAndResetEnrichSchedule();
  enrichAllowed = true;

  const deferred = Boolean(result?.deferredDetail || result?.detailApiReady === false);
  setStatus(
    "loading",
    deferred
      ? "登录已保存，正在获取签名并验证明细权限…"
      : "登录成功，正在刷新签名并拉取票房数据…",
  );

  const status = await window.overlay?.ensureApi?.();
  if (status?.apiBase) config.apiBase = status.apiBase;

  if (!status?.apiBase) {
    setStatus("error", "票房服务未启动，请重启软件后再点登录");
    await updateLoginButton(true);
    return;
  }

  // 登录后立刻 refresh：换机场景依赖登录页已缓存的 mtgsig
  let refreshOk = false;
  for (let attempt = 0; attempt < 2 && !refreshOk; attempt += 1) {
    try {
      const movieId = String(latestMovies[0]?.movieId || "1462628");
      const resp = await fetch(
        `${status.apiBase}/api/refresh?movieId=${encodeURIComponent(movieId)}&boxLevel=1`,
        { signal: AbortSignal.timeout(120000) },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        const code = String(body?.code || "");
        const detail = String(body?.detail || resp.status);
        if (code === "login_required" || /login_required|401/.test(detail)) {
          await window.overlay?.reportSessionApiError?.("login_required");
          await updateLoginButton(true);
          setStatus("error", "登录态未生效，请重新点击右上角登录");
          return;
        }
        console.warn(`登录后刷新签名失败(attempt=${attempt + 1}):`, detail);
        if (attempt === 1) {
          setStatus("error", `登录成功但签名刷新失败：${detail}。请再点一次登录`);
          await updateLoginButton(true);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      refreshOk = true;
      resetApiSigWarm();
      await updateLoginButton(false);
    } catch (error) {
      console.warn(`登录后刷新签名异常(attempt=${attempt + 1}):`, error?.message || error);
      if (attempt === 1) {
        setStatus("error", `登录成功但无法刷新签名：${error?.message || error}。请再点一次登录`);
        await updateLoginButton(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  setStatus(
    "loading",
    deferred ? "签名处理中，正在拉取明日/后天等明细数据…" : "正在拉取票房数据…",
  );
  startPolling();
}

function isLoginRelatedError(error) {
  if (error instanceof MaoyanApiError) {
    return (
      error.action === "login" ||
      error.code === "login_required" ||
      error.code === "upstream_401"
    );
  }
  const msg = String(error?.message || "");
  return /登录失效|需要登录|login_required|upstream_401|\b401\b/.test(msg);
}

function isSignatureRelatedError(error) {
  if (error instanceof MaoyanApiError) {
    return (
      error.action === "refresh" ||
      ["upstream_403", "sig_capture_failed"].includes(String(error.code))
    );
  }
  const msg = String(error?.message || "");
  return /签名|风控|upstream_403|sig_capture/.test(msg);
}

function formatUserFacingError(error) {
  if (isSignatureRelatedError(error)) {
    return "猫眼签名失效或触发风控，正在尝试刷新签名";
  }
  if (error instanceof MaoyanApiError) {
    return error.detail || error.message;
  }
  return String(error?.message || "请求失败");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDelta(deltaWan) {
  if (!Number.isFinite(deltaWan) || deltaWan <= 0) return "";
  if (deltaWan >= 10000) return `+${(deltaWan / 10000).toFixed(2)}亿`;
  if (deltaWan >= 100) return `+${deltaWan.toFixed(1)}万`;
  if (deltaWan >= 1) return `+${deltaWan.toFixed(1)}万`;
  return `+${deltaWan.toFixed(2)}万`;
}

function formatDeltaWithArrow(deltaWan) {
  const text = formatDelta(deltaWan);
  return text ? `${text} ↑` : "";
}

function getBubbleDurationMs() {
  const durationMs = getOverlaySettings()?.bubble?.durationMs;
  if (Number.isFinite(durationMs) && durationMs > 0) return durationMs;
  return 3000;
}

function pulseInlineDelta(el, deltaWan, timerKey) {
  const bubble = getOverlaySettings()?.bubble;
  const minDelta = bubble?.minDelta ?? 0.001;
  if (!el || bubble?.enabled === false) return;
  if (!Number.isFinite(deltaWan) || deltaWan < minDelta) return;

  el.textContent = formatDeltaWithArrow(deltaWan);
  el.classList.remove("is-animating");
  void el.offsetWidth;
  el.classList.add("is-visible", "is-animating");

  const key = timerKey || el;
  if (inlineDeltaTimers.has(key)) clearTimeout(inlineDeltaTimers.get(key));
  inlineDeltaTimers.set(
    key,
    setTimeout(() => {
      el.classList.remove("is-visible", "is-animating");
      el.textContent = "";
      inlineDeltaTimers.delete(key);
    }, getBubbleDurationMs()),
  );
}

function safeDecodeBox(html, unit = "万") {
  if (!html) return 0;
  const value = decodeBoxFromHtml(html, unit);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isTrustedMovieBoxAmount(movie) {
  if (!movie) return false;
  const text = String(movie.todayBoxText || "").trim();
  if (text && text !== "--" && isUntrustedBoxDecode(text)) return false;
  const amount = getMovieBoxAmount(movie);
  if (amount <= 0) return false;
  if (isUntrustedBoxDecode(String(amount))) return false;
  return true;
}

function isReasonableBoxDelta(prevAmount, nextAmount, delta) {
  if (!Number.isFinite(delta) || delta <= 0) return false;
  if (!Number.isFinite(prevAmount) || !Number.isFinite(nextAmount)) return false;
  if (nextAmount <= prevAmount) return false;
  if (isUntrustedBoxDecode(String(nextAmount)) || isUntrustedBoxDecode(String(prevAmount))) {
    return false;
  }
  // 可信数字已过滤垃圾解码；放宽跳变阈值，避免解码中断恢复后多部片涨幅被误杀
  if (prevAmount >= 1 && delta > prevAmount * 3 && delta > 200) return false;
  return true;
}

function resolvePrevAmount(prevAmount, prevHtml, unit) {
  if (Number.isFinite(prevAmount) && prevAmount > 0) return prevAmount;
  if (prevHtml) return safeDecodeBox(prevHtml, unit);
  return 0;
}

function computeBoxIncrease(prevAmount, prevHtml, nextHtml, unit) {
  const next = safeDecodeBox(nextHtml, unit);
  if (next <= 0) return 0;
  const prev = resolvePrevAmount(prevAmount, prevHtml, unit);
  if (prev <= 0 || next <= prev) return 0;
  const delta = next - prev;
  return delta >= 0.001 ? delta : 0;
}

function mergeDailyTableRows(prevRows, nextRows) {
  const labels = ["今日", "明日", "后天"];
  const prevMap = new Map((prevRows || []).map((row) => [String(row.label || "").trim(), row]));
  const nextMap = new Map((nextRows || []).map((row) => [String(row.label || "").trim(), row]));
  const pickCell = (label, idx, field) => {
    const prev = prevMap.get(label) || prevRows?.[idx] || {};
    const next = nextMap.get(label) || nextRows?.[idx] || {};
    const candidates = [next[field], prev[field]];
    for (const val of candidates) {
      if (!isEmptyField(val) && val !== "--") return val;
    }
    return next[field] ?? prev[field] ?? "--";
  };

  return labels.map((label, idx) => ({
    label,
    box: pickCell(label, idx, "box"),
    boxHtml: pickCell(label, idx, "boxHtml"),
    boxUnit: pickCell(label, idx, "boxUnit"),
    forecast: pickCell(label, idx, "forecast"),
    boxRate: pickCell(label, idx, "boxRate"),
    showCountRate: pickCell(label, idx, "showCountRate"),
    avgSeatView: pickCell(label, idx, "avgSeatView"),
  }));
}

function stabilizeMovie(movie) {
  const key = String(movie.movieId);
  const prev = lastGoodMovies.get(key) || {};
  const stable = { ...movie };

  for (const field of PRESERVE_MOVIE_FIELDS) {
    if (field === "dailyTable") {
      const prevTable = Array.isArray(prev.dailyTable) ? prev.dailyTable : [];
      const nextTable = Array.isArray(stable.dailyTable) ? stable.dailyTable : [];
      if (nextTable.length) {
        stable.dailyTable = mergeDailyTableRows(prevTable, nextTable);
      } else if (prevTable.length) {
        stable.dailyTable = prevTable;
      }
      continue;
    }
    // 时速只保留「来自 getBoxShow」的缓存，避免把短窗口估算的夸张数字粘住
    if (PRESERVE_MOVIE_FIELDS_SKIP_AUTO.has(field)) {
      if (isEmptyField(stable[field]) && !isEmptyField(prev[field])) {
        stable[field] = prev[field];
        if (field === "hourSpeedText" && prev.hourSpeed > 0) {
          stable.hourSpeed = prev.hourSpeed;
          stable.hourSpeedFromApi = true;
        }
      } else if (field === "hourSpeedText" && stable.hourSpeed > 0 && movie.hourSpeedFromApi) {
        stable.hourSpeedFromApi = true;
      }
      continue;
    }
    if (isEmptyField(stable[field])) {
      const cached = prev[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }

  if (stable.hourSpeed > 0 && (movie.hourSpeedFromApi || prev.hourSpeedFromApi)) {
    stable.hourSpeedFromApi = true;
  }

  stable.rank = movie.rank;
  stable.name = movie.name;
  stable.movieId = movie.movieId;

  // 仅当本轮明文本身是垃圾解码时才清零；"--"/空文本不能否掉已有数字
  {
    const boxText = String(stable.todayBoxText || "").trim();
    if (
      stable.todayBox > 0 &&
      boxText &&
      boxText !== "--" &&
      isUntrustedBoxDecode(boxText)
    ) {
      stable.todayBox = 0;
    }
  }
  const prevBoxTrusted =
    prev.todayBox > 0 && !isUntrustedBoxDecode(String(prev.todayBoxText || prev.todayBox));

  if (stable.todayBox <= 0 && stable.todayBoxHtml) {
    const decoded = safeDecodeBox(stable.todayBoxHtml, stable.todayUnit);
    if (decoded > 0) stable.todayBox = decoded;
    else if (prevBoxTrusted) {
      stable.todayBox = prev.todayBox;
      if (isEmptyField(stable.todayBoxText) && !isEmptyField(prev.todayBoxText)) {
        stable.todayBoxText = prev.todayBoxText;
      }
    }
  } else if (stable.todayBox <= 0 && prevBoxTrusted) {
    stable.todayBox = prev.todayBox;
    if (isEmptyField(stable.todayBoxText) && !isEmptyField(prev.todayBoxText)) {
      stable.todayBoxText = prev.todayBoxText;
    }
  }

  // 回填可信票房后同步解码态，避免 UI 仍按 FAILED/ENCODED 走乱码字形
  if (
    stable.todayBox > 0 &&
    !isEmptyField(stable.todayBoxText) &&
    !isUntrustedBoxDecode(String(stable.todayBoxText))
  ) {
    stable.decodeStatus = DECODE_STATUS.OK;
  }

  updateMovieCache(key, stable);
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
    if (!isEmptyField(movie.avgShowView)) merged.avgShowView = movie.avgShowView;
    if (!isEmptyField(movie.avgSeatView)) merged.avgSeatView = movie.avgSeatView;
    if (!isEmptyField(movie.sumBoxDesc)) merged.sumBoxDesc = movie.sumBoxDesc;
    if (Array.isArray(enriched.dailyTable) && enriched.dailyTable.length) {
      const prevTable = Array.isArray(movie.dailyTable) ? movie.dailyTable : [];
      merged.dailyTable = mergeDailyTableRows(prevTable, enriched.dailyTable);
    }
    return stabilizeMovie(merged);
  });
}

function stabilizeNation(nation) {
  const stable = { ...nation };
  for (const field of [
    "todayBoxHtml",
    "todayUnit",
    "todayBoxText",
    "showCountDesc",
    "viewCountDesc",
    "seatLabel",
    "seatValue",
    "seatRaw",
  ]) {
    if (isEmptyField(stable[field])) {
      const cached = lastGoodNation[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }
  if (!stable.todayBoxHtml && lastGoodNation.todayBoxHtml) {
    stable.todayBoxHtml = lastGoodNation.todayBoxHtml;
    stable.todayUnit = stable.todayUnit || lastGoodNation.todayUnit;
  }
  if (
    stable.todayBox <= 0 &&
    lastGoodNation.todayBox > 0 &&
    !isUntrustedBoxDecode(String(lastGoodNation.todayBoxText || lastGoodNation.todayBox))
  ) {
    stable.todayBox = lastGoodNation.todayBox;
    if (isEmptyField(stable.todayBoxText) && !isEmptyField(lastGoodNation.todayBoxText)) {
      stable.todayBoxText = lastGoodNation.todayBoxText;
    }
  }
  // "--"/空文本不能把已回填的大盘数字再次清零
  {
    const boxText = String(stable.todayBoxText || "").trim();
    if (
      stable.todayBox > 0 &&
      boxText &&
      boxText !== "--" &&
      isUntrustedBoxDecode(boxText)
    ) {
      stable.todayBox = 0;
    }
  }
  for (const field of [
    "todayBoxHtml",
    "todayUnit",
    "todayBoxText",
    "showCountDesc",
    "viewCountDesc",
    "seatLabel",
    "seatValue",
    "seatRaw",
  ]) {
    if (!isEmptyField(stable[field])) lastGoodNation[field] = stable[field];
  }
  if (stable.todayBox > 0) lastGoodNation.todayBox = stable.todayBox;
  return stable;
}

function purgeMovieState(id) {
  cardPool.delete(id);
  prevValues.delete(id);
  prevBoxHtml.delete(id);
  prevRankMap.delete(id);
  speedSnapshots.delete(id);
  // 保留 lastGoodMovies：影片进出 TOP N 时仍可回退实时票房，避免闪成 --
}

function getMovieBoxAmount(movie) {
  if (movie.todayBox > 0 && movie.todayBox < 100000) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  if (movie.todayBoxHtml) {
    const decoded = decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (decoded > 0) return decoded;
  }
  if (!isEmptyField(movie.todayBoxText)) {
    const n = parseBoxNum(movie.todayBoxText, movie.todayUnit || "万");
    if (n > 0 && !isUntrustedBoxDecode(movie.todayBoxText)) return n;
  }
  if (!isEmptyField(movie.dailyIncrease)) {
    const n = parseBoxNum(movie.dailyIncrease, "万");
    if (n > 0) return n;
  }
  return 0;
}

function trendArrow(trend) {
  if (trend === "up") return '<span class="trend trend--up">↑</span>';
  if (trend === "down") return '<span class="trend trend--down">↓</span>';
  return "";
}

function buildSpeedMap(movies) {
  const now = Date.now();
  const map = {};
  for (const movie of movies) {
    const key = String(movie.movieId);
    const prev = speedSnapshots.get(key);
    const box = getMovieBoxAmount(movie);
    if (prev && box > 0 && isTrustedMovieBoxAmount(movie)) {
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

function setTextIfChanged(el, next) {
  if (!el || el.textContent === next) return false;
  el.textContent = next;
  return true;
}

function setHtmlIfChanged(el, next) {
  if (!el || el.innerHTML === next) return false;
  el.innerHTML = next;
  return true;
}

function fitMetricEls(card) {
  if (!card) return;
  card.querySelectorAll(".metric__value, .metric__label").forEach((el) => {
    el.style.fontSize = "";
  });
  card.querySelectorAll(".metric").forEach((metric) => {
    const valueEl = metric.querySelector(".metric__value");
    const labelEl = metric.querySelector(".metric__label");
    if (!valueEl) return;
    const limit = metric.clientWidth;
    if (!limit) return;
    if (metric.scrollWidth <= limit + 1) return;
    const valueSize0 = parseFloat(getComputedStyle(valueEl).fontSize) || 20;
    const labelSize0 = labelEl ? parseFloat(getComputedStyle(labelEl).fontSize) || 18 : 0;
    let valueSize = valueSize0;
    let labelSize = labelSize0;
    let guard = 0;
    while (guard < 14 && metric.scrollWidth > limit + 1) {
      if (valueSize > 15) {
        valueSize -= 1;
        valueEl.style.fontSize = `${valueSize}px`;
      } else if (labelEl && labelSize > 14) {
        labelSize -= 1;
        labelEl.style.fontSize = `${labelSize}px`;
      } else {
        break;
      }
      guard += 1;
    }
  });
}

function resetTableFitStyles(table) {
  if (!table) return;
  table.style.fontSize = "";
  table.style.lineHeight = "";
  table.style.transform = "";
  table.style.width = "";
  table.querySelectorAll("th, td").forEach((cell) => {
    cell.style.paddingTop = "";
    cell.style.paddingBottom = "";
  });
}

function fitTableInCard(card) {
  const wrap = card.querySelector(".race-card__table-wrap");
  const scaler = card.querySelector(".race-card__table-scaler");
  const table = card.querySelector(".race-card__table");
  if (!wrap || !table) return;

  const limit = Math.max(0, wrap.clientHeight - 2);
  if (limit < 24) {
    requestAnimationFrame(() => fitTableInCard(card));
    return;
  }

  const pendingKey = `${limit}`;
  if (card.dataset.tableFitKey === pendingKey && card.dataset.tableFitReady === "1") {
    return;
  }

  resetTableFitStyles(table);
  if (scaler) {
    scaler.style.transform = "";
    scaler.style.width = "";
    scaler.style.height = "100%";
    scaler.style.marginBottom = "";
  }

  // 优先保证「今日/明日/后天」三行完整可见，再尽量放大字号填满
  const minSize = 16;
  const maxSize = Math.min(34, Math.max(22, Math.floor(limit / 4.8)));
  let size = maxSize;
  table.style.fontSize = `${size}px`;
  table.style.lineHeight = "1.25";

  const tableHeight = () => table.scrollHeight;
  const setPad = (pad) => {
    table.querySelectorAll("th, td").forEach((cell) => {
      cell.style.paddingTop = `${pad}px`;
      cell.style.paddingBottom = `${pad}px`;
    });
  };
  setPad(5);

  while (size > minSize && tableHeight() > limit) {
    size -= 0.5;
    table.style.fontSize = `${size}px`;
  }

  if (tableHeight() > limit) {
    setPad(2);
    table.style.lineHeight = "1.12";
    while (size > minSize && tableHeight() > limit) {
      size -= 0.5;
      table.style.fontSize = `${size}px`;
    }
  }

  // 仍装不下：整体等比缩小，绝不能裁切「后天」
  if (tableHeight() > limit && scaler) {
    const raw = tableHeight();
    const scale = Math.max(0.7, Math.min(1, (limit - 1) / raw));
    scaler.style.transformOrigin = "top left";
    scaler.style.transform = `scale(${scale})`;
    scaler.style.width = `${100 / scale}%`;
    scaler.style.height = `${100 / scale}%`;
  } else {
    let pad = parseFloat(table.querySelector("td")?.style.paddingTop) || 5;
    while (pad < 22 && tableHeight() < limit - 3) {
      pad += 1;
      setPad(pad);
      if (tableHeight() > limit) {
        pad -= 1;
        setPad(pad);
        break;
      }
    }

    while (size + 0.5 <= maxSize && tableHeight() < limit - 3) {
      size += 0.5;
      table.style.fontSize = `${size}px`;
      if (tableHeight() > limit) {
        size -= 0.5;
        table.style.fontSize = `${size}px`;
        break;
      }
    }
  }

  card.dataset.tableFitKey = pendingKey;
  card.dataset.tableFitReady = "1";
}

function maybeFitTableAfterUpdate(card) {
  const wrap = card.querySelector(".race-card__table-wrap");
  const table = card.querySelector(".race-card__table");
  if (!wrap || !table) return;
  if (table.scrollHeight <= wrap.clientHeight) return;
  card.dataset.tableFitReady = "";
  fitTableInCard(card);
}

function fitCardChrome(card, movie, { fitMetrics = true, fitTable = true } = {}) {
  if (!card) return;
  const rank = Number(movie?.rank ?? card.dataset.rank);
  // 片名单行省略，避免双行标题挤掉「后天」表格行
  fitNowrapEl(card.querySelector(".race-card__title"), {
    minSize: rank === 1 ? 28 : 26,
    allowWrap: false,
  });
  fitNowrapEl(card.querySelector(".js-mainland"), { minSize: 20 });
  if (fitMetrics) fitMetricEls(card);
  if (fitTable) fitTableInCard(card);
}

function refitAllRaceCards() {
  if (!raceListEl) return;
  raceListEl.querySelectorAll(".race-card:not(.race-card--skeleton)").forEach((card) => {
    const movie = latestMovies.find((item) => String(item.movieId) === card.dataset.movieId);
    if (movie) fitCardChrome(card, movie);
    else {
      fitNowrapEl(card.querySelector(".race-card__title"), {
        minSize: Number(card.dataset.rank) === 1 ? 28 : 26,
        allowWrap: false,
      });
      fitNowrapEl(card.querySelector(".js-mainland"), { minSize: 20 });
      fitMetricEls(card);
      fitTableInCard(card);
    }
  });
}

let raceReflowTimer = null;

function scheduleRaceCardReflow() {
  if (raceReflowTimer) clearTimeout(raceReflowTimer);
  raceReflowTimer = setTimeout(() => {
    raceReflowTimer = null;
    requestAnimationFrame(refitAllRaceCards);
  }, 150);
}

function fitNowrapEl(el, { minSize = 20, allowWrap = false } = {}) {
  if (!el) return;
  if (allowWrap) {
    el.style.whiteSpace = "normal";
    el.style.display = "-webkit-box";
    el.style.webkitLineClamp = "2";
    el.style.webkitBoxOrient = "vertical";
    el.style.overflow = "hidden";
    el.style.textOverflow = "";
    const computed = parseFloat(getComputedStyle(el).fontSize) || minSize;
    if (computed < minSize) el.style.fontSize = `${minSize}px`;
    return;
  }
  el.style.display = "";
  el.style.webkitLineClamp = "";
  el.style.webkitBoxOrient = "";
  el.style.whiteSpace = "nowrap";
  el.style.overflow = "hidden";
  el.style.textOverflow = "ellipsis";
  const parent = el.parentElement;
  const limit = parent?.clientWidth || el.clientWidth;
  if (!limit) return;
  if (el.scrollWidth <= limit + 1) {
    const stableSize = parseFloat(getComputedStyle(el).fontSize) || minSize;
    if (stableSize >= minSize) return;
  }
  el.style.fontSize = "";
  const computed = parseFloat(getComputedStyle(el).fontSize) || minSize;
  let size = computed;
  let guard = 0;
  while (guard < 20 && size > minSize && el.scrollWidth > limit + 1) {
    size -= 1;
    el.style.fontSize = `${size}px`;
    guard += 1;
  }
}

function mainlandValue(movie) {
  return movie.mainlandBox || movie.sumBoxDesc || "";
}

function buildSummaryMetricHtml(def, movie) {
  const bubble =
    def.key === "dailyBox"
      ? `<span class="race-card__delta-bubble race-card__delta-float" aria-hidden="true"></span>`
      : "";
  return `<div class="metric" data-metric="${def.key}"><span class="metric__label">${def.label}</span>${bubble}<span class="metric__value">${buildSummaryMetricValueHtml(def, movie)}</span></div>`;
}

function getSummaryMetricsByColumn(movie) {
  const usedKeys = new Set();
  const usedValues = new Set();
  const colDefs = [[], [], []];

  SUMMARY_COLUMN_DEFS.forEach((defs, colIdx) => {
    defs.forEach((def) => {
      usedKeys.add(def.key);
      const sig = metricValueSignature(def, movie);
      if (sig) usedValues.add(sig);
      colDefs[colIdx].push(def);
    });
  });

  const extras = [];
  for (const def of EXTRA_SUMMARY_DEFS) {
    if (extras.length >= MAX_EXTRA_SUMMARY_METRICS) break;
    if (usedKeys.has(def.key)) continue;
    const sig = metricValueSignature(def, movie);
    if (!sig || usedValues.has(sig)) continue;
    usedKeys.add(def.key);
    usedValues.add(sig);
    extras.push(def);
  }

  extras.forEach((def, i) => {
    colDefs[i % 3].push(def);
  });

  return colDefs;
}

function buildSummaryMetricValueHtml(def, movie, previousHtml = "") {
  const prevText = String(previousHtml || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const prevLooksPlain =
    Boolean(previousHtml) &&
    prevText &&
    prevText !== "--" &&
    !String(previousHtml).includes("metric__box-encoded");

  // 本轮只能画乱码时：若上一帧已有明文数字，继续保留，避免字体未绑定时闪空白
  if (def.key === "dailyBox" && shouldPreferEncodedBox(movie)) {
    if (prevLooksPlain) return previousHtml;
    const unit = escapeHtml(movie.todayUnit || "万");
    return `<span class="mtsi-font metric__box-encoded">${movie.todayBoxHtml}</span><span class="unit">${unit}</span>`;
  }
  const raw = resolveMetricRaw(def, movie);
  const trend = def.trend && !isEmptyField(raw) ? trendArrow(def.trend(movie)) : "";
  if (isEmptyField(raw)) {
    if (prevText && prevText !== "--") {
      return previousHtml;
    }
    return "--";
  }
  const value = String(raw);
  return `${escapeHtml(value)}${trend}`;
}

function updateSummaryInPlace(summaryWrap, movie) {
  const root = summaryWrap?.firstElementChild;
  if (!root?.classList.contains("race-card__summary")) return null;

  const colDefs = getSummaryMetricsByColumn(movie);
  const cols = [...root.querySelectorAll(".race-card__summary-col")];
  if (cols.length !== colDefs.length) return null;

  let changed = false;
  for (let colIdx = 0; colIdx < cols.length; colIdx += 1) {
    const metrics = [...cols[colIdx].querySelectorAll(".metric")];
    const defs = colDefs[colIdx];
    if (metrics.length !== defs.length) return null;
    for (let i = 0; i < defs.length; i += 1) {
      if (metrics[i].dataset.metric !== defs[i].key) return null;
      const valueEl = metrics[i].querySelector(".metric__value");
      const nextHtml = buildSummaryMetricValueHtml(defs[i], movie, valueEl?.innerHTML || "");
      if (valueEl && valueEl.innerHTML !== nextHtml) {
        valueEl.innerHTML = nextHtml;
        changed = true;
      }
    }
  }
  return changed;
}

function buildSummaryHtml(movie) {
  const columns = getSummaryMetricsByColumn(movie)
    .map(
      (defs) =>
        `<div class="race-card__summary-col">${defs.map((def) => buildSummaryMetricHtml(def, movie)).join("")}</div>`,
    )
    .join("");
  return `<div class="race-card__summary">${columns}</div>`;
}

function isRenderTraceEnabled() {
  if (typeof process !== "undefined" && process?.env?.RENDER_TRACE === "1") return true;
  return new URLSearchParams(location.search).has("renderTrace");
}

function traceMovieRender(movie) {
  if (!isRenderTraceEnabled()) return;
  console.log("[RENDER_MOVIE_TRACE]", {
    rank: movie.rank,
    movieId: movie.movieId,
    name: movie.name,
    todayBoxRaw: movie.todayBox,
    todayBoxText: movie.todayBoxText,
    renderedTodayBox: formatDisplayBox(movie),
  });
}

function buildRegionsHtml(movie) {
  const regions = [
    { label: "中国港澳台", value: movie.hmtBox },
    { label: "海外", value: movie.overseasBox },
  ].filter((item) => !isEmptyField(item.value));

  if (!regions.length) return "";

  return regions
    .map(
      (item) =>
        `<span class="region"><em>${item.label}：</em><strong>${escapeHtml(item.value)}</strong></span>`
    )
    .join("");
}

function dailyTableSignature(rows) {
  return JSON.stringify(
    (rows || []).map((row) => [
      row.label,
      row.box,
      row.boxHtml || "",
      row.forecast,
      row.boxRate,
      row.showCountRate,
      row.avgSeatView,
    ])
  );
}

function resolveTodayTableBox(movie) {
  const amount = getMovieBoxAmount(movie);
  // 有可信数字时一律明文，禁止因 decodeStatus 抖动改走乱码
  if (amount > 0) {
    return {
      box: formatWanDisplayText(amount),
      boxHtml: "",
      boxUnit: movie.todayUnit || "万",
    };
  }
  // 无可信数字：仅在确认要走编码路径时才塞乱码 HTML
  if (shouldPreferEncodedBox(movie)) {
    return {
      box: "--",
      boxHtml: movie.todayBoxHtml,
      boxUnit: movie.todayUnit || "万",
    };
  }
  return { box: "--", boxHtml: "", boxUnit: movie.todayUnit || "万" };
}

function ensureDailyTable(movie) {
  const labels = ["今日", "明日", "后天"];
  const src = Array.isArray(movie.dailyTable) ? movie.dailyTable : [];
  const byLabel = new Map(src.map((row) => [String(row.label || "").trim(), row]));
  const todayResolved = resolveTodayTableBox(movie);

  return labels.map((label, i) => {
    const prev = byLabel.get(label) || src[i] || {};
    const isToday = i === 0;
    const box = isToday
      ? todayResolved.box
      : !isEmptyField(prev.box) && prev.box !== "--"
        ? prev.box
        : "--";
    return {
      label,
      box,
      boxHtml: isToday ? todayResolved.boxHtml : prev.boxHtml || "",
      boxUnit: isToday ? todayResolved.boxUnit : prev.boxUnit || movie.todayUnit || "万",
      forecast:
        !isEmptyField(prev.forecast) && prev.forecast !== "--"
          ? prev.forecast
          : isToday && !isEmptyField(movie.dynamicForecast)
            ? movie.dynamicForecast
            : "--",
      boxRate:
        !isEmptyField(prev.boxRate) && prev.boxRate !== "--"
          ? prev.boxRate
          : isToday && !isEmptyField(movie.boxRate)
            ? movie.boxRate
            : "--",
      showCountRate:
        !isEmptyField(prev.showCountRate) && prev.showCountRate !== "--"
          ? prev.showCountRate
          : isToday && !isEmptyField(movie.showCountRate)
            ? movie.showCountRate
            : "--",
      avgSeatView:
        !isEmptyField(prev.avgSeatView) && prev.avgSeatView !== "--"
          ? prev.avgSeatView
          : isToday && !isEmptyField(movie.avgSeatView)
            ? movie.avgSeatView
            : "--",
    };
  });
}

const DAILY_TABLE_LABELS = ["今日", "明日", "后天"];

const DAILY_TABLE_COLUMNS = [
  {
    key: "box",
    label: "票房(含分账)",
    render: (row) => {
      if (!isEmptyField(row.box) && row.box !== "--") {
        return `<span class="num--hot">${escapeHtml(row.box)}</span>`;
      }
      if (row.boxHtml) {
        return `<span class="mtsi-font js-day-box num--hot">${row.boxHtml}</span><span class="unit">${escapeHtml(row.boxUnit || "万")}</span>`;
      }
      return `<span class="num--hot">--</span>`;
    },
  },
  {
    key: "forecast",
    label: "预测",
    render: (row) => escapeHtml(row.forecast || "--"),
  },
  {
    key: "boxRate",
    label: "票房%",
    render: (row) => escapeHtml(row.boxRate || "--"),
  },
  {
    key: "showCountRate",
    label: "排片%",
    render: (row) => escapeHtml(row.showCountRate || "--"),
  },
  {
    key: "avgSeatView",
    label: "上座率",
    render: (row) => escapeHtml(row.avgSeatView || "--"),
  },
];

function normalizeDailyTableRows(rows) {
  const src = Array.isArray(rows) ? rows : [];
  const byLabel = new Map(src.map((row) => [String(row.label || "").trim(), row]));
  return DAILY_TABLE_LABELS.map((label, i) => byLabel.get(label) || src[i] || { label });
}

function updateDailyTableInPlace(table, rows) {
  const list = normalizeDailyTableRows(rows);
  const tbody = table?.querySelector("tbody");
  if (!tbody) return null;

  const trs = [...tbody.querySelectorAll("tr")];
  if (trs.length !== list.length) return null;

  let changed = false;
  for (let rowIdx = 0; rowIdx < list.length; rowIdx += 1) {
    const row = list[rowIdx];
    const tr = trs[rowIdx];
    const tds = tr.querySelectorAll("td");
    if (tds.length !== DAILY_TABLE_COLUMNS.length + 1) return null;

    const labelText = row.label || DAILY_TABLE_LABELS[rowIdx];
    if (tds[0].textContent !== labelText) {
      tds[0].textContent = labelText;
      changed = true;
    }

    DAILY_TABLE_COLUMNS.forEach((col, colIdx) => {
      const nextHtml = col.render(row);
      const td = tds[colIdx + 1];
      if (td.innerHTML !== nextHtml) {
        td.innerHTML = nextHtml;
        changed = true;
      }
    });
  }

  return changed;
}

function dailyTableHtml(rows) {
  const list = normalizeDailyTableRows(rows);
  const head = `<tr><th>日期</th>${DAILY_TABLE_COLUMNS.map((col) => `<th>${col.label}</th>`).join("")}</tr>`;
  const body = list
    .map((row, idx) => {
      const cells = DAILY_TABLE_COLUMNS.map((col) => `<td class="num">${col.render(row)}</td>`).join("");
      return `<tr><td>${escapeHtml(row.label || DAILY_TABLE_LABELS[idx])}</td>${cells}</tr>`;
    })
    .join("");

  return `<table class="race-card__table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const RACE_TOP_COUNT = 5;

function getDisplayMovieCount() {
  return Math.max(1, Number(config.topCount) || RACE_TOP_COUNT);
}

function cardClassName(movie) {
  const rank = Math.min(Number(movie.rank) || 99, RACE_TOP_COUNT);
  return `race-card race-card--rank${rank}`;
}

function formatDisplayBox(movie) {
  const amount = getMovieBoxAmount(movie);
  if (amount > 0) return formatWanDisplayText(amount);
  if (!isEmptyField(movie.todayBoxText)) return `${movie.todayBoxText}${movie.todayUnit || "万"}`;
  return "--";
}

function raceCardTemplate(movie) {
  const mainland = formatMainlandDisplay(movie);
  const summary = buildSummaryHtml(movie);
  const tableRows = ensureDailyTable(movie);
  const table = dailyTableHtml(tableRows);

  return `
    <div class="race-card__head">
      <span class="race-card__rank">NO.${movie.rank}</span>
      <div class="race-card__title-wrap">
        <h2 class="race-card__title">《${escapeHtml(movie.name)}》</h2>
      </div>
      <div class="race-card__mainland-wrap">
        <div class="race-card__mainland${isEmptyField(mainland) || mainland === "--" ? " is-empty" : ""}">
          <em class="js-mainland-label">${mainlandLabel()}：</em>
          <strong class="js-mainland">${escapeHtml(mainland)}</strong>
        </div>
      </div>
    </div>
    <div class="race-card__summary-wrap">${summary}</div>
    <div class="race-card__table-wrap" data-table-sig=""><div class="race-card__table-scaler">${table}</div></div>
  `;
}

function applyCardEncodedBoxes(card, movie) {
  if (!card || !movie) return;
  const summaryWrap = card.querySelector(".race-card__summary-wrap");
  if (summaryWrap) updateSummaryInPlace(summaryWrap, movie);

  const tableRows = ensureDailyTable(movie);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  if (tableWrap) {
    const table = tableWrap.querySelector(".race-card__table");
    const inPlace = table ? updateDailyTableInPlace(table, tableRows) : null;
    if (inPlace === null) {
      tableWrap.innerHTML = `<div class="race-card__table-scaler">${dailyTableHtml(tableRows)}</div>`;
    }
    tableWrap.dataset.tableSig = dailyTableSignature(tableRows);
  }
}

function buildRaceCard(movie) {
  const card = document.createElement("article");
  card.className = cardClassName(movie);
  card.dataset.movieId = String(movie.movieId);
  card.dataset.rank = String(movie.rank);
  card.innerHTML = raceCardTemplate(movie);
  applyCardEncodedBoxes(card, movie);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  if (tableWrap) {
    tableWrap.dataset.tableSig = dailyTableSignature(ensureDailyTable(movie));
  }
  requestAnimationFrame(() => {
    fitCardChrome(card, movie);
  });
  return card;
}

function computeMovieDelta(movie, isNew) {
  if (isNew) return 0;
  const key = String(movie.movieId);
  const unit = movie.todayUnit || "万";
  const stored = prevValues.get(key);
  const storedHtml = prevBoxHtml.get(key);
  const decoded = getMovieBoxAmount(movie);
  if (!isTrustedMovieBoxAmount(movie)) return 0;

  let delta = 0;
  if (movie.todayBoxHtml && storedHtml && storedHtml !== movie.todayBoxHtml) {
    delta = computeBoxIncrease(stored, storedHtml, movie.todayBoxHtml, unit);
  }
  if (delta <= 0 && decoded > 0 && stored != null && decoded > stored) {
    delta = computeMovieBoxDeltaWan(stored, decoded);
  }
  if (!isReasonableBoxDelta(stored ?? 0, decoded, delta)) return 0;
  return delta;
}

function updateRaceCardDelta(card, movie, isNew) {
  let bubbleEl = card.querySelector(".race-card__delta-bubble");
  const dailyBoxMetric = card.querySelector('[data-metric="dailyBox"]');
  // 摘要结构重建后确保气泡挂在「实时票房」上
  if (dailyBoxMetric && (!bubbleEl || bubbleEl.parentElement !== dailyBoxMetric)) {
    if (bubbleEl) bubbleEl.remove();
    bubbleEl = document.createElement("span");
    bubbleEl.className = "race-card__delta-bubble race-card__delta-float";
    bubbleEl.setAttribute("aria-hidden", "true");
    const valueEl = dailyBoxMetric.querySelector(".metric__value");
    if (valueEl) dailyBoxMetric.insertBefore(bubbleEl, valueEl);
    else dailyBoxMetric.appendChild(bubbleEl);
  }
  if (!bubbleEl) return;
  const delta = computeMovieDelta(movie, isNew);
  if (delta > 0) {
    pulseInlineDelta(bubbleEl, delta, `movie-${movie.movieId}`);
  }
}

function trackBoxDelta(_card, movie) {
  const key = String(movie.movieId);
  const decoded = getMovieBoxAmount(movie);
  const stored = prevValues.get(key);

  // 只抬升/写入可信票房基线，拒绝 1111.1 等解码垃圾污染气泡
  if (isTrustedMovieBoxAmount(movie)) {
    if (stored == null || decoded >= stored) {
      prevValues.set(key, decoded);
    }
  }
  if (movie.todayBoxHtml) {
    const prevHtml = prevBoxHtml.get(key);
    if (!prevHtml || prevHtml !== movie.todayBoxHtml) {
      if (isTrustedMovieBoxAmount(movie) || boxHtmlUsesAntiScrapeFont(movie.todayBoxHtml)) {
        prevBoxHtml.set(key, movie.todayBoxHtml);
      }
    }
  }
}

function updateRaceCard(card, movie, isNew = false) {
  const prevRank = Number(card.dataset.rank || 0);
  card.className = cardClassName(movie);
  card.dataset.rank = String(movie.rank);

  if (prevRank && prevRank !== movie.rank) {
    card.classList.remove("is-flash");
    void card.offsetWidth;
    card.classList.add("is-flash");
  }

  const head = card.querySelector(".race-card__head");
  if (!head) {
    card.innerHTML = raceCardTemplate(movie);
    const tableWrap = card.querySelector(".race-card__table-wrap");
    if (tableWrap) {
      tableWrap.dataset.tableSig = dailyTableSignature(ensureDailyTable(movie));
    }
    updateRaceCardDelta(card, movie, isNew);
    trackBoxDelta(card, movie, isNew);
    return;
  }

  setTextIfChanged(card.querySelector(".race-card__rank"), `NO.${movie.rank}`);
  const titleChanged = setTextIfChanged(card.querySelector(".race-card__title"), `《${movie.name}》`);

  const mainland = formatMainlandDisplay(movie);
  const mainlandWrap = card.querySelector(".race-card__mainland");
  const mainlandEl = card.querySelector(".js-mainland");
  const mainlandLabelEl = card.querySelector(".js-mainland-label");
  if (mainlandLabelEl) {
    setTextIfChanged(mainlandLabelEl, `${mainlandLabel()}：`);
  }
  if (mainlandWrap && mainlandEl) {
    mainlandWrap.classList.toggle("is-empty", isEmptyField(mainland) || mainland === "--");
    mainlandEl.classList.remove("mtsi-font");
    if (!isEmptyField(mainland) && mainland !== "--") {
      setTextIfChanged(mainlandEl, mainland);
    }
  }

  const summaryWrap = card.querySelector(".race-card__summary-wrap");
  let summaryStructural = false;
  let summaryValuesChanged = false;
  if (summaryWrap) {
    const inPlace = updateSummaryInPlace(summaryWrap, movie);
    if (inPlace === null) {
      summaryWrap.innerHTML = buildSummaryHtml(movie);
      summaryStructural = true;
    } else if (inPlace) {
      summaryValuesChanged = true;
    }
  }

  const tableRows = ensureDailyTable(movie);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  let tableStructural = false;
  let tableValuesChanged = false;
  if (tableWrap) {
    const sig = dailyTableSignature(tableRows);
    if (tableWrap.dataset.tableSig !== sig) {
      const table = tableWrap.querySelector(".race-card__table");
      const inPlace = table ? updateDailyTableInPlace(table, tableRows) : null;
      if (inPlace === null) {
        tableWrap.innerHTML = `<div class="race-card__table-scaler">${dailyTableHtml(tableRows)}</div>`;
        tableWrap.dataset.tableFitReady = "";
        card.dataset.tableFitKey = "";
        card.dataset.tableFitReady = "";
        tableStructural = true;
      } else if (inPlace) {
        tableValuesChanged = true;
      }
      tableWrap.dataset.tableSig = sig;
    }
  }

  updateRaceCardDelta(card, movie, isNew);
  trackBoxDelta(card, movie, isNew);

  if (titleChanged || summaryStructural || tableStructural) {
    requestAnimationFrame(() => {
      fitCardChrome(card, movie, {
        fitMetrics: titleChanged || summaryStructural,
        fitTable: tableStructural,
      });
    });
  } else if (tableValuesChanged) {
    requestAnimationFrame(() => maybeFitTableAfterUpdate(card));
  }
}

function isFirstSeen(movieId) {
  const key = String(movieId);
  return !prevBoxHtml.has(key) && !prevValues.has(key);
}

function ensureRaceCard(movie) {
  const key = String(movie.movieId);
  let card = cardPool.get(key);
  if (!card || !card.classList.contains("race-card") || !card.querySelector(".race-card__head")) {
    card?.remove();
    card = buildRaceCard(movie);
    cardPool.set(key, card);
    updateRaceCardDelta(card, movie, isFirstSeen(key));
    trackBoxDelta(card, movie, isFirstSeen(key));
    return card;
  }
  updateRaceCard(card, movie, isFirstSeen(key));
  return card;
}

function renderLoadingSkeleton() {
  if (!raceListEl) return;
  raceListEl.innerHTML = Array.from({ length: getDisplayMovieCount() }, (_, i) => {
    const rank = i + 1;
    return `
      <article class="race-card race-card--skeleton race-card--rank${rank}" aria-hidden="true">
        <div class="race-card__head">
          <span class="race-card__rank skeleton-block">NO.${rank}</span>
          <h2 class="race-card__title skeleton-block">加载中</h2>
          <div class="race-card__mainland skeleton-block"></div>
        </div>
        <div class="race-card__summary-wrap">
          <div class="race-card__summary">
            ${Array.from({ length: 3 }, () => '<div class="race-card__summary-col skeleton-block"></div>').join("")}
          </div>
        </div>
        <div class="race-card__table-wrap skeleton-block"></div>
      </article>
    `;
  }).join("");
}

function renderList(movies) {
  if (!raceListEl) return;

  const list = (movies || [])
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, getDisplayMovieCount());
  const activeIds = new Set(list.map((m) => String(m.movieId)));

  raceListEl.querySelectorAll(".race-card--skeleton").forEach((el) => el.remove());

  for (const [id, card] of cardPool) {
    if (!activeIds.has(id)) {
      card.remove();
      purgeMovieState(id);
    }
  }

  const cards = list.map((movie) => {
    traceMovieRender(movie);
    const card = ensureRaceCard(movie);
    prevRankMap.set(String(movie.movieId), movie.rank);
    return card;
  });

  if (cards.length) {
    syncRaceListChildren(cards);
    // 不再每次轮询全表 refit：字号抖动是界面闪烁主因；结构变化时 updateRaceCard 会局部 fit
  }

  updateChampion(list);
}

function syncRaceListChildren(cards) {
  if (!raceListEl) return;
  const existing = [...raceListEl.children];
  if (existing.length === cards.length && existing.every((node, idx) => node === cards[idx])) {
    return;
  }
  raceListEl.replaceChildren(...cards);
}

function setPlainBoxValue(el, amount, unitEl) {
  if (!el) return;
  const { valueText, unit } = formatWanForDisplay(amount);
  el.classList.remove("mtsi-font");
  if (el.textContent !== valueText) el.textContent = valueText;
  if (unitEl && unitEl.textContent !== unit) unitEl.textContent = unit;
}

function resolveDisplayDate(parsed) {
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  let d = null;
  if (parsed?.updateTimestamp) {
    d = new Date(Number(parsed.updateTimestamp));
  }
  if ((!d || Number.isNaN(d.getTime())) && parsed?.updateTimeText) {
    d = new Date(String(parsed.updateTimeText).replace(/-/g, "/"));
  }
  if (!d || Number.isNaN(d.getTime())) d = new Date();

  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  let day = d.getDate();
  const calendarDay = String(parsed?.calendar?.today || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(calendarDay)) {
    const [cy, cm, cd] = calendarDay.split("-").map(Number);
    if (cy && cm && cd) {
      y = cy;
      m = cm;
      day = cd;
      const synced = new Date(y, m - 1, day, d.getHours(), d.getMinutes(), d.getSeconds());
      if (!Number.isNaN(synced.getTime())) d = synced;
    }
  }

  return `今日：${y}年${String(m).padStart(2, "0")}月${String(day).padStart(2, "0")}日 周${WEEK[d.getDay()]}`;
}

function isDataTraceEnabled() {
  if (typeof process !== "undefined" && process?.env?.DATA_TRACE === "1") return true;
  return new URLSearchParams(location.search).has("dataTrace");
}

function resolveDisplayBoxAmount(html, unit, numeric, text) {
  if (Number.isFinite(numeric) && numeric > 0 && !isUntrustedBoxDecode(String(text || numeric))) {
    return numeric;
  }
  const fromHtml = safeDecodeBox(html, unit);
  if (fromHtml > 0) return fromHtml;
  if (!isEmptyField(text) && !isUntrustedBoxDecode(text)) {
    const n = parseBoxNum(text, unit || "万");
    if (n > 0 && !isUntrustedBoxDecode(String(n))) return n;
  }
  return 0;
}

function setEncodedBoxValue(el, html, fallbackText = "--") {
  if (!el) return;
  const raw = html == null ? "" : String(html);
  if (raw && /登录猫眼|专业版即可|剩余城市|商排|请先登录|开通专业版/.test(raw.replace(/<[^>]+>/g, ""))) {
    if (el.textContent === fallbackText) return;
    el.classList.remove("mtsi-font");
    el.textContent = fallbackText;
    return;
  }
  if (raw) {
    if (el.innerHTML === raw) return;
    el.classList.add("mtsi-font");
    el.innerHTML = raw;
    return;
  }
  if (el.textContent === fallbackText) return;
  el.classList.remove("mtsi-font");
  el.textContent = fallbackText;
}

function updateNationSeatMetric(nation) {
  const metric = resolveNationSeatMetric(nation || {});
  if (nationSeatLabelEl) {
    setTextIfChanged(nationSeatLabelEl, metric.label);
  }
  if (nationSeatEl) {
    setTextIfChanged(nationSeatEl, metric.value || "--");
  }
  const hideSeat = isEmptyField(metric.value) || metric.value === "--";
  $("nation-seat-pill")?.classList.toggle("is-hidden", hideSeat);
}

function updateChampion(movies) {
  const top = (movies || []).find((m) => m.rank === 1) || movies?.[0];
  if (!top) {
    champBoxPillEl?.classList.add("is-hidden");
    return;
  }

  const preferEncoded = shouldPreferEncodedBox(top);
  const amount = preferEncoded ? 0 : resolveChampionBoxWan(top);
  if (preferEncoded && top.todayBoxHtml) {
    champBoxPillEl?.classList.remove("is-hidden");
    setEncodedBoxValue(champBoxEl, top.todayBoxHtml);
  } else if (amount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, amount, champBoxUnitEl);
    prevValues.set("__champ__", amount);
  } else {
    // 本轮解码失败：保留上次冠军票房，禁止闪成 --
    champBoxPillEl?.classList.remove("is-hidden");
    const prevAmount = prevValues.get("__champ__");
    if (!(prevAmount > 0)) {
      setPlainBoxValue(champBoxEl, null, champBoxUnitEl);
    }
  }
}

function updateNation(nation, parsed) {
  nation = stabilizeNation(nation);
  const unitEl = document.querySelector(".js-nation-unit");
  const unit = nation.todayUnit || "万";
  const prevNation = prevValues.get("__nation__");
  const nationAmount = resolveDisplayBoxAmount(
    nation.todayBoxHtml,
    unit,
    nation.todayBox,
    nation.todayBoxText,
  );

  // 今日大盘只展示解码后的真实数字；解码失败保留上次数字，禁止闪成 -- / 乱码
  if (nationAmount > 0) {
    if (
      prevNation != null &&
      isReasonableBoxDelta(prevNation, nationAmount, nationAmount - prevNation)
    ) {
      pulseInlineDelta(nationDeltaEl, nationAmount - prevNation, "__nation__");
    }
    setPlainBoxValue(nationBoxEl, nationAmount, unitEl);
    prevValues.set("__nation__", nationAmount);
    if (nation.todayBoxHtml) prevBoxHtml.set("__nation__", nation.todayBoxHtml);
  } else if (!(prevNation > 0)) {
    setPlainBoxValue(nationBoxEl, null, unitEl);
  }

  setTextIfChanged(nationShowsEl, nation.showCountDesc || "--");
  setTextIfChanged(nationViewsEl, nation.viewCountDesc || "--");

  $("nation-shows-pill")?.classList.toggle("is-hidden", isEmptyField(nation.showCountDesc));
  $("nation-views-pill")?.classList.toggle("is-hidden", isEmptyField(nation.viewCountDesc));

  updateNationSeatMetric(nation);

  if (heroDateEl) {
    setTextIfChanged(heroDateEl, resolveDisplayDate(parsed));
  }

  if (isDataTraceEnabled() && nation.showCountDesc) {
    console.log(
      `[DATA_TRACE] nation.showCountDesc raw = ${nation.showCountDesc} rendered = ${nation.showCountDesc}`,
    );
  }
}

async function abortAndResetEnrichSchedule() {
  enrichGeneration += 1;
  currentEnrichController?.abort();
  if (currentEnrichPromise) {
    try {
      await currentEnrichPromise;
    } catch {
      /* aborted or failed */
    }
  }
  currentEnrichController = null;
  currentEnrichPromise = null;
  resetEnrichScheduleState(enrichSchedule, { clearInflight: true });
}

function scheduleBackgroundEnrich(requestPollGen, parsed, speed) {
  if (!enrichAllowed) {
    pendingEnrichArgs = { requestPollGen, parsed, speed };
    return;
  }
  if (enrichSchedule.enrichingBackground) return;

  const now = Date.now();
  enrichSchedule.pollCount = pollCount;
  if (!shouldScheduleFullEnrich(now, enrichSchedule, FULL_ENRICH_INTERVAL_MS)) return;

  const gen = enrichGeneration;
  enrichSchedule.enrichingBackground = true;
  markFullEnrichAttempt(enrichSchedule, now);

  const controller = new AbortController();
  currentEnrichController = controller;
  const timeoutId = setTimeout(() => controller.abort(), FULL_ENRICH_GLOBAL_TIMEOUT_MS);

  const promise = (async () => {
    try {
      if (await window.overlay?.isLoginRunning?.()) return;

      const enrichOpts = {
        concurrency: config.enrichConcurrency || 2,
        todayStr: parsed.calendar?.today || "",
        speed,
        trendLimit: getDisplayMovieCount(),
        enableExtraApis: true,
        signal: controller.signal,
      };

      const visibleMovies = parsed.movies.slice(0, getDisplayMovieCount());
      const enriched = await enrichMovies(config.apiBase, visibleMovies, enrichOpts);

      if (gen !== enrichGeneration) return;

      const baseMovies = latestMovies.length ? latestMovies : parsed.movies;
      const currentSpeed = buildSpeedMap(baseMovies);
      const movies = mergeEnrichedMovies(baseMovies, enriched, currentSpeed);
      renderList(movies);
      const errors = getLastEnrichErrors();
      updatePartialDataWarning(errors);
      setStatus("ok", "");
      if (shouldMarkFullEnrichFailure(errors, getDisplayMovieCount())) {
        markFullEnrichFailure(enrichSchedule, Date.now());
      } else {
        markFullEnrichSuccess(enrichSchedule, Date.now());
      }
    } catch (err) {
      console.warn("后台补充字段失败", err);
      if (gen === enrichGeneration) markFullEnrichFailure(enrichSchedule, Date.now());
      if (isLoginRelatedError(err)) {
        await updateLoginButton(true);
        partialDataWarning = `部分详细数据获取失败：${formatUserFacingError(err)}`;
        setStatus("ok", "");
      } else if (isSignatureRelatedError(err)) {
        partialDataWarning = `部分详细数据获取失败：${formatUserFacingError(err)}`;
        setStatus("ok", "");
      }
    } finally {
      clearTimeout(timeoutId);
      if (gen === enrichGeneration) enrichSchedule.enrichingBackground = false;
      if (currentEnrichPromise === promise) {
        currentEnrichController = null;
        currentEnrichPromise = null;
      }
    }
  })();

  currentEnrichPromise = promise;
}

function scheduleDecodeRetry() {
  setTimeout(() => {
    if (latestNation) {
      const amount = resolveDisplayBoxAmount(
        latestNation.todayBoxHtml,
        latestNation.todayUnit || "万",
        latestNation.todayBox,
        latestNation.todayBoxText
      );
      if (amount > 0) {
        latestNation = { ...latestNation, todayBox: amount };
        updateNation(latestNation, latestParsedMeta || {});
      }
    }

    if (!latestMovies.length) return;
    const needsRetry = latestMovies.some(
      (m) => m.todayBoxHtml && getMovieBoxAmount(stabilizeMovie(m)) <= 0
    );
    if (!needsRetry) {
      // 解码已成功：禁止二次 renderList，避免约每轮多闪一次
      updateChampion(latestMovies.map(stabilizeMovie));
      return;
    }
    const refreshed = rerankMoviesByTodayBox(
      latestMovies.map((movie) => refreshMovieBoxFields(movie)),
    );
    latestMovies = refreshed;
    const movies = enrichMoviesQuick(refreshed, latestSpeedMap).map(stabilizeMovie);
    renderList(movies);
  }, 800);
}

async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  pollCount += 1;

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

    const displayCount = getDisplayMovieCount();
    const raw = await fetchDashboard(config.apiBase, "", { topCount: displayCount });
    // 必须先注入反爬字体再 parse/decode，否则 todayBox 全失败 → 排名冻成猫眼原始序
    if (raw.fontStyle) {
      try {
        await injectFontStyle(raw.fontStyle);
      } catch (err) {
        console.warn("字体加载失败", err);
      }
    }
    const parsed = parseDashboard(raw, displayCount);
    resetLastGoodIfDayChanged(parsed.calendar?.today);
    traceDashboardData(parsed, raw, { enabled: isDataTraceEnabled() });
    if (!parsed.movies.length) {
      if (!hasDisplayedData) setStatus("loading", "等待票房数据…");
      return;
    }

    pollGeneration += 1;
    latestMovies = rerankMoviesByTodayBox(
      parsed.movies.map((movie) => refreshMovieBoxFields(movie)),
    );
    latestNation = parsed.nation
      ? refreshMovieBoxFields({ ...parsed.nation, todayBoxHtml: parsed.nation.todayBoxHtml || "" })
      : parsed.nation;
    latestParsedMeta = parsed;
    const speed = buildSpeedMap(latestMovies);
    latestSpeedMap = speed;
    const movies = enrichMoviesQuick(latestMovies, speed).map(stabilizeMovie);

    renderList(movies);
    updateNation(latestNation, parsed);

    hasDisplayedData = true;
    document.body.classList.add("is-ready");
    setStatus("ok", "");

    if (!firstDashboardPainted) {
      firstDashboardPainted = true;
    }
    enrichAllowed = true;
    scheduleBackgroundEnrich(pollGeneration, parsed, speed);
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
    } else if (e instanceof MaoyanApiError || isLoginRelatedError(e) || isSignatureRelatedError(e)) {
      if (isLoginRelatedError(e)) {
        const code = e instanceof MaoyanApiError ? e.code : "login_required";
        await window.overlay?.reportSessionApiError?.(code);
        await updateLoginButton(true);
      } else if (isSignatureRelatedError(e)) {
        const code = e instanceof MaoyanApiError ? e.code : "upstream_403";
        await window.overlay?.reportSessionApiError?.(code);
      }
      setStatus("error", formatUserFacingError(e) || "请求失败，请稍后重试");
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
  pollTimer = setInterval(refreshData, config.pollIntervalMs || 3000);
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
  config.topCount = RACE_TOP_COUNT;
  config.enrichConcurrency = settings.enrich?.concurrency;
  config.trendLimit = RACE_TOP_COUNT;
  FULL_ENRICH_INTERVAL_MS = settings.enrich?.fullIntervalMs || 60000;
  await abortAndResetEnrichSchedule();
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
  if (!window.overlay) {
    return { ready: false, error: "界面桥接未就绪，请重启软件" };
  }

  setStatus("loading", "正在自动启动票房数据服务…");

  // 先订阅，避免 ensureApi 完成时事件已发出却漏接
  let latestFromEvent = null;
  const off = window.overlay.onApiReady?.((next) => {
    latestFromEvent = next;
  });

  try {
    let status = await window.overlay.getApiStatus();
    if (status?.ready) return status;

    const ensurePromise = window.overlay.ensureApi();
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ __timeout: true }), 45_000);
    });
    status = await Promise.race([ensurePromise, timeoutPromise]);

    if (status?.__timeout) {
      if (latestFromEvent) return latestFromEvent;
      const current = await window.overlay.getApiStatus().catch(() => null);
      if (current?.ready) return current;
      return {
        ready: false,
        error:
          current?.error ||
          "票房服务启动超时（45 秒），请重启软件；换电脑后需安装 Google Chrome",
      };
    }

    if (status?.ready) return status;
    if (latestFromEvent?.ready) return latestFromEvent;
    return {
      ready: false,
      error:
        status?.error ||
        latestFromEvent?.error ||
        "票房服务启动失败，请重启软件",
    };
  } finally {
    off?.();
  }
}

function isLoginRequiredStatus(status) {
  if (status?.loginRequired) return true;
  const err = String(status?.lastVerifyError || "");
  if (/^(login_required|detail_http_401|upstream_401|session_expired)$/.test(err)) return true;
  if (
    err === "sig_capture_failed" &&
    status?.identityCookieExists &&
    !status?.detailApiReady &&
    !status?.signatureReady
  ) {
    return true;
  }
  if (err === "box_page_not_loaded" && status?.identityCookieExists && !status?.detailApiReady) {
    return true;
  }
  return false;
}

function isSignatureIssueStatus(status) {
  if (isLoginRequiredStatus(status)) return false;
  const err = String(status?.lastVerifyError || "");
  if (
    /^(detail_http_403|upstream_403|403|mtgsig_not_captured|getboxshow_request_not_seen|sig_capture_failed)$/.test(
      err,
    ) || /mtgsig/i.test(err)
  ) {
    return true;
  }
  // 已有登录 Cookie 但签名明确不可用
  if (
    status?.identityCookieExists &&
    status?.signatureReady === false &&
    status?.sessionUsable === false
  ) {
    return true;
  }
  return false;
}

async function updateLoginButton(forceShow = false) {
  const btn = $("btn-login");
  if (!btn) return;
  const status = (await window.overlay?.getSessionStatus?.()) || {};

  const needLogin = forceShow || isLoginRequiredStatus(status);
  const needSig = !needLogin && isSignatureIssueStatus(status);

  // 右上角登录按钮常驻显示，方便随时重新登录
  btn.classList.remove("is-hidden");
  btn.textContent = "登录";
  if (needLogin || forceShow) {
    btn.title = "登录猫眼账号";
    return;
  }
  if (needSig) {
    btn.title = "猫眼签名不可用，点击登录或刷新签名";
    return;
  }
  btn.title = "登录猫眼账号";
}

function handleLoginFailure(result) {
  const detail =
    result?.detail ||
    result?.error ||
    (result?.code === "login_cancelled"
      ? "未完成登录"
      : result?.code === "login_timeout"
        ? "登录超时，请重新点击登录"
        : result?.code === "login_incomplete"
          ? "未检测到猫眼账号登录态，请在浏览器里完成登录后再试"
        : "登录失败，请重试");
  setStatus("error", detail);
  if (result?.code === "chrome_not_found" || result?.code === "browser_launch_failed") {
    $("btn-login")?.classList.add("is-highlight");
  }
}

async function handleSignatureRefresh() {
  setStatus("loading", "正在刷新猫眼签名…");
  const apiStatus = await window.overlay?.ensureApi?.();
  if (!apiStatus?.apiBase) {
    setStatus("error", "票房服务未就绪，无法刷新签名");
    return;
  }
  config.apiBase = apiStatus.apiBase;
  const movieId = String(latestMovies[0]?.movieId || "1462628");
  try {
    const resp = await fetch(
      `${apiStatus.apiBase}/api/refresh?movieId=${encodeURIComponent(movieId)}&boxLevel=1`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new MaoyanApiError(body.detail || "刷新签名失败", body);
    }
    resetApiSigWarm();
    await updateLoginButton(false);
    setStatus("loading", "签名已刷新，正在重新拉取数据…");
    refreshData();
  } catch (error) {
    const code = error instanceof MaoyanApiError ? error.code : "";
    if (code === "login_required" || isLoginRequiredStatus({ lastVerifyError: code, loginRequired: code === "login_required" })) {
      await window.overlay?.reportSessionApiError?.("login_required");
      await updateLoginButton(true);
      setStatus("error", "猫眼登录已过期，请点击右上角登录");
      return;
    }
    setStatus("error", formatUserFacingError(error));
  }
}

async function handleLoginClick() {
  const sessionStatus = (await window.overlay?.getSessionStatus?.()) || {};
  if (isSignatureIssueStatus(sessionStatus) && !isLoginRequiredStatus(sessionStatus)) {
    await handleSignatureRefresh();
    return;
  }

  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }
  $("btn-login")?.classList.remove("is-highlight");
  const relogin = sessionStatus.identityCookieExists;
  setStatus(
    "loading",
    relogin
      ? "正在打开登录窗口，请在浏览器登录页完成猫眼账号登录…"
      : "正在打开登录窗口，若出现登录页请完成猫眼账号登录…",
  );

  let offResult = null;
  const waitForResult = new Promise((resolve) => {
    offResult = window.overlay?.onLoginResult?.((result) => resolve(result));
  });

  const loginResult = await window.overlay?.startLogin?.({ relogin });
  if (loginResult && loginResult.ok === false) {
    offResult?.();
    handleLoginFailure(loginResult);
    return;
  }

  setStatus("loading", "请在浏览器中完成登录，成功后窗口将自动关闭");

  const deadline = Date.now() + 10 * 60 * 1000;
  const result = await Promise.race([
    waitForResult,
    new Promise((resolve) => {
      loginWatchTimer = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(loginWatchTimer);
          loginWatchTimer = null;
          resolve({ ok: false, code: "login_timeout", detail: "登录超时，请重新点击「登录」" });
          return;
        }
        const running = await window.overlay?.isLoginRunning?.();
        if (running) return;
        const session = (await window.overlay?.getSessionStatus?.()) || {};
        if (
          session.detailApiReady ||
          (session.loginCookieReady && session.storageStateExists)
        ) {
          clearInterval(loginWatchTimer);
          loginWatchTimer = null;
          resolve({
            ok: true,
            detailApiReady: Boolean(session.detailApiReady),
            loginCookieReady: Boolean(session.loginCookieReady),
          });
        }
      }, 2000);
    }),
  ]);

  offResult?.();
  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }

  if (result?.ok && (result?.detailApiReady || result?.loggedIn || result?.loginCookieReady)) {
    await finishLoginSuccess(result);
    return;
  }
  handleLoginFailure(result);
}

async function init() {
  bindDesignViewport();
  window.addEventListener(
    "resize",
    () => {
      scheduleRaceCardReflow();
    },
    { passive: true },
  );
  renderLoadingSkeleton();
  $("btn-login")?.addEventListener("click", handleLoginClick);
  if (heroDateEl) setTextIfChanged(heroDateEl, resolveDisplayDate(null));

  config = (await window.overlay?.getConfig()) || {
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 3000,
    topCount: RACE_TOP_COUNT,
  };
  config.topCount = RACE_TOP_COUNT;

  await syncOverlaySettings();
  window.overlay?.onSettingsChanged?.(async (settings) => {
    applyOverlaySettings(settings);
    config.pollIntervalMs = settings.pollIntervalMs;
    config.topCount = RACE_TOP_COUNT;
    config.enrichConcurrency = settings.enrich?.concurrency;
    config.trendLimit = RACE_TOP_COUNT;
    FULL_ENRICH_INTERVAL_MS = settings.enrich?.fullIntervalMs || 60000;
    await abortAndResetEnrichSchedule();
    if (hasDisplayedData) {
      restartPolling();
      refreshData();
    }
  });

  await updateLoginButton();

  if (new URLSearchParams(location.search).has("preview")) {
    window.__racePreview = {
      renderList,
      refitAllRaceCards,
      updateNation,
      setStatus,
      stabilizeMovie,
      pulseInlineDelta,
      computeMovieDelta,
      formatDeltaWithArrow,
      formatWanForDisplay,
      formatWanDisplayText,
      parseDashboard,
      resolveChampionBoxWan,
      resolveNationSeatMetric,
      computeMovieBoxDeltaWan,
      getExtraMetrics,
      getExtraMetricsGridClass,
      buildDailyTrendItems,
    };
    setStatus("ok", "");
    return;
  }

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

setTimeout(() => {
  if (hasDisplayedData) return;
  if (statusEl?.classList.contains("status--loading")) {
    setStatus(
      "error",
      "加载超时：请重启软件，或点击右上角「登录」完成猫眼登录；换电脑请先安装 Google Chrome"
    );
  }
}, 60_000);

init().catch((err) => {
  console.error("界面初始化失败", err);
  setStatus("error", err?.message || "界面初始化失败，请重启软件");
});
