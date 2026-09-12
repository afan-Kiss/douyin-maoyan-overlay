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
import { applyOverlaySettings, getOverlaySettings } from "./settings-applier.js";

const $ = (id) => document.getElementById(id);

const podiumEl = $("podium");
const compactListEl = $("rank-compact");
const PODIUM_SLOTS = [2, 1, 3];
const deltaOverlayEl = $("delta-overlay");
const statusEl = $("status");
const nationBoxEl = $("nation-box");
const nationShowsEl = $("nation-shows");
const nationViewsEl = $("nation-views");
const updateTimeEl = $("update-time");

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
const speedSnapshots = new Map();
const lastGoodMovies = new Map();
const lastGoodNation = {};
const lastDeltaDisplay = new Map();
let latestMovies = [];
let latestSpeedMap = {};
let pollGeneration = 0;
let FULL_ENRICH_INTERVAL_MS = 60000;
const DELTA_PERSIST_MS = 4000;

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

function setStatus(type, text) {
  if (!statusEl) return;
  statusEl.className = `status status--${type}`;
  statusEl.textContent = text;
  statusEl.style.display = type === "ok" ? "none" : "block";
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
  el.style.top = `${rect.top}px`;
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
  speedSnapshots.delete(id);
  lastGoodMovies.delete(id);
  lastDeltaDisplay.delete(id);
}

function getMovieBoxAmount(movie) {
  if (movie.todayBox > 0) return movie.todayBox;
  if (movie.todayBoxHtml) return decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
  return 0;
}

function trendArrow(trend) {
  if (trend === "up") return '<span class="trend trend--up">↑</span>';
  if (trend === "down") return '<span class="trend trend--down">↓</span>';
  return "";
}

function isEmptyField(val) {
  if (val == null) return true;
  const text = String(val).trim();
  return !text || text === "--" || text === "-";
}

function buildMetaText(movie) {
  if (movie.endDate && movie.endDate !== "--") {
    const remaining =
      movie.remainingDays !== "--" ? ` 剩下${escapeHtml(movie.remainingDays)}天` : "";
    return `下映${escapeHtml(movie.endDate)}${remaining}`;
  }
  return isEmptyField(movie.releaseInfo) ? "" : escapeHtml(movie.releaseInfo);
}

function buildRegionsHtml(movie) {
  const regions = [
    { label: "中国内地", value: movie.mainlandBox || movie.sumBoxDesc },
    { label: "中国港澳台", value: movie.hmtBox },
    { label: "海外", value: movie.overseasBox },
  ].filter((item) => !isEmptyField(item.value));

  if (!regions.length) return "";

  return `<div class="movie-card__regions">${regions
    .map(
      (item) =>
        `<span class="region"><em>${item.label}</em><strong>${escapeHtml(item.value)}</strong></span>`
    )
    .join("")}</div>`;
}

function buildPodiumMainlandHtml(movie) {
  const value = movie.mainlandBox || movie.sumBoxDesc;
  if (isEmptyField(value)) return "";
  return `<div class="movie-card__regions movie-card__regions--mainland"><span class="region region--mainland"><em>中国内地累计</em><strong>${escapeHtml(value)}</strong></span></div>`;
}

function buildPodiumMetricsHtml(movie) {
  const forecastRaw = !isEmptyField(movie.dynamicForecast)
    ? movie.dynamicForecast
    : movie.totalForecast;
  const forecastTrend = !isEmptyField(movie.dynamicForecast)
    ? movie.dynamicTrend
    : movie.totalTrend;

  const metrics = [
    { key: "boxRate", label: "票房占比", raw: movie.boxRate },
    { key: "showCountRate", label: "排片占比", raw: movie.showCountRate },
    { key: "avgSeatView", label: "上座率", raw: movie.avgSeatView },
    {
      key: "forecast",
      label: "预测票房",
      raw: forecastRaw,
      trend: forecastTrend,
    },
  ]
    .filter((item) => !isEmptyField(item.raw))
    .map((item) => ({
      ...item,
      value:
        item.key === "forecast"
          ? `${escapeHtml(item.raw)}${trendArrow(item.trend)}`
          : escapeHtml(item.raw),
    }));

  if (!metrics.length) return "";

  return `<div class="movie-card__metrics movie-card__metrics--podium">${metrics
    .map(
      (item) =>
        `<div class="metric" data-metric="${item.key}"><span class="metric__label">${item.label}</span><span class="metric__value">${item.value}</span></div>`
    )
    .join("")}</div>`;
}

function formatMetricValue(item) {
  if (item.key === "dynamicForecast") {
    return isEmptyField(item.raw)
      ? ""
      : `${escapeHtml(item.raw)}${trendArrow(item.trend)}`;
  }
  if (item.key === "totalForecast") {
    return isEmptyField(item.raw)
      ? ""
      : `${escapeHtml(item.raw)}${trendArrow(item.trend)}`;
  }
  return escapeHtml(item.raw);
}

function buildMetricsHtml(movie, options = {}) {
  const metrics = [
    { key: "dailyIncrease", label: "日增", raw: movie.dailyIncrease },
    { key: "hourSpeed", label: "时速", raw: movie.hourSpeedText },
    {
      key: "dynamicForecast",
      label: "动态预测",
      raw: movie.dynamicForecast,
      trend: movie.dynamicTrend,
    },
    { key: "yesterdayTotal", label: "昨日", raw: movie.yesterdayTotal },
    { key: "yesterdayHourSpeed", label: "昨日时速", raw: movie.yesterdayHourSpeedText },
    { key: "yesterdaySamePeriod", label: "昨日同期", raw: movie.yesterdaySamePeriodText },
    { key: "totalViews", label: "总人次", raw: movie.totalViews },
    {
      key: "totalForecast",
      label: "总预测",
      raw: movie.totalForecast,
      trend: movie.totalTrend,
    },
  ]
    .filter((item) => {
      if (options.hideDailyIncrease && item.key === "dailyIncrease") return false;
      return !isEmptyField(item.raw);
    })
    .map((item) => ({ ...item, value: formatMetricValue(item) }))
    .filter((item) => !isEmptyField(item.value));

  if (!metrics.length) return "";

  return `<div class="movie-card__metrics">${metrics
    .map(
      (item) =>
        `<div class="metric" data-metric="${item.key}"><span class="metric__label">${item.label}</span><span class="metric__value">${item.value}</span></div>`
    )
    .join("")}</div>`;
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

function dailyTableHtml(rows, rank = 99) {
  const filteredRows = (rows || []).filter(
    (row) =>
      !isEmptyField(row.box) ||
      !isEmptyField(row.boxHtml) ||
      !isEmptyField(row.forecast) ||
      !isEmptyField(row.boxRate) ||
      !isEmptyField(row.showCountRate) ||
      !isEmptyField(row.avgSeatView)
  );
  if (!filteredRows.length) return "";

  if (rank > 3 && filteredRows.length === 1) {
    const row = filteredRows[0];
    const hasExtraData =
      !isEmptyField(row.forecast) ||
      !isEmptyField(row.boxRate) ||
      !isEmptyField(row.showCountRate) ||
      !isEmptyField(row.avgSeatView);
    if (!hasExtraData) return "";
  }

  const columns = [
    {
      key: "box",
      label: "票房(含预售)",
      render: (row) => {
        if (row.boxHtml) {
          return `<span class="mtsi-font js-day-box">${row.boxHtml}</span><span class="unit">${escapeHtml(row.boxUnit || "万")}</span>`;
        }
        return escapeHtml(row.box);
      },
      hasValue: (row) => !isEmptyField(row.box) || !isEmptyField(row.boxHtml),
    },
    {
      key: "forecast",
      label: "预测",
      render: (row) => escapeHtml(row.forecast),
      hasValue: (row) => !isEmptyField(row.forecast),
    },
    {
      key: "boxRate",
      label: "票房%",
      render: (row) => escapeHtml(row.boxRate),
      hasValue: (row) => !isEmptyField(row.boxRate),
    },
    {
      key: "showCountRate",
      label: "排片",
      render: (row) => escapeHtml(row.showCountRate),
      hasValue: (row) => !isEmptyField(row.showCountRate),
    },
    {
      key: "avgSeatView",
      label: "上座率",
      render: (row) => escapeHtml(row.avgSeatView),
      hasValue: (row) => !isEmptyField(row.avgSeatView),
    },
  ].filter((col) => filteredRows.some((row) => col.hasValue(row)));

  if (!columns.length) return "";

  const head = `<tr><th>日期</th>${columns
    .map((col) => `<th>${col.label}</th>`)
    .join("")}</tr>`;
  const body = filteredRows
    .map((row) => {
      const cells = columns.map((col) => `<td class="num">${col.render(row)}</td>`).join("");
      return `<tr><td>${escapeHtml(row.label)}</td>${cells}</tr>`;
    })
    .join("");

  return `<table class="movie-card__table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildTodayBoxHtml(movie) {
  if (movie.todayBoxHtml) {
    return `<span class="podium-slot__box-value mtsi-font js-today-box">${movie.todayBoxHtml}</span><span class="podium-slot__box-unit">${escapeHtml(movie.todayUnit || "万")}</span>`;
  }
  if (!isEmptyField(movie.dailyIncrease)) {
    return `<span class="podium-slot__box-value js-today-box">${escapeHtml(movie.dailyIncrease)}</span>`;
  }
  return "";
}

function podiumTemplate(movie) {
  const todayBox = buildTodayBoxHtml(movie);

  return `
    <div class="podium-slot__panel">
      <h2 class="podium-slot__title">《${escapeHtml(movie.name)}》</h2>
      ${todayBox ? `<div class="podium-slot__box">${todayBox}</div>` : ""}
      ${buildPodiumMainlandHtml(movie)}
      ${buildPodiumMetricsHtml(movie)}
    </div>
    <div class="podium-slot__stand">
      <span class="podium-slot__medal">TOP ${movie.rank}</span>
    </div>
  `;
}

function compactRowTemplate(movie) {
  return `
    <span class="compact-row__rank">${movie.rank}</span>
    <span class="compact-row__title">《${escapeHtml(movie.name)}》</span>
    <span class="compact-row__stats">${buildCompactRowStatsHtml(movie)}</span>
  `;
}

function updateCompactRowDelta(row, movie, isNew) {
  const deltaEl = row.querySelector(".compact-row__delta");
  if (!deltaEl) return;

  const key = String(movie.movieId);
  const unit = movie.todayUnit || "万";
  const stored = prevValues.get(key);
  const storedHtml = prevBoxHtml.get(key);
  const decoded = getMovieBoxAmount(movie);
  let delta = 0;

  if (!isNew && movie.todayBoxHtml && storedHtml && storedHtml !== movie.todayBoxHtml) {
    delta = computeBoxIncrease(stored, storedHtml, movie.todayBoxHtml, unit);
  } else if (!isNew && decoded > 0 && stored != null && decoded > stored) {
    delta = decoded - stored;
  }

  if (delta > 0) {
    const text = `${formatDelta(delta, unit)} ↑`;
    deltaEl.textContent = text;
    deltaEl.classList.add("has-rise");
    lastDeltaDisplay.set(key, { text, until: Date.now() + DELTA_PERSIST_MS });
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

function buildCompactRowStatsHtml(movie) {
  const lines = [];
  if (movie.todayBoxHtml) {
    lines.push(
      `<span class="compact-row__box"><span class="mtsi-font js-today-box">${movie.todayBoxHtml}</span><em>${escapeHtml(movie.todayUnit || "万")}</em></span>`
    );
  } else if (!isEmptyField(movie.dailyIncrease)) {
    lines.push(
      `<span class="compact-row__box"><span class="js-today-box">${escapeHtml(movie.dailyIncrease)}</span></span>`
    );
  }

  const forecast = !isEmptyField(movie.dynamicForecast)
    ? movie.dynamicForecast
    : movie.totalForecast;
  const forecastTrend = !isEmptyField(movie.dynamicForecast)
    ? movie.dynamicTrend
    : movie.totalTrend;
  if (!isEmptyField(forecast)) {
    lines.push(
      `<span class="compact-row__forecast">预测 ${escapeHtml(forecast)}${trendArrow(forecastTrend)}</span>`
    );
  }

  lines.push(`<span class="compact-row__delta"></span>`);
  return lines.join("");
}

function buildPodiumCard(movie) {
  const card = document.createElement("article");
  card.className = `podium-slot__card podium-slot__card--rank${movie.rank}`;
  card.dataset.movieId = String(movie.movieId);
  card.dataset.rank = String(movie.rank);
  card.innerHTML = podiumTemplate(movie);
  return card;
}

function buildCompactRow(movie) {
  const row = document.createElement("article");
  row.className = "compact-row";
  row.dataset.movieId = String(movie.movieId);
  row.dataset.rank = String(movie.rank);
  row.innerHTML = compactRowTemplate(movie);
  return row;
}

function setTextIfChanged(el, next) {
  if (!el || el.textContent === next) return;
  el.textContent = next;
}

function getBoxAnchor(card) {
  return (
    card.querySelector(".js-today-box") ||
    card.querySelector(".compact-row__box") ||
    card.querySelector(".podium-slot__box") ||
    card.querySelector('[data-metric="dailyIncrease"] .metric__value') ||
    card.querySelector(".js-day-box")
  );
}

function trackBoxDelta(card, movie, isNew) {
  const key = String(movie.movieId);
  const unit = movie.todayUnit || "万";
  const stored = prevValues.get(key);
  const storedHtml = prevBoxHtml.get(key);
  const decoded = getMovieBoxAmount(movie);
  const anchor = getBoxAnchor(card);

  if (movie.todayBoxHtml) {
    const next = safeDecodeBox(movie.todayBoxHtml, unit);
    if (storedHtml !== movie.todayBoxHtml) {
      maybeShowBoxIncrease(anchor, stored, storedHtml, movie.todayBoxHtml, unit, isNew);
      if (next > 0 || !storedHtml) prevBoxHtml.set(key, movie.todayBoxHtml);
    }
    if (next > 0) prevValues.set(key, next);
    else if (decoded > 0) prevValues.set(key, decoded);
  } else if (decoded > 0) {
    if (!isNew && stored != null && decoded > stored) {
      showBoxDeltaWhenReady(anchor, decoded - stored, unit);
    }
    prevValues.set(key, decoded);
  }
}

function updatePodiumCard(card, movie, isNew = false) {
  card.className = `podium-slot__card podium-slot__card--rank${movie.rank}`;
  card.dataset.rank = String(movie.rank);

  const panel = card.querySelector(".podium-slot__panel");
  if (!panel) {
    card.innerHTML = podiumTemplate(movie);
    trackBoxDelta(card, movie, isNew);
    return;
  }

  const titleEl = card.querySelector(".podium-slot__title");
  const medalEl = card.querySelector(".podium-slot__medal");
  if (titleEl) titleEl.textContent = `《${movie.name}》`;
  if (medalEl) medalEl.textContent = `TOP ${movie.rank}`;

  const todayBox = buildTodayBoxHtml(movie);
  let boxEl = card.querySelector(".podium-slot__box");
  if (todayBox) {
    if (!boxEl) {
      boxEl = document.createElement("div");
      boxEl.className = "podium-slot__box";
      titleEl?.insertAdjacentElement("afterend", boxEl);
    }
    boxEl.style.display = "";
    boxEl.innerHTML = todayBox;
  } else if (boxEl) {
    boxEl.style.display = "none";
  }

  const mainlandHtml = buildPodiumMainlandHtml(movie);
  let mainlandEl = card.querySelector(".movie-card__regions--mainland");
  if (mainlandHtml) {
    if (mainlandEl) mainlandEl.outerHTML = mainlandHtml;
    else (boxEl || titleEl)?.insertAdjacentHTML("afterend", mainlandHtml);
  } else if (mainlandEl) {
    mainlandEl.remove();
  }

  const metricsHtml = buildPodiumMetricsHtml(movie);
  let metricsEl = card.querySelector(".movie-card__metrics--podium");
  if (metricsHtml) {
    if (metricsEl) metricsEl.outerHTML = metricsHtml;
    else panel.insertAdjacentHTML("beforeend", metricsHtml);
  } else if (metricsEl) {
    metricsEl.remove();
  }

  trackBoxDelta(card, movie, isNew);
}

function updateCompactRow(row, movie, isNew = false) {
  row.dataset.rank = String(movie.rank);

  const rankEl = row.querySelector(".compact-row__rank");
  const titleEl = row.querySelector(".compact-row__title");
  const statsEl = row.querySelector(".compact-row__stats");
  if (!rankEl || !titleEl || !statsEl) {
    row.innerHTML = compactRowTemplate(movie);
    updateCompactRowDelta(row, movie, isNew);
    trackBoxDelta(row, movie, isNew);
    return;
  }

  rankEl.textContent = String(movie.rank);
  titleEl.textContent = `《${movie.name}》`;
  statsEl.innerHTML = buildCompactRowStatsHtml(movie);
  updateCompactRowDelta(row, movie, isNew);
  trackBoxDelta(row, movie, isNew);
}

function isFirstSeen(movieId) {
  const key = String(movieId);
  return !prevBoxHtml.has(key) && !prevValues.has(key);
}

function ensurePodiumCard(movie) {
  const key = String(movie.movieId);
  let card = cardPool.get(key);
  if (!card || !card.classList.contains("podium-slot__card")) {
    card?.remove();
    card = buildPodiumCard(movie);
    cardPool.set(key, card);
    trackBoxDelta(card, movie, isFirstSeen(key));
    return card;
  }
  updatePodiumCard(card, movie, isFirstSeen(key));
  return card;
}

function ensureCompactRow(movie) {
  const key = String(movie.movieId);
  let row = cardPool.get(key);
  if (!row || !row.classList.contains("compact-row")) {
    row?.remove();
    row = buildCompactRow(movie);
    cardPool.set(key, row);
    trackBoxDelta(row, movie, isFirstSeen(key));
    return row;
  }
  updateCompactRow(row, movie, isFirstSeen(key));
  return row;
}

function mountPodiumSlot(slotEl, card) {
  if (!slotEl) return;
  slotEl.replaceChildren(card);
}

function renderList(movies) {
  if (!podiumEl || !compactListEl) return;

  const activeIds = new Set(movies.map((m) => String(m.movieId)));

  for (const [id, card] of cardPool) {
    if (!activeIds.has(id)) {
      card.remove();
      purgeMovieState(id);
    }
  }

  const top3 = movies.filter((m) => m.rank <= 3);
  const rest = movies.filter((m) => m.rank > 3);
  const top3Ids = new Set(top3.map((m) => String(m.movieId)));
  const restIds = new Set(rest.map((m) => String(m.movieId)));

  for (const slotRank of PODIUM_SLOTS) {
    const slotEl = podiumEl.querySelector(`[data-slot="${slotRank}"]`);
    const movie = top3.find((m) => m.rank === slotRank);
    if (!movie) {
      slotEl?.replaceChildren();
      continue;
    }

    const card = ensurePodiumCard(movie);
    mountPodiumSlot(slotEl, card);
  }

  [...compactListEl.children].forEach((row) => {
    const id = row.dataset.movieId;
    if (!restIds.has(id)) {
      row.remove();
      if (!top3Ids.has(id)) purgeMovieState(id);
    }
  });

  for (const movie of rest) {
    const row = ensureCompactRow(movie);
    const index = movie.rank - 4;
    const ref = compactListEl.children[index];
    if (ref !== row) compactListEl.insertBefore(row, ref || null);
  }
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

function updateNation(nation, parsed) {
  nation = stabilizeNation(nation);
  const unitEl = document.querySelector(".js-nation-unit");
  const unit = nation.todayUnit || "万";
  const prevNation = prevValues.get("__nation__");
  const prevHtml = prevBoxHtml.get("__nation__");

  if (nation.todayBoxHtml) {
    const changed = prevHtml !== nation.todayBoxHtml;
    const nationAmount = nation.todayBox > 0
      ? nation.todayBox
      : safeDecodeBox(nation.todayBoxHtml, unit);
    if (changed) {
      maybeShowBoxIncrease(
        nationBoxEl,
        prevNation,
        prevHtml,
        nation.todayBoxHtml,
        unit,
        prevNation == null
      );
      setEncodedBoxValue(nationBoxEl, nation.todayBoxHtml);
      if (nationAmount > 0 || !prevHtml) prevBoxHtml.set("__nation__", nation.todayBoxHtml);
    }
    if (nationAmount > 0) prevValues.set("__nation__", nationAmount);
  }

  if (unitEl) unitEl.textContent = unit;
  setTextIfChanged(nationShowsEl, nation.showCountDesc);
  setTextIfChanged(nationViewsEl, nation.viewCountDesc);

  const showsItem = nationShowsEl?.closest(".hero__nation-item");
  const viewsItem = nationViewsEl?.closest(".hero__nation-item");
  showsItem?.classList.toggle("is-hidden", isEmptyField(nation.showCountDesc));
  viewsItem?.classList.toggle("is-hidden", isEmptyField(nation.viewCountDesc));
  document.querySelectorAll(".hero__nation-divider").forEach((divider) => {
    const prevHidden = divider.previousElementSibling?.classList.contains("is-hidden");
    const nextHidden = divider.nextElementSibling?.classList.contains("is-hidden");
    divider.classList.toggle("is-hidden", prevHidden || nextHidden);
  });

  if (updateTimeEl) {
    const ts = parsed.updateTimeText || new Date().toLocaleString("zh-CN");
    const timePart = String(ts).includes(" ")
      ? String(ts).split(" ").pop()
      : new Date().toLocaleTimeString("zh-CN", { hour12: false });
    updateTimeEl.textContent = `更新于 ${timePart}`;
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
      renderList(movies);
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
      (m) => m.todayBoxHtml && getMovieBoxAmount(stabilizeMovie(m)) <= 0
    );
    if (!needsRetry) return;
    const movies = enrichMoviesQuick(latestMovies, latestSpeedMap).map(stabilizeMovie);
    renderList(movies);
  }, 600);
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
    await injectFontStyle(raw.fontStyle);

    const parsed = parseDashboard(raw, config.topCount || 10);
    if (!parsed.movies.length) {
      if (!hasDisplayedData) setStatus("loading", "等待票房数据…");
      return;
    }

    pollGeneration += 1;
    latestMovies = parsed.movies;
    const speed = buildSpeedMap(parsed.movies);
    latestSpeedMap = speed;
    const movies = enrichMoviesQuick(parsed.movies, speed).map(stabilizeMovie);

    renderList(movies);
    updateNation(parsed.nation, parsed);

    hasDisplayedData = true;
    setStatus("ok", "");
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
