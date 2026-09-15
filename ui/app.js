import {
  fetchDashboard,
  parseDashboardStructure,
  parseDashboard,
  decodeBoxFromHtml,
  decodeBoxHtmlLoose,
  decodeFontNum,
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
  refreshNationBoxFields,
  getFontMappingVersion,
  getActivePuaMapState,
  prepareDashboardFont,
  scheduleDashboardPuaMap,
  fontFamilyForVersion,
  getActiveFontFamily,
  resolveMaoyanSumBoxWan,
  rerankMoviesByTodayBox,
  isMaoyanFontReady,
  DECODE_STATUS,
  traceDashboardData,
  getExtraMetrics,
  getExtraMetricsGridClass,
  buildDailyTrendItems,
  formatReleaseTag,
  tryPublishDashboardSession,
} from "./maoyan-api.js";
import {
  createDashboardSession,
  isSessionCurrent,
  prepareSessionFont,
  buildSessionPuaMap,
  tryPublishSession,
  decodeSessionDashboard,
  sessionFontIdentity,
} from "./dashboard-session.js";
import { normalizeFontIdentity, isVisualReady } from "./font-registry.js";
import {
  submitBubbleSample,
  tickBubbleSamples,
  bubbleSamples,
  registerBubbleAnchor,
  getBubbleSkipLog,
  BUBBLE_SKIP,
} from "./bubble-tracker.js";
import { applyOverlaySettings, getOverlaySettings } from "./settings-applier.js";
import { bindDesignViewport } from "./viewport-fit.js";
import {
  formatWanForDisplay,
  formatWanDisplayText,
  formatBoxTextForDisplay,
  sanitizeBoxUnit,
} from "./box-display.js";
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
import { beginStartupSession, markStartup, flushStartupReport, getPreviousStartupReport } from "./startup-metrics.js";

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
let fetchInFlight = false;
let mappingGeneration = 0;
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
let lastFontMappingVersion = "";
let lastChampionKey = "";
let lastChampionAmount = 0;
let lastChampionUnit = "万";
let lastChampionFontVersion = "";
const DISPLAY_CACHE_TTL_MS = 120000;
const displayCache = new Map();
let latestMovies = [];
let latestSpeedMap = {};
let latestNation = null;
let latestParsedMeta = null;
let pollGeneration = 0;
let FULL_ENRICH_INTERVAL_MS = 60000;
const inlineDeltaTimers = new Map();
const BUBBLE_INTERVAL_MS = 3000;
let bubbleTimer = null;
let bubbleTimerScheduled = false;
let partialDataWarning = "";
let activeLoginAttemptId = 0;
let lastAppliedLoginAttemptId = 0;

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
  "releaseDate",
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

/** 上映：优先 tech releaseDate，其次 dashboard releaseInfo */
function formatReleaseMetric(m) {
  if (!isEmptyField(m?.releaseDate)) {
    return String(m.releaseDate).replace(/^\d{4}-/, "").trim();
  }
  const tagged = formatReleaseTag(m?.releaseInfo);
  if (!isEmptyField(tagged)) return tagged;
  if (!isEmptyField(m?.releaseInfo)) return String(m.releaseInfo).trim();
  return "";
}

function formatMoneyMetric(val) {
  if (isEmptyField(val)) return "";
  const text = String(val).trim();
  if (text.startsWith("¥")) return text;
  if (text.includes("亿") || text.includes("万") || text.includes("%")) return text.includes("亿") || text.includes("万") ? `¥${text}` : text;
  return `¥${text}`;
}

function isPuaMapVerified() {
  const state = getActivePuaMapState();
  return Boolean(state?.hasMap && state?.meta?.confidence === "verified");
}

function normalizeDisplayFontVersion(versionKey) {
  const ver = String(versionKey || "").trim();
  if (!ver) return "";
  const sha = ver.match(/sha256:([a-f0-9]+)/i)?.[1];
  if (sha) return `sha256:${sha}`;
  const urlHash = ver.match(/^mtsi:([a-f0-9]{8,})$/i)?.[1];
  if (urlHash) return `url:${urlHash}`;
  return ver;
}

function elementHasVisibleBox(el) {
  if (!el) return false;
  if (el.classList.contains("mtsi-font-encoded") && String(el.innerHTML || "").trim()) return true;
  const text = String(el.textContent || "").trim();
  return Boolean(text && text !== "--" && text !== "-");
}

function shouldPreferEncodedBox(movie) {
  if (!movie?.todayBoxHtml) return false;
  const text = String(movie.todayBoxText || "").trim();
  const amount = Number(movie.todayBox) || 0;
  const key = String(movie.movieId || "");
  const cached = lastGoodMovies.get(key);
  if (
    (cached?.todayBox > 0 && !isUntrustedBoxDecode(String(cached.todayBoxText || cached.todayBox))) ||
    (amount > 0 && !isUntrustedBoxDecode(text || String(amount)))
  ) {
    return false;
  }
  if (amount > 0 && text && text !== "--" && !isUntrustedBoxDecode(text)) {
    return false;
  }
  const fontKey = resolveRecordFontKey(movie);
  if (!fontKey || !isExactFontVisualReady(fontKey)) return false;
  if (isEncodedBoxHtml(movie.todayBoxHtml)) return true;
  const raw = String(movie.todayBoxText || "").trim();
  return raw && raw !== "--" && isUntrustedBoxDecode(raw);
}

function formatDailyBoxDisplay(movie) {
  if (shouldPreferEncodedBox(movie)) return "";
  // 优先保留猫眼原文精度；单位经 sanitize，杜绝 PUA 空白「万」
  if (!isEmptyField(movie.todayBoxText) && movie.todayBoxText !== "--") {
    const text = String(movie.todayBoxText).trim();
    if (!isUntrustedBoxDecode(text)) {
      const unit = sanitizeBoxUnit(movie.todayUnit || "万");
      const normalized = formatBoxTextForDisplay(text, unit, parseBoxNum);
      if (normalized) return `¥${normalized}`;
    }
    // 垃圾 current text 不能挡住已恢复的可信金额
  }
  const amount = getMovieBoxAmount(movie);
  if (amount > 0) return `¥${formatWanDisplayText(amount)}`;
  return "--";
}

/** 当前 record/session 的精确字体身份（禁止回退到任意 published） */
function resolveRecordFontKey(record, sessionMeta = {}) {
  return String(
    record?.fontContentKey ||
      record?.fontMappingVersion ||
      sessionMeta?.fontContentKey ||
      sessionMeta?.fontUrlKey ||
      "",
  ).trim();
}

function isExactFontVisualReady(fontKey) {
  const key = String(fontKey || "").trim();
  if (!key) return false;
  return isVisualReady(key) || isMaoyanFontReady(key);
}

function hasTrustedCurrentPlainBox(record) {
  if (!record || record.decodeKeepPrevious === true) return false;
  const amount = Number(record.todayBox) || 0;
  if (!(amount > 0)) return false;
  if (record.decodeStatus === DECODE_STATUS.DECODE_ERROR) return false;
  if (record.decodeStatus === DECODE_STATUS.ENCODED) return false;
  const text = String(record.todayBoxText || amount).trim();
  if (text && text !== "--" && isUntrustedBoxDecode(text)) return false;
  return record.decodeStatus === DECODE_STATUS.OK || record.decodeVerified === true || !record.decodeStatus;
}

/**
 * 当前响应是否允许刷新票房 UI。
 * A) 当前可信 plain numeric  B) 当前 encoded HTML + 精确字体 visualReady
 * todayBoxHtml 存在本身不算 fresh。
 */
function canPaintCurrentBox(record, sessionMeta = {}) {
  if (hasTrustedCurrentPlainBox(record)) return true;
  const html = String(record?.todayBoxHtml || "").trim();
  if (!html || !isEncodedBoxHtml(html)) return false;
  const fontKey = resolveRecordFontKey(record, sessionMeta);
  return isExactFontVisualReady(fontKey);
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
      key: "releaseInfo",
      label: "上映日期",
      get: (m) => formatReleaseMetric(m),
      // 大盘自带字段，不依赖 getTechData；比「实时上座」更适合直播展示
      fallbacks: [],
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
            const cleaned = formatBoxTextForDisplay(
              m.todayBoxText,
              sanitizeBoxUnit(m.todayUnit || "万"),
              parseBoxNum,
            );
            return cleaned ? `¥${cleaned}` : "";
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

function resetBubbleBaselineOnFontChange(fontVer) {
  const ver = normalizeFontIdentity(fontVer || getFontMappingVersion());
  if (!ver) return;
  lastFontMappingVersion = ver;
}

function displayCacheKey(kind, id, businessDate) {
  const day = String(businessDate || lastGoodCacheDay || "").slice(0, 10);
  return `${kind}:${id}:${day}`;
}

function isStickyBoxCacheKey(key) {
  return /^(movie-box|champion|nation):/.test(String(key || ""));
}

function readDisplayCache(key) {
  const entry = displayCache.get(key);
  if (!entry) return null;
  if (!isStickyBoxCacheKey(key) && Date.now() - entry.at > DISPLAY_CACHE_TTL_MS) {
    displayCache.delete(key);
    return null;
  }
  return entry;
}

function displayHtmlLooksLikeBox(html) {
  const raw = String(html || "").trim();
  if (!raw || raw === "--") return false;
  if (raw.includes("metric__box-encoded") || raw.includes("mtsi-font-encoded")) {
    return raw.replace(/<[^>]+>/g, "").trim().length > 0 || /<span[\s>]/i.test(raw);
  }
  const text = raw.replace(/<[^>]+>/g, "").trim();
  return Boolean(text && text !== "--" && text !== "-");
}

function stickyBoxMetricHtml(previousHtml, cacheKey) {
  if (displayHtmlLooksLikeBox(previousHtml)) return previousHtml;
  const cached = readDisplayCache(cacheKey);
  if (cached?.encodedHtml) {
    const html = String(cached.encodedHtml);
    if (html.includes("<")) return html.includes("metric__box-unit") ? html : wrapEncodedBoxMetricHtml(html, cached.unit || "万");
    return buildEncodedBoxHtml(html, cached.fontVersion, cached.unit || "万");
  }
  if (cached?.plainHtml) return String(cached.plainHtml);
  return null;
}

function writeDisplayCache(key, payload) {
  if (!key || !payload) return;
  displayCache.set(key, { ...payload, at: Date.now() });
}

function formatCacheAgeMs(at) {
  if (!at) return "";
  const sec = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}秒前`;
  return `${Math.round(sec / 60)}分钟前`;
}

function cacheTitleAttr(entry) {
  if (!entry?.at) return "";
  return ` title="缓存 ${formatCacheAgeMs(entry.at)}"`;
}

function buildEncodedBoxHtml(html, fontVersion, unit = "万") {
  const ver = String(fontVersion || getFontMappingVersion() || "").trim();
  const family = fontFamilyForVersion(ver || getActiveFontFamily());
  const safeVer = escapeHtml(ver);
  const safeFamily = escapeHtml(family);
  const safeUnit = sanitizeBoxUnit(unit);
  return `<span class="metric__box-encoded mtsi-font-encoded" data-font-version="${safeVer}" style="font-family:'${safeFamily}',var(--font-sans)">${html}</span><span class="metric__box-unit">${escapeHtml(safeUnit)}</span>`;
}

function wrapEncodedBoxMetricHtml(html, unit = "万") {
  if (!html) return html;
  if (String(html).includes("metric__box-unit")) return html;
  const safeUnit = sanitizeBoxUnit(unit);
  return `${html}<span class="metric__box-unit">${escapeHtml(safeUnit)}</span>`;
}

function resolveDisplayBoxUnit(record, amountWan = 0) {
  if (Number.isFinite(amountWan) && amountWan >= 10000) return "亿";
  const unit = sanitizeBoxUnit(record?.todayUnit || "万");
  return unit === "亿" ? "亿" : "万";
}

function bubbleDecodeBoxWan(html, unit, contentKey) {
  if (!html) return 0;
  const safeUnit = sanitizeBoxUnit(unit || "万");
  const key = String(contentKey || "").trim();
  // 编码票房必须带本轮字体身份；禁止静默回退到 published 旧映射
  if (!key && boxHtmlUsesAntiScrapeFont(html)) return 0;
  const n = decodeBoxHtmlLoose(html, safeUnit, key || getFontMappingVersion());
  return n > 0 ? n : 0;
}

function readBubbleAmountFromCard(card, movie) {
  const valueEl = card?.querySelector('[data-metric="dailyBox"] .metric__value');
  if (!valueEl) return 0;
  const text = String(valueEl.textContent || "")
    .replace(/[¥,\s]/g, "")
    .trim();
  if (!text || text === "--") return 0;
  const unit = sanitizeBoxUnit(movie?.todayUnit || "万");
  const n = parseBoxNum(text, unit);
  if (n > 0 && !isUntrustedBoxDecode(text)) return n;
  return 0;
}

function hasVisibleDailyBox(card) {
  const valueEl = card?.querySelector('[data-metric="dailyBox"] .metric__value');
  if (!valueEl) return false;
  if (displayHtmlLooksLikeBox(valueEl.innerHTML)) return true;
  const text = String(valueEl.textContent || "").trim();
  return Boolean(text && text !== "--" && text !== "-");
}

function rememberBubbleBoxAmount(movie, amount) {
  if (!movie?.movieId || !(amount > 0)) return;
  const key = String(movie.movieId);
  const prev = Number(prevValues.get(key)) || 0;
  // 高水位：仅在更高时更新，低于上次的读数抛弃
  if (amount > prev) prevValues.set(key, amount);
}

function scheduleBubbleAmountRetry(card, movie, bubbleEl, key, contentKey) {
  if (!card || !bubbleEl || bubbleSamples.get(key)?.amount > 0) return;
  const businessDate = latestParsedMeta?.calendar?.today || lastGoodCacheDay;
  const attempt = () => {
    if (!bubbleEl.isConnected) return;
    const resolved = resolveBubbleAmountWithHtmlDelta(movie, {
      contentKey,
      card,
      bubbleKey: key,
      trackKey: String(movie.movieId),
    });
    if (resolved.amount > 0) {
      observeBubble(key, bubbleEl, resolved.amount, {
        movie,
        businessDate,
        movieId: movie.movieId,
        trusted: true,
        decodeVerified: true,
        contentKey,
        responseId: latestParsedMeta?.responseId || 0,
        previousAmount: resolved.previousAmount,
      });
      rememberBubbleBoxAmount(movie, resolved.amount);
    }
  };
  requestAnimationFrame(attempt);
  setTimeout(attempt, 500);
  setTimeout(attempt, 2000);
}

function championCacheKey(movie, businessDate) {
  const day = String(businessDate || latestParsedMeta?.calendar?.today || lastGoodCacheDay || "").slice(0, 10);
  return `${movie?.movieId || ""}:${day}`;
}

function buildMovieBoxRefreshOptions(movie, nation) {
  const nationBoxWan = nation?.todayBox > 0 ? nation.todayBox : lastGoodNation.todayBox || 0;
  const sumBoxNumWan =
    Number(movie?.sumBoxNum) > 0 ? Number(movie.sumBoxNum) : resolveMaoyanSumBoxWan(movie);
  const mapState = getActivePuaMapState();
  return {
    nationBoxWan,
    sumBoxNumWan,
    todayUnit: movie?.todayUnit,
    fontMappingVersion: mapState.version || getFontMappingVersion(),
  };
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
    prevValues.clear();
    prevBoxHtml.clear();
    displayCache.clear();
    lastChampionKey = "";
    lastChampionAmount = 0;
    bubbleSamples.clear();
    clearInterval(bubbleTimer);
    bubbleTimer = null;
    bubbleTimerScheduled = false;
    for (const timer of inlineDeltaTimers.values()) clearTimeout(timer);
    inlineDeltaTimers.clear();
    document.querySelectorAll(".race-card__delta-bubble, #nation-delta").forEach((el) => {
      el.classList.remove("is-visible", "is-animating", "is-idle", "is-rise");
      el.textContent = "";
    });
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

async function updatePartialDataWarning(errors = []) {
  if (!errors.length) {
    partialDataWarning = "";
    return;
  }
  const session = (await window.overlay?.getSessionStatus?.()) || {};
  const sessionReady =
    Boolean(session.detailApiReady) ||
    (Boolean(session.signatureReady) && !session.loginRequired);
  const loginIssue = errors.find(
    (e) =>
      e.action === "login" ||
      /login|登录/.test(String(e.code)) ||
      String(e.code) === "login_required" ||
      String(e.code) === "upstream_401",
  );
  if (loginIssue && !sessionReady) {
    partialDataWarning = "明日/后天等明细数据需要猫眼登录，请点击右上角「登录」完成账号登录";
    return;
  }
  if (loginIssue && sessionReady) {
    partialDataWarning = `部分明细暂时不可用：${loginIssue.detail || "接口重试中，大盘与实时票房不受影响"}`;
    return;
  }
  const detail = errors[0]?.detail || "部分详细数据获取失败";
  partialDataWarning = `部分详细数据获取失败：${detail}`;
}

function shouldApplyLoginResult(result) {
  const attemptId = Number(result?.attemptId) || 0;
  if (!attemptId) return true;
  if (attemptId <= lastAppliedLoginAttemptId) return false;
  lastAppliedLoginAttemptId = attemptId;
  return true;
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
    deferred ? "账号已登录，签名准备中，正在拉取票房数据…" : "登录成功，正在拉取票房数据…",
  );

  let status = null;
  try {
    status = await Promise.race([
      window.overlay?.ensureApi?.() || Promise.resolve(null),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, error: "票房服务启动超时", apiBase: config.apiBase }), 35000),
      ),
    ]);
  } catch (error) {
    status = { ready: false, error: error?.message || "ensureApi failed", apiBase: config.apiBase };
  }
  if (status?.apiBase) config.apiBase = status.apiBase;
  console.log(
    "登录后 ensureApi:",
    `ready=${Boolean(status?.ready)}`,
    `apiBase=${status?.apiBase || "-"}`,
    `error=${status?.error || "-"}`,
  );

  if (!status?.apiBase || status?.ready === false) {
    // 无 ready 时仍尝试用已有 apiBase 拉大盘；完全没有则提示
    if (!status?.apiBase && !config.apiBase) {
      setStatus("error", status?.error || "票房服务未启动，请重启软件后再点登录");
      await updateLoginButton(true);
      return;
    }
    if (!status?.apiBase) status = { ...(status || {}), apiBase: config.apiBase };
    if (status?.error) {
      console.warn("登录后票房服务未就绪:", status.error);
      // 服务挂了仍尝试拉大盘；同时把真实错误写进状态，避免一直“加载中”
      if (status?.ready === false) {
        setStatus("loading", `票房服务异常，正在重试… ${String(status.error).slice(0, 80)}`);
      }
    }
  }

  const apiBase = status?.apiBase || config.apiBase;
  if (apiBase) config.apiBase = apiBase;

  // 先拉大盘，避免卡在 refresh/无头抓签
  startPolling();

  // 后台 refresh：优先复用登录缓存签名；短超时，失败不阻断界面
  void (async () => {
    try {
      if (!apiBase) return;
      console.log("登录后开始 refresh 签名");
      const movieId = String(latestMovies[0]?.movieId || "1462628");
      const resp = await fetch(
        `${apiBase}/api/refresh?movieId=${encodeURIComponent(movieId)}&boxLevel=1`,
        { signal: AbortSignal.timeout(45000) },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        const code = String(body?.code || "");
        const detail = String(body?.detail || resp.status);
        console.warn("登录后刷新签名失败:", code || detail);
        if (code === "login_required" || /login_required|401/.test(detail)) {
          await window.overlay?.reportSessionApiError?.("login_required");
          await updateLoginButton(true);
          setStatus("error", "登录态未生效，请重新点击右上角登录");
          return;
        }
        if (deferred) {
          partialDataWarning = `签名刷新未完成：${detail}`;
        }
        return;
      }
      resetApiSigWarm();
      console.log("登录后 refresh 签名完成");
      // 签名就绪后再拉一轮明细
      try {
        await refreshData();
      } catch (error) {
        console.warn("签名就绪后拉取明细失败:", error?.message || error);
      }
    } catch (error) {
      console.warn("登录后刷新签名异常:", error?.message || error);
      if (deferred) {
        partialDataWarning = `签名刷新超时，大盘可先显示；明细稍后重试`;
      }
    }
  })();
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
  const sign = "+";
  const cents = Math.round(Math.abs(deltaWan) * 1000000);
  if (!cents) return "";
  if (cents >= 10000000000) return `${sign}${Number((cents / 10000000000).toFixed(10))}亿`;
  if (cents >= 1000000) return `${sign}${Number((cents / 1000000).toFixed(6))}万`;
  return `${sign}${Number((cents / 100).toFixed(2))}元`;
}

function formatDeltaWithArrow(deltaWan) {
  const text = formatDelta(deltaWan);
  return text ? `${text} ↑` : "";
}

function getBubbleDurationMs() {
  const durationMs = getOverlaySettings()?.bubble?.durationMs;
  if (Number.isFinite(durationMs) && durationMs > 0) return durationMs;
  return 2000;
}

function isBubbleVisible(key) {
  const sample = bubbleSamples.get(key);
  return Boolean(sample && sample.visibleUntil > Date.now());
}

function markBubbleVisible(key, durationMs) {
  const sample = bubbleSamples.get(key);
  if (sample) sample.visibleUntil = Date.now() + durationMs;
}

const BUBBLE_NO_CHANGE_TEXT = "暂无变化";

function hideBubble(el, key) {
  if (!el) return;
  el.textContent = "";
  el.classList.remove("is-visible", "is-animating", "is-idle", "is-rise");
  el.style.color = "";
  el.style.textShadow = "";
  el.style.animation = "";
  el.style.animationDuration = "";
  el.style.opacity = "";
  el.style.visibility = "";
  const sample = bubbleSamples.get(key);
  if (sample) {
    sample.el = el;
    sample.visibleUntil = 0;
  }
}

function finishBubbleAnimation(el, key) {
  inlineDeltaTimers.delete(key);
  const live = bubbleSamples.get(key);
  if (live) live.visibleUntil = 0;
  const target = live?.el?.isConnected ? live.el : el?.isConnected ? el : null;
  if (target) hideBubble(target, key);
}

/** 统一：上浮动效 → 播完隐藏。mode=rise 红色涨幅，mode=idle 暂无变化 */
function playBubblePulse(el, key, mode, deltaWan = 0) {
  const bubble = getOverlaySettings()?.bubble;
  if (!el || bubble?.enabled === false) return;
  el.style.display = "inline-flex";

  if (inlineDeltaTimers.has(key)) clearTimeout(inlineDeltaTimers.get(key));

  const durationMs = getBubbleDurationMs();
  const isRise = mode === "rise";
  if (isRise) {
    if (!Number.isFinite(deltaWan) || deltaWan <= 0 || !formatDelta(deltaWan)) return;
    el.textContent = formatDeltaWithArrow(deltaWan);
    el.style.color = "#ff4d4d";
    el.style.textShadow = "0 0 8px rgba(255, 77, 109, 0.45)";
    el.classList.remove("is-idle");
    el.classList.add("is-rise");
  } else {
    el.textContent = BUBBLE_NO_CHANGE_TEXT;
    el.style.color = "#d1d5db";
    el.style.textShadow = "none";
    el.classList.remove("is-rise");
    el.classList.add("is-idle");
  }

  el.style.animation = "none";
  el.style.animationDuration = `${durationMs}ms`;
  el.style.opacity = "1";
  el.style.visibility = "visible";
  el.classList.remove("is-animating");
  void el.offsetWidth;
  el.style.animation = "";
  el.classList.add("is-visible", "is-animating");

  markBubbleVisible(key, durationMs);
  const sample = bubbleSamples.get(key);
  if (sample) sample.el = el;
  inlineDeltaTimers.set(key, setTimeout(() => finishBubbleAnimation(el, key), durationMs));
}

function pulseInlineDelta(el, deltaWan, timerKey) {
  playBubblePulse(el, timerKey || el, "rise", deltaWan);
}

function pulseNoChangeBubble(el, key) {
  playBubblePulse(el, key, "idle");
}

// Rendering records observations; only this clock starts bubbles. Slow requests and
// duplicate detail/decode renders must not control or restart the animation cadence.
function observeBubble(key, el, amount, options = {}) {
  const trusted = isTrustedBubbleAmount(amount, options);
  const trackKey =
    key === "__nation__"
      ? "__nation__"
      : options.movieId != null
        ? String(options.movieId)
        : String(key || "").replace(/^movie-/, "");
  const previousAmount =
    Number(options.previousAmount) > 0
      ? Number(options.previousAmount)
      : Number(bubbleSamples.get(key)?.baseline) > 0
        ? Number(bubbleSamples.get(key).baseline)
        : Number(prevValues.get(trackKey)) || 0;
  const result = submitBubbleSample({
    key,
    el,
    amount,
    businessDate: options.businessDate || lastGoodCacheDay,
    movieId: options.movieId || "",
    scope: key === "__nation__" ? "nation" : "movie",
    contentKey: options.contentKey || getFontMappingVersion(),
    decodeVerified: trusted,
    responseId: options.responseId || 0,
    resetBaseline: options.resetBaseline === true,
    isReasonableDelta: isReasonableBoxDelta,
    bubbleEnabled: getOverlaySettings()?.bubble?.enabled !== false,
    isVisible: isBubbleVisible,
    lastTriggeredAmount: bubbleSamples.get(key)?.lastTriggeredAmount || 0,
    previousAmount,
  });
  if (result.action === "pulse" && result.delta > 0) {
    pulseInlineDelta(el, result.delta, key);
    const sample = bubbleSamples.get(key);
    if (sample) sample.lastTriggeredAmount = amount;
  } else if (result.reason === BUBBLE_SKIP.SETTINGS_OFF) {
    hideBubble(el, key);
  }
  ensureBubbleTimer();
}

function ensureBubbleTimer() {
  if (!bubbleSamples.size || bubbleTimer !== null) return;
  if (bubbleTimerScheduled) return;
  bubbleTimerScheduled = true;
  setTimeout(() => {
    bubbleTimerScheduled = false;
    if (!bubbleSamples.size) return;
    tickBubbles();
    if (bubbleTimer === null && bubbleSamples.size > 0) {
      bubbleTimer = setInterval(tickBubbles, BUBBLE_INTERVAL_MS);
    }
  }, BUBBLE_INTERVAL_MS);
}

function bindBubbleAnchor(key, el) {
  if (!key || !el) return;
  registerBubbleAnchor(key, el);
  ensureBubbleTimer();
}

function tickBubbles() {
  tickBubbleSamples({
    isReasonableDelta: isReasonableBoxDelta,
    bubbleEnabled: getOverlaySettings()?.bubble?.enabled !== false,
    isVisible: isBubbleVisible,
    onPulse: (el, delta, key) => {
      pulseInlineDelta(el, delta, key);
      const sample = bubbleSamples.get(key);
      if (sample) sample.lastTriggeredAmount = sample.amount;
    },
    onNoChange: (el, key) => {
      pulseNoChangeBubble(el, key);
    },
  });
}

window.addEventListener("beforeunload", () => {
  clearInterval(bubbleTimer);
  bubbleTimer = null;
  bubbleTimerScheduled = false;
  for (const timer of inlineDeltaTimers.values()) clearTimeout(timer);
});

function safeDecodeBox(html, unit = "万", contentKey = "") {
  if (!html) return 0;
  const encoded = boxHtmlUsesAntiScrapeFont(html);
  // 编码票房必须绑定本轮字体版本。没有版本时宁可暂时不解码，也不能
  // 用上一轮 published map 猜，否则会把错误大数写进高水位。
  if (encoded && !contentKey) return 0;
  if (contentKey || encoded) {
    const loose = bubbleDecodeBoxWan(html, unit, contentKey);
    if (loose > 0) return loose;
  }
  const value = decodeBoxFromHtml(html, unit);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isTrustedBubbleAmount(amount, options = {}) {
  if (options.trusted === true || options.decodeVerified === true) return true;
  // 已经拿到干净正数就给气泡用；不要被「仍带编码 HTML」的 movie 标志卡死
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (isUntrustedBoxDecode(String(amount))) return false;
  return true;
}

function isTrustedMovieBoxAmount(movie) {
  if (!movie) return false;
  if (movie.decodeVerified === true) return getMovieBoxAmount(movie) > 0;
  const text = String(movie.todayBoxText || "").trim();
  if (text && text !== "--" && isUntrustedBoxDecode(text)) return false;
  const amount = getMovieBoxAmount(movie);
  if (amount <= 0) return false;
  if (isUntrustedBoxDecode(String(amount))) return false;
  if (movie.decodeStatus === DECODE_STATUS.OK) return true;
  const html = movie.todayBoxHtml || "";
  if (html && isEncodedBoxHtml(html)) return false;
  if (text && /^\d+(\.\d+)?$/.test(text)) return true;
  if (!html) return true;
  return false;
}

function isReasonableBoxDelta(prevAmount, nextAmount, delta) {
  if (!Number.isFinite(delta) || delta <= 0) return false;
  if (!Number.isFinite(prevAmount) || !Number.isFinite(nextAmount)) return false;
  if (prevAmount <= 0 || nextAmount <= prevAmount) return false;
  if (isUntrustedBoxDecode(String(nextAmount)) || isUntrustedBoxDecode(String(prevAmount))) {
    return false;
  }
  if (prevAmount >= 1 && delta > prevAmount * 3 && delta > 200) return false;
  return true;
}

function resolvePrevAmount(prevAmount, prevHtml, unit, contentKey = "") {
  if (Number.isFinite(prevAmount) && prevAmount > 0) return prevAmount;
  if (prevHtml) return safeDecodeBox(prevHtml, unit, contentKey);
  return 0;
}

function computeBoxIncrease(prevAmount, prevHtml, nextHtml, unit, contentKey = "") {
  const next = safeDecodeBox(nextHtml, unit, contentKey);
  if (next <= 0) return 0;
  const prev = resolvePrevAmount(prevAmount, prevHtml, unit, contentKey);
  if (prev <= 0 || next <= prev) return 0;
  const delta = next - prev;
  return delta >= 0.001 ? delta : 0;
}

function resolveBubbleAmountWithHtmlDelta(record, options = {}) {
  const unit = sanitizeBoxUnit(record?.todayUnit || "万");
  const contentKey =
    options.contentKey ||
    record?.fontContentKey ||
    record?.fontMappingVersion ||
    getFontMappingVersion();
  const trackKey = options.trackKey || String(record?.movieId || "__nation__");
  const bubbleKey = options.bubbleKey || (trackKey === "__nation__" ? "__nation__" : `movie-${trackKey}`);
  const htmlSig = String(record?.todayBoxHtml || "").trim();
  const isNew = options.isNew === true;
  const prevSample = bubbleSamples.get(bubbleKey);
  const prevHtml = prevBoxHtml.get(trackKey) || prevSample?.lastBoxHtml || "";
  const prevAmount = Number(prevValues.get(trackKey)) || Number(prevSample?.baseline) || 0;

  let amount = 0;
  let previousAmount = prevAmount;

  if (htmlSig) {
    // 有 encoded HTML 时禁止用 DOM 旧明文冒充 fresh sample
    amount = bubbleDecodeBoxWan(htmlSig, unit, contentKey);
    if (!isNew && prevHtml && htmlSig !== prevHtml) {
      const prevDecoded = bubbleDecodeBoxWan(prevHtml, unit, contentKey);
      const currDecoded = amount || bubbleDecodeBoxWan(htmlSig, unit, contentKey);
      if (currDecoded > prevDecoded && prevDecoded > 0) {
        amount = currDecoded;
        previousAmount = prevDecoded;
      } else {
        const htmlDelta = computeBoxIncrease(prevAmount, prevHtml, htmlSig, unit, contentKey);
        if (htmlDelta > 0 && currDecoded > 0) {
          amount = currDecoded;
          previousAmount = prevDecoded > 0 ? prevDecoded : prevAmount;
        }
      }
    }
  } else {
    amount = resolveFreshBubbleAmount(record, { contentKey, card: options.card });
  }

  return { amount, previousAmount, htmlSig, contentKey, unit, bubbleKey, trackKey };
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
  const oldTodayBox = Number(prev.todayBox) || 0;
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
    // 本轮已是可信明文时，禁止回填上一轮 PUA HTML，否则 fresh bubble 会卡在无法解码的旧 HTML
    if (field === "todayBoxHtml") {
      const plainTrusted =
        !movie.decodeKeepPrevious &&
        Number(movie.todayBox) > 0 &&
        (movie.decodeStatus === DECODE_STATUS.OK || movie.decodeVerified === true) &&
        !isUntrustedBoxDecode(String(movie.todayBoxText || movie.todayBox));
      if (plainTrusted && isEmptyField(movie.todayBoxHtml)) {
        stable.todayBoxHtml = "";
        continue;
      }
      if (isEmptyField(stable.todayBoxHtml) && !isEmptyField(prev.todayBoxHtml)) {
        stable.todayBoxHtml = prev.todayBoxHtml;
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

  const incomingFailed =
    movie.decodeKeepPrevious === true ||
    movie.decodeStatus === DECODE_STATUS.DECODE_ERROR ||
    movie.decodeStatus === DECODE_STATUS.ENCODED;
  const currentRoundTrusted =
    !movie.decodeKeepPrevious &&
    Number(movie.todayBox) > 0 &&
    movie.decodeStatus !== DECODE_STATUS.DECODE_ERROR &&
    movie.decodeStatus !== DECODE_STATUS.ENCODED &&
    !isUntrustedBoxDecode(String(movie.todayBoxText || movie.todayBox));

  let decodedThisRound = false;
  if (stable.todayBox <= 0 && stable.todayBoxHtml) {
    const decoded = safeDecodeBox(
      stable.todayBoxHtml,
      stable.todayUnit,
      stable.fontContentKey || stable.fontMappingVersion || "",
    );
    if (decoded > 0) {
      stable.todayBox = decoded;
      decodedThisRound = true;
      if (isEmptyField(stable.todayBoxText) || stable.todayBoxText === "--") {
        stable.todayBoxText = String(decoded);
      }
    }
  }

  // 本轮无可信 fresh 时，恢复上一轮自洽显示快照（不污染 bubble fresh）
  if (!currentRoundTrusted && !decodedThisRound && prevBoxTrusted) {
    const textNow = String(stable.todayBoxText || "").trim();
    const textBad =
      !textNow ||
      textNow === "--" ||
      isUntrustedBoxDecode(textNow) ||
      incomingFailed ||
      !(Number(stable.todayBox) > 0);
    if (textBad || !(Number(stable.todayBox) > 0)) {
      stable.todayBox = prev.todayBox;
      stable.todayBoxText = prev.todayBoxText || String(prev.todayBox);
      stable.todayUnit = stable.todayUnit || prev.todayUnit || "万";
      stable.decodeKeepPrevious = true;
      stable.decodeStatusCurrent = movie.decodeStatus || stable.decodeStatus || "";
      // 保留本轮失败 decodeStatus 供日志；显示走 decodeKeepPrevious
    }
  }

  // 仅本轮真正解出可信值时标记 OK；keep-previous 不得伪装成 fresh OK
  if (
    !stable.decodeKeepPrevious &&
    (currentRoundTrusted || decodedThisRound) &&
    stable.todayBox > 0 &&
    !isEmptyField(stable.todayBoxText) &&
    !isUntrustedBoxDecode(String(stable.todayBoxText))
  ) {
    stable.decodeStatus = DECODE_STATUS.OK;
  }

  const newTodayBox = Number(stable.todayBox) || 0;
  const kept =
    oldTodayBox > 0 &&
    newTodayBox === oldTodayBox &&
    (stable.decodeKeepPrevious === true ||
      movie.decodeKeepPrevious === true ||
      !(Number(movie.todayBox) > 0) ||
      String(movie.todayBoxText || "").trim() === "--");
  logMovieBoxMerge({
    movieId: stable.movieId,
    title: stable.name,
    oldTodayBox,
    newTodayBox: Number(movie.todayBox) > 0 ? Number(movie.todayBox) : null,
    decodeStatus: movie.decodeStatus || stable.decodeStatus || "",
    decodeKeepPrevious: Boolean(stable.decodeKeepPrevious),
    fontMappingVersion: stable.fontContentKey || stable.fontMappingVersion || "",
    mergeResult: kept
      ? "keep-old"
      : newTodayBox > 0 && newTodayBox !== oldTodayBox
        ? "replace"
        : newTodayBox > 0
          ? "replace"
          : oldTodayBox > 0
            ? "keep-old"
            : "empty",
  });

  updateMovieCache(key, stable);
  return stable;
}

function isBoxMergeTraceEnabled() {
  if (typeof process !== "undefined" && process?.env?.BOX_MERGE_TRACE === "1") return true;
  try {
    return new URLSearchParams(location.search).has("boxMergeTrace");
  } catch {
    return false;
  }
}

function logMovieBoxMerge(payload) {
  if (!isBoxMergeTraceEnabled()) return;
  console.log("[BOX_MERGE]", payload);
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

function shouldPreferEncodedNation(nation) {
  if (!nation?.todayBoxHtml) return false;
  if ((Number(nation.todayBox) || 0) > 0) return false;
  if (lastGoodNation.todayBox > 0) return false;
  const businessDate = latestParsedMeta?.calendar?.today || lastGoodCacheDay;
  const cached = readDisplayCache(displayCacheKey("nation", "all", businessDate));
  if (cached?.plainAmount > 0) return false;
  const fontKey = nation.fontContentKey || nation.fontMappingVersion || getFontMappingVersion();
  if (!isExactFontVisualReady(fontKey) && !isMaoyanFontReady(fontKey)) return false;
  return isEncodedBoxHtml(nation.todayBoxHtml);
}

function stabilizeNation(nation) {
  const stable = { ...nation };
  const decodeLocked =
    stable.decodeStatus === DECODE_STATUS.ENCODED || stable.decodeStatus === DECODE_STATUS.DECODE_ERROR;
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
    !decodeLocked &&
    stable.todayBox <= 0 &&
    lastGoodNation.todayBox > 0 &&
    !isUntrustedBoxDecode(String(lastGoodNation.todayBoxText || lastGoodNation.todayBox))
  ) {
    stable.todayBox = lastGoodNation.todayBox;
    if (isEmptyField(stable.todayBoxText) && !isEmptyField(lastGoodNation.todayBoxText)) {
      stable.todayBoxText = lastGoodNation.todayBoxText;
    }
  }
  if (decodeLocked && stable.todayBox <= 0) {
    const cachedBox = lastGoodNation.todayBox;
    const cachedText = String(lastGoodNation.todayBoxText || "").trim();
    if (
      cachedBox > 0 &&
      cachedText &&
      cachedText !== "--" &&
      !isUntrustedBoxDecode(cachedText)
    ) {
      stable.todayBox = cachedBox;
      if (isEmptyField(stable.todayBoxText)) stable.todayBoxText = cachedText;
    } else if (isEmptyField(stable.todayBoxText)) {
      stable.todayBoxText = "--";
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
  // 显示层：keep-previous 必须返回已恢复的可信值
  if (movie?.decodeKeepPrevious === true) {
    const kept = Number(movie.todayBox) || 0;
    if (kept > 0 && !isUntrustedBoxDecode(String(movie.todayBoxText || kept))) return kept;
  }
  if (movie.decodeVerified === true && movie.todayBox > 0) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  if (movie.todayBoxHtml && movie.decodeVerified === true) {
    const fromHtml = decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (fromHtml > 0 && !isUntrustedBoxDecode(String(fromHtml))) return fromHtml;
  }
  if (movie.todayBox > 0) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  if (!isEmptyField(movie.todayBoxText)) {
    const n = parseBoxNum(movie.todayBoxText, movie.todayUnit || "万");
    if (n > 0 && !isUntrustedBoxDecode(movie.todayBoxText)) return n;
  }
  const cached = lastGoodMovies.get(String(movie?.movieId || ""));
  if (cached?.todayBox > 0 && !isUntrustedBoxDecode(String(cached.todayBoxText || cached.todayBox))) {
    return cached.todayBox;
  }
  return 0;
}

/** 气泡专用：不用 lastGoodMovies / keep-previous / DOM 缓存，避免涨幅被粘住 */
function getMovieBoxAmountFresh(movie) {
  if (movie?.decodeKeepPrevious === true) return 0;
  if (movie?.decodeStatus === DECODE_STATUS.DECODE_ERROR) return 0;
  if (movie?.decodeStatus === DECODE_STATUS.ENCODED) return 0;
  if (movie.decodeVerified === true && movie.todayBox > 0) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  if (movie.todayBoxHtml && movie.decodeVerified === true) {
    const fromHtml = decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (fromHtml > 0 && !isUntrustedBoxDecode(String(fromHtml))) return fromHtml;
  }
  if (movie.todayBox > 0) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  if (!isEmptyField(movie.todayBoxText)) {
    const n = parseBoxNum(movie.todayBoxText, movie.todayUnit || "万");
    if (n > 0 && !isUntrustedBoxDecode(movie.todayBoxText)) return n;
  }
  return 0;
}

/** 每轮从最新 HTML/字段解码，禁止回落到 stabilize / DOM 显示缓存 */
function resolveFreshBubbleAmount(record, options = {}) {
  const unit = sanitizeBoxUnit(record?.todayUnit || "万");
  const contentKey =
    options.contentKey ||
    record?.fontContentKey ||
    record?.fontMappingVersion ||
    getFontMappingVersion();
  const html = String(record?.todayBoxHtml || "").trim();

  if (html) {
    const loose = bubbleDecodeBoxWan(html, unit, contentKey);
    return loose > 0 ? loose : 0;
  }

  if (record?.decodeKeepPrevious === true) return 0;
  return getMovieBoxAmountFresh(record);
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
  return movie.mainlandBox || "";
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

function buildSummaryMetricValueHtml(def, movie, previousHtml = "", options = {}) {
  const prevText = String(previousHtml || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const prevLooksPlain =
    Boolean(previousHtml) &&
    prevText &&
    prevText !== "--" &&
    !String(previousHtml).includes("metric__box-encoded");
  const businessDate = latestParsedMeta?.calendar?.today || lastGoodCacheDay;
  const cacheKey = displayCacheKey("movie-box", movie.movieId, businessDate);
  const fontKey = resolveRecordFontKey(movie);

  // 仅在本轮精确字体未就绪的空窗期暂存票房 DOM，避免闪空
  if (def.key === "dailyBox" && options.holdBoxes && !isExactFontVisualReady(fontKey)) {
    const held = stickyBoxMetricHtml(previousHtml, cacheKey);
    if (held) return held;
  }

  if (def.key === "dailyBox" && shouldPreferEncodedBox(movie)) {
    if (prevLooksPlain && options.holdBoxes && !isExactFontVisualReady(fontKey)) return previousHtml;
    const cached = readDisplayCache(cacheKey);
    if (cached?.plainHtml && cached.fontVersion === (movie.fontMappingVersion || getFontMappingVersion())) {
      return `<span class="metric__cache"${cacheTitleAttr(cached)}>${cached.plainHtml}</span>`;
    }
    if (movie.todayBoxHtml && isExactFontVisualReady(fontKey)) {
      const encoded = buildEncodedBoxHtml(
        movie.todayBoxHtml,
        movie.fontMappingVersion,
        resolveDisplayBoxUnit(movie, getMovieBoxAmount(movie)),
      );
      writeDisplayCache(cacheKey, {
        encodedHtml: encoded,
        fontVersion: movie.fontMappingVersion || getFontMappingVersion(),
        source: "encoded",
      });
      return encoded;
    }
    if (cached?.encodedHtml) {
      return wrapEncodedBoxMetricHtml(
        `<span class="metric__cache"${cacheTitleAttr(cached)}>${cached.encodedHtml}</span>`,
        resolveDisplayBoxUnit(movie, getMovieBoxAmount(movie)),
      );
    }
    if (cached?.plainHtml) {
      return `<span class="metric__cache"${cacheTitleAttr(cached)}>${cached.plainHtml}</span>`;
    }
    const held = stickyBoxMetricHtml(previousHtml, cacheKey);
    if (held) return held;
    // 禁止 decode/字体空窗把已显示的有效票房刷成 "--"
    if (displayHtmlLooksLikeBox(previousHtml)) return previousHtml;
    return "--";
  }
  const raw = resolveMetricRaw(def, movie);
  const trend = def.trend && !isEmptyField(raw) ? trendArrow(def.trend(movie)) : "";
  if (isEmptyField(raw)) {
    const held = stickyBoxMetricHtml(previousHtml, cacheKey);
    if (held) return held;
    if (displayHtmlLooksLikeBox(previousHtml)) return previousHtml;
    return "--";
  }
  const value = String(raw);
  const html = `${escapeHtml(value)}${trend}`;
  if (def.key === "dailyBox" && !shouldPreferEncodedBox(movie)) {
    writeDisplayCache(cacheKey, {
      plainHtml: html,
      fontVersion: movie.fontMappingVersion || getFontMappingVersion(),
      source: "plain",
    });
  }
  return html;
}

function updateSummaryInPlace(summaryWrap, movie, options = {}) {
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
      const nextHtml = buildSummaryMetricValueHtml(
        defs[i],
        movie,
        valueEl?.innerHTML || "",
        options,
      );
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

  return labels.map((label, i) => {
    const prev = byLabel.get(label) || src[i] || {};
    return {
      label,
      box: !isEmptyField(prev.box) && prev.box !== "--" ? prev.box : "--",
      boxHtml: prev.boxHtml || "",
      boxUnit: prev.boxUnit || movie.todayUnit || "万",
      forecast: !isEmptyField(prev.forecast) && prev.forecast !== "--" ? prev.forecast : "--",
      boxRate: !isEmptyField(prev.boxRate) && prev.boxRate !== "--" ? prev.boxRate : "--",
      showCountRate:
        !isEmptyField(prev.showCountRate) && prev.showCountRate !== "--" ? prev.showCountRate : "--",
      avgSeatView:
        !isEmptyField(prev.avgSeatView) && prev.avgSeatView !== "--" ? prev.avgSeatView : "--",
    };
  });
}

const DAILY_TABLE_LABELS = ["今日", "明日", "后天"];

const DAILY_TABLE_COLUMNS = [
  {
    key: "box",
    label: "票房",
    render: (row) => {
      if (!isEmptyField(row.box) && row.box !== "--") {
        return `<span class="num--hot">${escapeHtml(row.box)}</span>`;
      }
      if (row.boxHtml) {
        return `<span class="num--hot">--</span>`;
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
  if (!isEmptyField(movie.todayBoxText)) {
    return formatBoxTextForDisplay(movie.todayBoxText, movie.todayUnit || "万", parseBoxNum) || "--";
  }
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

function applyCardEncodedBoxes(card, movie, options = {}) {
  if (!card || !movie) return;
  const summaryWrap = card.querySelector(".race-card__summary-wrap");
  if (summaryWrap) updateSummaryInPlace(summaryWrap, movie, options);

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

  const storedBaseline =
    Number.isFinite(stored) && stored > 0 ? stored : storedHtml ? safeDecodeBox(storedHtml, unit) : 0;

  const delta = decoded - storedBaseline;
  if (!isReasonableBoxDelta(storedBaseline, decoded, delta)) return 0;
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

  const key = `movie-${movie.movieId}`;
  const businessDate = latestParsedMeta?.calendar?.today || lastGoodCacheDay;
  const prevSample = bubbleSamples.get(key);
  if (prevSample && prevSample.el !== bubbleEl) {
    prevSample.el = bubbleEl;
  }

  const resolved = resolveBubbleAmountWithHtmlDelta(movie, {
    card,
    isNew,
    bubbleKey: key,
    trackKey: String(movie.movieId),
  });
  const { amount, previousAmount, htmlSig, contentKey } = resolved;
  if (prevSample && htmlSig) {
    prevSample.lastBoxHtml = htmlSig;
  }

  if (amount > 0) {
    observeBubble(key, bubbleEl, amount, {
      movie,
      businessDate,
      movieId: movie.movieId,
      trusted: true,
      decodeVerified: true,
      decodeStatus: movie.decodeStatus,
      contentKey,
      responseId: latestParsedMeta?.responseId || 0,
      previousAmount,
    });
    rememberBubbleBoxAmount(movie, amount);
  } else if (prevSample && !prevSample.idleOnly) {
    prevSample.el = bubbleEl;
    ensureBubbleTimer();
  } else if (hasVisibleDailyBox(card)) {
    bindBubbleAnchor(key, bubbleEl);
    const anchor = bubbleSamples.get(key);
    if (anchor && htmlSig) anchor.lastBoxHtml = htmlSig;
    scheduleBubbleAmountRetry(card, movie, bubbleEl, key, contentKey);
  }
}

function trackBoxDelta(_card, movie) {
  const key = String(movie.movieId);
  const contentKey = movie.fontContentKey || movie.fontMappingVersion || getFontMappingVersion();
  const decoded = resolveFreshBubbleAmount(movie, { contentKey }) || getMovieBoxAmount(movie);
  // 高水位：低于上次的读数抛弃，不跟随下行
  const prev = Number(prevValues.get(key)) || 0;
  if ((decoded > 0 || isTrustedMovieBoxAmount(movie)) && decoded > prev) {
    prevValues.set(key, decoded);
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

function updateRaceCard(card, movie, isNew = false, options = {}) {
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
    const inPlace = updateSummaryInPlace(summaryWrap, movie, options);
    if (inPlace === null) {
      if (options.holdBoxes) {
        const dailyMetric = summaryWrap.querySelector('[data-metric="dailyBox"] .metric__value');
        const heldDaily = dailyMetric?.innerHTML || "";
        summaryWrap.innerHTML = buildSummaryHtml(movie);
        if (heldDaily && displayHtmlLooksLikeBox(heldDaily)) {
          const nextDaily = summaryWrap.querySelector('[data-metric="dailyBox"] .metric__value');
          if (nextDaily) nextDaily.innerHTML = heldDaily;
        }
      } else {
        summaryWrap.innerHTML = buildSummaryHtml(movie);
      }
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

function ensureRaceCard(movie, options = {}) {
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
  updateRaceCard(card, movie, isFirstSeen(key), options);
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

function renderList(movies, options = {}) {
  if (!raceListEl) return;

  const list = (movies || [])
    .map((movie) => stabilizeMovie(movie))
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, getDisplayMovieCount());
  const activeIds = new Set(list.map((m) => String(m.movieId)));

  raceListEl.querySelectorAll(".race-card--skeleton").forEach((el) => el.remove());

  for (const [id, card] of cardPool) {
    if (!activeIds.has(id)) {
      card.remove();
      bubbleSamples.delete(`movie-${id}`);
      clearTimeout(inlineDeltaTimers.get(`movie-${id}`));
      inlineDeltaTimers.delete(`movie-${id}`);
      purgeMovieState(id);
    }
  }

  const cards = list.map((movie) => {
    traceMovieRender(movie);
    const card = ensureRaceCard(movie, options);
    prevRankMap.set(String(movie.movieId), movie.rank);
    return card;
  });

  if (cards.length) {
    syncRaceListChildren(cards);
    // 不再每次轮询全表 refit：字号抖动是界面闪烁主因；结构变化时 updateRaceCard 会局部 fit
  }

  updateChampion(list, latestParsedMeta?.calendar?.today || lastGoodCacheDay, options);
}

function syncRaceListChildren(cards) {
  if (!raceListEl) return;
  const existing = [...raceListEl.children];
  if (existing.length === cards.length && existing.every((node, idx) => node === cards[idx])) {
    return;
  }
  raceListEl.replaceChildren(...cards);
}

function setPlainBoxValue(el, amount, unitEl, options = {}) {
  if (!el) return;
  const hold = options.hold !== false;
  const { valueText, unit } = formatWanForDisplay(amount);
  const safeUnit = sanitizeBoxUnit(unit || options.unit || "万");
  if (hold && (!Number.isFinite(amount) || amount <= 0 || valueText === "--")) {
    if (elementHasVisibleBox(el)) {
      if (unitEl && !/[万亿]/.test(String(unitEl.textContent || ""))) {
        unitEl.textContent = safeUnit;
      }
      return;
    }
  }
  el.classList.remove("mtsi-font", "mtsi-font-encoded");
  el.style.fontFamily = "";
  delete el.dataset.fontVersion;
  if (el.textContent !== valueText) el.textContent = valueText;
  if (unitEl && unitEl.textContent !== safeUnit) unitEl.textContent = safeUnit;
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

function resolveDisplayBoxAmount(html, unit, numeric, text, contentKey = "") {
  if (Number.isFinite(numeric) && numeric > 0 && !isUntrustedBoxDecode(String(text || numeric))) {
    return numeric;
  }
  const fontKey = String(contentKey || "").trim();
  if (html && fontKey) {
    const raw = decodeFontNum(html, fontKey);
    if (raw && !isUntrustedBoxDecode(raw)) {
      const fromKey = parseBoxNum(raw, unit || "万");
      if (fromKey > 0 && !isUntrustedBoxDecode(String(fromKey))) return fromKey;
    }
  }
  const fromHtml = safeDecodeBox(html, unit, fontKey);
  if (fromHtml > 0) return fromHtml;
  if (!isEmptyField(text) && !isUntrustedBoxDecode(text)) {
    const n = parseBoxNum(text, unit || "万");
    if (n > 0 && !isUntrustedBoxDecode(String(n))) return n;
  }
  return 0;
}

function resolveBubbleTrackingAmount(record, options = {}) {
  return resolveFreshBubbleAmount(record, options);
}

function setEncodedBoxValue(el, html, options = {}) {
  if (!el) return;
  const fallbackText = options.fallbackText ?? "--";
  const unitEl = options.unitEl;
  const unit = sanitizeBoxUnit(options.unit || "万");
  const fontVersion = options.fontVersion || getFontMappingVersion();
  const family = fontFamilyForVersion(fontVersion || getActiveFontFamily());
  const raw = html == null ? "" : String(html);
  if (raw && /登录猫眼|专业版即可|剩余城市|商排|请先登录|开通专业版/.test(raw.replace(/<[^>]+>/g, ""))) {
    if (el.textContent === fallbackText) return;
    el.classList.remove("mtsi-font", "mtsi-font-encoded");
    el.style.fontFamily = "";
    delete el.dataset.fontVersion;
    el.textContent = fallbackText;
    if (unitEl) setTextIfChanged(unitEl, unit);
    return;
  }
  if (raw) {
    const normalizedVer = normalizeDisplayFontVersion(fontVersion);
    if (
      el.innerHTML === raw &&
      normalizeDisplayFontVersion(el.dataset.fontVersion) === normalizedVer
    ) {
      if (unitEl) setTextIfChanged(unitEl, unit);
      return;
    }
    el.classList.remove("mtsi-font");
    el.classList.add("mtsi-font-encoded");
    el.dataset.fontVersion = fontVersion || "";
    el.style.fontFamily = `"${family}", var(--font-sans)`;
    el.innerHTML = raw;
    if (unitEl) setTextIfChanged(unitEl, unit);
    return;
  }
  if (elementHasVisibleBox(el)) {
    if (unitEl && !/[万亿]/.test(String(unitEl.textContent || ""))) setTextIfChanged(unitEl, unit);
    return;
  }
  if (el.textContent === fallbackText) {
    if (unitEl) setTextIfChanged(unitEl, unit);
    return;
  }
  el.classList.remove("mtsi-font", "mtsi-font-encoded");
  el.style.fontFamily = "";
  delete el.dataset.fontVersion;
  el.textContent = fallbackText;
  if (unitEl) setTextIfChanged(unitEl, unit);
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

function isBoxPipelineTraceEnabled() {
  if (typeof process !== "undefined" && process?.env?.BOX_PIPELINE_TRACE === "1") return true;
  try {
    return new URLSearchParams(location.search).has("boxPipelineTrace");
  } catch {
    return false;
  }
}

function logBoxPipeline(payload) {
  if (!isBoxPipelineTraceEnabled()) return;
  console.log("[BOX_PIPELINE]", payload);
}

function updateChampion(movies, businessDate, options = {}) {
  const top = (movies || []).find((m) => m.rank === 1) || movies?.[0];
  if (!top) {
    champBoxPillEl?.classList.add("is-hidden");
    return;
  }

  const cacheKey = championCacheKey(top, businessDate);
  const sessionMeta = options.sessionMeta || latestParsedMeta || {};
  const championHasFreshBox = canPaintCurrentBox(top, sessionMeta);
  const displayAmount = getMovieBoxAmount(top);
  if (
    options.holdBoxes &&
    !championHasFreshBox &&
    elementHasVisibleBox(champBoxEl)
  ) {
    champBoxPillEl?.classList.remove("is-hidden");
    logBoxPipeline({
      stage: "render",
      championPaintDecision: "hold-visible",
      movieId: top.movieId,
      title: top.name,
      freshTodayBox: null,
      displayTodayBox: displayAmount,
      exactVisualReady: isExactFontVisualReady(resolveRecordFontKey(top, sessionMeta)),
      decodeKeepPrevious: Boolean(top.decodeKeepPrevious),
      decodeStatus: top.decodeStatus || "",
    });
    return;
  }

  const cacheEntry = readDisplayCache(displayCacheKey("champion", top.movieId, businessDate));
  const preferEncoded = shouldPreferEncodedBox(top);
  const amount = preferEncoded ? 0 : resolveChampionBoxWan(top) || displayAmount;
  const fontVersion = top.fontMappingVersion || getFontMappingVersion();
  const unit = sanitizeBoxUnit(top.todayUnit || "万");
  let paintDecision = "none";

  if (preferEncoded && top.todayBoxHtml && championHasFreshBox) {
    champBoxPillEl?.classList.remove("is-hidden");
    setEncodedBoxValue(champBoxEl, top.todayBoxHtml, {
      unitEl: champBoxUnitEl,
      unit,
      fontVersion,
    });
    lastChampionKey = cacheKey;
    lastChampionFontVersion = fontVersion;
    writeDisplayCache(displayCacheKey("champion", top.movieId, businessDate), {
      encodedHtml: top.todayBoxHtml,
      fontVersion,
      unit,
      source: "encoded",
    });
    paintDecision = "encoded-fresh";
  } else if (amount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, amount, champBoxUnitEl);
    lastChampionKey = cacheKey;
    lastChampionAmount = amount;
    lastChampionUnit = unit;
    lastChampionFontVersion = fontVersion;
    writeDisplayCache(displayCacheKey("champion", top.movieId, businessDate), {
      plainAmount: amount,
      unit,
      fontVersion,
      source: "plain",
    });
    paintDecision = championHasFreshBox ? "plain-fresh" : "plain-display";
  } else if (cacheKey === lastChampionKey && lastChampionAmount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, lastChampionAmount, champBoxUnitEl);
    if (champBoxUnitEl) setTextIfChanged(champBoxUnitEl, lastChampionUnit || unit);
    paintDecision = "last-champion-amount";
  } else if (cacheEntry?.plainAmount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, cacheEntry.plainAmount, champBoxUnitEl);
    if (champBoxUnitEl) setTextIfChanged(champBoxUnitEl, cacheEntry.unit || unit);
    paintDecision = "display-cache-plain";
  } else if (
    cacheEntry?.encodedHtml &&
    isExactFontVisualReady(cacheEntry.fontVersion || resolveRecordFontKey(top, sessionMeta))
  ) {
    champBoxPillEl?.classList.remove("is-hidden");
    setEncodedBoxValue(champBoxEl, cacheEntry.encodedHtml, {
      unitEl: champBoxUnitEl,
      unit: cacheEntry.unit || unit,
      fontVersion: cacheEntry.fontVersion || fontVersion,
    });
    paintDecision = "display-cache-encoded";
  } else if (elementHasVisibleBox(champBoxEl)) {
    champBoxPillEl?.classList.remove("is-hidden");
    paintDecision = "keep-dom";
  } else if (cacheKey !== lastChampionKey && !hasDisplayedData) {
    setPlainBoxValue(champBoxEl, null, champBoxUnitEl, { hold: false });
    paintDecision = "first-empty";
  }

  logBoxPipeline({
    stage: "render",
    championPaintDecision: paintDecision,
    movieId: top.movieId,
    title: top.name,
    fontUrlKey: sessionMeta.fontUrlKey || "",
    fontContentKey: resolveRecordFontKey(top, sessionMeta),
    exactVisualReady: isExactFontVisualReady(resolveRecordFontKey(top, sessionMeta)),
    freshTodayBox: championHasFreshBox ? amount || displayAmount : null,
    displayTodayBox: amount || displayAmount || lastChampionAmount || 0,
    lastGoodTodayBox: lastGoodMovies.get(String(top.movieId))?.todayBox || 0,
    decodeStatus: top.decodeStatus || "",
    decodeKeepPrevious: Boolean(top.decodeKeepPrevious),
  });
}

function updateNation(nation, parsed, options = {}) {
  nation = stabilizeNation(nation);
  const unitEl = document.querySelector(".js-nation-unit");
  const unit = sanitizeBoxUnit(nation.todayUnit || "万");
  const businessDate = parsed?.calendar?.today || lastGoodCacheDay;
  const nationContentKey =
    nation.fontContentKey ||
    nation.fontMappingVersion ||
    parsed?.fontContentKey ||
    parsed?.fontUrlKey ||
    "";
  const nationCacheKey = displayCacheKey("nation", "all", businessDate);
  const nationAmount = resolveDisplayBoxAmount(
    nation.todayBoxHtml,
    unit,
    nation.todayBox,
    nation.todayBoxText,
    nationContentKey,
  );
  const fontVersion = nation.fontMappingVersion || getFontMappingVersion();
  const cachedNation = readDisplayCache(nationCacheKey);

  const nationHasFreshBox = canPaintCurrentBox(
    {
      ...nation,
      fontContentKey: nationContentKey,
      fontMappingVersion: nation.fontMappingVersion || nationContentKey,
    },
    parsed || {},
  );
  const skipBoxPaint =
    options.holdBoxes && !nationHasFreshBox && elementHasVisibleBox(nationBoxEl);
  if (!skipBoxPaint) {
    const preferEncoded = shouldPreferEncodedNation(nation);
    if (preferEncoded && nation.todayBoxHtml && nationHasFreshBox) {
      setEncodedBoxValue(nationBoxEl, nation.todayBoxHtml, { unitEl, unit, fontVersion });
      writeDisplayCache(nationCacheKey, {
        encodedHtml: nation.todayBoxHtml,
        fontVersion,
        unit,
        source: "encoded",
      });
    } else if (nationAmount > 0 && !preferEncoded) {
      setPlainBoxValue(nationBoxEl, nationAmount, unitEl);
      writeDisplayCache(nationCacheKey, {
        plainAmount: nationAmount,
        fontVersion,
        unit,
        source: "plain",
      });
    } else if (cachedNation?.plainAmount > 0) {
      setPlainBoxValue(nationBoxEl, cachedNation.plainAmount, unitEl);
      if (unitEl) setTextIfChanged(unitEl, cachedNation.unit || unit);
    } else if (
      cachedNation?.encodedHtml &&
      isExactFontVisualReady(cachedNation.fontVersion || nationContentKey)
    ) {
      setEncodedBoxValue(nationBoxEl, cachedNation.encodedHtml, {
        unitEl,
        unit: cachedNation.unit || unit,
        fontVersion: cachedNation.fontVersion || fontVersion,
      });
    } else if (lastGoodNation.todayBox > 0) {
      setPlainBoxValue(nationBoxEl, lastGoodNation.todayBox, unitEl);
    } else if (elementHasVisibleBox(nationBoxEl)) {
      /* 保留当前 DOM，避免解码间歇闪空 */
    } else if (!(prevValues.get("__nation__") > 0) && !preferEncoded && !hasDisplayedData) {
      setPlainBoxValue(nationBoxEl, null, unitEl, { hold: false });
    }
  }

  const refreshedNation = refreshNationBoxFields(nation, {
    fontContentKey: nationContentKey,
    fontMappingVersion: nationContentKey,
    movies: latestMovies,
  });
  const nationResolved = resolveBubbleAmountWithHtmlDelta(nation, {
    contentKey: nationContentKey,
    trackKey: "__nation__",
    bubbleKey: "__nation__",
  });
  const liveNationAmount = nationResolved.amount;
  if (liveNationAmount > 0) {
    if (nationResolved.htmlSig) {
      const nationSample = bubbleSamples.get("__nation__");
      if (nationSample) nationSample.lastBoxHtml = nationResolved.htmlSig;
    }
    observeBubble("__nation__", nationDeltaEl, liveNationAmount, {
      nation: refreshedNation,
      businessDate,
      trusted: true,
      decodeVerified: true,
      contentKey: nationContentKey,
      responseId: parsed?.responseId || 0,
      previousAmount: nationResolved.previousAmount,
    });
    // 必须在 observeBubble 之后提交高水位，否则 previousAmount 会被当前值覆盖，
    // 大盘每轮都会算成 0 涨幅。
    const prevNation = Number(prevValues.get("__nation__")) || 0;
    if (liveNationAmount > prevNation) prevValues.set("__nation__", liveNationAmount);
    if (nationResolved.htmlSig) prevBoxHtml.set("__nation__", nationResolved.htmlSig);
  } else if (bubbleSamples.get("__nation__") && !bubbleSamples.get("__nation__").idleOnly) {
    bubbleSamples.get("__nation__").el = nationDeltaEl;
    ensureBubbleTimer();
  } else if (nationDeltaEl && elementHasVisibleBox(nationBoxEl)) {
    bindBubbleAnchor("__nation__", nationDeltaEl);
    const retryNation = () => {
      if (!nationDeltaEl?.isConnected) return;
      const resolved = resolveBubbleAmountWithHtmlDelta(nation, {
        contentKey: nationContentKey,
        trackKey: "__nation__",
        bubbleKey: "__nation__",
      });
      if (resolved.amount > 0) {
        observeBubble("__nation__", nationDeltaEl, resolved.amount, {
          nation: refreshedNation,
          businessDate,
          trusted: true,
          decodeVerified: true,
          contentKey: nationContentKey,
          responseId: parsed?.responseId || 0,
          previousAmount: resolved.previousAmount,
        });
        const prevNation = Number(prevValues.get("__nation__")) || 0;
        if (resolved.amount > prevNation) prevValues.set("__nation__", resolved.amount);
        if (resolved.htmlSig) prevBoxHtml.set("__nation__", resolved.htmlSig);
      }
    };
    requestAnimationFrame(retryNation);
    setTimeout(retryNation, 500);
    setTimeout(retryNation, 2000);
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
      await updatePartialDataWarning(errors);
      setStatus("ok", "");
      if (shouldMarkFullEnrichFailure(errors, getDisplayMovieCount())) {
        markFullEnrichFailure(enrichSchedule, Date.now());
      } else {
        markFullEnrichSuccess(enrichSchedule, Date.now());
        markStartup("enrichComplete");
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

function scheduleDecodeRetry(requestPollGen, requestFontVer, requestBusinessDate) {
  setTimeout(() => {
    if (requestPollGen !== pollGeneration) return;
    if (
      requestFontVer &&
      normalizeFontIdentity(requestFontVer) !== normalizeFontIdentity(getFontMappingVersion())
    ) {
      return;
    }
    if (requestBusinessDate && requestBusinessDate !== lastGoodCacheDay) return;

    const fontVer = getFontMappingVersion();
    if (latestNation) {
      latestNation = refreshNationBoxFields(latestNation, {
        fontMappingVersion: fontVer,
        movies: latestMovies,
      });
      if (latestNation.todayBox > 0 || latestNation.todayBoxHtml) {
        updateNation(latestNation, latestParsedMeta || {});
      }
    }

    if (!latestMovies.length) return;
    const needsRetry = latestMovies.some(
      (m) => m.todayBoxHtml && getMovieBoxAmount(stabilizeMovie(m)) <= 0,
    );
    if (!needsRetry) {
      updateChampion(
        latestMovies.map(stabilizeMovie),
        latestParsedMeta?.calendar?.today || lastGoodCacheDay,
      );
      return;
    }
    const refreshOpts = (movie) => buildMovieBoxRefreshOptions(movie, latestNation);
    const refreshed = rerankMoviesByTodayBox(
      latestMovies.map((movie) => refreshMovieBoxFields(movie, refreshOpts(movie))),
    );
    latestMovies = refreshed;
    const movies = enrichMoviesQuick(refreshed, latestSpeedMap).map(stabilizeMovie);
    syncHeroAndMovieBoxes(movies);
  }, 800);
}

function buildMoviesForRender(parsed, fontContentKey) {
  const decodeOpts = {
    fontContentKey,
    fontMappingVersion: fontContentKey,
    movies: parsed.movies,
  };
  latestNation = parsed.nation
    ? refreshNationBoxFields(parsed.nation, decodeOpts)
    : parsed.nation;
  const refreshOpts = (movie) => ({
    ...buildMovieBoxRefreshOptions(movie, latestNation),
    fontContentKey,
    fontMappingVersion: fontContentKey,
  });
  latestMovies = rerankMoviesByTodayBox(
    parsed.movies.map((movie) => refreshMovieBoxFields(movie, refreshOpts(movie))),
  );
  latestParsedMeta = parsed;
  const speed = buildSpeedMap(latestMovies);
  latestSpeedMap = speed;
  return enrichMoviesQuick(latestMovies, speed).map(stabilizeMovie);
}

function paintStructuralDashboard(parsed, raw, requestGen, sessionMeta = {}) {
  if (!parsed?.movies?.length) return false;
  resetLastGoodIfDayChanged(parsed.calendar?.today);
  traceDashboardData(parsed, raw, { enabled: isDataTraceEnabled() });
  resetBubbleBaselineOnFontChange(parsed.fontUrlKey || parsed.fontContentKey);
  const fontKey =
    sessionMeta.fontContentKey ||
    sessionMeta.fontUrlKey ||
    parsed.fontContentKey ||
    parsed.fontUrlKey ||
    "";
  latestParsedMeta = {
    ...parsed,
    fontContentKey: parsed.fontContentKey || sessionMeta.fontContentKey || "",
    fontUrlKey: parsed.fontUrlKey || sessionMeta.fontUrlKey || "",
    responseId: sessionMeta.responseId || parsed.responseId || 0,
  };
  latestMovies = parsed.movies.map((movie) =>
    stabilizeMovie({
      ...movie,
      fontContentKey: movie.fontContentKey || fontKey,
      fontMappingVersion: movie.fontMappingVersion || fontKey,
      fontUrlKey: movie.fontUrlKey || sessionMeta.fontUrlKey || parsed.fontUrlKey || "",
    }),
  );
  latestNation = parsed.nation
    ? stabilizeNation({
        ...parsed.nation,
        fontContentKey: parsed.nation.fontContentKey || fontKey,
        fontMappingVersion: parsed.nation.fontMappingVersion || fontKey,
      })
    : parsed.nation;
  const speed = buildSpeedMap(latestMovies);
  latestSpeedMap = speed;
  const movies = enrichMoviesQuick(latestMovies, speed).map(stabilizeMovie);
  const anyCurrentPaintable = movies.some((m) => canPaintCurrentBox(m, latestParsedMeta));
  // 已有显示数据时：本轮精确字体/票房未确认可画 → 一律 hold，禁止因全局旧字体 ready 放开
  const holdBoxes = hasDisplayedData && !anyCurrentPaintable;
  const boxOpts = {
    holdBoxes,
    sessionMeta: latestParsedMeta,
  };
  logBoxPipeline({
    stage: "structural",
    responseId: latestParsedMeta.responseId || 0,
    fontUrlKey: latestParsedMeta.fontUrlKey || "",
    fontContentKey: fontKey,
    publishedContentKey: "",
    exactVisualReady: isExactFontVisualReady(fontKey),
    mapReady: false,
    holdBoxes,
    anyCurrentPaintable,
    movies: movies.slice(0, 3).map((m) => ({
      movieId: m.movieId,
      title: m.name,
      freshTodayBox: canPaintCurrentBox(m, latestParsedMeta) ? m.todayBox : null,
      displayTodayBox: getMovieBoxAmount(m),
      lastGoodTodayBox: lastGoodMovies.get(String(m.movieId))?.todayBox || 0,
      decodeStatus: m.decodeStatus || "",
      decodeKeepPrevious: Boolean(m.decodeKeepPrevious),
    })),
  });
  renderList(movies, boxOpts);
  updateNation(latestNation, latestParsedMeta, boxOpts);
  updateChampion(movies, parsed.calendar?.today || lastGoodCacheDay, boxOpts);
  hasDisplayedData = true;
  document.body.classList.add("is-ready");
  setStatus("ok", "");
  if (!firstDashboardPainted) firstDashboardPainted = true;
  markStartup("firstRealFields");
  return true;
}

function paintDecodedDashboard(parsed, raw, requestGen, fontContentKey) {
  if (!parsed?.movies?.length || requestGen !== pollGeneration) return false;
  resetBubbleBaselineOnFontChange(fontContentKey);
  const movies = buildMoviesForRender(parsed, fontContentKey);
  logBoxPipeline({
    stage: "decoded",
    responseId: parsed.responseId || latestParsedMeta?.responseId || 0,
    fontContentKey: fontContentKey || "",
    exactVisualReady: isExactFontVisualReady(fontContentKey),
    mapReady: true,
    movies: movies.slice(0, 3).map((m) => ({
      movieId: m.movieId,
      title: m.name,
      freshTodayBox: getMovieBoxAmountFresh(m),
      displayTodayBox: getMovieBoxAmount(m),
      lastGoodTodayBox: lastGoodMovies.get(String(m.movieId))?.todayBox || 0,
      decodeStatus: m.decodeStatus || "",
      decodeKeepPrevious: Boolean(m.decodeKeepPrevious),
    })),
  });
  syncHeroAndMovieBoxes(movies);
  markStartup("mappingComplete");
  if (movies.some((m) => getMovieBoxAmount(m) > 0)) {
    markStartup("firstBoxDisplay");
  }
  return true;
}

function tryPublishEncodedSession(session, requestGen) {
  if (!isSessionCurrent(session) || requestGen !== pollGeneration) return;
  const contentKey = session.fontContentKey;
  if (!contentKey || !isVisualReady(contentKey)) return;
  const pub = tryPublishDashboardSession({
    responseId: session.responseId,
    contentKey,
    businessDate: session.businessDate,
    fontStyle: session.fontStyle,
  });
  if (!pub.ok) return;
  latestParsedMeta = { ...session.parsed, fontContentKey: contentKey };
  latestNation = session.parsed.nation
    ? { ...stabilizeNation(session.parsed.nation), fontMappingVersion: contentKey }
    : latestNation;
  repaintEncodedGlyphs(requestGen);
}

function syncHeroAndMovieBoxes(movies) {
  for (const movie of movies || []) {
    const card = cardPool.get(String(movie.movieId));
    if (!card) continue;
    applyCardEncodedBoxes(card, movie);
    updateRaceCardDelta(card, movie, false);
    trackBoxDelta(card, movie);
  }
  if (latestNation) updateNation(latestNation, latestParsedMeta || {});
  updateChampion(movies, latestParsedMeta?.calendar?.today || lastGoodCacheDay);
}

function redecodeAndRepaint(requestGen) {
  if (requestGen !== pollGeneration) return;
  const fontVer = getFontMappingVersion();
  if (latestNation) {
    latestNation = refreshNationBoxFields(latestNation, {
      fontMappingVersion: fontVer,
      movies: latestMovies,
    });
  }
  if (!latestMovies.length) return;
  const refreshOpts = (movie) => buildMovieBoxRefreshOptions(movie, latestNation);
  latestMovies = rerankMoviesByTodayBox(
    latestMovies.map((movie) => refreshMovieBoxFields(movie, refreshOpts(movie))),
  );
  const movies = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
  syncHeroAndMovieBoxes(movies);
  markStartup("mappingComplete");
  if (movies.some((m) => getMovieBoxAmount(m) > 0)) {
    markStartup("firstBoxDisplay");
  }
}

function repaintEncodedGlyphs(requestGen) {
  if (requestGen !== pollGeneration) return;
  if (!latestMovies.length) return;
  const movies = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
  syncHeroAndMovieBoxes(movies);
  markStartup("firstBoxDisplay");
}

async function refreshData() {
  if (fetchInFlight) return;
  fetchInFlight = true;
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
    markStartup("dashboardReturned");

    const session = createDashboardSession(raw, displayCount);
    if (!session.parsed.movies.length) {
      if (!hasDisplayedData) setStatus("loading", "等待票房数据…");
      return;
    }

    pollGeneration += 1;
    const requestGen = pollGeneration;
    session.mapGen = ++mappingGeneration;

    paintStructuralDashboard(session.parsed, raw, requestGen, {
      fontContentKey: session.fontContentKey,
      fontUrlKey: session.fontUrlKey,
      responseId: session.responseId,
    });
    enrichAllowed = true;
    scheduleBackgroundEnrich(requestGen, session.parsed, latestSpeedMap);

    const fontStyle = session.fontStyle;
    if (fontStyle) {
      void prepareSessionFont(session)
        .then(() => {
          tryPublishEncodedSession(session, requestGen);
        })
        .catch((err) => console.warn("字体注入失败", err));

      void buildSessionPuaMap(session)
        .then(() => {
          if (!isSessionCurrent(session)) return;
          const pub = tryPublishSession(session);
          if (!pub.ok) return;
          tryPublishDashboardSession({
            responseId: session.responseId,
            contentKey: session.fontContentKey,
            businessDate: session.businessDate,
            fontStyle: session.fontStyle,
          });
          if (requestGen !== pollGeneration) return;
          const decoded = decodeSessionDashboard(session);
          paintDecodedDashboard(decoded, raw, requestGen, session.fontContentKey);
          scheduleDecodeRetry(
            requestGen,
            sessionFontIdentity(session),
            session.businessDate,
          );
        })
        .catch((err) => {
          console.warn("PUA 映射失败", err);
          if (isSessionCurrent(session) && requestGen === pollGeneration) {
            scheduleDecodeRetry(requestGen, sessionFontIdentity(session), session.businessDate);
          }
        });
    } else {
      scheduleDecodeRetry(requestGen, getFontMappingVersion(), session.businessDate);
    }

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
    fetchInFlight = false;
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshData, config.pollIntervalMs || 2000);
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
  if (loginResult?.attemptId) {
    activeLoginAttemptId = Number(loginResult.attemptId) || activeLoginAttemptId;
  }
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
          session.signatureReady ||
          (session.loginCookieReady && session.storageStateExists && session.identityCookieExists)
        ) {
          clearInterval(loginWatchTimer);
          loginWatchTimer = null;
          resolve({
            ok: true,
            attemptId: activeLoginAttemptId,
            detailApiReady: Boolean(session.detailApiReady),
            loginCookieReady: Boolean(session.loginCookieReady),
            loggedIn: true,
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

  if (
    result?.ok &&
    shouldApplyLoginResult(result) &&
    (result?.detailApiReady || result?.loggedIn || result?.loginCookieReady)
  ) {
    await finishLoginSuccess(result);
    return;
  }
  if (result?.ok === false && shouldApplyLoginResult(result)) {
    handleLoginFailure(result);
  }
}

async function init() {
  const prevReport = getPreviousStartupReport();
  beginStartupSession(prevReport?.completed ? "warm" : "cold");
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
  window.overlay?.onLoginResult?.((result) => {
    if (!shouldApplyLoginResult(result)) return;
    if (result?.ok && (result?.detailApiReady || result?.loggedIn || result?.loginCookieReady)) {
      void finishLoginSuccess(result);
      return;
    }
    if (result?.ok === false && result?.code !== "login_in_progress") {
      handleLoginFailure(result);
    }
  });
  if (heroDateEl) setTextIfChanged(heroDateEl, resolveDisplayDate(null));

  config = (await window.overlay?.getConfig()) || {
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 2000,
    topCount: RACE_TOP_COUNT,
  };
  config.topCount = RACE_TOP_COUNT;

  await syncOverlaySettings();
  window.getBubbleSkipLog = getBubbleSkipLog;
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
      resetLastGoodIfDayChanged,
      formatWanForDisplay,
      formatWanDisplayText,
      parseDashboard,
      resolveChampionBoxWan,
      resolveNationSeatMetric,
      computeMovieBoxDeltaWan,
      getExtraMetrics,
      getExtraMetricsGridClass,
      buildDailyTrendItems,
      observeBubble,
      bindBubbleAnchor,
      getBubbleSkipLog,
      resolveBubbleTrackingAmount,
      resolveFreshBubbleAmount,
      playBubblePulse,
      hideBubble,
      pulseNoChangeBubble,
      canPaintCurrentBox,
      paintStructuralDashboard,
      getMovieBoxAmount,
      getMovieBoxAmountFresh,
      formatDailyBoxDisplay,
      updateChampion,
    };
    setStatus("ok", "");
    return;
  }

  const apiStatus = await waitForApiReady();
  markStartup("serviceReady");
  if (!apiStatus?.ready) {
    setStatus("error", apiStatus?.error || "票房服务启动失败，5 秒后自动重试…");
    startServiceRetryLoop();
    return;
  }

  if (apiStatus.apiBase) config.apiBase = apiStatus.apiBase;
  setStatus("loading", "服务已就绪，正在拉取票房数据…");
  startPolling();
  setTimeout(() => flushStartupReport(), 90_000);
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
