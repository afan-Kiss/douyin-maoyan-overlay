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
  return !text || text === "--" || text === "-";
}

const PRESERVE_MOVIE_FIELDS = [
  "todayBoxHtml",
  "todayUnit",
  "todayBoxText",
  "boxRate",
  "showCountRate",
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

const SUMMARY_COLUMN_DEFS = [
  [
    {
      key: "dynamicForecast",
      label: "动态预测",
      get: (m) => m.dynamicForecast,
      trend: (m) => m.dynamicTrend,
    },
    {
      key: "totalForecast",
      label: "总预测",
      get: (m) => m.totalForecast,
      trend: (m) => m.totalTrend,
    },
    { key: "avgSeatView", label: "实时上座", get: (m) => m.avgSeatView },
  ],
  [
    { key: "dailyIncrease", label: "日增", get: (m) => m.dailyIncrease },
    { key: "boxRate", label: "票房占比", get: (m) => m.boxRate },
  ],
  [
    { key: "hourSpeed", label: "时速", get: (m) => formatHourSpeedDisplay(m.hourSpeedText) },
    { key: "showCountRate", label: "排片占比", get: (m) => m.showCountRate },
  ],
];

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
      if (key === "todayBox") {
        if (val > 0) result[key] = val;
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
  const loginIssue = errors.find((e) => e.action === "login" || /login|登录/.test(String(e.code)));
  const detail = loginIssue?.detail || errors[0]?.detail || "部分详细数据获取失败";
  partialDataWarning = `部分详细数据获取失败：${detail}`;
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
    if (isEmptyField(stable[field])) {
      const cached = prev[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }

  stable.rank = movie.rank;
  stable.name = movie.name;
  stable.movieId = movie.movieId;

  if (stable.todayBox <= 0 && stable.todayBoxHtml) {
    const decoded = safeDecodeBox(stable.todayBoxHtml, stable.todayUnit);
    if (decoded > 0) stable.todayBox = decoded;
    else if (prev.todayBox > 0) stable.todayBox = prev.todayBox;
  } else if (stable.todayBox <= 0 && prev.todayBox > 0) {
    stable.todayBox = prev.todayBox;
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
  if (stable.todayBox <= 0 && lastGoodNation.todayBox > 0) {
    stable.todayBox = lastGoodNation.todayBox;
  }
  for (const field of [
    "todayBoxHtml",
    "todayUnit",
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
  lastGoodMovies.delete(id);
}

function getMovieBoxAmount(movie) {
  if (movie.todayBox > 0 && movie.todayBox < 100000) return movie.todayBox;
  if (movie.todayBoxHtml) {
    const decoded = decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (decoded > 0) return decoded;
  }
  if (!isEmptyField(movie.todayBoxText)) {
    const n = parseBoxNum(movie.todayBoxText, movie.todayUnit || "万");
    if (n > 0) return n;
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
    const box =
      movie.todayBox > 0
        ? movie.todayBox
        : decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
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

function fitNowrapEl(el, { minSize = 20, allowWrap = false } = {}) {
  if (!el) return;
  el.style.fontSize = "";
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
  const raw = def.get(movie);
  if (isEmptyField(raw)) return "";
  const trend = def.trend ? trendArrow(def.trend(movie)) : "";
  return `<div class="metric" data-metric="${def.key}"><span class="metric__label">${def.label}</span><span class="metric__value">${escapeHtml(raw)}${trend}</span></div>`;
}

function buildSummaryHtml(movie) {
  const columns = SUMMARY_COLUMN_DEFS.map((defs) => {
    const items = defs.map((def) => buildSummaryMetricHtml(def, movie)).filter(Boolean);
    if (!items.length) return "";
    return `<div class="race-card__summary-col">${items.join("")}</div>`;
  }).filter(Boolean);

  return columns.length
    ? `<div class="race-card__summary">${columns.join("")}</div>`
    : "";
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

function ensureDailyTable(movie) {
  const labels = ["今日", "明日", "后天"];
  const src = Array.isArray(movie.dailyTable) ? movie.dailyTable : [];
  const byLabel = new Map(src.map((row) => [String(row.label || "").trim(), row]));

  const todayBoxPlain =
    movie.todayBox > 0
      ? formatWanDisplayText(movie.todayBox)
      : !isEmptyField(movie.todayBoxText)
        ? `${movie.todayBoxText}${movie.todayUnit || "万"}`
        : !isEmptyField(movie.dailyIncrease)
          ? String(movie.dailyIncrease)
          : "";

  return labels.map((label, i) => {
    const prev = byLabel.get(label) || src[i] || {};
    const isToday = i === 0;
    const box =
      !isEmptyField(prev.box) && prev.box !== "--"
        ? prev.box
        : isToday && todayBoxPlain
          ? todayBoxPlain
          : "--";
    return {
      label,
      box,
      // 优先用明文，避免猫眼加密字体显示成点
      boxHtml: isToday && isEmptyField(box) ? prev.boxHtml || movie.todayBoxHtml || "" : "",
      boxUnit: prev.boxUnit || movie.todayUnit || "万",
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

function dailyTableHtml(rows) {
  const labels = ["今日", "明日", "后天"];
  const src = Array.isArray(rows) ? rows : [];
  const byLabel = new Map(src.map((row) => [String(row.label || "").trim(), row]));
  const list = labels.map((label, i) => byLabel.get(label) || src[i] || { label });

  const columns = [
    {
      key: "box",
      label: "票房(含预售)",
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

  const head = `<tr><th>日期</th>${columns.map((col) => `<th>${col.label}</th>`).join("")}</tr>`;
  const body = list
    .map((row, idx) => {
      const cells = columns.map((col) => `<td class="num">${col.render(row)}</td>`).join("");
      return `<tr><td>${escapeHtml(row.label || labels[idx])}</td>${cells}</tr>`;
    })
    .join("");

  return `<table class="race-card__table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const RACE_TOP_COUNT = 5;

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
      <div class="race-card__mainland${isEmptyField(mainland) || mainland === "--" ? " is-empty" : ""}">
        <em>中国内地：</em>
        <strong class="js-mainland">${escapeHtml(mainland)}</strong>
        <span class="race-card__delta-bubble" aria-hidden="true"></span>
      </div>
    </div>
    <div class="race-card__summary-wrap${summary ? "" : " is-empty"}">${summary}</div>
    <div class="race-card__table-wrap" data-table-sig="">${table}</div>
  `;
}

function buildRaceCard(movie) {
  const card = document.createElement("article");
  card.className = cardClassName(movie);
  card.dataset.movieId = String(movie.movieId);
  card.dataset.rank = String(movie.rank);
  card.innerHTML = raceCardTemplate(movie);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  if (tableWrap) {
    tableWrap.dataset.tableSig = dailyTableSignature(ensureDailyTable(movie));
  }
  requestAnimationFrame(() => {
    fitNowrapEl(card.querySelector(".race-card__title"), { minSize: 24, allowWrap: Number(movie.rank) === 1 });
    fitNowrapEl(card.querySelector(".js-mainland"), { minSize: 18 });
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
  let delta = 0;
  if (movie.todayBoxHtml && storedHtml && storedHtml !== movie.todayBoxHtml) {
    delta = computeBoxIncrease(stored, storedHtml, movie.todayBoxHtml, unit);
  }
  if (delta <= 0 && decoded > 0 && stored != null && decoded > stored) {
    delta = decoded - stored;
  }
  return delta;
}

function updateRaceCardDelta(card, movie, isNew) {
  const bubbleEl = card.querySelector(".race-card__delta-bubble");
  if (!bubbleEl) return;
  const delta = computeMovieDelta(movie, isNew);
  if (delta > 0) {
    pulseInlineDelta(bubbleEl, delta, `movie-${movie.movieId}`);
  }
}

function trackBoxDelta(card, movie, isNew) {
  const key = String(movie.movieId);
  const unit = movie.todayUnit || "万";
  const stored = prevValues.get(key);
  const decoded = getMovieBoxAmount(movie);

  // Always track numeric amounts so bubbles work even when MTSI html decode fails
  if (decoded > 0) {
    if (!isNew && stored != null && decoded > stored) {
      // bubble is shown in updateRaceCardDelta to avoid double pop
    }
    prevValues.set(key, decoded);
  }
  if (movie.todayBoxHtml) {
    prevBoxHtml.set(key, movie.todayBoxHtml);
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
  if (setTextIfChanged(card.querySelector(".race-card__title"), `《${movie.name}》`)) {
    fitNowrapEl(card.querySelector(".race-card__title"), {
      minSize: 24,
      allowWrap: Number(movie.rank) === 1,
    });
  }

  const mainland = formatMainlandDisplay(movie);
  const mainlandWrap = card.querySelector(".race-card__mainland");
  const mainlandEl = card.querySelector(".js-mainland");
  if (mainlandWrap && mainlandEl) {
    mainlandWrap.classList.toggle("is-empty", isEmptyField(mainland) || mainland === "--");
    if (!isEmptyField(mainland) && mainland !== "--") {
      setTextIfChanged(mainlandEl, mainland);
      fitNowrapEl(mainlandEl, { minSize: 18 });
    }
  }

  const summaryHtml = buildSummaryHtml(movie);
  const summaryWrap = card.querySelector(".race-card__summary-wrap");
  if (summaryWrap) {
    summaryWrap.classList.toggle("is-empty", !summaryHtml);
    if (summaryHtml) {
      const current = summaryWrap.firstElementChild;
      if (!current || current.outerHTML !== summaryHtml) {
        summaryWrap.innerHTML = summaryHtml;
      }
    } else {
      summaryWrap.innerHTML = "";
    }
  }

  const tableRows = ensureDailyTable(movie);
  const tableHtml = dailyTableHtml(tableRows);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  if (tableWrap) {
    const sig = dailyTableSignature(tableRows);
    if (tableWrap.dataset.tableSig !== sig) {
      tableWrap.innerHTML = tableHtml;
      tableWrap.dataset.tableSig = sig;
    }
  }

  updateRaceCardDelta(card, movie, isNew);
  trackBoxDelta(card, movie, isNew);
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
  raceListEl.innerHTML = Array.from({ length: RACE_TOP_COUNT }, (_, i) => {
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
    .slice(0, RACE_TOP_COUNT);
  const activeIds = new Set(list.map((m) => String(m.movieId)));

  raceListEl.querySelectorAll(".race-card--skeleton").forEach((el) => el.remove());

  for (const [id, card] of cardPool) {
    if (!activeIds.has(id)) {
      card.remove();
      purgeMovieState(id);
    }
  }

  const cards = list.map((movie) => {
    const card = ensureRaceCard(movie);
    prevRankMap.set(String(movie.movieId), movie.rank);
    return card;
  });

  if (cards.length) {
    raceListEl.replaceChildren(...cards);
  }

  updateChampion(list);
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
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const fromHtml = safeDecodeBox(html, unit);
  if (fromHtml > 0) return fromHtml;
  if (!isEmptyField(text)) {
    const n = parseBoxNum(text, unit || "万");
    if (n > 0) return n;
  }
  return 0;
}

function setEncodedBoxValue(el, html, fallbackText = "--") {
  if (!el) return;
  if (html) {
    if (el.innerHTML === html) return;
    el.classList.add("mtsi-font");
    el.innerHTML = html;
    return;
  }
  if (el.textContent === fallbackText) return;
  el.classList.remove("mtsi-font");
  el.textContent = fallbackText;
}

function updateNationSeatMetric(nation) {
  const metric =
    nation?.seatLabel && nation?.seatValue
      ? { label: nation.seatLabel, value: nation.seatValue }
      : resolveNationSeatMetric(nation || {});
  if (nationSeatLabelEl) {
    setTextIfChanged(nationSeatLabelEl, metric.label);
  }
  if (nationSeatEl) {
    setTextIfChanged(nationSeatEl, metric.value || "--");
  }
  const hideSeat = isEmptyField(metric.value);
  $("nation-seat-pill")?.classList.toggle("is-hidden", hideSeat);
}

function updateChampion(movies) {
  const top = (movies || []).find((m) => m.rank === 1) || movies?.[0];
  if (!top) {
    champBoxPillEl?.classList.add("is-hidden");
    return;
  }

  const amount = resolveChampionBoxWan(top);
  if (amount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, amount, champBoxUnitEl);
  } else if (top.todayBoxHtml) {
    champBoxPillEl?.classList.remove("is-hidden");
    setEncodedBoxValue(champBoxEl, top.todayBoxHtml);
  } else {
    champBoxPillEl?.classList.add("is-hidden");
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
    nation.todayBoxText
  );

  if (nationAmount > 0) {
    if (prevNation != null && nationAmount > prevNation) {
      const delta = nationAmount - prevNation;
      pulseInlineDelta(nationDeltaEl, delta, "__nation__");
    }
    setPlainBoxValue(nationBoxEl, nationAmount, unitEl);
    prevValues.set("__nation__", nationAmount);
    if (nation.todayBoxHtml) prevBoxHtml.set("__nation__", nation.todayBoxHtml);
  } else if (nation.todayBoxHtml) {
    setEncodedBoxValue(nationBoxEl, nation.todayBoxHtml);
  } else {
    setPlainBoxValue(nationBoxEl, 0, unitEl);
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
        trendLimit: RACE_TOP_COUNT,
        enableExtraApis: true,
        signal: controller.signal,
      };

      const enriched = await enrichMovies(config.apiBase, parsed.movies, enrichOpts);

      if (gen !== enrichGeneration) return;

      const baseMovies = latestMovies.length ? latestMovies : parsed.movies;
      const currentSpeed = buildSpeedMap(baseMovies);
      const movies = mergeEnrichedMovies(baseMovies, enriched, currentSpeed);
      renderList(movies);
      const errors = getLastEnrichErrors();
      updatePartialDataWarning(errors);
      setStatus("ok", "");
      if (shouldMarkFullEnrichFailure(errors, RACE_TOP_COUNT)) {
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
      // still refresh champion plain numbers if possible
      renderList(latestMovies.map(stabilizeMovie));
      return;
    }
    const movies = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
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

    const raw = await fetchDashboard(config.apiBase);
    const parsed = parseDashboard(raw, RACE_TOP_COUNT);
    traceDashboardData(parsed, raw, { enabled: isDataTraceEnabled() });
    if (!parsed.movies.length) {
      if (!hasDisplayedData) setStatus("loading", "等待票房数据…");
      return;
    }

    pollGeneration += 1;
    latestMovies = parsed.movies;
    latestNation = parsed.nation;
    latestParsedMeta = parsed;
    const speed = buildSpeedMap(parsed.movies);
    latestSpeedMap = speed;
    const movies = enrichMoviesQuick(parsed.movies, speed).map(stabilizeMovie);

    renderList(movies);
    updateNation(parsed.nation, parsed);

    hasDisplayedData = true;
    setStatus("ok", "");
    scheduleBackgroundEnrich(pollGeneration, parsed, speed);
    void injectFontStyle(raw.fontStyle)
      .then(() => {
        if (!latestMovies.length) return;
        const decoded = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
        renderList(decoded);
        if (latestNation) updateNation(latestNation, latestParsedMeta || {});
        scheduleDecodeRetry();
      })
      .catch((err) => console.warn("字体加载失败", err));
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
  let status = await window.overlay.getApiStatus();
  if (status?.ready) return status;
  status = await window.overlay.ensureApi();
  if (status?.ready) return status;

  return new Promise((resolve) => {
    let off = null;
    const timeout = setTimeout(() => {
      off?.();
      resolve({
        ready: false,
        error: "票房服务启动超时（45 秒），请确认已运行 setup.bat 或重启软件",
      });
    }, 45_000);
    off = window.overlay.onApiReady((next) => {
      clearTimeout(timeout);
      off?.();
      resolve(next);
    });
  });
}

function isSignatureIssueStatus(status) {
  const err = String(status?.lastVerifyError || "");
  return (
    /403|signature|sig_|mtgsig/i.test(err) ||
    (status?.identityCookieExists && !status?.detailApiReady && !status?.loginRequired)
  );
}

async function updateLoginButton(forceShow = false) {
  const btn = $("btn-login");
  if (!btn) return;
  const status = (await window.overlay?.getSessionStatus?.()) || {};
  btn.classList.remove("is-hidden");

  if (forceShow || status.loginRequired) {
    btn.textContent = "登录";
    btn.title = "登录猫眼账号";
    return;
  }

  if (isSignatureIssueStatus(status)) {
    btn.textContent = "刷新签名";
    btn.title = "猫眼签名失效，可尝试刷新签名或重新登录";
    return;
  }

  if (status.identityCookieExists) {
    btn.textContent = "重新登录";
    btn.title = status.productionDetailReady
      ? "详细数据已就绪，可重新登录猫眼账号"
      : "重新登录猫眼账号";
    return;
  }

  btn.textContent = "登录";
  btn.title = "登录猫眼账号";
}

async function finishLoginSuccess() {
  await updateLoginButton(false);
  resetApiSigWarm();
  partialDataWarning = "";
  await abortAndResetEnrichSchedule();
  setStatus("loading", "登录成功，正在拉取票房数据…");
  const status = await window.overlay?.ensureApi?.();
  if (status?.apiBase) config.apiBase = status.apiBase;
  startPolling();
}

function handleLoginFailure(result) {
  const detail =
    result?.detail ||
    result?.error ||
    (result?.code === "login_cancelled"
      ? "未完成登录"
      : result?.code === "login_timeout"
        ? "登录超时，请重新点击登录"
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
    setStatus("error", formatUserFacingError(error));
  }
}

async function handleLoginClick() {
  const sessionStatus = (await window.overlay?.getSessionStatus?.()) || {};
  if (isSignatureIssueStatus(sessionStatus) && !sessionStatus.loginRequired) {
    await handleSignatureRefresh();
    return;
  }

  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }
  $("btn-login")?.classList.remove("is-highlight");
  const relogin = sessionStatus.identityCookieExists;
  setStatus("loading", relogin ? "正在打开登录窗口，请重新完成登录…" : "正在打开登录窗口，请在浏览器中完成登录…");

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
        if (session.detailApiReady && session.identityCookieExists) {
          clearInterval(loginWatchTimer);
          loginWatchTimer = null;
          resolve({ ok: true, detailApiReady: true });
        }
      }, 2000);
    }),
  ]);

  offResult?.();
  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }

  if (result?.ok && (result?.detailApiReady || result?.loggedIn)) {
    await finishLoginSuccess();
    return;
  }
  handleLoginFailure(result);
}

async function init() {
  bindDesignViewport();
  renderLoadingSkeleton();
  $("btn-login")?.addEventListener("click", handleLoginClick);
  if (heroDateEl) setTextIfChanged(heroDateEl, resolveDisplayDate(null));

  config = (await window.overlay?.getConfig()) || {
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 5000,
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
      "加载超时：请先运行 setup.bat 安装依赖，或点击右上角「登录」完成猫眼登录"
    );
  }
}, 60_000);

init().catch((err) => {
  console.error("界面初始化失败", err);
  setStatus("error", err?.message || "界面初始化失败，请重启软件");
});
