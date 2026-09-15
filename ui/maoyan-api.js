/** 内置票房服务 API */

import {
  DECODE_STATUS,
  resolveDecodeStatus,
  resolveMaoyanSumBoxWan,
  sortDashboardMovies,
  pickOfficialDashboardMovies,
  rerankMoviesByTodayBox,
  decodeHtmlEntities,
  containsEncodedBoxMarkup,
  validateDecodedBoxStructure,
  rejectImplausibleTodayBoxWan,
  ABSURD_BOX_WAN_MAX,
  validateNationCrossCheck,
  buildNationCrossCheckContext,
  isUntrustedBoxDecode as rankUntrustedBoxDecode,
  isPuaCodePoint,
  iterMarkupCodePoints,
} from "./dashboard-rank.js";
import {
  ensurePuaMap,
  clearPuaMapCache,
  decodeMarkupWithPuaMap,
  extractFontUrls,
  computeVersionKey,
  computeVersionKeyAsync,
  buildPuaMapFromFontBuffer,
  listFontPuaEntries,
  MAP_CONFIDENCE,
} from "./font-pua-mapper.js";
import {
  registerFontFromStyle,
  cacheMapForFont,
  publishSession,
  decodeHtmlWithFontKey,
  isMapVerified,
  isVisualReady,
  getPublishedState,
  waitForFontVisual,
  collectProbeGlyphsFromRaw,
  getMapForKey,
  getMapForKeyLoose,
  syncLegacyActivePointers,
  normalizeFontIdentity,
  resolveUrlKey,
} from "./font-registry.js";

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
let activeFontFamily = "mtsi-font";
let activePuaMap = null;
let activePuaMapVersion = "";
let activePuaMapMeta = null;
const injectedFontVersions = new Set();

export function fontFamilyForVersion(versionKey) {
  const ver = String(versionKey || "").trim();
  if (!ver) return "mtsi-font";
  const safe = ver.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `mtsi-font-${safe}`;
}

export function getActiveFontFamily() {
  return activeFontFamily || "mtsi-font";
}

function versionedFontCss(fontStyle, versionKey) {
  const family = fontFamilyForVersion(versionKey);
  const css = normalizeFontCss(fontStyle);
  if (!css) return "";
  if (css.includes(`font-family: "${family}"`) || css.includes(`font-family:'${family}'`)) {
    return css;
  }
  return css.replace(/font-family\s*:\s*(["']?)mtsi-font\1/gi, `font-family: "${family}"`);
}

function ensureVersionedFontStyle(versionKey, fontStyle) {
  if (!versionKey || !fontStyle || injectedFontVersions.has(versionKey)) return;
  const css = versionedFontCss(fontStyle, versionKey);
  if (!css) return;
  let registry = document.getElementById("maoyan-font-registry");
  if (!registry) {
    registry = document.createElement("style");
    registry.id = "maoyan-font-registry";
    document.head.appendChild(registry);
  }
  const marker = `/* mtsi-version:${versionKey} */`;
  if (!registry.textContent.includes(marker)) {
    registry.textContent += `${marker}\n${css}\n`;
  }
  injectedFontVersions.add(versionKey);
}

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
  return iterMarkupCodePoints(text).some(isPuaCodePoint);
}

/** 反爬字体 canvas 解码失败时常整串变成 1（如 1111.1 / 111.11） */
export function isUntrustedBoxDecode(text) {
  return rankUntrustedBoxDecode(text);
}

/** API 常返回 &#xe6d5; 实体或 PUA 字符，均属反爬字体票房 */
export function isEncodedBoxHtml(numHtml) {
  const raw = String(numHtml || "");
  if (!raw) return false;
  if (containsEncodedBoxMarkup(raw)) return true;
  if (typeof document === "undefined") return false;
  const el = ensureDecoder();
  el.innerHTML = raw;
  return hasPrivateUseChars(el.textContent || "");
}

export function boxHtmlUsesAntiScrapeFont(numHtml) {
  return isEncodedBoxHtml(numHtml);
}

export function getFontMappingVersion() {
  const published = getPublishedState().contentKey;
  if (published) return published;
  if (!lastFontStyle) return "";
  return computeVersionKey(lastFontStyle);
}

export function summarizeFontStyle(fontStyle) {
  const css = normalizeFontCss(fontStyle || "");
  const hash = css.match(/font\/([a-f0-9]+)\./i)?.[1] || "";
  const host = css.match(/url\(["']?https?:\/\/([^/"']+)/i)?.[1] || "";
  return {
    version: hash ? `mtsi:${hash}` : "",
    host: host ? host.replace(/\./g, "[.]") : "",
    url: extractFontUrls(css),
  };
}

const puaMapHelpers = {
  validateNationCrossCheck,
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
  parseBoxNum,
  parseRate,
};

export function getActivePuaMapState() {
  return {
    version: activePuaMapVersion,
    ready: fontReady === true,
    hasMap: Boolean(activePuaMap),
    meta: activePuaMapMeta,
  };
}

export function buildCrossContextFromRaw(raw) {
  const nation = raw?.movieList?.nationBoxInfo ?? {};
  const list = raw?.movieList?.list ?? [];
  return {
    nationHtml: nation.nationBoxSplitUnit?.num || "",
    nationUnit: normalizeUnit(nation.nationBoxSplitUnit?.unit),
    nationSplitHtml: nation.nationSplitBoxSplitUnit?.num || "",
    nationSplitUnit: normalizeUnit(nation.nationSplitBoxSplitUnit?.unit),
    movies: list.map((item, index) => ({
      rank: index + 1,
      todayBoxHtml: item.boxSplitUnit?.num || "",
      todayUnit: normalizeUnit(item.boxSplitUnit?.unit),
      splitBoxHtml: item.splitBoxSplitUnit?.num || "",
      splitUnit: normalizeUnit(item.splitBoxSplitUnit?.unit),
      boxRate: item.boxRate || "",
      boxRateNum: parseRate(item.boxRate),
    })),
  };
}

function syncGlobalsFromPublished(contentKey) {
  const key = contentKey || getPublishedState().contentKey;
  if (!key) return;
  const ptr = syncLegacyActivePointers(key);
  activePuaMapVersion = key;
  activeFontFamily = ptr.family;
  activePuaMap = getMapForKey(key);
  activePuaMapMeta = ptr.mapMeta;
  fontReady = ptr.visualReady;
}

export function tryPublishDashboardSession({ responseId, contentKey, businessDate, fontStyle }) {
  const gate = publishSession({ responseId, contentKey, businessDate });
  if (!gate.ok) return gate;
  if (fontStyle) lastFontStyle = normalizeFontCss(fontStyle);
  syncGlobalsFromPublished(contentKey);
  return { ...gate, mapVerified: isMapVerified(contentKey), visualReady: isVisualReady(contentKey) };
}

export function applyBuiltPuaMap(built, fontStyle = lastFontStyle, options = {}) {
  if (!built) return built;
  const contentKey = built.versionKey || computeVersionKey(fontStyle);
  const map =
    built.map instanceof Map ? built.map : built.map ? new Map(built.map) : null;
  cacheMapForFont(contentKey, { ...built, map });
  if (options.publish === true) {
    syncGlobalsFromPublished(contentKey);
  }
  return { ...built, contentKey, map, applied: options.publish === true };
}

/** 仅注册字体并等待本轮 PUA 探针字形可用，不发布映射 */
export async function prepareDashboardFont(raw) {
  const fontStyle = raw?.fontStyle || lastFontStyle;
  if (!fontStyle || typeof document === "undefined") {
    return { ok: false, reason: "no_font_style" };
  }
  const probeGlyphs = collectProbeGlyphsFromRaw(raw);
  const reg = await registerFontFromStyle(normalizeFontCss(fontStyle), { probeGlyphs });
  await waitForFontVisual(reg.contentKey, probeGlyphs);
  return {
    ok: true,
    urlKey: reg.urlKey,
    contentKey: reg.contentKey,
    versionKey: reg.contentKey,
    fontFamily: reg.family,
    fontReady: isVisualReady(reg.contentKey),
  };
}

/** 后台 Worker 构建 PUA 映射；结果仅写入版本缓存，不污染当前活动映射 */
export async function scheduleDashboardPuaMap(raw, options = {}) {
  const fontStyle = raw?.fontStyle || lastFontStyle;
  if (!fontStyle || typeof document === "undefined") {
    return { ok: false, reason: "no_font_style" };
  }
  const { schedulePuaMapBuild } = await import("./font-pipeline.js");
  const built = await schedulePuaMapBuild(normalizeFontCss(fontStyle), buildCrossContextFromRaw(raw), {
    force: options.force === true,
    budget: options.budget,
    simulateDelayMs: options.simulateDelayMs || 0,
  });
  let mapBuilt = built;
  if (built?.map && Array.isArray(built.map)) {
    mapBuilt = { ...built, map: new Map(built.map) };
  }
  const contentKey = mapBuilt?.versionKey || computeVersionKey(fontStyle);
  cacheMapForFont(contentKey, mapBuilt);
  return { ...mapBuilt, contentKey, applied: false };
}

export async function loadPuaMapForDashboard(raw, options = {}) {
  const fontStyle = raw?.fontStyle || lastFontStyle;
  if (!fontStyle || typeof document === "undefined") {
    return { ok: false, reason: "no_font_style" };
  }
  if (options.background === true) {
    return scheduleDashboardPuaMap(raw, options);
  }
  const built = await ensurePuaMap(normalizeFontCss(fontStyle), {
    force: options.force === true,
    crossContext: buildCrossContextFromRaw(raw),
    helpers: puaMapHelpers,
    fontBuffer: options.fontBuffer,
  });
  return applyBuiltPuaMap(built, fontStyle);
}

function measureFontProbeWidth(fontFamily) {
  const el = ensureDecoder();
  const probe = "\uE6D5\uE6D6";
  el.style.fontFamily = `"${fontFamily}", monospace`;
  el.textContent = probe;
  const encodedWidth = el.getBoundingClientRect().width;
  el.style.fontFamily = "monospace";
  el.textContent = probe;
  const fallbackWidth = el.getBoundingClientRect().width;
  return { encodedWidth, fallbackWidth };
}

async function waitForMtsiFont(fontFamily = activeFontFamily, probeGlyphs = [], retries = 8) {
  const family = fontFamily || "mtsi-font";
  const contentKey = activePuaMapVersion || getPublishedState().contentKey;
  if (contentKey) {
    const ready = await waitForFontVisual(contentKey, probeGlyphs, retries);
    if (ready) {
      activeFontFamily = family;
      if (getPublishedState().contentKey === contentKey) fontReady = true;
      return true;
    }
    return Boolean(getPublishedState().contentKey === contentKey && isVisualReady(contentKey));
  }
  for (let i = 0; i < retries; i++) {
    try {
      await document.fonts.load(`16px "${family}"`);
      await document.fonts.ready;
      if (document.fonts.check(`16px "${family}"`)) {
        activeFontFamily = family;
        fontReady = true;
        return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  return fontReady === true;
}

export function isMaoyanFontReady(fontContentKey) {
  const key = fontContentKey || getPublishedState().contentKey || activePuaMapVersion;
  if (key) return isVisualReady(key);
  return fontReady === true;
}

async function resolveFontVersionKey(fontStyle, fontBuffer = null, fastOnly = false) {
  if (fontBuffer) return computeVersionKeyAsync(fontStyle, fontBuffer);
  const css = normalizeFontCss(fontStyle);
  if (!css) return activePuaMapVersion || "";
  const urlKey = computeVersionKey(css);
  if (fastOnly && urlKey && !urlKey.startsWith("mtsi:css:")) return urlKey;
  const url = extractFontUrls(css);
  if (!url) return urlKey;
  try {
    const normalizedUrl = url.startsWith("//") ? `https:${url}` : url;
    const resp = await fetch(normalizedUrl);
    if (resp.ok) {
      const buffer = await resp.arrayBuffer();
      return computeVersionKeyAsync(css, buffer);
    }
  } catch {
    /* fallback below */
  }
  return urlKey || computeVersionKey(css);
}

export async function injectFontStyle(fontStyle, options = {}) {
  const remoteCss = normalizeFontCss(fontStyle);
  if (!remoteCss || typeof document === "undefined") {
    return { versionKey: activePuaMapVersion, fontFamily: activeFontFamily, changed: false };
  }
  const probeGlyphs = options.probeGlyphs || [];
  const reg = await registerFontFromStyle(remoteCss, {
    fontBuffer: options.fontBuffer,
    probeGlyphs,
    fetchBuffer: options.fastVersion !== true && !options.fontBuffer,
  });
  const contentKey = options.versionKey || reg.contentKey;
  await waitForFontVisual(contentKey, probeGlyphs);
  const sameIdentity =
    normalizeFontIdentity(contentKey) === normalizeFontIdentity(activePuaMapVersion);
  lastFontStyle = remoteCss;
  activeFontFamily = reg.family;
  if (!sameIdentity) {
    activePuaMapVersion = contentKey;
  }
  if (getPublishedState().contentKey === contentKey) {
    fontReady = isVisualReady(contentKey);
  }
  return {
    versionKey: contentKey,
    urlKey: reg.urlKey,
    fontFamily: reg.family,
    changed: !sameIdentity,
  };
}

export function decodeFontNum(numHtml, fontContentKey) {
  if (!numHtml) return "";
  const contentKey = fontContentKey || getPublishedState().contentKey;
  if (contentKey) {
    const result = decodeHtmlWithFontKey(numHtml, contentKey);
    return result.verified ? result.text : "";
  }
  const rawInput = String(numHtml).replace(/<[^>]+>/g, "").trim();
  if (containsEncodedBoxMarkup(rawInput)) {
    if (
      typeof document === "undefined" ||
      !fontReady ||
      !activePuaMap ||
      activePuaMapMeta?.confidence !== MAP_CONFIDENCE.VERIFIED
    ) {
      return "";
    }
    const decoded = decodeMarkupWithPuaMap(numHtml, activePuaMap);
    if (!decoded.complete || !decoded.text) return "";
    if (!validateDecodedBoxStructure(numHtml, decoded.text) || isUntrustedBoxDecode(decoded.text)) {
      return "";
    }
    return decoded.text;
  }
  if (typeof document === "undefined") {
    const decoded = decodeHtmlEntities(rawInput);
    if (containsEncodedBoxMarkup(decoded)) return "";
    return isUntrustedBoxDecode(decoded) ? "" : decoded;
  }
  const el = ensureDecoder();
  el.innerHTML = numHtml;
  const text = (el.textContent || "").trim();
  if (!text) return "";
  if (hasPrivateUseChars(text)) {
    if (!fontReady || !activePuaMap || activePuaMapMeta?.confidence !== MAP_CONFIDENCE.VERIFIED) return "";
    const decoded = decodeMarkupWithPuaMap(numHtml, activePuaMap);
    if (!decoded.complete || !decoded.text) return "";
    if (!validateDecodedBoxStructure(numHtml, decoded.text) || isUntrustedBoxDecode(decoded.text)) {
      return "";
    }
    return decoded.text;
  }
  return isUntrustedBoxDecode(text) ? "" : text;
}

export function decodeFontNumWithTrace(numHtml) {
  const encoded = containsEncodedBoxMarkup(numHtml) || isEncodedBoxHtml(numHtml);
  const raw = decodeFontNum(numHtml);
  return {
    rawHtml: numHtml || "",
    encoded,
    fontVersion: activePuaMapVersion,
    fontMeta: activePuaMapMeta,
    decodedString: raw,
    mapReady: Boolean(activePuaMap),
    fontReady: fontReady === true,
  };
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
  const todayBox = parseBoxNum(todayRaw, todayUnit);
  if (todayBox > 0 && !isUntrustedBoxDecode(String(todayBox))) return todayBox;
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
  if (!isEmptyMetricValue(nation.seatValue)) {
    const raw = String(nation.seatValue).trim();
    const label = String(nation.seatLabel || "场均人次").trim() || "场均人次";
    if (/上座/.test(label)) {
      return {
        label,
        value: raw.includes("%") ? raw : `${raw.replace(/%$/g, "")}%`,
        seatRaw: raw,
        source: nation.seatSource || "preset",
      };
    }
    return { label, value: raw, seatRaw: raw, source: nation.seatSource || "preset" };
  }

  const avgShow = pickNonemptyNationField(nation, ["avgShowView", "avgShowViewDesc"]);
  if (avgShow) {
    return { label: "场均人次", value: avgShow, seatRaw: avgShow, source: "avgShowView" };
  }

  const views = parseDescNumber(nation.viewCountDesc);
  const shows = parseDescNumber(nation.showCountDesc);
  if (Number.isFinite(views) && Number.isFinite(shows) && shows > 0) {
    const formatted = formatAvgAttendance(views / shows);
    if (formatted) {
      return {
        label: "场均人次",
        value: formatted,
        seatRaw: `views/shows:${formatted}`,
        source: "computed",
      };
    }
  }

  const seatRaw = pickNonemptyNationField(nation, ["viewSeatRate", "seatRate", "viewSeatRateDesc"]);
  if (seatRaw) {
    const value = seatRaw.includes("%") ? seatRaw : `${seatRaw.replace(/%$/, "")}%`;
    return { label: "上座率", value, seatRaw, source: "avgSeatView" };
  }

  return { label: "场均人次", value: "--", seatRaw: "", source: "none" };
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

function buildRefreshDecodeContext(entity, options = {}) {
  return {
    todayUnit: normalizeUnit(entity?.todayUnit || options.todayUnit),
    nationBoxWan: Number(options.nationBoxWan) > 0 ? Number(options.nationBoxWan) : 0,
    sumBoxNumWan:
      Number(options.sumBoxNumWan) > 0
        ? Number(options.sumBoxNumWan)
        : Number(entity?.sumBoxNum) > 0
          ? Number(entity.sumBoxNum)
          : resolveMaoyanSumBoxWan(entity),
    fontMappingVersion: options.fontMappingVersion || getFontMappingVersion(),
  };
}

export function finalizeRefreshBoxFields(
  entity,
  todayBoxHtml,
  ctx,
  decodeStatus,
  todayRaw,
  todayBox,
  rejectionReason = "",
) {
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const fontVer = ctx.fontMappingVersion || getFontMappingVersion();
  if (decodeStatus === DECODE_STATUS.OK && todayBox > 0) {
    return {
      ...entity,
      todayBoxHtml,
      todayUnit: ctx.todayUnit,
      todayBoxText: todayRaw,
      todayBox,
      decodeStatus: DECODE_STATUS.OK,
      fontMappingVersion: fontVer,
      rejectionReason: "",
      decodeKeepPrevious: false,
    };
  }
  let status = decodeStatus;
  if (status === DECODE_STATUS.FAILED && encodedBox) {
    status = fontReady && activePuaMap ? DECODE_STATUS.DECODE_ERROR : DECODE_STATUS.ENCODED;
  }
  if (status === DECODE_STATUS.OK) status = DECODE_STATUS.DECODE_ERROR;

  // decode 失败：保留上一轮有效票房，禁止用 0/"--" 覆盖
  const prevBox = Number(entity?.todayBox) || 0;
  const prevText = String(entity?.todayBoxText || "").trim();
  const keepPrev = prevBox > 0 && !isUntrustedBoxDecode(String(prevBox));

  return {
    ...entity,
    todayBoxHtml,
    todayUnit: ctx.todayUnit,
    todayBoxText: keepPrev
      ? prevText && prevText !== "--" && !isUntrustedBoxDecode(prevText)
        ? prevText
        : String(prevBox)
      : "--",
    todayBox: keepPrev ? prevBox : 0,
    decodeStatus: status,
    fontMappingVersion: fontVer,
    rejectionReason: rejectionReason || activePuaMapMeta?.reason || "",
    decodeKeepPrevious: keepPrev,
  };
}

function resolveRefreshDecodeStatus(todayBoxHtml, todayRaw, encodedBox, ctx, { isNation = false } = {}) {
  const plausibility = isNation
    ? { nationBoxWan: 0, sumBoxNumWan: 0, absurdMaxWan: ABSURD_BOX_WAN_MAX }
    : { nationBoxWan: ctx.nationBoxWan, sumBoxNumWan: ctx.sumBoxNumWan };
  return resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox, {
    todayUnit: ctx.todayUnit,
    ...plausibility,
  });
}

export function refreshMovieBoxFields(movie, options = {}) {
  if (!movie) return movie;
  const todayBoxHtml = movie.todayBoxHtml || "";
  const ctx = buildRefreshDecodeContext(movie, options);
  const contentKey =
    ctx.fontContentKey || ctx.fontMappingVersion || getPublishedState().contentKey;
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const mapReady = contentKey ? isMapVerified(contentKey) : Boolean(activePuaMap);
  const visualReady = contentKey ? isVisualReady(contentKey) : fontReady;
  const todayRaw =
    encodedBox && (!visualReady || !mapReady) ? "" : decodeFontNum(todayBoxHtml, contentKey);
  const decodeStatus = resolveRefreshDecodeStatus(todayBoxHtml, todayRaw, encodedBox, ctx);

  if (decodeStatus === DECODE_STATUS.OK) {
    const todayBox = resolveTodayBox(todayRaw, ctx.todayUnit);
    if (todayBox <= 0) {
      return finalizeRefreshBoxFields(
        movie,
        todayBoxHtml,
        ctx,
        DECODE_STATUS.DECODE_ERROR,
        "",
        0,
        "non_positive",
      );
    }
    return finalizeRefreshBoxFields(movie, todayBoxHtml, ctx, DECODE_STATUS.OK, todayRaw, todayBox);
  }

  if (
    decodeStatus === DECODE_STATUS.ENCODED &&
    (!visualReady || !mapReady) &&
    movie.decodeStatus === DECODE_STATUS.OK &&
    movie.todayBox > 0
  ) {
    return {
      ...movie,
      todayUnit: ctx.todayUnit,
      fontMappingVersion: contentKey || ctx.fontMappingVersion || getFontMappingVersion(),
      fontContentKey: contentKey || "",
    };
  }

  return finalizeRefreshBoxFields(movie, todayBoxHtml, ctx, decodeStatus, "", 0);
}

export function refreshNationBoxFields(nation, options = {}) {
  if (!nation) return nation;
  const todayBoxHtml = nation.todayBoxHtml || "";
  const ctx = buildRefreshDecodeContext(nation, options);
  const contentKey =
    ctx.fontContentKey || ctx.fontMappingVersion || getPublishedState().contentKey;
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const mapReady = contentKey ? isMapVerified(contentKey) : Boolean(activePuaMap);
  const visualReady = contentKey ? isVisualReady(contentKey) : fontReady;
  const todayRaw =
    encodedBox && (!visualReady || !mapReady) ? "" : decodeFontNum(todayBoxHtml, contentKey);
  const decodeStatus = resolveRefreshDecodeStatus(todayBoxHtml, todayRaw, encodedBox, ctx, {
    isNation: true,
  });

  if (decodeStatus === DECODE_STATUS.OK) {
    const todayBox = resolveTodayBox(todayRaw, ctx.todayUnit);
    if (todayBox <= 0) {
      return finalizeRefreshBoxFields(
        nation,
        todayBoxHtml,
        ctx,
        DECODE_STATUS.DECODE_ERROR,
        "",
        0,
        "non_positive",
      );
    }
    if (
      !validateDecodedBoxStructure(todayBoxHtml, todayRaw) ||
      isUntrustedBoxDecode(todayRaw) ||
      rejectImplausibleTodayBoxWan(todayBox, { absurdMaxWan: ABSURD_BOX_WAN_MAX })
    ) {
      return finalizeRefreshBoxFields(
        nation,
        todayBoxHtml,
        ctx,
        DECODE_STATUS.DECODE_ERROR,
        "",
        0,
        "structure_or_absurd",
      );
    }
    const crossCtx =
      options.crossCheck || buildNationCrossCheckContext(options.movies || [], nation);
    const cross = validateNationCrossCheck(todayBox, crossCtx);
    if (!cross.ok) {
      return finalizeRefreshBoxFields(
        nation,
        todayBoxHtml,
        ctx,
        DECODE_STATUS.DECODE_ERROR,
        "",
        0,
        cross.reasons.join("|"),
      );
    }
    return finalizeRefreshBoxFields(nation, todayBoxHtml, ctx, DECODE_STATUS.OK, todayRaw, todayBox);
  }

  if (
    decodeStatus === DECODE_STATUS.ENCODED &&
    !fontReady &&
    nation.decodeStatus === DECODE_STATUS.OK &&
    nation.todayBox > 0
  ) {
    return {
      ...nation,
      todayUnit: ctx.todayUnit,
      decodeStatus: nation.decodeStatus,
      fontMappingVersion: ctx.fontMappingVersion || getFontMappingVersion(),
    };
  }

  return finalizeRefreshBoxFields(nation, todayBoxHtml, ctx, decodeStatus, "", 0);
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
  const decoded = String(decodeFontNum(unit) || unit || "").trim();
  if (!decoded) return "万";
  if (decoded.includes("亿")) return "亿";
  if (decoded.includes("万")) return "万";
  // 反爬 PUA / 未识别字符不能当单位，实时票房默认「万」
  if (/[\uE000-\uF8FF]/.test(decoded)) return "万";
  return "万";
}

export function decodeBoxFromHtml(numHtml, unit = "万") {
  return resolveTodayBox(decodeFontNum(numHtml), unit);
}

/** 气泡追踪：有 PUA 映射即可解码，不要求 VERIFIED */
export function decodeBoxHtmlLoose(numHtml, unit = "万", fontContentKey = "") {
  if (!numHtml) return 0;
  const safeUnit = normalizeUnit(unit);
  const contentKey = fontContentKey || getPublishedState().contentKey || activePuaMapVersion;

  const strictRaw = decodeFontNum(numHtml, contentKey);
  if (strictRaw && !isUntrustedBoxDecode(strictRaw)) {
    const strict = resolveTodayBox(strictRaw, safeUnit);
    if (strict > 0) return strict;
  }

  const tryMap = (map) => {
    if (!map?.size) return 0;
    const decoded = decodeMarkupWithPuaMap(numHtml, map);
    const raw = String(decoded?.text || "").trim();
    if (!raw || isUntrustedBoxDecode(raw)) return 0;
    const n = resolveTodayBox(raw, safeUnit);
    return n > 0 ? n : 0;
  };

  const fromRegistry = tryMap(getMapForKeyLoose(contentKey));
  if (fromRegistry > 0) return fromRegistry;

  // 显式指定了当前字体时，只能使用同一字体身份的 active map。
  // 禁止拿上一轮已发布字体去解这一轮新字体，避免错误数字污染高水位。
  const sameAsActive =
    !fontContentKey ||
    (contentKey &&
      activePuaMapVersion &&
      normalizeFontIdentity(contentKey) === normalizeFontIdentity(activePuaMapVersion));
  if (sameAsActive) {
    const fromActive = tryMap(activePuaMap);
    if (fromActive > 0) return fromActive;
  }

  for (const entry of [getMapForKey(contentKey)]) {
    const n = tryMap(entry);
    if (n > 0) return n;
  }
  return 0;
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

function parseYmdKeyToDate(key) {
  const digits = String(key).replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  return new Date(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8)));
}

function dayOffsetFromBusinessDate(showDate, businessDateStr) {
  const showKey = normalizeShowDateKey(showDate);
  const bizKey = normalizeShowDateKey(businessDateStr);
  if (!showKey || !bizKey) return null;
  const show = parseYmdKeyToDate(showKey);
  const biz = parseYmdKeyToDate(bizKey);
  if (!show || !biz) return null;
  return Math.round((show.getTime() - biz.getTime()) / 86400000);
}

function mapRowsByBusinessDateOffsets(rows, businessDateStr, mapRowFn) {
  const labels = ["今日", "明日", "后天"];
  const byOffset = new Map();
  for (const row of rows || []) {
    const offset = dayOffsetFromBusinessDate(row?.showDate, businessDateStr);
    if (offset == null || offset < 0 || offset > 2) continue;
    if (!byOffset.has(offset)) byOffset.set(offset, row);
  }
  return labels.map((label, offset) => {
    const row = byOffset.get(offset);
    if (!row) {
      return { label, box: "--", forecast: "--", boxRate: "--", showCountRate: "--", avgSeatView: "--" };
    }
    return { label, ...mapRowFn(row, offset) };
  });
}

function mapShowDateRowsToDaily(rows, todayStr, { forecastFields = [] } = {}) {
  return mapRowsByBusinessDateOffsets(rows, todayStr, (row) => {
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
    return {
      box: box ? formatDescMoney(box) : "--",
      forecast: forecast ? formatDescMoney(forecast) : "--",
      boxRate: row.boxRate || row.boxOfficeRate || "--",
      showCountRate: row.showCountRate || "--",
      avgSeatView: row.viewSeatRate || row.avgSeatView || row.seatRate || "--",
    };
  });
}

function mapBoxShowRowsToDaily(rows, todayStr) {
  // 表格「票房」：getBoxShow 按 showDate 对齐 businessDate 的 boxDesc（综合票房，样本 101.60万）
  return mapRowsByBusinessDateOffsets(rows, todayStr, (row) => {
    const box = pickDescValue(row.boxDesc, row.boxInfo, row.boxInfoDesc, row.boxOfficeDesc);
    return {
      box: box ? formatDescMoney(box) : "--",
      forecast: "--",
      boxRate: row.boxRate || row.boxOfficeRate || "--",
      showCountRate: row.showCountRate || "--",
      avgSeatView: row.viewSeatRate || row.avgSeatView || row.seatRate || "--",
    };
  });
}

function mapPredictionPageListToDaily(rows, todayStr) {
  return mapRowsByBusinessDateOffsets(rows, todayStr, (row) => {
    const forecastRaw = pickDescValue(
      row.boxInfo,
      row.boxInfoDesc,
      row.predictionDesc,
      row.predBoxDesc,
      row.box,
    );
    return {
      box: "--",
      forecast: forecastRaw ? formatDescMoney(forecastRaw) : "--",
      boxRate: row.boxRate || row.boxOfficeRate || "--",
      showCountRate: row.showCountRate || "--",
      avgSeatView: row.viewSeatRate || row.avgSeatView || row.seatRate || "--",
    };
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

  const totalViewsRaw =
    summary["累计观影人次"]?.valueDesc ?? summary["观影人次"]?.valueDesc ?? null;
  const totalViews =
    totalViewsRaw != null && String(totalViewsRaw).trim() !== "" ? String(totalViewsRaw).trim() : null;

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
    const todayRow = pageDaily.find((row) => row.label === "今日") || pageDaily[0];
    const todayVal = String(todayRow?.forecast || "").replace(/^¥/, "");
    if (todayVal && todayVal !== "--") {
      result.dynamicForecast = todayVal;
      result.dynamicForecastNum = parseBoxNum(todayVal);
    }
    const summary = inner.pageData?.boxSummary;
    const summaryVal = summary?.valueDesc || inner.pageData?.sumBox;
    const summaryUnit = summary?.unitDesc || "万";
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
    if (summary?.iMessage) {
      result.totalForecastMessage = String(summary.iMessage);
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
    result.dailyForecast = mapRowsByBusinessDateOffsets(list, todayStr, (item) => {
      const forecastRaw = pickDescValue(
        item.boxInfo,
        item.boxInfoDesc,
        item.predictionDesc,
        item.predBoxDesc,
        item.boxDesc,
        item.valueDesc,
        item.box,
      );
      return {
        box: "--",
        forecast: forecastRaw ? formatDescMoney(forecastRaw) : "--",
        boxRate: item.boxRate || item.boxOfficeRate || "--",
        showCountRate: item.showCountRate || "--",
        avgSeatView: item.viewSeatRate || item.avgSeatView || item.seatRate || "--",
      };
    });
    const todayRow = result.dailyForecast.find((row) => row.label === "今日");
    if (todayRow && todayRow.forecast && todayRow.forecast !== "--") {
      const val = String(todayRow.forecast).replace(/^¥/, "");
      result.dynamicForecast = val;
      result.dynamicForecastNum = parseBoxNum(val);
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

  const nationData = inner.nationData || {};
  const rankList = nationData.globalBoxRankList || inner.globalData || [];
  if (!Array.isArray(rankList) || !rankList.length) return null;

  let globalTotalBox = null;
  if (nationData.globalBox != null && String(nationData.globalBox).trim() !== "") {
    const unit = nationData.globalBoxUnit || "亿";
    const val = String(nationData.globalBox).trim();
    const text = val.includes("亿") || val.includes("万") ? val : `${val}${unit}`;
    globalTotalBox = formatDescMoney(text);
  }

  let mainland = null;
  let hmtWan = 0;
  let hmtHas = false;
  let overseasWan = 0;
  let overseasHas = false;
  const hmtNames = ["香港", "澳门", "台湾", "港澳台"];

  for (const item of rankList) {
    const name = String(item?.regionName || item?.name || item?.title || "").trim();
    const info = item?.sumBoxInfo || item?.boxDesc || item?.valueDesc || "";
    if (!name || !info) continue;
    if (name === "中国内地" || name === "中国大陆") {
      mainland = formatDescMoney(info);
      continue;
    }
    const wan = parseBoxNum(info);
    if (!(wan > 0)) continue;
    if (hmtNames.some((tag) => name.includes(tag))) {
      hmtWan += wan;
      hmtHas = true;
    } else {
      overseasWan += wan;
      overseasHas = true;
    }
  }

  return {
    mainland: mainland || "--",
    hmt: hmtHas ? formatMoneyWan(hmtWan) : "--",
    overseas: overseasHas ? formatMoneyWan(overseasWan) : "--",
    globalTotalBox: globalTotalBox || "--",
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

/** 从技术参数文案抽出 YYYY-MM-DD 列表（中文日期优先，否则 ISO） */
function extractYmdListFromTechText(text) {
  const s = String(text || "");
  const out = [];
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let m;
  while ((m = cn.exec(s))) {
    out.push(
      `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`,
    );
  }
  if (out.length) return out;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((m = iso.exec(s))) {
    out.push(
      `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`,
    );
  }
  return out;
}

/**
 * 真实 getTechData 结构是 items:[{title,desc}]，
 * 下映日在「延期至 / 延期至N / 放映期限」区间的最后一个日期。
 */
function pickDatesFromTechItems(items) {
  if (!Array.isArray(items) || !items.length) return { endDate: null, releaseDate: null };

  const delayItems = items
    .filter((it) => /^延期至/i.test(String(it?.title || "").trim()))
    .map((it) => {
      const n = Number((String(it.title).match(/延期至\s*(\d+)/i) || [])[1] || 0);
      return { it, n };
    })
    .sort((a, b) => a.n - b.n);

  const periodItem = items.find((it) => String(it?.title || "").includes("放映期限"));

  let endDate = null;
  if (delayItems.length) {
    const dates = extractYmdListFromTechText(delayItems[delayItems.length - 1].it?.desc);
    if (dates.length) endDate = dates[dates.length - 1];
  }
  if (!endDate && periodItem) {
    const dates = extractYmdListFromTechText(periodItem.desc);
    if (dates.length) endDate = dates[dates.length - 1];
  }

  let releaseDate = null;
  if (periodItem) {
    const dates = extractYmdListFromTechText(periodItem.desc);
    if (dates.length) releaseDate = dates[0];
  }

  return { endDate, releaseDate };
}

function formatTechYmd(value) {
  if (value == null || String(value).trim() === "") return "--";
  const dateRaw = String(value).trim();
  if (/^\d{8}$/.test(dateRaw)) {
    return `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(dateRaw)) return dateRaw.slice(0, 10);
  const fromText = extractYmdListFromTechText(dateRaw);
  if (fromText.length) return fromText[fromText.length - 1];
  // 纯月日
  if (/^\d{1,2}-\d{1,2}$/.test(dateRaw)) return dateRaw;
  return dateRaw.slice(0, 16);
}

function remainingDaysFromYmd(endDateStr, businessDateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endDateStr || ""));
  if (!m) return "--";
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let today = null;
  if (businessDateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDateStr))) {
    const [y, mo, d] = String(businessDateStr).split("-").map(Number);
    today = new Date(y, mo - 1, d);
  } else {
    const now = new Date();
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (Number.isNaN(end.getTime())) return "--";
  return String(Math.max(0, Math.round((end - today) / 86400000)));
}

function parseTechMetrics(raw, businessDateStr = "") {
  if (isFailedApiPayload(raw)) return null;
  const inner = unwrapPayload(raw);
  if (!inner) return null;

  const fromItems = pickDatesFromTechItems(inner.items);

  const endDate =
    fromItems.endDate ||
    inner.endDate ||
    inner.offlineDate ||
    inner.lastShowDate ||
    inner.endShowDate ||
    inner.showEndDate ||
    inner.offlineDay ||
    deepFind(inner, [
      "endDate",
      "offlineDate",
      "lastShowDate",
      "endShowDate",
      "showEndDate",
      "offlineDay",
    ]);

  const releaseDateRaw =
    fromItems.releaseDate ||
    inner.releaseDate ||
    inner.beginDate ||
    inner.startDate ||
    inner.showDate ||
    inner.releaseTime ||
    inner.openDay ||
    deepFind(inner, ["releaseDate", "beginDate", "startDate", "showDate", "releaseTime", "openDay"]);

  let endDateStr = "--";
  let remainingDays = "--";
  let releaseDateStr = "--";

  if (endDate != null && String(endDate).trim() !== "") {
    endDateStr = formatTechYmd(endDate);
    remainingDays = remainingDaysFromYmd(endDateStr, businessDateStr);
  } else if (inner.remainingDays != null && String(inner.remainingDays).trim() !== "") {
    remainingDays = String(inner.remainingDays).trim();
    const desc = inner.endDateDesc || inner.offlineDateDesc;
    if (desc != null && String(desc).trim() && String(desc).trim() !== "--") {
      endDateStr = String(desc).trim();
    }
  }

  if (inner.remainingDays != null && String(inner.remainingDays).trim() !== "") {
    remainingDays = String(inner.remainingDays).trim();
  }

  releaseDateStr = formatTechYmd(releaseDateRaw);
  if (releaseDateStr === "--") {
    const desc = inner.releaseDateDesc || inner.beginDateDesc || inner.startDateDesc;
    if (desc != null && String(desc).trim() && String(desc).trim() !== "--") {
      releaseDateStr = String(desc).trim();
    }
  }

  // 有 items 却解析不出日期时，仍返回对象，便于上层保留旧值；全空则视为无效
  if (
    endDateStr === "--" &&
    remainingDays === "--" &&
    releaseDateStr === "--" &&
    Array.isArray(inner.items)
  ) {
    return { endDate: "--", remainingDays: "--", releaseDate: "--" };
  }

  return { endDate: endDateStr, remainingDays, releaseDate: releaseDateStr };
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

function mapDashboardItemStructure(item, index) {
  const info = item.movieInfo || {};
  const todayBoxHtml = item.boxSplitUnit?.num || "";
  const todayUnit = normalizeUnit(item.boxSplitUnit?.unit);
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const splitHtml = item.splitBoxSplitUnit?.num || "";
  const splitUnit = normalizeUnit(item.splitBoxSplitUnit?.unit);

  return {
    _apiIndex: index,
    originalRank: index + 1,
    decodeStatus: encodedBox ? DECODE_STATUS.ENCODED : DECODE_STATUS.FAILED,
    movieId: info.movieId ?? `unknown-${index}`,
    name: info.movieName || "未知",
    releaseInfo: info.releaseInfo || "",
    releaseDate: info.releaseDate || info.showDate || "",
    todayBox: 0,
    todayBoxHtml,
    todayUnit,
    todayBoxText: "--",
    boxRate: item.boxRate || "--",
    boxRateNum: parseRate(item.boxRate),
    splitBoxRate: item.splitBoxRate || "--",
    splitBoxRateNum: parseRate(item.splitBoxRate),
    splitBoxHtml: splitHtml,
    splitBoxText: "--",
    splitBoxUnit: splitUnit,
    showCount: item.showCount ?? 0,
    showCountRate: item.showCountRate || "--",
    avgShowView: item.avgShowView || "--",
    avgSeatView: item.avgSeatView || "--",
    sumBoxDesc: item.sumBoxDesc || "--",
    sumSplitBoxDesc: item.sumSplitBoxDesc || "--",
    sumBoxNum: resolveMaoyanSumBoxWan(item),
    listItem: item,
    decodeVerified: false,
  };
}

function mapDashboardItem(item, index, context = {}) {
  const structural = mapDashboardItemStructure(item, index);
  const todayBoxHtml = structural.todayBoxHtml;
  const todayUnit = structural.todayUnit;
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const contentKey = context.fontContentKey || getPublishedState().contentKey;
  const todayRaw = decodeFontNum(todayBoxHtml, contentKey);
  const decodeStatus = resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox, {
    todayUnit,
    nationBoxWan: context.nationBoxWan,
    sumBoxNumWan: structural.sumBoxNum,
  });
  const todayBox =
    decodeStatus === DECODE_STATUS.OK ? resolveTodayBox(todayRaw, todayUnit) : 0;
  const splitRaw = decodeFontNum(structural.splitBoxHtml, contentKey);

  return {
    ...structural,
    decodeStatus,
    todayBox,
    todayBoxText: decodeStatus === DECODE_STATUS.OK ? todayRaw : "--",
    splitBoxText: splitRaw || "--",
    fontContentKey: contentKey || "",
    decodeVerified: decodeStatus === DECODE_STATUS.OK,
  };
}

function decodeMovieBoxFields(movie, fontContentKey, nationBoxWan = 0) {
  if (!movie || !fontContentKey) return movie;
  const todayBoxHtml = movie.todayBoxHtml || "";
  const todayUnit = movie.todayUnit || "万";
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const mapReady = isMapVerified(fontContentKey);
  const todayRaw =
    encodedBox && !mapReady ? "" : decodeFontNum(todayBoxHtml, fontContentKey);
  const decodeStatus = resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox, {
    todayUnit,
    nationBoxWan,
    sumBoxNumWan: movie.sumBoxNum || resolveMaoyanSumBoxWan(movie.listItem || movie),
  });
  const todayBox =
    decodeStatus === DECODE_STATUS.OK ? resolveTodayBox(todayRaw, todayUnit) : movie.todayBox || 0;
  const splitRaw = decodeFontNum(movie.splitBoxHtml, fontContentKey);
  return {
    ...movie,
    todayBox,
    todayBoxText: decodeStatus === DECODE_STATUS.OK ? todayRaw : movie.todayBoxText || "--",
    splitBoxText: splitRaw || movie.splitBoxText || "--",
    decodeStatus,
    fontContentKey,
    fontMappingVersion: fontContentKey,
    decodeVerified: decodeStatus === DECODE_STATUS.OK,
  };
}

function decodeNationBoxFields(nation, fontContentKey, movies = []) {
  if (!nation || !fontContentKey) return nation;
  const todayBoxHtml = nation.todayBoxHtml || "";
  const todayUnit = nation.todayUnit || "万";
  const encodedBox = isEncodedBoxHtml(todayBoxHtml);
  const mapReady = isMapVerified(fontContentKey);
  const todayRaw =
    encodedBox && !mapReady ? "" : decodeFontNum(todayBoxHtml, fontContentKey);
  const decodeStatus = resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox, {
    todayUnit,
  });
  let todayBox = nation.todayBox || 0;
  if (decodeStatus === DECODE_STATUS.OK) {
    todayBox = resolveTodayBox(todayRaw, todayUnit);
    if (
      !validateDecodedBoxStructure(todayBoxHtml, todayRaw) ||
      isUntrustedBoxDecode(todayRaw) ||
      rejectImplausibleTodayBoxWan(todayBox, { absurdMaxWan: ABSURD_BOX_WAN_MAX })
    ) {
      return { ...nation, decodeStatus: DECODE_STATUS.DECODE_ERROR, decodeVerified: false };
    }
    const crossCtx = buildNationCrossCheckContext(movies, nation);
    const cross = validateNationCrossCheck(todayBox, crossCtx);
    if (!cross.ok) {
      return {
        ...nation,
        decodeStatus: DECODE_STATUS.DECODE_ERROR,
        decodeVerified: false,
        rejectionReason: cross.reasons.join("|"),
      };
    }
  }
  const nationSplitRaw = decodeFontNum(nation.splitBoxHtml, fontContentKey);
  return {
    ...nation,
    todayBox,
    todayBoxText: decodeStatus === DECODE_STATUS.OK ? todayRaw : nation.todayBoxText || "--",
    splitBoxText: nationSplitRaw || nation.splitBoxText || "--",
    decodeStatus,
    fontContentKey,
    fontMappingVersion: fontContentKey,
    decodeVerified: decodeStatus === DECODE_STATUS.OK && todayBox > 0,
  };
}

export function decodeDashboardFields(parsed, fontContentKey, options = {}) {
  if (!parsed || !fontContentKey) return parsed;
  const movies = (parsed.movies || []).map((movie) =>
    decodeMovieBoxFields(movie, fontContentKey, 0),
  );
  const nation = decodeNationBoxFields(
    parsed.nation,
    fontContentKey,
    options.crossCheckMovies || movies,
  );
  const nationBoxWan = nation?.todayBox > 0 ? nation.todayBox : 0;
  const decodedMovies = movies.map((movie) =>
    decodeMovieBoxFields(movie, fontContentKey, nationBoxWan),
  );
  const ranked = pickOfficialDashboardMovies(
    rerankMoviesByTodayBox(decodedMovies),
    decodedMovies.length,
  );
  logDashboardRankDebug(ranked);
  return {
    ...parsed,
    movies: ranked,
    nation,
    fontContentKey,
  };
}

export function parseDashboardStructure(raw, topCount = 5) {
  const limit = resolveDisplayMovieCount(topCount);
  const list = raw?.movieList?.list ?? [];
  const nation = raw?.movieList?.nationBoxInfo ?? {};
  const updateInfo = raw?.movieList?.updateInfo ?? {};
  const calendar = raw?.calendar ?? {};

  const nationBoxHtml = nation.nationBoxSplitUnit?.num || "";
  const nationUnit = normalizeUnit(nation.nationBoxSplitUnit?.unit);
  const nationEncoded = isEncodedBoxHtml(nationBoxHtml);
  const nationDecodeStatus = nationEncoded ? DECODE_STATUS.ENCODED : DECODE_STATUS.FAILED;

  const fontUrlKey = resolveUrlKey(raw?.fontStyle || "");
  // 结构阶段还没有内容 sha256，但必须把“本轮字体身份”带到每条记录上。
  // 这样气泡 loose decode 在映射未准备好时会等待，而不是误用上一轮映射。
  const mapped = list.map((item, index) => ({
    ...mapDashboardItemStructure(item, index),
    fontMappingVersion: fontUrlKey,
  }));
  const movies = pickOfficialDashboardMovies(mapped, limit);

  const nationSplitHtml = nation.nationSplitBoxSplitUnit?.num || "";
  const nationSplitUnit = normalizeUnit(nation.nationSplitBoxSplitUnit?.unit);
  const globalTrends = parseTrends(raw?.movieInfo?.boxTrends, calendar.today);
  const seatMetric = resolveNationSeatMetric(nation);

  return {
    movies,
    nation: {
      title: nation.title || "实时大盘",
      todayBoxHtml: nationBoxHtml,
      todayUnit: nationUnit,
      todayBoxText: "--",
      todayBox: 0,
      decodeStatus: nationDecodeStatus,
      splitBoxHtml: nationSplitHtml,
      splitBoxText: "--",
      splitBoxUnit: nationSplitUnit,
      showCountDesc: nation.showCountDesc || "--",
      viewCountDesc: nation.viewCountDesc || "--",
      avgShowView: nation.avgShowView || "",
      seatLabel: seatMetric.label,
      seatValue: seatMetric.value,
      seatRaw: seatMetric.seatRaw,
      seatSource: seatMetric.source,
      decodeVerified: false,
      fontMappingVersion: fontUrlKey,
    },
    calendar: {
      today: calendar.today || "",
    },
    updateGapSecond: updateInfo.updateGapSecond || 5,
    updateTimestamp: updateInfo.updateTimestamp || Date.now(),
    updateTimeText: formatTimestamp(updateInfo.updateTimestamp) || "",
    fontStyle: raw?.fontStyle || "",
    fontUrlKey,
    updatedAt: Date.now(),
    globalTrends,
  };
}

export function parseDashboard(raw, topCount = 5) {
  const structural = parseDashboardStructure(raw, topCount);
  const contentKey = getPublishedState().contentKey;
  if (contentKey && isMapVerified(contentKey)) {
    return decodeDashboardFields(structural, contentKey);
  }
  return structural;
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
  if (boxShow.totalViews != null && String(boxShow.totalViews).trim() !== "") {
    mergeOverwriteField(merged, "totalViews", boxShow.totalViews);
  }

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
  }
  mergePreserveField(merged, "hmtBox", global.hmt);
  mergePreserveField(merged, "overseasBox", global.overseas);
  mergePreserveField(merged, "globalTotalBox", global.globalTotalBox);

  mergePreserveField(merged, "endDate", tech.endDate);
  mergePreserveField(merged, "remainingDays", tech.remainingDays);
  mergePreserveField(merged, "releaseDate", tech.releaseDate);

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
    if (/场$/.test(text) || /万/.test(text)) return text;
    return `${text}场`;
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
const TECH_AUDIT_FIELDS = ["endDate", "remainingDays", "releaseDate"];

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
  { label: "下映日期", key: "endDate", source: "getTechData", raw: "items[延期至/放映期限]" },
  { label: "剩余天数", key: "remainingDays", source: "getTechData", raw: "from endDate" },
  { label: "分账票房", key: "sumSplitBoxDesc", source: "dashboard", raw: "sumSplitBoxDesc" },
  { label: "分账占比", key: "splitBoxRate", source: "dashboard", raw: "splitBoxRate" },
  { label: "内地票房", key: "mainlandBox", source: "getBoxShowna", raw: "nationData.globalBoxRankList[中国内地].sumBoxInfo" },
  { label: "港澳台票房", key: "hmtBox", source: "getBoxShowna", raw: "hmtBoxDesc" },
  { label: "海外票房", key: "overseasBox", source: "getBoxShowna", raw: "overseasBoxDesc" },
];

function formatEndDateForExtra(m) {
  const hasDate = !isEmptyMetricValue(m?.endDate);
  const hasDays = !isEmptyMetricValue(m?.remainingDays);
  if (!hasDate && !hasDays) return "";
  const dateText = hasDate ? String(m.endDate).replace(/^\d{4}-/, "").trim() : "";
  const days = hasDays ? `剩${String(m.remainingDays).trim()}天` : "";
  if (dateText && days) return `${dateText} ${days}`;
  return dateText || days;
}

const EXTRA_METRIC_CANDIDATES = [
  { key: "dynamicForecast", label: "动态预测", tier: 1, get: (m) => m.dynamicForecast },
  { key: "showCountDesc", label: "排片场次", tier: 1, get: (m) => formatShowCountDesc(m) },
  { key: "sumBoxDesc", label: "累计票房", tier: 1, get: (m) => m.sumBoxDesc },
  { key: "yesterdayTotal", label: "昨日票房", tier: 1, get: (m) => m.yesterdayTotal },
  { key: "avgShowView", label: "场均人次", tier: 1, get: (m) => m.avgShowView },
  { key: "yesterdaySamePeriodText", label: "昨日同期", tier: 1, get: (m) => m.yesterdaySamePeriodText },
  { key: "totalViews", label: "累计观影人次", tier: 1, get: (m) => m.totalViews },
  { key: "totalForecast", label: "总预测", tier: 2, get: (m) => m.totalForecast },
  {
    key: "endDate",
    label: "下映日期",
    tier: 2,
    get: (m) => formatEndDateForExtra(m),
  },
  {
    key: "remainingDays",
    label: "剩余天数",
    tier: 2,
    // 下映日期已带「剩N天」时不再单独占一格
    get: (m) =>
      !isEmptyMetricValue(m.endDate) || isEmptyMetricValue(m.remainingDays)
        ? ""
        : `剩${m.remainingDays}天`,
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
  const forecastByLabel = new Map(forecasts.map((row) => [String(row.label || "").trim(), row]));
  const boxByLabel = new Map(boxShowRows.map((row) => [String(row.label || "").trim(), row]));
  const rows = [];

  for (const label of labels) {
    const pf = forecastByLabel.get(label) || {};
    const bs = boxByLabel.get(label) || {};
    const isToday = label === "今日";
    rows.push({
      label,
      // 表格票房：仅 getBoxShow 按 showDate 对齐；不与 dashboard 实时口径混用
      box: !isEmptyMetricValue(bs.box) && bs.box !== "--" ? bs.box : "--",
      boxHtml: "",
      boxUnit: "万",
      // 表格预测：仅 getPredictionBox 按 showDate 对齐
      forecast: !isEmptyMetricValue(pf.forecast) && pf.forecast !== "--" ? pf.forecast : "--",
      boxRate: !isEmptyMetricValue(bs.boxRate) && bs.boxRate !== "--" ? bs.boxRate : "--",
      showCountRate:
        !isEmptyMetricValue(bs.showCountRate) && bs.showCountRate !== "--" ? bs.showCountRate : "--",
      avgSeatView:
        !isEmptyMetricValue(bs.avgSeatView) && bs.avgSeatView !== "--" ? bs.avgSeatView : "--",
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
  let techRaw = null;
  // 预测 + 下映并行，优先出下映/上映日期，避免先卡在预测重试
  try {
    [predictionRaw, techRaw] = await Promise.all([
      fetchPredictionBox(apiBase, movie.movieId, parentSignal).catch((error) => {
        if (parentSignal?.aborted) throw error;
        captureExtraError("预测票房", error);
        return null;
      }),
      fetchTechData(apiBase, movie.movieId, parentSignal).catch((error) => {
        if (parentSignal?.aborted) throw error;
        captureExtraError("下映时间", error);
        console.warn(`getTechData 失败 movieId=${movie.movieId}:`, error?.message || error);
        return null;
      }),
    ]);
  } catch (error) {
    if (parentSignal?.aborted) throw error;
  }

  let parsedPrediction = predictionRaw ? parsePredictionMetrics(predictionRaw, todayStr) : null;
  if (!parsedPrediction?.dailyForecast?.length && predictionRaw == null) {
    await sleep(200);
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
  if (techRaw) {
    const parsed = parseTechMetrics(techRaw, todayStr);
    if (parsed) {
      detail.tech = parsed;
      if (parsed.endDate === "--" && parsed.remainingDays === "--") {
        const titles = Array.isArray(unwrapPayload(techRaw)?.items)
          ? unwrapPayload(techRaw).items.map((it) => it?.title).filter(Boolean).join(",")
          : "";
        console.warn(`getTechData 无下映日期 movieId=${movie.movieId} items=${titles || "-"}`);
      } else {
        console.log(
          `getTechData ok movieId=${movie.movieId} endDate=${parsed.endDate} remain=${parsed.remainingDays}`,
        );
      }
    } else {
      console.warn(`getTechData 解析空 movieId=${movie.movieId}`);
    }
  }

  const [boxShowRaw, globalRaw] = await Promise.all([
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
  ]);

  if (boxShowRaw) detail.boxShow = parseBoxShowMetrics(boxShowRaw, todayStr) || {};
  if (globalRaw) {
    const parsed = parseGlobalMetrics(globalRaw);
    if (parsed) detail.global = parsed;
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

export { parsePredictionMetrics, parseBoxShowMetrics, parseTechMetrics, parseGlobalMetrics };

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
