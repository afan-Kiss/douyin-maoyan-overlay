/** 内置票房服务 API */

export class MaoyanApiError extends Error {
  constructor(message, { code = "api_error", detail = "", action = null, retryable = false } = {}) {
    super(message || detail || code);
    this.name = "MaoyanApiError";
    this.code = code;
    this.detail = detail || message;
    this.action = action;
    this.retryable = retryable;
  }
}

async function readApiError(resp) {
  const body = await resp.json().catch(() => ({}));
  return new MaoyanApiError(body.detail || `请求失败 ${resp.status}`, {
    code: body.code || `http_${resp.status}`,
    detail: body.detail || `请求失败 ${resp.status}`,
    action: body.action || null,
    retryable: body.retryable === true,
  });
}

const DASHBOARD_PARAMS = {
  orderType: "0",
  uuid: "",
  timeStamp: "",
  "User-Agent": "",
  index: "240",
  channelId: "40009",
  sVersion: "2",
  signKey: "",
  WuKongReady: "h5",
  force_refresh: "true",
};

export async function fetchDashboard(apiBase, movieId = "") {
  const url =
    `${apiBase}/i/api/dashboard-ajax/movie?` +
    new URLSearchParams({ ...DASHBOARD_PARAMS, movieId: String(movieId || "") });
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw await readApiError(resp);
  return resp.json();
}

async function fetchMovieApi(apiBase, apiPath, movieId, extra = {}, timeoutMs = 20000) {
  const url =
    `${apiBase}${apiPath}?` +
    new URLSearchParams({ movieId: String(movieId), WuKongReady: "h5", ...extra });
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw await readApiError(resp);
  return resp.json();
}

let apiSigWarmed = false;
let lastEnrichErrors = [];
let warmLastError = null;

export function resetApiSigWarm() {
  apiSigWarmed = false;
  warmLastError = null;
}

export function getWarmLastError() {
  return warmLastError ? { ...warmLastError } : null;
}

export function getLastEnrichErrors() {
  return lastEnrichErrors.slice();
}

function summarizeEnrichError(error) {
  if (error instanceof MaoyanApiError) {
    return {
      code: error.code,
      detail: error.detail,
      action: error.action,
    };
  }
  return {
    code: "api_error",
    detail: error?.message || "请求失败",
    action: null,
  };
}

async function warmMovieApiSignatures(apiBase, movieId) {
  if (apiSigWarmed || !apiBase || !movieId) return true;
  const url =
    `${apiBase}/api/refresh?` +
    new URLSearchParams({ movieId: String(movieId), boxLevel: "1" });
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!resp.ok) {
      const err = await readApiError(resp);
      warmLastError = summarizeEnrichError(err);
      throw err;
    }
    apiSigWarmed = true;
    warmLastError = null;
    return true;
  } catch (error) {
    warmLastError = summarizeEnrichError(error);
    throw error instanceof MaoyanApiError
      ? error
      : new MaoyanApiError(warmLastError.detail, warmLastError);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBoxShow(apiBase, movieId, boxLevel = 1) {
  return fetchMovieApi(apiBase, "/i/api/movie/getBoxShow", movieId, {
    boxLevel: String(boxLevel),
    yodaReady: "h5",
    csecplatform: "4",
    csecversion: "4.3.0",
  });
}

export async function fetchPredictionBox(apiBase, movieId) {
  return fetchMovieApi(apiBase, "/i/api/movie/getPredictionBox", movieId);
}

export async function fetchBoxShowna(apiBase, movieId) {
  return fetchMovieApi(apiBase, "/i/api/movie/getBoxShowna", movieId);
}

export async function fetchTechData(apiBase, movieId) {
  return fetchMovieApi(apiBase, "/i/api/movie/getTechData", movieId);
}

let decoderEl = null;
let fontReady = false;
let lastFontStyle = "";
const puaDigitMap = new Map();
let decodeCanvas = null;
let decodeCtx = null;

function ensureDecoder() {
  if (decoderEl) return decoderEl;
  decoderEl = document.createElement("span");
  decoderEl.className = "mtsi-font";
  decoderEl.setAttribute("aria-hidden", "true");
  decoderEl.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;font-size:16px;";
  document.body.appendChild(decoderEl);
  return decoderEl;
}

function normalizeFontCss(fontStyle) {
  return String(fontStyle || "")
    .replace(/url\("\/\//g, 'url("https://')
    .replace(/url\('\/\//g, "url('https://")
    .replace(/url\(\/\//g, "url(https://");
}

function hasPrivateUseChars(text) {
  return /[\uE000-\uF8FF]/.test(text);
}

function ensureDecodeCanvas() {
  if (!decodeCanvas) {
    decodeCanvas = document.createElement("canvas");
    decodeCanvas.width = 100;
    decodeCanvas.height = 100;
    decodeCtx = decodeCanvas.getContext("2d", { willReadFrequently: true });
    decodeCtx.textBaseline = "top";
  }
  return decodeCtx;
}

function getGlyphBitmap(font, text, fillStyle = "#000") {
  const ctx = ensureDecodeCanvas();
  ctx.clearRect(0, 0, 100, 100);
  ctx.fillStyle = fillStyle;
  ctx.font = font;
  ctx.fillText(text, 10, 10);
  const data = ctx.getImageData(0, 0, 100, 100).data;
  const bitmap = new Uint8Array(data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    bitmap[i / 4] = data[i] || data[i + 1] || data[i + 2] || data[i + 3] ? 1 : 0;
  }
  return bitmap;
}

function bitmapSimilarity(a, b) {
  let same = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) same++;
  }
  return same;
}

function guessDigitFromPua(charCode) {
  if (puaDigitMap.has(charCode)) return puaDigitMap.get(charCode);
  const ch = String.fromCharCode(charCode);
  const target = getGlyphBitmap('80px "mtsi-font"', ch);
  let max = 0;
  let digit = 0;
  for (let d = 0; d < 10; d++) {
    const guess = getGlyphBitmap('72px Arial, Helvetica, sans-serif', String(d), "#ff0000");
    const score = bitmapSimilarity(target, guess);
    if (score > max) {
      max = score;
      digit = d;
    }
  }
  puaDigitMap.set(charCode, digit);
  return digit;
}

function decodePuaString(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xe000 && code <= 0xf8ff) {
      out += guessDigitFromPua(code);
    } else {
      out += ch;
    }
  }
  return out;
}

async function waitForMtsiFont(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await document.fonts.load('16px "mtsi-font"');
      await document.fonts.ready;
      if (document.fonts.check('16px "mtsi-font"')) {
        fontReady = true;
        return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  fontReady = false;
  return false;
}

export async function injectFontStyle(fontStyle) {
  const remoteCss = normalizeFontCss(fontStyle);
  if (remoteCss && remoteCss === lastFontStyle && fontReady) return;
  if (remoteCss) {
    let el = document.getElementById("maoyan-font-style");
    if (!el) {
      el = document.createElement("style");
      el.id = "maoyan-font-style";
      document.head.appendChild(el);
    }
    if (remoteCss !== lastFontStyle) {
      puaDigitMap.clear();
    }
    el.textContent = remoteCss;
    lastFontStyle = remoteCss;
    fontReady = false;
    await waitForMtsiFont();
  } else if (!fontReady) {
    await waitForMtsiFont();
  }
}

export function decodeFontNum(numHtml) {
  if (!numHtml) return "";
  if (typeof document === "undefined") {
    return String(numHtml).replace(/<[^>]+>/g, "").trim();
  }
  const el = ensureDecoder();
  el.innerHTML = numHtml;
  const text = (el.textContent || "").trim();
  if (!text) return "";
  if (hasPrivateUseChars(text)) {
    return fontReady ? decodePuaString(text) : "";
  }
  return text;
}

export function parseRate(rateStr) {
  if (!rateStr) return 0;
  const n = parseFloat(String(rateStr).replace("%", "").replace("<", ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseBoxNum(text, unit = "万") {
  if (!text) return 0;
  const s = String(text).replace(/,/g, "").trim();
  if (!s || s === "--") return 0;
  if (s.includes("亿")) {
    const n = parseFloat(s.replace(/亿/g, ""));
    return Number.isFinite(n) ? n * 10000 : 0;
  }
  if (s.endsWith("万")) {
    const n = parseFloat(s.replace(/万/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (unit === "亿") return n * 10000;
  return n;
}

function resolveTodayBox(todayRaw, todayUnit) {
  let todayBox = parseBoxNum(todayRaw, todayUnit);
  if (todayBox > 0) return todayBox;
  if (todayRaw) {
    const retry = parseBoxNum(todayRaw.replace(/[^\d.]/g, ""), todayUnit);
    if (retry > 0) return retry;
  }
  return 0;
}

function normalizeUnit(unit) {
  const decoded = decodeFontNum(unit) || String(unit || "").trim();
  if (!decoded || decoded === "万") return "万";
  return decoded;
}

export function decodeBoxFromHtml(numHtml, unit = "万") {
  return resolveTodayBox(decodeFontNum(numHtml), unit);
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatMoneyWan(n, prefix = "¥") {
  if (!Number.isFinite(n) || n <= 0) return "--";
  if (n >= 10000) {
    const yi = Math.floor(n / 10000);
    const rest = n - yi * 10000;
    if (rest < 0.01) return `${prefix}${yi}亿`;
    return `${prefix}${yi}亿${rest.toFixed(2)}万`;
  }
  return `${prefix}${n.toFixed(2)}万`;
}

function formatDescMoney(desc) {
  if (!desc || desc === "--") return "--";
  const s = String(desc).trim();
  if (s.startsWith("¥")) return s;
  if (s.includes("亿") || s.includes("万")) return `¥${s}`;
  return `¥${s}万`;
}

function unwrapPayload(raw) {
  return raw?.data?.data ?? raw?.data ?? raw;
}

function isFailedApiPayload(raw) {
  const inner = unwrapPayload(raw);
  if (!inner || typeof inner !== "object") return true;
  if (typeof inner.detail === "string" && inner.detail.trim()) {
    const msg = inner.detail.trim();
    if (
      /签名|不存在|失败|错误|超时|请刷新|请稍后再试|没找到浏览器/.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

function pickDescValue(...values) {
  for (const val of values) {
    if (val == null) continue;
    const text = String(val).trim();
    if (text && text !== "--" && text !== "-") return text;
  }
  return "";
}

function mapBoxShowRowsToDaily(rows, todayStr) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const sorted = [...rows]
    .filter((row) => row?.showDate)
    .sort((a, b) => Number(a.showDate) - Number(b.showDate));
  if (!sorted.length) return [];

  const todayKey = todayStr ? Number(String(todayStr).replace(/-/g, "")) : 0;
  let todayIdx = todayKey
    ? sorted.findIndex((row) => Number(row.showDate) === todayKey)
    : -1;
  if (todayIdx < 0) todayIdx = Math.max(0, sorted.length - 1);

  const labels = ["今日", "明日", "后天"];
  const result = [];
  for (let i = 0; i < 3; i++) {
    const row = sorted[todayIdx + i];
    if (!row) break;
    const box = pickDescValue(
      row.boxDesc,
      row.boxOfficeDesc,
      row.sumBoxDesc,
      row.splitBoxDesc,
      row.valueDesc
    );
    const forecast = pickDescValue(
      row.predictionDesc,
      row.predBoxDesc,
      row.forecastDesc,
      row.predictionBoxDesc,
      row.boxPredictionDesc
    );
    result.push({
      label: labels[i],
      box: box ? formatDescMoney(box) : "--",
      forecast: forecast ? formatDescMoney(forecast) : "--",
      boxRate: row.boxRate || row.boxOfficeRate || "--",
      showCountRate: row.showCountRate || "--",
      avgSeatView: row.viewSeatRate || row.avgSeatView || row.seatRate || "--",
    });
  }
  return result;
}

function deepFind(obj, keys, depth = 0) {
  if (!obj || depth > 6) return undefined;
  if (typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = deepFind(value, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function parseTrends(boxTrends, todayStr) {
  const trends = Array.isArray(boxTrends) ? boxTrends : [];
  if (!trends.length) {
    return { yesterdayBox: 0, yesterdayDesc: "--", todayTrendBox: 0, todayTrendDesc: "--" };
  }
  const todayKey = todayStr ? Number(todayStr.replace(/-/g, "")) : 0;
  let todayEntry = trends.find((t) => Number(t.date) === todayKey);
  let yesterdayEntry = null;
  if (todayEntry) {
    const idx = trends.indexOf(todayEntry);
    if (idx > 0) yesterdayEntry = trends[idx - 1];
  } else {
    todayEntry = trends[trends.length - 1];
    yesterdayEntry = trends.length > 1 ? trends[trends.length - 2] : null;
  }
  return {
    yesterdayBox: yesterdayEntry?.box ? yesterdayEntry.box / 10000 : 0,
    yesterdayDesc: yesterdayEntry?.boxDesc || "--",
    todayTrendBox: todayEntry?.box ? todayEntry.box / 10000 : 0,
    todayTrendDesc: todayEntry?.boxDesc || "--",
  };
}

function pickSeriesPoint(series, name) {
  const s = (series || []).find((item) => item.name === name);
  if (!s?.data?.length) return null;
  return s.data[s.data.length - 1];
}

function pickPrevSeriesPoint(series, name) {
  const s = (series || []).find((item) => item.name === name);
  if (!s?.data || s.data.length < 2) return null;
  return s.data[s.data.length - 2];
}

function parseBoxShowMetrics(raw, todayStr = "") {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const series = inner.timeChartData?.series || [];
  const solid = pickSeriesPoint(series, "time_solid");
  const prevSolid = pickPrevSeriesPoint(series, "time_solid");
  const yesterdaySolid = pickSeriesPoint(series, "time_yesterday");
  const prevYesterday = pickPrevSeriesPoint(series, "time_yesterday");

  const hourSpeed = solid && prevSolid
    ? Math.max(0, parseBoxNum(solid.tooltip?.val1, "万") - parseBoxNum(prevSolid.tooltip?.val1, "万"))
    : 0;

  const yesterdayHourSpeed = yesterdaySolid && prevYesterday
    ? Math.max(
        0,
        parseBoxNum(yesterdaySolid.tooltip?.val1, "万") - parseBoxNum(prevYesterday.tooltip?.val1, "万"),
      )
    : 0;

  const yesterdaySamePeriod = yesterdaySolid ? parseBoxNum(yesterdaySolid.tooltip?.val1, "万") : 0;

  const rows = Array.isArray(inner.boxDatas?.[0]) ? inner.boxDatas[0] : [];
  let latest = null;
  for (const row of rows) {
    if (!row?.showDate) continue;
    if (!latest || Number(row.showDate) > Number(latest.showDate)) latest = row;
  }

  const summaryList = inner.boxInfoDataRes?.[0]?.boxSummaryList || [];
  const summary = {};
  for (const item of summaryList) {
    if (item?.title) summary[item.title] = item;
  }

  const totalViews =
    summary["累计观影人次"]?.valueDesc ||
    summary["观影人次"]?.valueDesc ||
    latest?.viewCountDesc ||
    "--";

  return {
    hourSpeed,
    hourSpeedText: hourSpeed > 0 ? formatMoneyWan(hourSpeed) : "--",
    yesterdayHourSpeed,
    yesterdayHourSpeedText: yesterdayHourSpeed > 0 ? formatMoneyWan(yesterdayHourSpeed) : "--",
    yesterdaySamePeriod,
    yesterdaySamePeriodText: yesterdaySamePeriod > 0 ? formatMoneyWan(yesterdaySamePeriod) : "--",
    totalViews,
    presaleTotal: summary["累计综合票房(含预售)"]?.valueDesc || "--",
    dailyRows: mapBoxShowRowsToDaily(rows, todayStr),
  };
}

function parsePredictionMetrics(raw) {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const detailObj =
    inner.detail && typeof inner.detail === "object" && !Array.isArray(inner.detail)
      ? inner.detail
      : null;

  const list =
    inner.predictionBoxList ||
    inner.boxPredictionList ||
    inner.list ||
    inner.dayList ||
    detailObj?.predictionBoxList ||
    detailObj?.boxPredictionList ||
    detailObj?.list ||
    detailObj?.dayList ||
    [];

  const result = {
    dynamicForecast: "--",
    dynamicForecastNum: 0,
    dynamicTrend: "",
    totalForecast: "--",
    totalForecastNum: 0,
    totalTrend: "",
    dailyForecast: [],
  };

  if (Array.isArray(list)) {
    const dayLabels = ["今日", "明日", "后天"];
    for (let i = 0; i < Math.min(list.length, 3); i++) {
      const item = list[i];
      const boxRaw = pickDescValue(
        item.realBoxDesc,
        item.todayBoxDesc,
        item.boxOfficeDesc,
        item.splitBoxDesc,
        item.boxDesc
      );
      const forecastRaw = pickDescValue(
        item.predictionDesc,
        item.predBoxDesc,
        item.forecastDesc,
        item.predictionBoxDesc,
        item.valueDesc,
        item.boxDesc
      );
      result.dailyForecast.push({
        label: item.dateDesc || item.title || item.dayDesc || dayLabels[i] || `D+${i}`,
        forecast: forecastRaw ? formatDescMoney(forecastRaw) : "--",
        box: boxRaw ? formatDescMoney(boxRaw) : "--",
        boxRate: item.boxRate || item.boxOfficeRate || "--",
        showCountRate: item.showCountRate || "--",
        avgSeatView: item.viewSeatRate || item.avgSeatView || item.seatRate || "--",
      });
    }
    const todayItem = list[0];
    if (todayItem) {
      const val = todayItem.boxDesc || todayItem.valueDesc || todayItem.predictionDesc;
      result.dynamicForecast = val || "--";
      result.dynamicForecastNum = parseBoxNum(val);
      result.dynamicTrend = todayItem.trend || todayItem.changeTrend || "";
    }
    const totalItem = list.find((x) => /总/.test(x.title || x.dateDesc || "")) || list[list.length - 1];
    if (totalItem) {
      const val = totalItem.boxDesc || totalItem.valueDesc || totalItem.sumBoxDesc;
      result.totalForecast = val ? formatDescMoney(val) : "--";
      result.totalForecastNum = parseBoxNum(val);
      result.totalTrend = totalItem.trend || totalItem.changeTrend || "";
    }
  }

  const dynamic =
    inner.dynamicPrediction ||
    inner.todayPrediction ||
    inner.predictionBox ||
    inner.boxPrediction;
  if (dynamic) {
    const val = dynamic.boxDesc || dynamic.valueDesc || dynamic.numDesc;
    if (val) {
      result.dynamicForecast = val.includes("万") || val.includes("亿") ? formatDescMoney(val) : `${val}万`;
      result.dynamicForecastNum = parseBoxNum(val);
      result.dynamicTrend = dynamic.trend || dynamic.changeTrend || result.dynamicTrend;
    }
  }

  const total = inner.sumPrediction || inner.totalPrediction || inner.finalPrediction;
  if (total) {
    const val = total.boxDesc || total.valueDesc || total.sumBoxDesc;
    if (val) {
      result.totalForecast = formatDescMoney(val);
      result.totalForecastNum = parseBoxNum(val);
      result.totalTrend = total.trend || total.changeTrend || result.totalTrend;
    }
  }

  return result;
}

function parseGlobalMetrics(raw) {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const hmt =
    deepFind(inner, ["hmtBoxDesc", "gatBoxDesc", "chinaGatBoxDesc", "hmtSumBoxDesc"]) ||
    findRegionBox(inner, ["港澳台", "中国港澳台", "港澳台地区"]);
  const overseas =
    deepFind(inner, ["overseasBoxDesc", "foreignBoxDesc", "abroadBoxDesc", "overseaBoxDesc"]) ||
    findRegionBox(inner, ["海外", "国外", "境外"]);
  const mainland =
    deepFind(inner, ["chinaBoxDesc", "mainlandBoxDesc", "sumBoxDesc", "boxDesc"]) ||
    findRegionBox(inner, ["中国内地", "大陆", "国内"]);

  return {
    mainland: mainland ? formatDescMoney(mainland) : "--",
    hmt: hmt ? formatDescMoney(hmt) : "--",
    overseas: overseas ? formatDescMoney(overseas) : "--",
  };
}

function findRegionBox(obj, labels) {
  const items = obj?.boxList || obj?.areaList || obj?.regionList || obj?.list || [];
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const name = item.name || item.title || item.areaName || item.regionName || "";
    if (labels.some((l) => name.includes(l))) {
      return item.boxDesc || item.sumBoxDesc || item.valueDesc;
    }
  }
  return undefined;
}

function parseTechMetrics(raw) {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const endDate =
    inner.endDate ||
    inner.offlineDate ||
    inner.lastShowDate ||
    inner.endShowDate ||
    deepFind(inner, ["endDate", "offlineDate", "lastShowDate"]);

  let endDateStr = "--";
  let remainingDays = "--";

  if (endDate) {
    if (typeof endDate === "number" && String(endDate).length === 8) {
      const s = String(endDate);
      endDateStr = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    } else {
      endDateStr = String(endDate).slice(0, 10);
    }
    const end = new Date(endDateStr);
    const now = new Date();
    if (!Number.isNaN(end.getTime())) {
      const diff = Math.ceil((end - now) / 86400000);
      remainingDays = diff >= 0 ? String(diff) : "0";
    }
  } else if (inner.remainingDays != null) {
    remainingDays = String(inner.remainingDays);
    endDateStr = inner.endDateDesc || "--";
  }

  return { endDate: endDateStr, remainingDays };
}

function mapDashboardItem(item, index) {
  const info = item.movieInfo || {};
  const todayBoxHtml = item.boxSplitUnit?.num || "";
  const todayUnit = normalizeUnit(item.boxSplitUnit?.unit);
  const todayRaw = decodeFontNum(todayBoxHtml);
  const todayBox = resolveTodayBox(todayRaw, todayUnit);
  const splitHtml = item.splitBoxSplitUnit?.num || "";
  const splitUnit = normalizeUnit(item.splitBoxSplitUnit?.unit);
  const splitRaw = decodeFontNum(splitHtml);

  return {
    rank: index + 1,
    movieId: info.movieId ?? `unknown-${index}`,
    name: info.movieName || "未知",
    releaseInfo: info.releaseInfo || "",
    todayBox,
    todayBoxHtml,
    todayUnit,
    todayBoxText: todayRaw || "--",
    boxRate: item.boxRate || "--",
    boxRateNum: parseRate(item.boxRate),
    splitBoxRate: item.splitBoxRate || "--",
    splitBoxRateNum: parseRate(item.splitBoxRate),
    splitBoxHtml: splitHtml,
    splitBoxText: splitRaw || "--",
    splitBoxUnit: splitUnit,
    showCount: item.showCount ?? 0,
    showCountRate: item.showCountRate || "--",
    avgShowView: item.avgShowView || "--",
    avgSeatView: item.avgSeatView || "--",
    sumBoxDesc: item.sumBoxDesc || "--",
    sumSplitBoxDesc: item.sumSplitBoxDesc || "--",
  };
}

export function parseDashboard(raw, topCount = 5) {
  const list = raw?.movieList?.list ?? [];
  const nation = raw?.movieList?.nationBoxInfo ?? {};
  const updateInfo = raw?.movieList?.updateInfo ?? {};
  const calendar = raw?.calendar ?? {};
  const movies = list.slice(0, topCount).map(mapDashboardItem);

  const nationBoxHtml = nation.nationBoxSplitUnit?.num || "";
  const nationUnit = normalizeUnit(nation.nationBoxSplitUnit?.unit);
  const nationToday = decodeFontNum(nationBoxHtml);
  const nationBox = resolveTodayBox(nationToday, nationUnit);

  const nationSplitHtml = nation.nationSplitBoxSplitUnit?.num || "";
  const nationSplitUnit = normalizeUnit(nation.nationSplitBoxSplitUnit?.unit);
  const nationSplitRaw = decodeFontNum(nationSplitHtml);

  const globalTrends = parseTrends(raw?.movieInfo?.boxTrends, calendar.today);

  return {
    movies,
    nation: {
      title: nation.title || "实时大盘",
      todayBoxHtml: nationBoxHtml,
      todayUnit: nationUnit,
      todayBoxText: nationToday || "--",
      todayBox: nationBox,
      splitBoxHtml: nationSplitHtml,
      splitBoxText: nationSplitRaw || "--",
      splitBoxUnit: nationSplitUnit,
      showCountDesc: nation.showCountDesc || "--",
      viewCountDesc: nation.viewCountDesc || "--",
    },
    calendar: {
      today: calendar.today || "",
    },
    updateGapSecond: updateInfo.updateGapSecond || 5,
    updateTimestamp: updateInfo.updateTimestamp || Date.now(),
    updateTimeText: formatTimestamp(updateInfo.updateTimestamp) || "",
    fontStyle: raw?.fontStyle || "",
    updatedAt: Date.now(),
    globalTrends,
  };
}

export function mergeMovieDetail(base, detail = {}) {
  const trends = detail.trends || {};
  const boxShow = detail.boxShow || {};
  const prediction = detail.prediction || {};
  const global = detail.global || {};
  const tech = detail.tech || {};
  const speed = detail.speed || {};

  const dailyIncrease = base.todayBox > 0 ? formatMoneyWan(base.todayBox) : "--";
  const yesterdayDesc = trends.yesterdayDesc || "--";
  const yesterdayBox = trends.yesterdayBox || 0;

  let hourSpeedText = boxShow.hourSpeedText || "--";
  let hourSpeed = boxShow.hourSpeed || 0;
  if (!hourSpeed && speed.estimatedHourSpeed > 0) {
    hourSpeed = speed.estimatedHourSpeed;
    hourSpeedText = formatMoneyWan(hourSpeed);
  }

  let dynamicForecast = prediction.dynamicForecast || "--";
  let dynamicForecastNum = prediction.dynamicForecastNum || 0;
  let dynamicTrend = prediction.dynamicTrend || "";
  if (dynamicForecast === "--" && speed.estimatedDayForecast > 0) {
    dynamicForecastNum = speed.estimatedDayForecast;
    dynamicForecast = formatMoneyWan(dynamicForecastNum);
    dynamicTrend = speed.forecastTrend || "";
  }

  let yesterdaySamePeriodText = boxShow.yesterdaySamePeriodText || "--";
  if (yesterdaySamePeriodText === "--" && yesterdayBox > 0 && base.todayBox > 0) {
    const ratio = Math.min(1, base.todayBox / Math.max(yesterdayBox, 1));
    const est = yesterdayBox * ratio * 0.85;
    if (est > 0) yesterdaySamePeriodText = formatMoneyWan(est);
  }

  const dailyTable = buildDailyTable(base, prediction, detail);

  return {
    ...base,
    mainlandBox: global.mainland || formatDescMoney(base.sumBoxDesc),
    hmtBox: global.hmt || "--",
    overseasBox: global.overseas || "--",
    endDate: tech.endDate || "--",
    remainingDays: tech.remainingDays || "--",
    dailyIncrease,
    hourSpeed,
    hourSpeedText,
    dynamicForecast,
    dynamicForecastNum,
    dynamicTrend,
    yesterdayTotal: yesterdayDesc,
    yesterdayBox,
    yesterdayHourSpeedText: boxShow.yesterdayHourSpeedText || "--",
    yesterdaySamePeriodText,
    totalViews: boxShow.totalViews || "--",
    totalForecast: prediction.totalForecast || formatDescMoney(base.sumBoxDesc),
    totalForecastNum: prediction.totalForecastNum || parseBoxNum(base.sumBoxDesc),
    totalTrend: prediction.totalTrend || "",
    dailyTable,
    showCountDesc: base.showCount >= 10000
      ? `${(base.showCount / 10000).toFixed(1)}万`
      : String(base.showCount || "--"),
  };
}

function mergeDailyRowField(primary, fallback, isToday, todayFallback) {
  const pick = (val) => {
    const text = String(val ?? "").trim();
    return text && text !== "--" && text !== "-" ? text : "";
  };
  return (
    pick(primary) ||
    pick(fallback) ||
    (isToday ? pick(todayFallback) : "") ||
    "--"
  );
}

function buildDailyTable(base, prediction, detail) {
  const labels = ["今日", "明日", "后天"];
  const forecasts = prediction.dailyForecast || [];
  const boxShowRows = detail.boxShow?.dailyRows || [];
  const rows = [];

  for (let i = 0; i < 3; i++) {
    const pf = forecasts[i] || {};
    const bs = boxShowRows[i] || {};
    const isToday = i === 0;
    const todayBoxPlain =
      base.todayBox > 0
        ? `${base.todayBox.toFixed(2)}万`
        : base.todayBoxText !== "--"
          ? `${base.todayBoxText}万`
          : "";
    rows.push({
      label: pf.label || bs.label || labels[i],
      box: isToday
        ? todayBoxPlain || mergeDailyRowField(pf.box, bs.box, false, "")
        : mergeDailyRowField(pf.box, bs.box, false, ""),
      boxHtml: isToday ? base.todayBoxHtml : "",
      boxUnit: isToday ? base.todayUnit : "万",
      forecast: mergeDailyRowField(
        pf.forecast,
        bs.forecast,
        isToday,
        detail.speed?.estimatedDayForecastText || base.dynamicForecast
      ),
      boxRate: mergeDailyRowField(
        isToday ? base.boxRate : pf.boxRate,
        bs.boxRate,
        isToday,
        base.boxRate
      ),
      showCountRate: mergeDailyRowField(
        isToday ? base.showCountRate : pf.showCountRate,
        bs.showCountRate,
        isToday,
        base.showCountRate
      ),
      avgSeatView: mergeDailyRowField(
        isToday ? base.avgSeatView : pf.avgSeatView,
        bs.avgSeatView,
        isToday,
        base.avgSeatView
      ),
    });
  }
  return rows;
}

export function estimateSpeedMetrics(movieId, todayBox, prevSnapshot, elapsedMs) {
  if (!prevSnapshot || !Number.isFinite(todayBox) || todayBox <= 0) {
    return { estimatedHourSpeed: 0, estimatedDayForecast: 0, estimatedDayForecastText: "--", forecastTrend: "" };
  }
  const delta = todayBox - (prevSnapshot.box || 0);
  const elapsedHours = Math.max(elapsedMs / 3600000, 1 / 3600);
  const estimatedHourSpeed = delta > 0 ? delta / elapsedHours : 0;

  const now = new Date();
  const hoursElapsed = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const fraction = Math.max(hoursElapsed / 24, 0.04);
  const estimatedDayForecast = todayBox / fraction;

  let forecastTrend = "";
  if (prevSnapshot.forecast > 0) {
    if (estimatedDayForecast > prevSnapshot.forecast * 1.005) forecastTrend = "up";
    else if (estimatedDayForecast < prevSnapshot.forecast * 0.995) forecastTrend = "down";
  }

  return {
    estimatedHourSpeed,
    estimatedDayForecast,
    estimatedDayForecastText: estimatedDayForecast > 0 ? formatMoneyWan(estimatedDayForecast) : "--",
    forecastTrend,
  };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

async function fetchMovieTrends(apiBase, movie, todayStr) {
  try {
    const trendRaw = await Promise.race([
      fetchDashboard(apiBase, movie.movieId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("trend_timeout")), 10000)),
    ]);
    return parseTrends(trendRaw?.movieInfo?.boxTrends, trendRaw?.calendar?.today || todayStr);
  } catch {
    return {};
  }
}

export function enrichMoviesQuick(movies, speed = {}) {
  return movies.map((movie) =>
    mergeMovieDetail(movie, { speed: speed[String(movie.movieId)] || {} })
  );
}

async function fetchMovieExtraDetail(apiBase, movie, todayStr, speed = {}) {
  const detail = {
    trends: await fetchMovieTrends(apiBase, movie, todayStr),
    boxShow: {},
    prediction: {},
    global: {},
    tech: {},
    speed,
  };

  const extraErrors = [];
  const captureExtraError = (label, error) => {
    if (error) extraErrors.push({ label, error });
  };

  let predictionRaw = null;
  try {
    predictionRaw = await fetchPredictionBox(apiBase, movie.movieId);
  } catch (error) {
    captureExtraError("预测票房", error);
  }
  let parsedPrediction = predictionRaw ? parsePredictionMetrics(predictionRaw) : null;
  if (!parsedPrediction?.dailyForecast?.length) {
    await sleep(800);
    try {
      predictionRaw = await fetchPredictionBox(apiBase, movie.movieId);
      parsedPrediction = predictionRaw ? parsePredictionMetrics(predictionRaw) : null;
    } catch (error) {
      captureExtraError("预测票房", error);
    }
  }
  if (parsedPrediction) detail.prediction = parsedPrediction;

  const [boxShowRaw, globalRaw, techRaw] = await Promise.all([
    fetchBoxShow(apiBase, movie.movieId, 1).catch((error) => {
      captureExtraError("日期票房", error);
      return null;
    }),
    fetchBoxShowna(apiBase, movie.movieId).catch((error) => {
      captureExtraError("全球票房", error);
      return null;
    }),
    fetchTechData(apiBase, movie.movieId).catch((error) => {
      captureExtraError("下映时间", error);
      return null;
    }),
  ]);

  if (boxShowRaw) detail.boxShow = parseBoxShowMetrics(boxShowRaw, todayStr) || {};
  if (globalRaw) {
    const parsed = parseGlobalMetrics(globalRaw);
    if (parsed) detail.global = parsed;
  }
  if (techRaw) {
    const parsed = parseTechMetrics(techRaw);
    if (parsed) detail.tech = parsed;
  }

  detail.extraErrors = extraErrors;
  return detail;
}

export async function enrichMoviesLight(apiBase, movies, options = {}) {
  const concurrency = options.concurrency || 3;
  const todayStr = options.todayStr || "";
  // 仅前 trendLimit 名请求详细接口；其余排名依赖大盘 parseDashboard 字段
  const trendLimit = options.trendLimit ?? 5;
  const enableExtraApis = options.enableExtraApis !== false;
  const results = enrichMoviesQuick(movies, options.speed || {});

  const targets = movies.slice(0, trendLimit);
  const enriched = await mapPool(targets, concurrency, async (movie) => {
    const speed = options.speed?.[String(movie.movieId)] || {};
    if (!enableExtraApis) {
      const trends = await fetchMovieTrends(apiBase, movie, todayStr);
      return mergeMovieDetail(movie, { trends, speed });
    }
    const detail = await fetchMovieExtraDetail(apiBase, movie, todayStr, speed);
    return mergeMovieDetail(movie, detail);
  });

  for (let i = 0; i < enriched.length; i++) {
    const idx = movies.indexOf(targets[i]);
    if (idx >= 0) results[idx] = enriched[i];
  }
  return results;
}

export async function enrichMovies(apiBase, movies, options = {}) {
  const concurrency = options.concurrency || 2;
  const enableExtraApis = options.enableExtraApis !== false;
  const todayStr = options.todayStr || "";
  // 显示的前 trendLimit 名均走详细 enrich（默认与 TOP5 榜单一致）
  const trendLimit = options.trendLimit ?? 5;

  lastEnrichErrors = [];
  const results = enrichMoviesQuick(movies, options.speed || {});
  const targets = movies.slice(0, trendLimit);

  if (enableExtraApis && targets.length) {
    try {
      await warmMovieApiSignatures(apiBase, targets[0].movieId);
    } catch (error) {
      const warmErr = getWarmLastError() || summarizeEnrichError(error);
      lastEnrichErrors.push({ movieId: targets[0].movieId, label: "签名预热", ...warmErr });
    }
  }

  await mapPool(targets, concurrency, async (movie) => {
    const idx = movies.indexOf(movie);
    if (idx < 0) return;

    const speed = options.speed?.[String(movie.movieId)] || {};
    if (!enableExtraApis) {
      const trends = await fetchMovieTrends(apiBase, movie, todayStr);
      results[idx] = mergeMovieDetail(movie, { trends, speed });
      return;
    }

    const detail = await fetchMovieExtraDetail(apiBase, movie, todayStr, speed);
    for (const item of detail.extraErrors || []) {
      lastEnrichErrors.push({
        movieId: movie.movieId,
        label: item.label,
        ...summarizeEnrichError(item.error),
      });
    }
    results[idx] = mergeMovieDetail(movie, detail);
  });

  return results;
}
