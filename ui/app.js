import {
  fetchDashboard,
  parseDashboard,
  injectFontStyle,
  decodeBoxFromHtml,
  enrichMovies,
  enrichMoviesLight,
  enrichMoviesQuick,
  estimateSpeedMetrics,
  resetApiSigWarm,
  getLastEnrichErrors,
  MaoyanApiError,
} from "./maoyan-api.js";
import { applyOverlaySettings, getOverlaySettings } from "./settings-applier.js";
import { bindDesignViewport } from "./viewport-fit.js";

const $ = (id) => document.getElementById(id);

const raceListEl = $("race-list");
const deltaOverlayEl = $("delta-overlay");
const statusEl = $("status");
const nationBoxEl = $("nation-box");
const nationShowsEl = $("nation-shows");
const nationViewsEl = $("nation-views");
const nationSeatEl = $("nation-seat");
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
let lastFullEnrich = 0;
let enrichGeneration = 0;
let enrichingBackground = false;

const cardPool = new Map();
const prevValues = new Map();
const prevBoxHtml = new Map();
const prevRankMap = new Map();
const speedSnapshots = new Map();
const lastGoodMovies = new Map();
const lastGoodNation = {};
const lastDeltaDisplay = new Map();
let latestMovies = [];
let latestSpeedMap = {};
let latestNation = null;
let latestParsedMeta = null;
let pollGeneration = 0;
let FULL_ENRICH_INTERVAL_MS = 60000;
const DELTA_PERSIST_MS = 4000;
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

const METRIC_DEFS = [
  {
    key: "endDate",
    label: "下映日期",
    get: (m) => {
      if (isEmptyField(m.endDate) && isEmptyField(m.remainingDays)) return "";
      const days = isEmptyField(m.remainingDays) ? "" : ` 剩余${m.remainingDays}天`;
      return `${m.endDate || "--"}${days}`;
    },
  },
  {
    key: "dynamicForecast",
    label: "动态预测",
    get: (m) => m.dynamicForecast,
    trend: (m) => m.dynamicTrend,
  },
  { key: "dailyIncrease", label: "日增", get: (m) => m.dailyIncrease },
  { key: "hourSpeed", label: "时速", get: (m) => m.hourSpeedText },
  { key: "yesterdayTotal", label: "昨日", get: (m) => m.yesterdayTotal },
  {
    key: "yesterdaySamePeriod",
    label: "昨日同期",
    get: (m) => m.yesterdaySamePeriodText,
  },
  {
    key: "yesterdayHourSpeed",
    label: "昨日时速",
    get: (m) => m.yesterdayHourSpeedText,
  },
  { key: "totalViews", label: "总人次", get: (m) => m.totalViews },
  {
    key: "totalForecast",
    label: "总预测",
    get: (m) => m.totalForecast,
    trend: (m) => m.totalTrend,
  },
  { key: "boxRate", label: "票房占比", get: (m) => m.boxRate },
  { key: "showCountRate", label: "排片占比", get: (m) => m.showCountRate },
  { key: "avgSeatView", label: "实时上座", get: (m) => m.avgSeatView },
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
    return error.action === "login" || /login|401|403/.test(String(error.code));
  }
  const msg = String(error?.message || "");
  return /登录|签名|401|403/.test(msg);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDelta(delta, unit = "万") {
  if (!Number.isFinite(delta) || delta <= 0) return "";
  if (unit === "亿" || delta >= 10000) {
    return `+${(delta / 10000).toFixed(2)}亿`;
  }
  if (delta >= 100) return `+${delta.toFixed(1)}${unit}`;
  if (delta >= 1) return `+${delta.toFixed(1)}${unit}`;
  return `+${delta.toFixed(2)}${unit}`;
}

function safeDecodeBox(html, unit = "万") {
  if (!html) return 0;
  const value = decodeBoxFromHtml(html, unit);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function showBoxDelta(anchorEl, delta, unit = "万") {
  const bubble = getOverlaySettings()?.bubble;
  const minDelta = bubble?.minDelta ?? 0.001;
  if (bubble?.enabled === false) return;
  if (!anchorEl || !deltaOverlayEl || !Number.isFinite(delta) || delta < minDelta) return;

  const rect = anchorEl.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  const el = document.createElement("span");
  el.className = "delta-bubble";
  el.textContent = formatDelta(delta, unit);
  el.style.left = `${rect.left + rect.width * 0.5}px`;
  el.style.top = `${Math.max(8, rect.top - 6)}px`;
  deltaOverlayEl.appendChild(el);

  requestAnimationFrame(() => el.classList.add("delta-bubble--pop"));
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

function showBoxDeltaWhenReady(anchorEl, delta, unit = "万", attempt = 0) {
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  if (rect.width || rect.height) {
    showBoxDelta(anchorEl, delta, unit);
    return;
  }
  if (attempt < 8) {
    requestAnimationFrame(() => showBoxDeltaWhenReady(anchorEl, delta, unit, attempt + 1));
  }
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

function maybeShowBoxIncrease(anchorEl, prevAmount, prevHtml, nextHtml, unit, isNew) {
  if (isNew || !anchorEl) return;
  const delta = computeBoxIncrease(prevAmount, prevHtml, nextHtml, unit);
  if (delta > 0) showBoxDeltaWhenReady(anchorEl, delta, unit);
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

function purgeMovieState(id) {
  cardPool.delete(id);
  prevValues.delete(id);
  prevBoxHtml.delete(id);
  prevRankMap.delete(id);
  speedSnapshots.delete(id);
  lastGoodMovies.delete(id);
  lastDeltaDisplay.delete(id);
}

function getMovieBoxAmount(movie) {
  if (movie.todayBox > 0) return movie.todayBox;
  if (movie.todayBoxHtml) {
    const decoded = decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
    if (decoded > 0) return decoded;
  }
  if (!isEmptyField(movie.todayBoxText)) {
    const n = parseFloat(String(movie.todayBoxText).replace(/,/g, "").replace(/万|亿/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (!isEmptyField(movie.dailyIncrease)) {
    const n = parseFloat(String(movie.dailyIncrease).replace(/,/g, "").replace(/万|亿/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
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
    const computed = parseFloat(getComputedStyle(el).fontSize) || minSize;
    if (computed < minSize) el.style.fontSize = `${minSize}px`;
    return;
  }
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

function buildMetricsHtml(movie) {
  const items = METRIC_DEFS.map((def) => {
    const raw = def.get(movie);
    if (isEmptyField(raw)) return null;
    const trend = def.trend ? trendArrow(def.trend(movie)) : "";
    return {
      key: def.key,
      label: def.label,
      value: `${escapeHtml(raw)}${trend}`,
    };
  }).filter(Boolean);

  if (!items.length) return "";

  return items
    .map(
      (item) =>
        `<div class="metric" data-metric="${item.key}"><span class="metric__label">${item.label}：</span><span class="metric__value">${item.value}</span></div>`
    )
    .join("");
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
      ? `${Number(movie.todayBox).toFixed(2)}${movie.todayUnit || "万"}`
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
  const list = Array.isArray(rows) && rows.length ? rows : [];
  if (!list.length) return "";

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
    .map((row) => {
      const cells = columns.map((col) => `<td class="num">${col.render(row)}</td>`).join("");
      return `<tr><td>${escapeHtml(row.label)}</td>${cells}</tr>`;
    })
    .join("");

  return `<table class="race-card__table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const RACE_TOP_COUNT = 10;
const PODIUM_COUNT = 3;

function isPodiumRank(rank) {
  return Number(rank) > 0 && Number(rank) <= PODIUM_COUNT;
}

function cardClassName(movie) {
  const rank = Math.min(Number(movie.rank) || 99, RACE_TOP_COUNT);
  const compact = !isPodiumRank(rank) ? " race-card--compact race-row" : "";
  return `race-card race-card--rank${rank}${compact}`;
}

function formatCompactBox(movie) {
  const amount = getMovieBoxAmount(movie);
  if (amount > 0) return `${formatBoxAmount(amount)}${movie.todayUnit || "万"}`;
  if (!isEmptyField(movie.todayBoxText)) return `${movie.todayBoxText}${movie.todayUnit || "万"}`;
  return "--";
}

function raceRowTemplate(movie) {
  const boxText = formatCompactBox(movie);
  return `
    <div class="race-row__inner">
      <span class="race-card__rank">NO.${movie.rank}</span>
      <h2 class="race-card__title race-row__title">《${escapeHtml(movie.name)}》</h2>
      <div class="race-row__metrics">
        <span class="race-row__metric"><em>实时</em><strong class="js-day-box">${escapeHtml(boxText)}</strong></span>
        <span class="race-row__metric"><em>占比</em><strong>${escapeHtml(movie.boxRate || "--")}</strong></span>
        <span class="race-row__metric"><em>排片</em><strong>${escapeHtml(movie.showCountRate || "--")}</strong></span>
        <span class="race-row__metric"><em>上座</em><strong>${escapeHtml(movie.avgSeatView || "--")}</strong></span>
      </div>
    </div>
  `;
}

function buildRaceRow(movie) {
  const card = document.createElement("article");
  card.className = cardClassName(movie);
  card.dataset.movieId = String(movie.movieId);
  card.dataset.rank = String(movie.rank);
  card.innerHTML = raceRowTemplate(movie);
  requestAnimationFrame(() => {
    fitNowrapEl(card.querySelector(".race-row__title"), { minSize: 20, allowWrap: true });
  });
  return card;
}

function updateRaceRow(card, movie, isNew = false) {
  const prevRank = Number(card.dataset.rank || 0);
  card.className = cardClassName(movie);
  card.dataset.rank = String(movie.rank);
  if (prevRank && prevRank !== movie.rank) {
    card.classList.remove("is-flash");
    void card.offsetWidth;
    card.classList.add("is-flash");
  }
  setTextIfChanged(card.querySelector(".race-card__rank"), `NO.${movie.rank}`);
  if (setTextIfChanged(card.querySelector(".race-card__title"), `《${movie.name}》`)) {
    fitNowrapEl(card.querySelector(".race-row__title"), { minSize: 20, allowWrap: true });
  }
  const boxText = formatCompactBox(movie);
  setTextIfChanged(card.querySelector(".js-day-box"), boxText);
  const metrics = card.querySelectorAll(".race-row__metric strong");
  if (metrics[1]) setTextIfChanged(metrics[1], movie.boxRate || "--");
  if (metrics[2]) setTextIfChanged(metrics[2], movie.showCountRate || "--");
  if (metrics[3]) setTextIfChanged(metrics[3], movie.avgSeatView || "--");
  updateRaceCardDelta(card, movie, isNew);
  trackBoxDelta(card, movie, isNew);
}

function raceCardTemplate(movie) {
  const mainland = mainlandValue(movie);
  const regions = buildRegionsHtml(movie);
  const metrics = buildMetricsHtml(movie);
  const dailyTable = ensureDailyTable(movie);
  const table = dailyTableHtml(dailyTable);
  const mainlandText = isEmptyField(mainland) ? "--" : String(mainland);

  return `
    <div class="race-card__head">
      <span class="race-card__rank">NO.${movie.rank}</span>
      <div class="race-card__title-wrap">
        <h2 class="race-card__title">《${escapeHtml(movie.name)}》</h2>
      </div>
      <div class="race-card__mainland${isEmptyField(mainland) ? " is-empty" : ""}">
        <span class="race-card__delta"></span>
        <div class="race-card__mainland-row">
          <em>中国内地：</em>
          <strong class="js-mainland">${isEmptyField(mainland) ? "--" : escapeHtml(mainlandText)}</strong>
        </div>
      </div>
    </div>
    <div class="race-card__regions${regions ? "" : " is-empty"}">${regions}</div>
    <div class="race-card__metrics${metrics ? "" : " is-empty"}">${metrics}</div>
    <div class="race-card__table-wrap${table ? "" : " is-empty"}" data-table-sig="">${table}</div>
  `;
}

function buildRaceCard(movie) {
  const card = document.createElement("article");
  card.className = cardClassName(movie);
  card.dataset.movieId = String(movie.movieId);
  card.dataset.rank = String(movie.rank);
  card.innerHTML = raceCardTemplate(movie);
  const wrap = card.querySelector(".race-card__table-wrap");
  if (wrap && !wrap.classList.contains("is-empty")) {
    wrap.dataset.tableSig = dailyTableSignature(ensureDailyTable(movie));
  }
  requestAnimationFrame(() => {
    fitNowrapEl(card.querySelector(".race-card__title"), { minSize: 30, allowWrap: true });
    fitNowrapEl(card.querySelector(".js-mainland"), { minSize: 26 });
  });
  return card;
}

function updateRaceCardDelta(card, movie, isNew) {
  const deltaEl = card.querySelector(".race-card__delta");
  if (!deltaEl) return;

  const key = String(movie.movieId);
  const unit = movie.todayUnit || "万";
  const stored = prevValues.get(key);
  const storedHtml = prevBoxHtml.get(key);
  const decoded = getMovieBoxAmount(movie);
  let delta = 0;

  if (!isNew && movie.todayBoxHtml && storedHtml && storedHtml !== movie.todayBoxHtml) {
    delta = computeBoxIncrease(stored, storedHtml, movie.todayBoxHtml, unit);
  }
  if (delta <= 0 && !isNew && decoded > 0 && stored != null && decoded > stored) {
    delta = decoded - stored;
  }

  if (delta > 0) {
    const text = formatDelta(delta, unit);
    deltaEl.textContent = text;
    deltaEl.classList.add("has-rise");
    lastDeltaDisplay.set(key, { text, until: Date.now() + DELTA_PERSIST_MS });
    showBoxDeltaWhenReady(getDeltaBubbleAnchor(card), delta, unit);
    return;
  }

  const cached = lastDeltaDisplay.get(key);
  if (cached && Date.now() < cached.until) {
    deltaEl.textContent = cached.text;
    deltaEl.classList.add("has-rise");
    return;
  }

  deltaEl.textContent = "";
  deltaEl.classList.remove("has-rise");
}

function getDeltaBubbleAnchor(card) {
  return (
    card.querySelector('[data-metric="dailyIncrease"] .metric__value') ||
    card.querySelector(".race-card__delta") ||
    card.querySelector(".race-card__title")
  );
}

function getBoxAnchor(card) {
  return (
    getDeltaBubbleAnchor(card) ||
    card.querySelector(".js-mainland") ||
    card.querySelector(".js-day-box")
  );
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
    updateRaceCardDelta(card, movie, isNew);
    trackBoxDelta(card, movie, isNew);
    return;
  }

  setTextIfChanged(card.querySelector(".race-card__rank"), `NO.${movie.rank}`);
  if (setTextIfChanged(card.querySelector(".race-card__title"), `《${movie.name}》`)) {
    fitNowrapEl(card.querySelector(".race-card__title"), { minSize: 30, allowWrap: true });
  }

  const mainland = mainlandValue(movie);
  const mainlandWrap = card.querySelector(".race-card__mainland");
  const mainlandEl = card.querySelector(".js-mainland");
  if (mainlandWrap && mainlandEl) {
    mainlandWrap.classList.toggle("is-empty", isEmptyField(mainland));
    if (!isEmptyField(mainland)) {
      setTextIfChanged(mainlandEl, mainland);
      fitNowrapEl(mainlandEl, { minSize: 26 });
    }
  }

  const regionsHtml = buildRegionsHtml(movie);
  const regionsEl = card.querySelector(".race-card__regions");
  if (regionsEl) {
    regionsEl.classList.toggle("is-empty", !regionsHtml);
    if (regionsHtml) setHtmlIfChanged(regionsEl, regionsHtml);
  }

  const metricsHtml = buildMetricsHtml(movie);
  const metricsEl = card.querySelector(".race-card__metrics");
  if (metricsEl) {
    metricsEl.classList.toggle("is-empty", !metricsHtml);
    if (metricsHtml) setHtmlIfChanged(metricsEl, metricsHtml);
  }

  const dailyTable = ensureDailyTable(movie);
  const tableHtml = dailyTableHtml(dailyTable);
  const tableWrap = card.querySelector(".race-card__table-wrap");
  if (tableWrap) {
    const sig = dailyTableSignature(dailyTable);
    tableWrap.classList.toggle("is-empty", !tableHtml);
    if (tableHtml && tableWrap.dataset.tableSig !== sig) {
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
  const podium = isPodiumRank(movie.rank);
  const isRow = card?.classList.contains("race-row");
  if (!card || !card.classList.contains("race-card") || (podium && isRow) || (!podium && !isRow)) {
    card?.remove();
    card = podium ? buildRaceCard(movie) : buildRaceRow(movie);
    cardPool.set(key, card);
    if (podium) {
      updateRaceCardDelta(card, movie, isFirstSeen(key));
      trackBoxDelta(card, movie, isFirstSeen(key));
    } else {
      updateRaceRow(card, movie, isFirstSeen(key));
    }
    return card;
  }
  if (podium) updateRaceCard(card, movie, isFirstSeen(key));
  else updateRaceRow(card, movie, isFirstSeen(key));
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
          <div class="race-card__title-wrap">
            <h2 class="race-card__title skeleton-block">加载中</h2>
          </div>
          <div class="race-card__mainland skeleton-block"></div>
        </div>
        <div class="race-card__metrics">
          ${Array.from({ length: 9 }, () => '<div class="metric skeleton-block"></div>').join("")}
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

function formatBoxAmount(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return "--";
  if (amount >= 1000) return amount.toFixed(1);
  return amount.toFixed(2);
}

function resolveDisplayBoxAmount(html, unit, numeric, text) {
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const fromHtml = safeDecodeBox(html, unit);
  if (fromHtml > 0) return fromHtml;
  if (!isEmptyField(text)) {
    const n = parseFloat(String(text).replace(/,/g, "").replace(/万|亿/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function setPlainBoxValue(el, amount) {
  if (!el) return;
  const text = formatBoxAmount(amount);
  el.classList.remove("mtsi-font");
  if (el.textContent === text) return;
  el.textContent = text;
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

function computeNationSeatRate(movies) {
  const rates = (movies || [])
    .map((m) => {
      const raw = m?.avgSeatView ?? m?.dailyTable?.[0]?.avgSeatView;
      if (isEmptyField(raw)) return null;
      const n = parseFloat(String(raw).replace(/%/g, ""));
      return Number.isFinite(n) ? n : null;
    })
    .filter((n) => n != null);
  if (!rates.length) return "--";
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  return `${avg.toFixed(1)}%`;
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

function updateChampion(movies) {
  const top = (movies || []).find((m) => m.rank === 1) || movies?.[0];
  if (!top) {
    champBoxPillEl?.classList.add("is-hidden");
    return;
  }

  const unit = top.todayUnit || "万";
  if (champBoxUnitEl) champBoxUnitEl.textContent = unit;

  const amount = resolveDisplayBoxAmount(
    top.todayBoxHtml,
    unit,
    top.todayBox,
    top.todayBoxText || top.dailyIncrease
  );
  if (amount > 0) {
    champBoxPillEl?.classList.remove("is-hidden");
    setPlainBoxValue(champBoxEl, amount);
  } else if (top.todayBoxHtml) {
    champBoxPillEl?.classList.remove("is-hidden");
    setEncodedBoxValue(champBoxEl, top.todayBoxHtml);
  } else {
    champBoxPillEl?.classList.add("is-hidden");
  }

  if (nationSeatEl) {
    setTextIfChanged(nationSeatEl, computeNationSeatRate(movies));
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
      const minDelta = getOverlaySettings()?.bubble?.minDelta ?? 0.001;
      if (delta >= minDelta) showBoxDeltaWhenReady(nationBoxEl, delta, unit);
    }
    setPlainBoxValue(nationBoxEl, nationAmount);
    prevValues.set("__nation__", nationAmount);
    if (nation.todayBoxHtml) prevBoxHtml.set("__nation__", nation.todayBoxHtml);
  } else if (nation.todayBoxHtml) {
    setEncodedBoxValue(nationBoxEl, nation.todayBoxHtml);
  } else {
    setPlainBoxValue(nationBoxEl, 0);
  }

  if (unitEl) unitEl.textContent = unit;
  setTextIfChanged(nationShowsEl, nation.showCountDesc || "--");
  setTextIfChanged(nationViewsEl, nation.viewCountDesc || "--");

  $("nation-shows-pill")?.classList.toggle("is-hidden", isEmptyField(nation.showCountDesc));
  $("nation-views-pill")?.classList.toggle("is-hidden", isEmptyField(nation.viewCountDesc));

  if (heroDateEl) {
    setTextIfChanged(heroDateEl, resolveDisplayDate(parsed));
  }
}

function scheduleBackgroundEnrich(requestPollGen, parsed, speed) {
  if (enrichingBackground) return;

  const now = Date.now();
  const needFull = pollCount === 1 || now - lastFullEnrich >= FULL_ENRICH_INTERVAL_MS;
  const gen = ++enrichGeneration;
  enrichingBackground = true;

  (async () => {
    try {
      if (await window.overlay?.isLoginRunning?.()) return;

      const enrichOpts = {
        concurrency: config.enrichConcurrency || 2,
        todayStr: parsed.calendar?.today || "",
        speed,
        trendLimit: config.trendLimit || RACE_TOP_COUNT,
        enableExtraApis: true,
      };

      const task = enrichMovies(config.apiBase, parsed.movies, enrichOpts);

      const enriched = await Promise.race([
        task,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("enrich_timeout")), 120000)
        ),
      ]);

      if (gen !== enrichGeneration) return;

      const baseMovies = latestMovies.length ? latestMovies : parsed.movies;
      const currentSpeed = buildSpeedMap(baseMovies);
      const movies = mergeEnrichedMovies(baseMovies, enriched, currentSpeed);
      renderList(movies);
      updatePartialDataWarning(getLastEnrichErrors());
      setStatus("ok", "");
      if (needFull) lastFullEnrich = Date.now();
    } catch (err) {
      console.warn("后台补充字段失败", err);
      if (isLoginRelatedError(err)) {
        await updateLoginButton(true);
        partialDataWarning = `部分详细数据获取失败：${err.detail || err.message || "请重新登录"}`;
        setStatus("ok", "");
      }
    } finally {
      if (gen === enrichGeneration) enrichingBackground = false;
    }
  })();
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
    const parsed = parseDashboard(raw, config.topCount || RACE_TOP_COUNT);
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
    } else if (e instanceof MaoyanApiError || isLoginRelatedError(e)) {
      await updateLoginButton(true);
      const detail = e instanceof MaoyanApiError ? e.detail : msg;
      setStatus("error", detail || "登录已过期，请点击右上角「登录」完成登录");
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
  config.topCount = Number(settings.topCount) || RACE_TOP_COUNT;
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

async function updateLoginButton(forceShow = false) {
  const btn = $("btn-login");
  if (!btn) return;
  const loggedIn = forceShow ? false : await window.overlay?.isLoggedIn?.();
  btn.classList.remove("is-hidden");
  btn.textContent = loggedIn ? "重新登录" : "登录";
  btn.title = loggedIn ? "重新登录猫眼账号" : "登录猫眼账号";
}

async function finishLoginSuccess() {
  await updateLoginButton(false);
  resetApiSigWarm();
  partialDataWarning = "";
  lastFullEnrich = 0;
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

async function handleLoginClick() {
  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }
  $("btn-login")?.classList.remove("is-highlight");
  const relogin = await window.overlay?.isLoggedIn?.();
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
        const loggedIn = await window.overlay?.isLoggedIn?.();
        if (loggedIn) {
          clearInterval(loginWatchTimer);
          loginWatchTimer = null;
          resolve({ ok: true, loggedIn: true });
        }
      }, 2000);
    }),
  ]);

  offResult?.();
  if (loginWatchTimer) {
    clearInterval(loginWatchTimer);
    loginWatchTimer = null;
  }

  if (result?.ok && result?.loggedIn) {
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
  config.topCount = Number(config.topCount) || RACE_TOP_COUNT;

  await syncOverlaySettings();
  window.overlay?.onSettingsChanged?.((settings) => {
    applyOverlaySettings(settings);
    config.pollIntervalMs = settings.pollIntervalMs;
    config.topCount = Number(settings.topCount) || RACE_TOP_COUNT;
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

  if (new URLSearchParams(location.search).has("preview")) {
    window.__racePreview = { renderList, updateNation, setStatus, stabilizeMovie };
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
