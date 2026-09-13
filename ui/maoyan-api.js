/** 内置票房服务 API */

import {
  DECODE_STATUS,
  resolveDecodeStatus,
  resolveMaoyanSumBoxWan,
  sortDashboardMovies,
  pickOfficialDashboardMovies,
  rerankMoviesByTodayBox,
} from "./dashboard-rank.js";

export { DECODE_STATUS, rerankMoviesByTodayBox, resolveMaoyanSumBoxWan, pickOfficialDashboardMovies };

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
};

function mergeFetchSignal(parentSignal, timeoutMs) {
  const parts = [];
  if (parentSignal) parts.push(parentSignal);
  if (timeoutMs) parts.push(AbortSignal.timeout(timeoutMs));
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

const movieApiInflight = new Map();
const dashboardInflight = new Map();

function runClientInflight(store, key, fn) {
  if (store.has(key)) return store.get(key);
  const task = Promise.resolve()
    .then(fn)
    .finally(() => {
      store.delete(key);
    });
  store.set(key, task);
  return task;
}

export function resolveDisplayMovieCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(Math.floor(n), 20);
}

/** 保留完整猫眼列表，排名与 TOP N 截取在 parseDashboard 内完成 */
export function trimDashboardRaw(raw, _topCount) {
  return raw;
}

export async function fetchDashboard(apiBase, movieId = "", options = {}) {
  const params = { ...DASHBOARD_PARAMS, movieId: String(movieId || "") };
  const url = `${apiBase}/i/api/dashboard-ajax/movie?` + new URLSearchParams(params);
  const dedupeKey = url;
  return runClientInflight(dashboardInflight, dedupeKey, async () => {
    const resp = await fetch(url, { signal: mergeFetchSignal(options.signal, 25000) });
    if (!resp.ok) throw await readApiError(resp);
    return resp.json();
  });
}

async function fetchMovieApi(apiBase, apiPath, movieId, extra = {}, timeoutMs = 20000, parentSignal) {
  const dedupeKey = `${apiPath}:${movieId}:${JSON.stringify(extra)}`;
  return runClientInflight(movieApiInflight, dedupeKey, async () => {
    const url =
      `${apiBase}${apiPath}?` +
      new URLSearchParams({ movieId: String(movieId), WuKongReady: "h5", ...extra });
    const resp = await fetch(url, { signal: mergeFetchSignal(parentSignal, timeoutMs) });
    if (!resp.ok) throw await readApiError(resp);
    return resp.json();
  });
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

async function warmMovieApiSignatures(apiBase, movieId, parentSignal) {
  if (apiSigWarmed || !apiBase || !movieId) return true;
  const url =
    `${apiBase}/api/refresh?` +
    new URLSearchParams({ movieId: String(movieId), boxLevel: "1" });
  try {
    const resp = await fetch(url, { signal: mergeFetchSignal(parentSignal, 45000) });
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

export async function fetchBoxShow(apiBase, movieId, boxLevel = 1, parentSignal) {
  return fetchMovieApi(
    apiBase,
    "/i/api/movie/getBoxShow",
    movieId,
    {
      boxLevel: String(boxLevel),
      yodaReady: "h5",
      csecplatform: "4",
      csecversion: "4.3.0",
    },
    20000,
    parentSignal,
  );
}

export async function fetchPredictionBox(apiBase, movieId, parentSignal) {
  return fetchMovieApi(apiBase, "/i/api/movie/getPredictionBox", movieId, {}, 20000, parentSignal);
}

export async function fetchBoxShowna(apiBase, movieId, parentSignal) {
  return fetchMovieApi(apiBase, "/i/api/movie/getBoxShowna", movieId, {}, 20000, parentSignal);
}

export async function fetchTechData(apiBase, movieId, parentSignal) {
  return fetchMovieApi(apiBase, "/i/api/movie/getTechData", movieId, {}, 20000, parentSignal);
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

/** 反爬字体 canvas 解码失败时常整串变成 1（如 1111.1 / 111.11） */
export function isUntrustedBoxDecode(text) {
  if (text == null) return true;
  const s = String(text).replace(/[^\d.]/g, "");
  if (!s) return true;
  const digits = s.replace(/\./g, "");
  if (!digits) return true;
  if (new Set(digits.split("")).size === 1) return true;
  const ones = (digits.match(/1/g) || []).length;
  if (ones / digits.length >= 0.75) return true;
  return false;
}

/** API 常返回 &#xe6d5; 实体或 PUA 字符，均属反爬字体票房 */
export function isEncodedBoxHtml(numHtml) {
  const raw = String(numHtml || "");
  if (!raw) return false;
  if (/&#x[e-f0-9]{3,4};/i.test(raw)) return true;
  if (/[\uE000-\uF8FF]/.test(raw)) return true;
  if (typeof document === "undefined") return false;
  const el = ensureDecoder();
  el.innerHTML = raw;
  return hasPrivateUseChars(el.textContent || "");
}

export function boxHtmlUsesAntiScrapeFont(numHtml) {
  if (!numHtml) return false;
  if (/&#x[e-f0-9]{3,4};/i.test(String(numHtml))) return true;
  if (typeof document === "undefined") {
    return /[\uE000-\uF8FF]/.test(String(numHtml));
  }
  const el = ensureDecoder();
  el.innerHTML = String(numHtml);
  return hasPrivateUseChars(el.textContent || "");
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

function glyphInk(bitmap) {
  let ink = 0;
  for (let i = 0; i < bitmap.length; i++) {
    if (bitmap[i]) ink += 1;
  }
  return ink;
}

function guessDigitFromPua(charCode) {
  if (puaDigitMap.has(charCode)) return puaDigitMap.get(charCode);
  const ch = String.fromCharCode(charCode);
  const target = getGlyphBitmap('80px "mtsi-font"', ch);
  const ink = glyphInk(target);
  if (ink < 80) {
    puaDigitMap.set(charCode, -1);
    return -1;
  }
  let max = 0;
  let second = 0;
  let digit = 0;
  for (let d = 0; d < 10; d++) {
    const guess = getGlyphBitmap('72px Arial, Helvetica, sans-serif', String(d), "#ff0000");
    const score = bitmapSimilarity(target, guess);
    if (score > max) {
      second = max;
      max = score;
      digit = d;
    } else if (score > second) {
      second = score;
    }
  }
  if (max < 120 || max - second < 12) {
    puaDigitMap.set(charCode, -1);
    return -1;
  }
  puaDigitMap.set(charCode, digit);
  return digit;
}

function decodePuaString(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xe000 && code <= 0xf8ff) {
      const digit = guessDigitFromPua(code);
      if (digit < 0) return "";
      out += digit;
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

export function isMaoyanFontReady() {
  return fontReady === true;
}

export async function injectFontStyle(fontStyle) {
  const remoteCss = normalizeFontCss(fontStyle);
  // CSS 未变：绝不重置 fontReady / 重写 style，避免每轮轮询闪空白
  if (remoteCss && remoteCss === lastFontStyle) {
    if (!fontReady) await waitForMtsiFont();
    return;
  }
  if (remoteCss) {
    let el = document.getElementById("maoyan-font-style");
    if (!el) {
      el = document.createElement("style");
      el.id = "maoyan-font-style";
      document.head.appendChild(el);
    }
    puaDigitMap.clear();
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
    const plain = String(numHtml).replace(/<[^>]+>/g, "").trim();
    return isUntrustedBoxDecode(plain) ? "" : plain;
  }
  const el = ensureDecoder();
  el.innerHTML = numHtml;
  const text = (el.textContent || "").trim();
  if (!text) return "";
  if (hasPrivateUseChars(text)) {
    if (!fontReady) return "";
    const decoded = decodePuaString(text);
    return decoded && !isUntrustedBoxDecode(decoded) ? decoded : "";
  }
  return isUntrustedBoxDecode(text) ? "" : text;
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
  if (!todayRaw || isUntrustedBoxDecode(todayRaw)) return 0;
  let todayBox = parseBoxNum(todayRaw, todayUnit);
  if (todayBox > 0 && !isUntrustedBoxDecode(String(todayBox))) return todayBox;
  const stripped = String(todayRaw).replace(/[^\d.]/g, "");
  if (stripped && !isUntrustedBoxDecode(stripped)) {
    const retry = parseBoxNum(stripped, todayUnit);
    if (retry > 0 && !isUntrustedBoxDecode(String(retry))) return retry;
  }
  return 0;
}

function pickNonemptyNationField(nation, fields) {
  for (const field of fields) {
    const val = nation?.[field];
    if (val == null) continue;
    const text = String(val).trim();
    if (text && text !== "--" && text !== "-") return text;
  }
  return "";
}

function parseDescNumber(desc) {
  if (!desc) return NaN;
  const s = String(desc).replace(/,/g, "").trim();
  if (!s || s === "--") return NaN;
  const n = parseBoxNum(s, s.includes("亿") ? "亿" : "万");
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function formatAvgAttendance(avg) {
  if (!Number.isFinite(avg) || avg <= 0) return "";
  if (avg >= 10000) return `${(avg / 10000).toFixed(1)}万`;
  return avg >= 100 ? avg.toFixed(0) : avg.toFixed(1);
}

export function resolveNationSeatMetric(nation = {}) {
  // 已解析好的 seatValue（含测试/缓存）优先
  if (!isEmptyMetricValue(nation.seatValue)) {
    const raw = String(nation.seatValue).trim();
    const label = String(nation.seatLabel || "上座率").trim() || "上座率";
    if (/上座/.test(label)) {
      return {
        label,
        value: raw.includes("%") ? raw : `${raw.replace(/%$/g, "")}%`,
        seatRaw: raw,
      };
    }
    return { label, value: raw, seatRaw: raw };
  }

  const seatRaw = pickNonemptyNationField(nation, [
    "viewSeatRate",
    "avgSeatView",
    "seatRate",
    "viewSeatRateDesc",
  ]);
  if (seatRaw) {
    const value = seatRaw.includes("%") ? seatRaw : `${seatRaw.replace(/%$/, "")}%`;
    return { label: "上座率", value, seatRaw };
  }

  const avgShow = pickNonemptyNationField(nation, ["avgShowView", "avgShowViewDesc"]);
  if (avgShow) {
    return { label: "场均人次", value: avgShow, seatRaw: avgShow };
  }

  const views = parseDescNumber(nation.viewCountDesc);
  const shows = parseDescNumber(nation.showCountDesc);
  if (Number.isFinite(views) && Number.isFinite(shows) && shows > 0) {
    const formatted = formatAvgAttendance(views / shows);
    if (formatted) {
      return { label: "场均人次", value: formatted, seatRaw: `views/shows:${formatted}` };
    }
  }

  return { label: "上座率", value: "--", seatRaw: "" };
}

export function resolveChampionBoxWan(movie) {
  if (!movie) return 0;
  if (Number.isFinite(movie.todayBox) && movie.todayBox > 0) {
    const raw = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(raw)) return movie.todayBox;
  }
  const fromHtml = resolveTodayBox(decodeFontNum(movie.todayBoxHtml || ""), normalizeUnit(movie.todayUnit));
  if (fromHtml > 0) return fromHtml;
  if (movie.todayBoxText && movie.todayBoxText !== "--") {
    const n = parseBoxNum(movie.todayBoxText, movie.todayUnit || "万");
    if (n > 0 && !isUntrustedBoxDecode(movie.todayBoxText)) return n;
  }
  return 0;
}

export function refreshMovieBoxFields(movie) {
  if (!movie) return movie;
  const todayBoxHtml = movie.todayBoxHtml || "";
  const todayUnit = normalizeUnit(movie.todayUnit);
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const todayRaw = encodedBox && !fontReady ? "" : decodeFontNum(todayBoxHtml);
  const prevText = String(movie.todayBoxText || "").trim();
  const prevBox = movie.todayBox;
  const prevTrusted =
    prevBox > 0 &&
    prevText !== "--" &&
    !isUntrustedBoxDecode(prevText || String(prevBox));

  if (!todayRaw) {
    if (prevTrusted) {
      return {
        ...movie,
        todayUnit,
        decodeStatus: DECODE_STATUS.OK,
      };
    }
    return {
      ...movie,
      todayBoxText: "--",
      todayBox: 0,
      todayUnit,
      decodeStatus: encodedBox ? DECODE_STATUS.ENCODED : DECODE_STATUS.FAILED,
    };
  }

  const todayBox = resolveTodayBox(todayRaw, todayUnit);
  if (todayBox <= 0) {
    if (prevTrusted) {
      return {
        ...movie,
        todayUnit,
        decodeStatus: DECODE_STATUS.OK,
      };
    }
    return {
      ...movie,
      todayBoxText: "--",
      todayBox: 0,
      todayUnit,
      decodeStatus: encodedBox ? DECODE_STATUS.ENCODED : DECODE_STATUS.FAILED,
    };
  }

  return {
    ...movie,
    todayBoxText: todayRaw,
    todayBox,
    todayUnit,
    decodeStatus: DECODE_STATUS.OK,
  };
}

export function computeMovieBoxDeltaWan(prevAmount, nextAmount) {
  if (!Number.isFinite(prevAmount) || !Number.isFinite(nextAmount)) return 0;
  if (prevAmount <= 0 || nextAmount <= prevAmount) return 0;
  const delta = nextAmount - prevAmount;
  return delta >= 0.001 ? delta : 0;
}

export function traceDashboardData(parsed, raw, { enabled = false } = {}) {
  if (!enabled) return;
  const nationRaw = raw?.movieList?.nationBoxInfo ?? {};
  const nation = parsed?.nation ?? {};
  const top1 = parsed?.movies?.[0];
  const seat = resolveNationSeatMetric(nationRaw);

  console.log("[DATA_TRACE]");
  console.log("nation:", {
    todayBoxRaw: nationRaw.nationBoxSplitUnit?.num ?? "",
    todayBoxParsedWan: nation.todayBox ?? 0,
    showCountDesc: nation.showCountDesc,
    viewCountDesc: nation.viewCountDesc,
    seatRaw: seat.seatRaw,
    nationSeatLabel: seat.label,
    nationSeatValue: seat.value,
  });
  if (nation.showCountDesc) {
    console.log(
      `[DATA_TRACE] nation.showCountDesc raw = ${nationRaw.showCountDesc} rendered = ${nation.showCountDesc}`,
    );
  }
  if (top1) {
    console.log("TOP1:", {
      movieId: top1.movieId,
      name: top1.name,
      todayBoxRaw: top1.todayBoxHtml,
      todayBoxWan: top1.todayBox,
      boxRate: top1.boxRate,
      showCountRate: top1.showCountRate,
      avgSeatView: top1.avgSeatView,
      sumBoxDesc: top1.sumBoxDesc,
    });
    console.log("[DATA_TRACE] championWan:", resolveChampionBoxWan(top1));
  }
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
  if (!s || /登录猫眼|专业版即可|剩余城市|商排|请先登录|开通专业版/.test(s)) return "--";
  if (s.startsWith("¥")) return s;
  if (s.includes("亿") || s.includes("万")) return `¥${s}`;
  // 纯中文提示不是金额
  if (/[\u4e00-\u9fff]/.test(s) && !/\d/.test(s)) return "--";
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
      /签名|不存在|失败|错误|超时|请刷新|请稍后再试|没找到浏览器|登录|专业版|商排/.test(msg)
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
    if (!text || text === "--" || text === "-") continue;
    if (/登录猫眼|专业版即可|剩余城市|商排|请先登录|开通专业版/.test(text)) continue;
    return text;
  }
  return "";
}

function normalizeShowDateKey(showDate) {
  if (showDate == null || showDate === "") return 0;
  const digits = String(showDate).replace(/\D/g, "").slice(0, 8);
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

function collectBoxDatasRows(inner) {
  const boxDatas = inner?.boxDatas;
  if (!Array.isArray(boxDatas)) return [];
  const rows = [];
  for (const chunk of boxDatas) {
    if (Array.isArray(chunk)) rows.push(...chunk);
    else if (chunk && typeof chunk === "object") rows.push(chunk);
  }
  const byDate = new Map();
  for (const row of rows) {
    const key = normalizeShowDateKey(row?.showDate);
    if (!key) continue;
    byDate.set(String(key), row);
  }
  return [...byDate.values()].sort(
    (a, b) => normalizeShowDateKey(a.showDate) - normalizeShowDateKey(b.showDate),
  );
}

function mapShowDateRowsToDaily(rows, todayStr, { forecastFields = [] } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const sorted = [...rows]
    .filter((row) => normalizeShowDateKey(row?.showDate) > 0)
    .sort((a, b) => normalizeShowDateKey(a.showDate) - normalizeShowDateKey(b.showDate));
  if (!sorted.length) return [];

  const todayKey = normalizeShowDateKey(todayStr);
  let todayIdx = todayKey
    ? sorted.findIndex((row) => normalizeShowDateKey(row.showDate) === todayKey)
    : -1;
  if (todayIdx < 0 && todayKey) {
    // 今日行缺失时，取第一天 >= 今日，避免误把最后一天当「今日」导致明日/后天全空
    todayIdx = sorted.findIndex((row) => normalizeShowDateKey(row.showDate) >= todayKey);
  }
  if (todayIdx < 0) todayIdx = 0;

  const labels = ["今日", "明日", "后天"];
  const result = [];
  for (let i = 0; i < 3; i++) {
    const row = sorted[todayIdx + i];
    if (!row) break;
    const box = pickDescValue(
      row.boxDesc,
      row.boxInfo,
      row.boxInfoDesc,
      row.boxOfficeDesc,
      row.sumBoxDesc,
      row.splitBoxDesc,
      row.valueDesc,
    );
    const forecast = pickDescValue(
      ...forecastFields.map((field) => row[field]),
      row.predictionDesc,
      row.predBoxDesc,
      row.forecastDesc,
      row.predictionBoxDesc,
      row.boxPredictionDesc,
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

function mapBoxShowRowsToDaily(rows, todayStr) {
  return mapShowDateRowsToDaily(rows, todayStr);
}

function mapPredictionPageListToDaily(rows, todayStr) {
  return mapShowDateRowsToDaily(rows, todayStr, {
    forecastFields: ["boxInfo", "boxInfoDesc", "predictionDesc", "predBoxDesc"],
  });
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

/** 图表点票房（万）：优先 tooltip.val1（万），其次 yValue/val0（元→万） */
function seriesPointWan(point) {
  if (!point || typeof point !== "object") return 0;
  const tip = point.tooltip?.val1;
  if (tip != null && String(tip).trim() !== "") {
    const fromTip = parseBoxNum(tip, "万");
    if (fromTip > 0) return fromTip;
  }
  const y = Number(point.yValue ?? point.tooltip?.val0);
  if (!Number.isFinite(y) || y <= 0) return 0;
  // 猫眼分时/累计图坐标一律是「元」
  return y / 10000;
}

function formatHourSpeedText(wan) {
  if (!(wan > 0)) return "--";
  return `${formatMoneyWan(wan).replace(/^¥/, "")}/h`;
}

/**
 * 时速：优先分时增量图 timeFilterChartData 末点（已是当小时票房），
 * 否则用累计图 timeChartData 末两点差值。
 * 禁止用短轮询瞬时速率冒充时速。
 */
function resolveHourSpeedWan(inner, seriesName) {
  const filterSeries = inner?.timeFilterChartData?.series || [];
  const filterPoint = pickSeriesPoint(filterSeries, seriesName);
  const fromFilter = seriesPointWan(filterPoint);
  if (fromFilter > 0) return fromFilter;

  const chartSeries = inner?.timeChartData?.series || [];
  const solid = pickSeriesPoint(chartSeries, seriesName);
  const prevSolid = pickPrevSeriesPoint(chartSeries, seriesName);
  if (solid && prevSolid) {
    return Math.max(0, seriesPointWan(solid) - seriesPointWan(prevSolid));
  }
  return 0;
}

function parseBoxShowMetrics(raw, todayStr = "") {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const series = inner.timeChartData?.series || [];
  const yesterdaySolid = pickSeriesPoint(series, "time_yesterday");

  const hourSpeed = resolveHourSpeedWan(inner, "time_solid");
  const yesterdayHourSpeed = resolveHourSpeedWan(inner, "time_yesterday");
  const yesterdaySamePeriod = seriesPointWan(yesterdaySolid);

  const rows = collectBoxDatasRows(inner);
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

  let yesterdayDesc = "--";
  let yesterdayBox = 0;
  for (const title of ["昨日综合票房", "昨日票房", "昨日总票房"]) {
    const item = summary[title];
    const val = item?.valueDesc;
    if (val == null || String(val).trim() === "") continue;
    const unit = item?.unitDesc || "万";
    const text = formatDescMoney(
      String(val).includes("亿") || String(val).includes("万") ? String(val) : `${val}${unit}`,
    );
    yesterdayDesc = text;
    yesterdayBox = parseBoxNum(text);
    break;
  }

  return {
    hourSpeed,
    hourSpeedText: formatHourSpeedText(hourSpeed),
    yesterdayHourSpeed,
    yesterdayHourSpeedText: formatHourSpeedText(yesterdayHourSpeed),
    yesterdaySamePeriod,
    yesterdaySamePeriodText: yesterdaySamePeriod > 0 ? formatMoneyWan(yesterdaySamePeriod) : "--",
    yesterdayDesc,
    yesterdayBox,
    totalViews,
    presaleTotal: summary["累计综合票房(含预售)"]?.valueDesc || "--",
    dailyRows: mapBoxShowRowsToDaily(rows, todayStr),
  };
}

function parsePredictionMetrics(raw, todayStr = "") {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const detailObj =
    inner.detail && typeof inner.detail === "object" && !Array.isArray(inner.detail)
      ? inner.detail
      : null;

  const result = {
    dynamicForecast: "--",
    dynamicForecastNum: 0,
    dynamicTrend: "",
    totalForecast: "--",
    totalForecastNum: 0,
    totalTrend: "",
    dailyForecast: [],
  };

  const pageDaily = mapPredictionPageListToDaily(inner.pageData?.list, todayStr);
  if (pageDaily.length) {
    result.dailyForecast = pageDaily;
    const todayRow = pageDaily[0];
    const todayVal = String(todayRow?.forecast || "").replace(/^¥/, "");
    if (todayVal && todayVal !== "--") {
      result.dynamicForecast = todayVal;
      result.dynamicForecastNum = parseBoxNum(todayVal);
    }
    const summaryVal = inner.pageData?.boxSummary?.valueDesc || inner.pageData?.sumBox;
    const summaryUnit = inner.pageData?.boxSummary?.unitDesc || "万";
    if (summaryVal != null && String(summaryVal).trim()) {
      const rawTotal = String(summaryVal).trim();
      const totalText =
        rawTotal.includes("亿") || rawTotal.includes("万")
          ? rawTotal
          : summaryUnit === "亿"
            ? `${rawTotal}亿`
            : `${rawTotal}万`;
      result.totalForecast = formatDescMoney(totalText);
      result.totalForecastNum = parseBoxNum(totalText);
    }
  }

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

  if (!result.dailyForecast.length && Array.isArray(list)) {
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
        item.boxInfo,
        item.boxInfoDesc,
        item.valueDesc,
        item.boxDesc,
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

function formatTodayBoxDebugText(movie) {
  if (movie.todayBoxText === "--") return "--";
  if (!movie.todayBoxText) return "--";
  const unit = movie.todayUnit || "万";
  const text = String(movie.todayBoxText);
  if (text.includes("万") || text.includes("亿")) return text;
  return `${text}${unit}`;
}

/** @deprecated 使用 sortDashboardMovies */
export function sortMoviesByTodayBox(movies) {
  return sortDashboardMovies(movies);
}

function logDashboardRankDebug(movies) {
  if (!movies?.length) return;
  for (const movie of movies) {
    console.log(
      `[box-rank] rank=${movie.rank} originalRank=${movie.originalRank} name=${movie.name} totalBox=${movie.sumBoxDesc} todayBox=${formatTodayBoxDebugText(movie)} boxRate=${movie.boxRate} decodeStatus=${movie.decodeStatus}`,
    );
  }
}

function mapDashboardItem(item, index) {
  const info = item.movieInfo || {};
  const todayBoxHtml = item.boxSplitUnit?.num || "";
  const todayUnit = normalizeUnit(item.boxSplitUnit?.unit);
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const todayRaw = decodeFontNum(todayBoxHtml);
  const decodeStatus = resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox);
  const todayBox =
    decodeStatus === DECODE_STATUS.OK ? resolveTodayBox(todayRaw, todayUnit) : 0;
  const splitHtml = item.splitBoxSplitUnit?.num || "";
  const splitUnit = normalizeUnit(item.splitBoxSplitUnit?.unit);
  const splitRaw = decodeFontNum(splitHtml);

  return {
    _apiIndex: index,
    originalRank: index + 1,
    decodeStatus,
    movieId: info.movieId ?? `unknown-${index}`,
    name: info.movieName || "未知",
    releaseInfo: info.releaseInfo || "",
    todayBox,
    todayBoxHtml,
    todayUnit,
    todayBoxText: decodeStatus === DECODE_STATUS.OK ? todayRaw : "--",
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
    sumBoxNum: resolveMaoyanSumBoxWan(item),
  };
}

export function parseDashboard(raw, topCount = 5) {
  const limit = resolveDisplayMovieCount(topCount);
  const list = raw?.movieList?.list ?? [];
  const nation = raw?.movieList?.nationBoxInfo ?? {};
  const updateInfo = raw?.movieList?.updateInfo ?? {};
  const calendar = raw?.calendar ?? {};
  const mapped = list.map((item, index) => mapDashboardItem(item, index));
  // 猫眼官方：先取当日榜 TOP N，再按累计总票房排显示顺序
  const movies = pickOfficialDashboardMovies(mapped, limit);
  logDashboardRankDebug(movies);

  const nationBoxHtml = nation.nationBoxSplitUnit?.num || "";
  const nationUnit = normalizeUnit(nation.nationBoxSplitUnit?.unit);
  const nationToday = decodeFontNum(nationBoxHtml);
  const nationBox = resolveTodayBox(nationToday, nationUnit);

  const nationSplitHtml = nation.nationSplitBoxSplitUnit?.num || "";
  const nationSplitUnit = normalizeUnit(nation.nationSplitBoxSplitUnit?.unit);
  const nationSplitRaw = decodeFontNum(nationSplitHtml);

  const globalTrends = parseTrends(raw?.movieInfo?.boxTrends, calendar.today);
  const seatMetric = resolveNationSeatMetric(nation);

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
      seatLabel: seatMetric.label,
      seatValue: seatMetric.value,
      seatRaw: seatMetric.seatRaw,
      avgShowView: nation.avgShowView || "",
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

function isEmptyMetricValue(val) {
  if (val == null) return true;
  if (Array.isArray(val)) return !val.length;
  const text = String(val).trim();
  return !text || text === "--" || text === "-";
}

/** 强保留：detail 为空时不覆盖 base 已有值 */
function mergePreserveField(merged, field, newVal) {
  if (!isEmptyMetricValue(newVal)) merged[field] = newVal;
}

/** 强覆盖：detail 有实时值时优先采用（禁止 newValue || oldValue 式合并） */
function mergeOverwriteField(merged, field, newVal) {
  if (!isEmptyMetricValue(newVal)) merged[field] = newVal;
}

export function mergeMovieDetail(base, detail = {}) {
  const trends = detail.trends || {};
  const boxShow = detail.boxShow || {};
  const prediction = detail.prediction || {};
  const global = detail.global || {};
  const tech = detail.tech || {};

  const merged = { ...base };

  const dailyIncrease = trends.increaseDesc || trends.dailyIncrease || boxShow.dailyIncrease;
  mergeOverwriteField(merged, "dailyIncrease", dailyIncrease);

  if (!isEmptyMetricValue(trends.yesterdayDesc)) {
    merged.yesterdayTotal = trends.yesterdayDesc;
    if (trends.yesterdayBox > 0) merged.yesterdayBox = trends.yesterdayBox;
  } else if (!isEmptyMetricValue(boxShow.yesterdayDesc)) {
    merged.yesterdayTotal = boxShow.yesterdayDesc;
    if (boxShow.yesterdayBox > 0) merged.yesterdayBox = boxShow.yesterdayBox;
  }

  const hourSpeedFromBoxShow =
    boxShow.hourSpeed > 0 ||
    (!isEmptyMetricValue(boxShow.hourSpeedText) && boxShow.hourSpeedText !== "--");
  const yesterdayHourSpeedFromBoxShow =
    boxShow.yesterdayHourSpeed > 0 ||
    (!isEmptyMetricValue(boxShow.yesterdayHourSpeedText) &&
      boxShow.yesterdayHourSpeedText !== "--");

  if (hourSpeedFromBoxShow) {
    merged.hourSpeed = boxShow.hourSpeed > 0 ? boxShow.hourSpeed : 0;
    merged.hourSpeedText = boxShow.hourSpeedText;
    merged.hourSpeedFromApi = true;
  }
  if (yesterdayHourSpeedFromBoxShow) {
    merged.yesterdayHourSpeed =
      boxShow.yesterdayHourSpeed > 0 ? boxShow.yesterdayHourSpeed : 0;
    merged.yesterdayHourSpeedText = boxShow.yesterdayHourSpeedText;
  }
  mergeOverwriteField(merged, "yesterdaySamePeriodText", boxShow.yesterdaySamePeriodText);
  mergeOverwriteField(merged, "totalViews", boxShow.totalViews);

  mergePreserveField(merged, "dynamicForecast", prediction.dynamicForecast);
  if (prediction.dynamicForecastNum > 0) {
    merged.dynamicForecastNum = prediction.dynamicForecastNum;
  }
  mergePreserveField(merged, "dynamicTrend", prediction.dynamicTrend);
  mergePreserveField(merged, "totalForecast", prediction.totalForecast);
  if (prediction.totalForecastNum > 0) {
    merged.totalForecastNum = prediction.totalForecastNum;
  }
  mergePreserveField(merged, "totalTrend", prediction.totalTrend);

  if (!isEmptyMetricValue(global.mainland)) {
    merged.mainlandBox = global.mainland;
  } else if (isEmptyMetricValue(merged.mainlandBox) && !isEmptyMetricValue(base.sumBoxDesc)) {
    merged.mainlandBox = formatDescMoney(base.sumBoxDesc);
  }
  mergePreserveField(merged, "hmtBox", global.hmt);
  mergePreserveField(merged, "overseasBox", global.overseas);

  mergePreserveField(merged, "endDate", tech.endDate);
  mergePreserveField(merged, "remainingDays", tech.remainingDays);

  const hasDetailDaily =
    (Array.isArray(prediction.dailyForecast) && prediction.dailyForecast.length > 0) ||
    (Array.isArray(boxShow.dailyRows) && boxShow.dailyRows.length > 0);
  if (hasDetailDaily) {
    merged.dailyTable = buildDailyTable(base, prediction, detail);
  }

  if (base.showCount > 0) {
    merged.showCountDesc =
      base.showCount >= 10000
        ? `${(base.showCount / 10000).toFixed(1)}万场`
        : `${base.showCount}场`;
  }

  return merged;
}

function normalizeMetricCompare(val) {
  return String(val ?? "")
    .replace(/[¥,\s]/g, "")
    .replace(/场$/, "")
    .replace(/\/h$/, "")
    .trim()
    .toLowerCase();
}

function metricValuesEquivalent(a, b) {
  if (isEmptyMetricValue(a) || isEmptyMetricValue(b)) return false;
  const na = normalizeMetricCompare(a);
  const nb = normalizeMetricCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const numA = parseBoxNum(na, na.includes("亿") ? "亿" : "万");
  const numB = parseBoxNum(nb, nb.includes("亿") ? "亿" : "万");
  return Number.isFinite(numA) && Number.isFinite(numB) && numA > 0 && Math.abs(numA - numB) < 0.05;
}

function formatShowCountDesc(movie) {
  if (!isEmptyMetricValue(movie.showCountDesc) && movie.showCountDesc !== "--") {
    const text = String(movie.showCountDesc).trim();
    return text.endsWith("场") ? text : `${text}场`;
  }
  if (movie.showCount > 0) {
    return movie.showCount >= 10000
      ? `${(movie.showCount / 10000).toFixed(1)}万场`
      : `${movie.showCount}场`;
  }
  return "";
}

function formatHourSpeedDisplay(text) {
  if (isEmptyMetricValue(text)) return "";
  const raw = String(text).trim().replace(/^¥/, "");
  return raw.includes("/h") ? raw : `${raw}/h`;
}

export function formatReleaseTag(releaseInfo) {
  if (isEmptyMetricValue(releaseInfo)) return "";
  const text = String(releaseInfo).trim();
  if (text.length > 8) return "";
  const m = text.match(/(\d+)\s*天/);
  if (m) return `上映${m[1]}天`;
  if (/^上映/.test(text) && text.length <= 8) return text;
  return "";
}

const DASHBOARD_AUDIT_FIELDS = [
  "releaseInfo",
  "todayBox",
  "todayBoxText",
  "boxRate",
  "splitBoxRate",
  "splitBoxText",
  "showCount",
  "showCountRate",
  "avgShowView",
  "avgSeatView",
  "sumBoxDesc",
  "sumSplitBoxDesc",
];

const DETAIL_AUDIT_FIELDS = [
  "dailyIncrease",
  "hourSpeed",
  "hourSpeedText",
  "dynamicForecast",
  "dynamicTrend",
  "totalForecast",
  "totalTrend",
  "yesterdayTotal",
  "yesterdayHourSpeedText",
  "yesterdaySamePeriodText",
  "totalViews",
  "endDate",
  "remainingDays",
  "mainlandBox",
  "hmtBox",
  "overseasBox",
  "showCountDesc",
];

const BOX_SHOW_AUDIT_FIELDS = [
  "hourSpeed",
  "hourSpeedText",
  "yesterdayHourSpeed",
  "yesterdayHourSpeedText",
  "yesterdaySamePeriod",
  "yesterdaySamePeriodText",
  "totalViews",
  "presaleTotal",
];

const PREDICTION_AUDIT_FIELDS = [
  "dynamicForecast",
  "dynamicForecastNum",
  "dynamicTrend",
  "totalForecast",
  "totalForecastNum",
  "totalTrend",
  "dailyForecast",
];

const GLOBAL_AUDIT_FIELDS = ["mainland", "hmt", "overseas"];
const TECH_AUDIT_FIELDS = ["endDate", "remainingDays"];

export const EXTRA_METRIC_FIELD_MAP = [
  { label: "实时票房", key: "todayBox", source: "dashboard", raw: "boxSplitUnit" },
  { label: "票房占比", key: "boxRate", source: "dashboard", raw: "boxRate" },
  { label: "排片占比", key: "showCountRate", source: "dashboard", raw: "showCountRate" },
  { label: "实时上座", key: "avgSeatView", source: "dashboard", raw: "avgSeatView" },
  { label: "累计票房", key: "sumBoxDesc", source: "dashboard", raw: "sumBoxDesc" },
  { label: "动态预测", key: "dynamicForecast", source: "getPredictionBox", raw: "predictionBoxList/boxDesc" },
  { label: "今日时速", key: "hourSpeedText", source: "getBoxShow", raw: "timeFilterChartData/timeChartData.time_solid" },
  { label: "排片场次", key: "showCountDesc", source: "dashboard", raw: "showCount" },
  { label: "场均人次", key: "avgShowView", source: "dashboard", raw: "avgShowView" },
  { label: "昨日票房", key: "yesterdayTotal", source: "dashboard(movieInfo.boxTrends)", raw: "boxTrends.boxDesc" },
  { label: "昨日同期", key: "yesterdaySamePeriodText", source: "getBoxShow", raw: "timeChartData.time_yesterday" },
  { label: "累计观影人次", key: "totalViews", source: "getBoxShow", raw: "boxSummaryList" },
  { label: "总预测", key: "totalForecast", source: "getPredictionBox", raw: "sumPrediction/boxDesc" },
  { label: "昨日时速", key: "yesterdayHourSpeedText", source: "getBoxShow", raw: "timeChartData.time_yesterday delta" },
  { label: "上映信息", key: "releaseInfo", source: "dashboard", raw: "movieInfo.releaseInfo" },
  { label: "下映日期", key: "endDate", source: "getTechData", raw: "endDate" },
  { label: "剩余天数", key: "remainingDays", source: "getTechData", raw: "remainingDays" },
  { label: "分账票房", key: "sumSplitBoxDesc", source: "dashboard", raw: "sumSplitBoxDesc" },
  { label: "分账占比", key: "splitBoxRate", source: "dashboard", raw: "splitBoxRate" },
  { label: "内地票房", key: "mainlandBox", source: "getBoxShowna", raw: "chinaBoxDesc" },
  { label: "港澳台票房", key: "hmtBox", source: "getBoxShowna", raw: "hmtBoxDesc" },
  { label: "海外票房", key: "overseasBox", source: "getBoxShowna", raw: "overseasBoxDesc" },
];

const EXTRA_METRIC_CANDIDATES = [
  { key: "dynamicForecast", label: "动态预测", tier: 1, get: (m) => m.dynamicForecast },
  { key: "showCountDesc", label: "排片场次", tier: 1, get: (m) => formatShowCountDesc(m) },
  { key: "sumBoxDesc", label: "累计票房", tier: 1, get: (m) => m.sumBoxDesc },
  { key: "yesterdayTotal", label: "昨日票房", tier: 1, get: (m) => m.yesterdayTotal },
  { key: "avgShowView", label: "场均人次", tier: 1, get: (m) => m.avgShowView },
  { key: "yesterdaySamePeriodText", label: "昨日同期", tier: 1, get: (m) => m.yesterdaySamePeriodText },
  { key: "totalViews", label: "累计观影人次", tier: 1, get: (m) => m.totalViews },
  { key: "totalForecast", label: "总预测", tier: 2, get: (m) => m.totalForecast },
  { key: "endDate", label: "下映日期", tier: 2, get: (m) => (isEmptyMetricValue(m.endDate) ? "" : m.endDate) },
  {
    key: "remainingDays",
    label: "剩余天数",
    tier: 2,
    get: (m) => (isEmptyMetricValue(m.remainingDays) ? "" : `${m.remainingDays}天`),
  },
  { key: "sumSplitBoxDesc", label: "分账票房", tier: 2, get: (m) => m.sumSplitBoxDesc },
  { key: "splitBoxRate", label: "分账占比", tier: 2, get: (m) => m.splitBoxRate },
  { key: "mainlandBox", label: "内地票房", tier: 3, get: (m) => m.mainlandBox },
  { key: "hmtBox", label: "港澳台票房", tier: 3, get: (m) => m.hmtBox },
  { key: "overseasBox", label: "海外票房", tier: 3, get: (m) => m.overseasBox },
];

function isValidExtraMetricValue(val, key) {
  if (isEmptyMetricValue(val)) return false;
  if (typeof val === "number" && val <= 0) return false;
  if (key === "avgShowView" || key === "showCount" || key === "showCountDesc") {
    const n = parseFloat(String(val).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n <= 0) return false;
  }
  return true;
}

function shouldSkipDuplicateMetric(candidate, value, selected, movie) {
  if (candidate.key === "mainlandBox") {
    const sumVal = selected.find((x) => x.key === "sumBoxDesc")?.value || movie?.sumBoxDesc;
    if (!isEmptyMetricValue(sumVal) && metricValuesEquivalent(value, sumVal)) return true;
  }
  if (candidate.key === "totalForecast") {
    const dynamic = selected.find((x) => x.key === "dynamicForecast")?.value || movie?.dynamicForecast;
    if (!isEmptyMetricValue(dynamic) && metricValuesEquivalent(value, dynamic)) return true;
  }
  for (const item of selected) {
    if (metricValuesEquivalent(value, item.value)) return true;
  }
  return false;
}

export function getExtraMetrics(movie, options = {}) {
  const rank = Number(movie?.rank) || 99;
  const maxCount = options.maxCount ?? (rank === 1 ? 6 : 4);
  const selected = [];

  for (const candidate of EXTRA_METRIC_CANDIDATES) {
    if (selected.length >= maxCount) break;
    const value = candidate.get(movie);
    if (!isValidExtraMetricValue(value, candidate.key)) continue;
    if (shouldSkipDuplicateMetric(candidate, value, selected, movie)) continue;
    selected.push({
      key: candidate.key,
      label: candidate.label,
      value: String(value).trim(),
      tier: candidate.tier,
    });
  }

  return selected;
}

export function getExtraMetricsGridClass(count) {
  if (count <= 0) return "race-card__extra-grid--0";
  if (count === 1) return "race-card__extra-grid--1";
  if (count === 2) return "race-card__extra-grid--2";
  if (count === 3) return "race-card__extra-grid--3";
  if (count === 4) return "race-card__extra-grid--4";
  return "race-card__extra-grid--6";
}

export function buildDailyTrendItems(movie) {
  if (Number(movie?.rank) !== 1) return [];
  const rows = Array.isArray(movie?.dailyTable) ? movie.dailyTable : [];
  if (rows.length < 2) return [];
  return rows.slice(0, 3).flatMap((row) => {
    const forecast = row?.forecast;
    if (isEmptyMetricValue(forecast) || forecast === "--") return [];
    return [{ label: `${row.label || ""}预测`, value: String(forecast).replace(/^¥/, "") }];
  });
}

function describeAuditValue(val) {
  if (val == null) return { type: "null", sample: "null" };
  if (Array.isArray(val)) {
    return { type: "array", sample: `[${val.length}]` };
  }
  if (typeof val === "number") {
    return { type: "number", sample: Number.isFinite(val) ? String(val) : "NaN" };
  }
  if (typeof val === "boolean") {
    return { type: "boolean", sample: val ? "true" : "false" };
  }
  const text = String(val).trim();
  if (text.length > 48) {
    return { type: "string", sample: `${text.slice(0, 24)}…(${text.length})` };
  }
  return { type: "string", sample: text };
}

function snapshotFields(source, fields) {
  const out = {};
  if (!source) return out;
  for (const field of fields) {
    const val = source[field];
    if (val == null || val === "" || val === "--" || val === "-") continue;
    if (typeof val === "number" && val <= 0 && field !== "rank") continue;
    out[field] = describeAuditValue(val);
  }
  return out;
}

function snapshotDashboardMovie(movie) {
  return snapshotFields(movie, DASHBOARD_AUDIT_FIELDS);
}

function snapshotDetailMovie(movie) {
  return snapshotFields(movie, DETAIL_AUDIT_FIELDS);
}

function snapshotParsedDetail(detail = {}) {
  return {
    boxShow: snapshotFields(detail.boxShow, BOX_SHOW_AUDIT_FIELDS),
    prediction: snapshotFields(detail.prediction, PREDICTION_AUDIT_FIELDS),
    global: snapshotFields(detail.global, GLOBAL_AUDIT_FIELDS),
    tech: snapshotFields(detail.tech, TECH_AUDIT_FIELDS),
    trends: snapshotFields(detail.trends, ["yesterdayBox", "yesterdayDesc", "todayTrendBox", "todayTrendDesc"]),
  };
}

let lastFieldAuditEntries = [];

export function getLastFieldAuditEntries() {
  return lastFieldAuditEntries.slice();
}

export function isFieldAuditEnabled(options = {}) {
  if (options.enabled === true) return true;
  if (typeof process !== "undefined" && process?.env?.MAOYAN_FIELD_AUDIT === "1") return true;
  if (typeof location !== "undefined") {
    return new URLSearchParams(location.search).has("maoyanFieldAudit");
  }
  return false;
}

export function logMaoyanFieldAudit(movies, detailSnapshots = {}, options = {}) {
  if (!isFieldAuditEnabled(options)) return;
  const list = (movies || []).slice(0, 5);
  lastFieldAuditEntries = list.map((movie) => {
    const key = String(movie.movieId);
    const snap = detailSnapshots[key] || {};
    const entry = {
      movieId: movie.movieId,
      name: movie.name,
      dashboard: snapshotDashboardMovie(movie),
      detail: snapshotDetailMovie(movie),
      boxShow: snap.boxShow || {},
      prediction: snap.prediction || {},
      global: snap.global || {},
      tech: snap.tech || {},
    };
    console.log("[MAOYAN_FIELD_AUDIT]", entry);
    return entry;
  });
  return lastFieldAuditEntries;
}

const fieldAuditHistory = new Map();

export function classifyFieldStability(entries) {
  const tallies = new Map();
  for (const entry of entries) {
    const groups = {
      dashboard: entry.dashboard,
      detail: entry.detail,
      boxShow: entry.boxShow,
      prediction: entry.prediction,
      global: entry.global,
      tech: entry.tech,
    };
    for (const [group, fields] of Object.entries(groups)) {
      for (const field of Object.keys(fields || {})) {
        const id = `${group}.${field}`;
        tallies.set(id, (tallies.get(id) || 0) + 1);
      }
    }
  }
  const total = Math.max(entries.length, 1);
  const stable = [];
  const occasional = [];
  const empty = [];
  for (const def of EXTRA_METRIC_FIELD_MAP) {
    const candidates = [
      `dashboard.${def.key}`,
      `detail.${def.key}`,
      `boxShow.${def.key}`,
      `prediction.${def.key}`,
      `global.${def.key === "mainlandBox" ? "mainland" : def.key === "hmtBox" ? "hmt" : def.key === "overseasBox" ? "overseas" : def.key}`,
      `tech.${def.key}`,
    ];
    const hit = Math.max(...candidates.map((id) => tallies.get(id) || 0));
    if (hit >= total) stable.push(def);
    else if (hit > 0) occasional.push(def);
    else empty.push(def);
  }
  return { stable, occasional, empty, totalRuns: total };
}

export function recordFieldAuditRun(entries) {
  for (const entry of entries) {
    const key = String(entry.movieId);
    const prev = fieldAuditHistory.get(key) || { runs: 0, hits: {} };
    prev.runs += 1;
    const groups = ["dashboard", "detail", "boxShow", "prediction", "global", "tech"];
    for (const group of groups) {
      for (const field of Object.keys(entry[group] || {})) {
        const id = `${group}.${field}`;
        prev.hits[id] = (prev.hits[id] || 0) + 1;
      }
    }
    fieldAuditHistory.set(key, prev);
  }
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
    const trustedText =
      base.todayBoxText !== "--" && !isUntrustedBoxDecode(base.todayBoxText)
        ? String(base.todayBoxText)
        : "";
    const trustedBox =
      base.todayBox > 0 && !isUntrustedBoxDecode(String(base.todayBoxText || base.todayBox))
        ? base.todayBox
        : 0;
    const todayBoxPlain = trustedBox > 0
      ? `${trustedBox.toFixed(2)}万`
      : trustedText
        ? `${trustedText}万`
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
  // 不再把短窗口 delta/elapsed 外推成「时速」；该值易夸张且与猫眼「本小时票房」定义不符
  const estimatedHourSpeed = 0;

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

async function mapPool(items, limit, worker, parentSignal) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      if (parentSignal?.aborted) break;
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

export function enrichMoviesQuick(movies, speed = {}) {
  return movies.map((movie) =>
    mergeMovieDetail(movie, { speed: speed[String(movie.movieId)] || {} })
  );
}

async function fetchMovieExtraDetail(apiBase, movie, todayStr, speed = {}, parentSignal) {
  if (parentSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const detail = {
    trends: {},
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
    predictionRaw = await fetchPredictionBox(apiBase, movie.movieId, parentSignal);
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    captureExtraError("预测票房", error);
  }
  let parsedPrediction = predictionRaw ? parsePredictionMetrics(predictionRaw, todayStr) : null;
  if (!parsedPrediction?.dailyForecast?.length) {
    await sleep(800);
    if (parentSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      predictionRaw = await fetchPredictionBox(apiBase, movie.movieId, parentSignal);
      parsedPrediction = predictionRaw ? parsePredictionMetrics(predictionRaw, todayStr) : null;
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      captureExtraError("预测票房", error);
    }
  }
  if (parsedPrediction) detail.prediction = parsedPrediction;

  const [boxShowRaw, globalRaw, techRaw] = await Promise.all([
    fetchBoxShow(apiBase, movie.movieId, 1, parentSignal).catch((error) => {
      if (parentSignal?.aborted) throw error;
      captureExtraError("日期票房", error);
      return null;
    }),
    fetchBoxShowna(apiBase, movie.movieId, parentSignal).catch((error) => {
      if (parentSignal?.aborted) throw error;
      captureExtraError("全球票房", error);
      return null;
    }),
    fetchTechData(apiBase, movie.movieId, parentSignal).catch((error) => {
      if (parentSignal?.aborted) throw error;
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
  detail.audit = snapshotParsedDetail(detail);
  return detail;
}

export async function enrichMoviesLight(apiBase, movies, options = {}) {
  const concurrency = options.concurrency || 3;
  const todayStr = options.todayStr || "";
  const trendLimit = resolveDisplayMovieCount(options.trendLimit ?? 5);
  const enableExtraApis = options.enableExtraApis !== false;
  const visible = (movies || []).slice(0, trendLimit);
  if (!visible.length) return [];

  const parentSignal = options.signal;
  const enriched = await mapPool(visible, concurrency, async (movie) => {
    const speed = options.speed?.[String(movie.movieId)] || {};
    if (!enableExtraApis) {
      return mergeMovieDetail(movie, { speed });
    }
    const detail = await fetchMovieExtraDetail(apiBase, movie, todayStr, speed, parentSignal);
    return mergeMovieDetail(movie, detail);
  }, parentSignal);

  return enriched;
}

export { parsePredictionMetrics, parseBoxShowMetrics };

export async function enrichMovies(apiBase, movies, options = {}) {
  const concurrency = options.concurrency || 2;
  const enableExtraApis = options.enableExtraApis !== false;
  const todayStr = options.todayStr || "";
  const trendLimit = resolveDisplayMovieCount(options.trendLimit ?? 5);
  const visible = (movies || []).slice(0, trendLimit);
  if (!visible.length) return [];

  lastEnrichErrors = [];
  const results = enrichMoviesQuick(visible, options.speed || {});

  const parentSignal = options.signal;
  const detailSnapshots = {};

  if (enableExtraApis && visible.length) {
    try {
      await warmMovieApiSignatures(apiBase, visible[0].movieId, parentSignal);
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      const warmErr = getWarmLastError() || summarizeEnrichError(error);
      lastEnrichErrors.push({ movieId: visible[0].movieId, label: "签名预热", ...warmErr });
    }
  }

  await mapPool(visible, concurrency, async (movie) => {
    const idx = visible.indexOf(movie);
    if (idx < 0) return;

    const speed = options.speed?.[String(movie.movieId)] || {};
    if (!enableExtraApis) {
      results[idx] = mergeMovieDetail(movie, { speed });
      return;
    }

    const detail = await fetchMovieExtraDetail(apiBase, movie, todayStr, speed, parentSignal);
    detailSnapshots[String(movie.movieId)] = detail.audit || snapshotParsedDetail(detail);
    for (const item of detail.extraErrors || []) {
      lastEnrichErrors.push({
        movieId: movie.movieId,
        label: item.label,
        ...summarizeEnrichError(item.error),
      });
    }
    results[idx] = mergeMovieDetail(movie, detail);
  }, parentSignal);

  logMaoyanFieldAudit(results, detailSnapshots, options);
  return results;
}
