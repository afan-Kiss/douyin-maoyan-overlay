/** 大盘排名纯数据逻辑（无 DOM 依赖，浏览器/Node 共用） */

export const DECODE_STATUS = {
  OK: "ok",
  FAILED: "failed",
  ENCODED: "encoded",
};

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

export function isEncodedBoxHtmlNode(numHtml) {
  const raw = String(numHtml || "");
  if (!raw) return false;
  if (/&#x[e-f0-9]{3,4};/i.test(raw)) return true;
  if (/[\uE000-\uF8FF]/.test(raw)) return true;
  return false;
}

export function decodeBoxNumNode(numHtml) {
  if (!numHtml) return "";
  const plain = String(numHtml).replace(/<[^>]+>/g, "").trim();
  if (!plain || plain === "0") return "";
  if (isUntrustedBoxDecode(plain)) return "";
  return plain;
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

function normalizeUnit(unit) {
  const decoded = String(unit || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return decoded || "万";
}

/**
 * 累计总票房（万）：只取猫眼接口真实字段。
 * 优先数字字段，否则解析 sumBoxDesc（如 "23.35亿"）。
 * 禁止估算、禁止用实时票房/占比反推。
 */
export function resolveMaoyanSumBoxWan(item = {}) {
  const numericCandidates = [
    item.sumBox,
    item.sumBoxInfo,
    item.totalBox,
    item.boxSum,
  ];
  for (const raw of numericCandidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      // 猫眼偶发返回「元」量级的大整数，统一到「万」
      return raw >= 1000000 ? raw / 10000 : raw;
    }
    const parsed = parseBoxNum(String(raw));
    if (parsed > 0) return parsed;
  }
  const desc = item.sumBoxDesc || item.sumBoxInfoDesc || "";
  return parseBoxNum(desc);
}

export function resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox) {
  if (todayRaw && todayRaw !== "0" && !isUntrustedBoxDecode(todayRaw)) {
    return DECODE_STATUS.OK;
  }
  if (encodedBox || isEncodedBoxHtmlNode(todayBoxHtml)) return DECODE_STATUS.ENCODED;
  return DECODE_STATUS.FAILED;
}

export function resolveTodayBoxFromRaw(todayRaw, todayUnit) {
  if (!todayRaw || isUntrustedBoxDecode(todayRaw)) return 0;
  const todayBox = parseBoxNum(todayRaw, todayUnit);
  if (todayBox > 0 && !isUntrustedBoxDecode(String(todayBox))) return todayBox;
  const stripped = String(todayRaw).replace(/[^\d.]/g, "");
  if (stripped && !isUntrustedBoxDecode(stripped)) {
    const retry = parseBoxNum(stripped, todayUnit);
    if (retry > 0 && !isUntrustedBoxDecode(String(retry))) return retry;
  }
  return 0;
}

export function mapRawItemForRank(item, index, options = {}) {
  const decodeFontNum = options.decodeFontNum || decodeBoxNumNode;
  const isEncodedBox = options.isEncodedBox || isEncodedBoxHtmlNode;
  const info = item.movieInfo || {};
  const todayBoxHtml = item.boxSplitUnit?.num || "";
  const todayUnit = normalizeUnit(item.boxSplitUnit?.unit);
  const encodedBox = isEncodedBox(todayBoxHtml);
  const todayRaw = decodeFontNum(todayBoxHtml);
  const decodeStatus = resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox);
  const todayBox =
    decodeStatus === DECODE_STATUS.OK ? resolveTodayBoxFromRaw(todayRaw, todayUnit) : 0;

  return {
    _apiIndex: index,
    originalRank: index + 1,
    movieId: info.movieId ?? `unknown-${index}`,
    movieName: info.movieName || "未知",
    name: info.movieName || "未知",
    todayBox,
    todayBoxText: decodeStatus === DECODE_STATUS.OK ? todayRaw : "--",
    todayUnit,
    boxRate: item.boxRate || "--",
    boxRateNum: parseRate(item.boxRate),
    sumBoxDesc: item.sumBoxDesc || "--",
    sumBoxNum: resolveMaoyanSumBoxWan(item),
    decodeStatus,
  };
}

/**
 * 按猫眼累计总票房（sumBoxDesc / sumBox）降序。
 * 数据全部来自猫眼大盘接口，客户端只做排序，不造数。
 */
export function sortDashboardMovies(movies) {
  const list = [...(movies || [])].map((movie, index) => ({
    ...movie,
    _apiIndex: movie._apiIndex ?? (movie.originalRank != null ? movie.originalRank - 1 : index),
    sumBoxNum:
      Number.isFinite(movie.sumBoxNum) && movie.sumBoxNum > 0
        ? movie.sumBoxNum
        : resolveMaoyanSumBoxWan(movie),
    boxRateNum:
      Number.isFinite(movie.boxRateNum) && movie.boxRateNum > 0
        ? movie.boxRateNum
        : parseRate(movie.boxRate),
  }));

  const anyTotal = list.some((movie) => Number(movie.sumBoxNum) > 0);
  if (!anyTotal) {
    return list.sort((a, b) => (a._apiIndex ?? 0) - (b._apiIndex ?? 0));
  }

  return list.sort((a, b) => {
    const totalDiff = (b.sumBoxNum || 0) - (a.sumBoxNum || 0);
    if (totalDiff !== 0) return totalDiff;
    const boxDiff = (b.todayBox || 0) - (a.todayBox || 0);
    if (boxDiff !== 0) return boxDiff;
    const rateDiff = (b.boxRateNum || 0) - (a.boxRateNum || 0);
    if (rateDiff !== 0) return rateDiff;
    return (a._apiIndex ?? 0) - (b._apiIndex ?? 0);
  });
}

/** 按累计总票房重新赋 rank（保留 originalRank） */
export function rerankMoviesByTodayBox(movies) {
  return rerankMoviesByTotalBox(movies);
}

export function rerankMoviesByTotalBox(movies) {
  const prepared = (movies || []).map((movie, index) => ({
    ...movie,
    _apiIndex: movie._apiIndex ?? (movie.originalRank != null ? movie.originalRank - 1 : index),
    originalRank: movie.originalRank ?? index + 1,
    sumBoxNum:
      Number.isFinite(movie.sumBoxNum) && movie.sumBoxNum > 0
        ? movie.sumBoxNum
        : resolveMaoyanSumBoxWan(movie),
    boxRateNum:
      Number.isFinite(movie.boxRateNum) && movie.boxRateNum > 0
        ? movie.boxRateNum
        : parseRate(movie.boxRate),
    decodeStatus:
      movie.decodeStatus ||
      (movie.todayBox > 0 ? DECODE_STATUS.OK : DECODE_STATUS.FAILED),
  }));
  const sorted = sortDashboardMovies(prepared);
  return sorted.map((movie, index) => {
    const { _apiIndex, ...rest } = movie;
    return { ...rest, rank: index + 1 };
  });
}

/**
 * 对齐猫眼专业版官方展示：
 * 1) 先取猫眼大盘 API 顺序中的前 N 名（当日实时票房榜）
 * 2) 再按累计总票房（中国内地 sumBoxDesc）重排显示顺序
 * 禁止：对全量电影按累计截 TOP N（会把「给阿嬷的情书」等挤进来）
 */
export function pickOfficialDashboardMovies(movies, topCount = 5) {
  const limit = Math.max(1, Math.min(Number(topCount) || 5, 20));
  const byApiOrder = [...(movies || [])].sort(
    (a, b) => (a._apiIndex ?? a.originalRank - 1) - (b._apiIndex ?? b.originalRank - 1),
  );
  const todayTop = byApiOrder.slice(0, limit);
  const sorted = sortDashboardMovies(todayTop);
  return sorted.map((movie, index) => {
    const { _apiIndex, ...rest } = movie;
    return { ...rest, rank: index + 1 };
  });
}

export function buildRankSnapshotEntries(movies) {
  return (movies || []).map((movie) => ({
    rank: movie.rank,
    movieName: movie.movieName || movie.name || "未知",
    todayBox: movie.todayBox ?? 0,
    sumBoxDesc: movie.sumBoxDesc || "--",
    boxRate: movie.boxRate || "--",
    decodeStatus: movie.decodeStatus || DECODE_STATUS.FAILED,
    originalRank: movie.originalRank ?? null,
  }));
}

export function rankDashboardList(rawList, options = {}) {
  const topCount = options.topCount || 0;
  const mapped = (rawList || []).map((item, index) => mapRawItemForRank(item, index, options));
  if (topCount > 0) return pickOfficialDashboardMovies(mapped, topCount);
  const sorted = sortDashboardMovies(mapped);
  return sorted.map((movie, index) => {
    const { _apiIndex, ...rest } = movie;
    return { ...rest, rank: index + 1 };
  });
}

export function buildRankSnapshotFromRawList(rawList, topN = 0, options = {}) {
  const ranked = rankDashboardList(rawList, { ...options, topCount: topN || 0 });
  return buildRankSnapshotEntries(ranked);
}
