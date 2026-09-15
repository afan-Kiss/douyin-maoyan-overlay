/** 大盘排名纯数据逻辑（无 DOM 依赖，浏览器/Node 共用） */

export const DECODE_STATUS = {
  OK: "ok",
  FAILED: "failed",
  ENCODED: "encoded",
  DECODE_ERROR: "decode_error",
};

export const PUA_MIN = 0xe000;
export const PUA_MAX = 0xf8ff;

export function isPuaCodePoint(code) {
  return Number.isFinite(code) && code >= PUA_MIN && code <= PUA_MAX;
}

export function decodeHtmlEntities(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/** 按顺序提取 HTML 实体与字面字符的 Unicode 码点（不含标签） */
export function iterMarkupCodePoints(text) {
  const raw = String(text || "");
  const points = [];
  const entityRe = /&#x([0-9a-f]+);|&#(\d+);/gi;
  let last = 0;
  let match;
  while ((match = entityRe.exec(raw)) !== null) {
    const between = raw.slice(last, match.index).replace(/<[^>]+>/g, "");
    for (const ch of between) {
      const cp = ch.codePointAt(0);
      if (cp != null) points.push(cp);
    }
    const code = match[1] ? parseInt(match[1], 16) : parseInt(match[2], 10);
    if (Number.isFinite(code)) points.push(code);
    last = match.index + match[0].length;
  }
  const tail = raw.slice(last).replace(/<[^>]+>/g, "");
  for (const ch of tail) {
    const cp = ch.codePointAt(0);
    if (cp != null) points.push(cp);
  }
  return points;
}

export function containsEncodedBoxMarkup(text) {
  return iterMarkupCodePoints(text).some(isPuaCodePoint);
}

export function countEncodedBoxGlyphs(numHtml) {
  return iterMarkupCodePoints(String(numHtml || "").replace(/<[^>]+>/g, "")).filter(isPuaCodePoint)
    .length;
}

export function isUntrustedBoxDecode(text) {
  if (text == null) return true;
  const raw = String(text).trim();
  if (!raw || raw === "--" || raw === "-") return true;
  if (containsEncodedBoxMarkup(raw)) return true;
  const s = raw.replace(/[^\d.]/g, "");
  if (!s) return true;
  const digits = s.replace(/\./g, "");
  if (!digits) return true;
  // 反爬解码失败常变成 1111.1 / 111.11，不能把 88.8 等真实票房误判为不可信
  if (digits.length >= 4 && /^1+$/.test(digits)) return true;
  const ones = (digits.match(/1/g) || []).length;
  if (digits.length >= 4 && ones / digits.length >= 0.75) return true;
  return false;
}

export function validateDecodedBoxStructure(numHtml, decodedText) {
  if (!decodedText || decodedText === "--") return false;
  const decoded = String(decodedText).trim();
  if (!/^[\d.]+$/.test(decoded)) return false;
  if ((decoded.match(/\./g) || []).length > 1) return false;
  const glyphCount = countEncodedBoxGlyphs(numHtml);
  const digitCount = decoded.replace(/\./g, "").length;
  if (glyphCount > 0 && digitCount !== glyphCount) return false;
  return digitCount >= 1 && digitCount <= 12;
}

/**
 * 内部票房单位「万」：30000万=3亿元（非3万元）。
 * 仅拦截 8572685.878 等明显不可能值；150亿 >> 节假日 5亿/10亿合法峰值。
 */
export const ABSURD_BOX_WAN_MAX = 1_500_000;

export function rejectImplausibleTodayBoxWan(todayBoxWan, context = {}) {
  if (!Number.isFinite(todayBoxWan) || todayBoxWan <= 0) return true;
  const { nationBoxWan, sumBoxNumWan, absurdMaxWan } = context;
  const absurdCap = Number.isFinite(absurdMaxWan) && absurdMaxWan > 0 ? absurdMaxWan : ABSURD_BOX_WAN_MAX;
  if (todayBoxWan > absurdCap) return true;
  if (Number.isFinite(nationBoxWan) && nationBoxWan > 0 && todayBoxWan > nationBoxWan * 1.05) {
    return true;
  }
  if (Number.isFinite(sumBoxNumWan) && sumBoxNumWan > 0 && todayBoxWan > sumBoxNumWan * 1.01) {
    return true;
  }
  return false;
}

export function validateNationCrossCheck(nationBoxWan, context = {}) {
  const reasons = [];
  if (!Number.isFinite(nationBoxWan) || nationBoxWan <= 0) {
    return { ok: false, reasons: ["non_positive"] };
  }
  const absurdCap =
    Number.isFinite(context.absurdMaxWan) && context.absurdMaxWan > 0
      ? context.absurdMaxWan
      : ABSURD_BOX_WAN_MAX;
  if (nationBoxWan > absurdCap) reasons.push("absurd_magnitude");

  const top1BoxWan = Number(context.top1BoxWan) || 0;
  const moviesSumWan = Number(context.moviesSumWan) || 0;
  const top1BoxRate = Number(context.top1BoxRate) || 0;

  if (top1BoxWan > 0 && nationBoxWan < top1BoxWan * 0.98) {
    reasons.push("nation_below_top1");
  }
  if (moviesSumWan > 0 && nationBoxWan < moviesSumWan * 0.85) {
    reasons.push("nation_below_movies_sum");
  }
  if (top1BoxRate > 0 && top1BoxWan > 0) {
    const impliedNation = (top1BoxWan / top1BoxRate) * 100;
    if (impliedNation > 0) {
      const ratio = nationBoxWan / impliedNation;
      if (ratio < 0.85 || ratio > 1.15) reasons.push("box_rate_mismatch");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function buildNationCrossCheckContext(movies = [], nation = {}) {
  const decoded = (movies || []).filter((m) => m?.decodeStatus === "ok" && m.todayBox > 0);
  const top1 = decoded.find((m) => Number(m.rank) === 1) || decoded[0] || null;
  const moviesSumWan = decoded.reduce((sum, m) => sum + (Number(m.todayBox) || 0), 0);
  return {
    top1BoxWan: top1?.todayBox || 0,
    top1BoxRate: top1?.boxRateNum || parseRate(top1?.boxRate),
    moviesSumWan,
    absurdMaxWan: ABSURD_BOX_WAN_MAX,
    nationYesterdayWan: Number(nation?.yesterdayBoxWan) || 0,
  };
}

export function isEncodedBoxHtmlNode(numHtml) {
  return containsEncodedBoxMarkup(numHtml);
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
 * 优先 sumBoxDesc / sumBoxInfoDesc（带「万/亿」），与专业版展示一致。
 * 数字字段仅在 desc 缺失时回退；禁止估算、禁止用实时票房/占比反推。
 */
export function resolveMaoyanSumBoxWan(item = {}) {
  const desc = String(item.sumBoxDesc || item.sumBoxInfoDesc || "").trim();
  if (desc && desc !== "--" && desc !== "-") {
    // 累计字段若被反爬编码，本函数不猜数（交由上层保留旧值）
    if (containsEncodedBoxMarkup(desc)) return 0;
    if (desc.includes("亿") || desc.includes("万")) {
      const fromDesc = parseBoxNum(desc);
      if (fromDesc > 0) return fromDesc;
    }
  }

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
      // 阈值：>=1e7 元（≥1000万）才按元缩放，避免把「万」量级误除
      if (raw >= 10_000_000) return raw / 10000;
      return raw;
    }
    const text = String(raw).trim();
    if (!text || containsEncodedBoxMarkup(text)) continue;
    const parsed = parseBoxNum(text);
    if (parsed > 0) return parsed;
  }

  if (desc && desc !== "--" && desc !== "-" && !containsEncodedBoxMarkup(desc)) {
    const fromPlain = parseBoxNum(desc, "万");
    if (fromPlain > 0) return fromPlain;
  }
  return 0;
}

/**
 * 累计票房稳定性校验（不改排序算法，只过滤异常值）。
 * 异常时返回 prev，避免污染排名与展示。
 */
export function stabilizeSumBoxWan(nextWan, options = {}) {
  const next = Number(nextWan) || 0;
  const prev = Number(options.prevWan) || 0;
  const todayBox = Number(options.todayBoxWan) || 0;
  const rawDesc = String(options.rawDesc || "").trim();

  if (!(next > 0)) {
    return {
      ok: false,
      valueWan: prev > 0 ? prev : 0,
      reason: "non_positive",
      keptPrevious: prev > 0,
    };
  }

  // 1) 累计必须大于实时（允许极小误差）
  if (todayBox > 0 && next + 0.01 < todayBox) {
    return {
      ok: false,
      valueWan: prev > 0 ? prev : 0,
      reason: "sum_lt_today",
      keptPrevious: prev > 0,
    };
  }

  // 2) 连续刷新禁止暴跳（如 1亿→7亿）
  if (prev > 0) {
    const ratio = next / prev;
    if (ratio >= 2 || ratio <= 0.5) {
      return {
        ok: false,
        valueWan: prev,
        reason: "sudden_jump",
        keptPrevious: true,
        prevWan: prev,
        nextWan: next,
        ratio,
      };
    }
  }

  // 3) 与猫眼原始 desc 单位一致：desc 能解析时，数值不得明显偏离
  if (rawDesc && (rawDesc.includes("亿") || rawDesc.includes("万")) && !containsEncodedBoxMarkup(rawDesc)) {
    const descWan = parseBoxNum(rawDesc);
    if (descWan > 0) {
      const drift = Math.abs(next - descWan) / descWan;
      if (drift > 0.05) {
        return {
          ok: true,
          valueWan: descWan,
          reason: "aligned_to_desc",
          keptPrevious: false,
        };
      }
    }
  }

  return { ok: true, valueWan: next, reason: "ok", keptPrevious: false };
}

export function resolveDecodeStatus(todayBoxHtml, todayRaw, encodedBox, options = {}) {
  const html = String(todayBoxHtml || "");
  const encoded = encodedBox || isEncodedBoxHtmlNode(html) || containsEncodedBoxMarkup(html);
  if (encoded) {
    if (!todayRaw || todayRaw === "0" || isUntrustedBoxDecode(todayRaw)) {
      return DECODE_STATUS.ENCODED;
    }
    if (!validateDecodedBoxStructure(html, todayRaw)) {
      return DECODE_STATUS.DECODE_ERROR;
    }
    const todayUnit = options.todayUnit || "万";
    const todayBoxWan = resolveTodayBoxFromRaw(todayRaw, todayUnit);
    if (rejectImplausibleTodayBoxWan(todayBoxWan, options)) {
      return DECODE_STATUS.DECODE_ERROR;
    }
    return DECODE_STATUS.OK;
  }
  if (todayRaw && todayRaw !== "0" && !isUntrustedBoxDecode(todayRaw)) {
    if (!validateDecodedBoxStructure(html, todayRaw)) {
      return DECODE_STATUS.DECODE_ERROR;
    }
    const todayUnit = options.todayUnit || "万";
    const todayBoxWan = resolveTodayBoxFromRaw(todayRaw, todayUnit);
    if (todayBoxWan <= 0) return DECODE_STATUS.FAILED;
    if (rejectImplausibleTodayBoxWan(todayBoxWan, options)) {
      return DECODE_STATUS.DECODE_ERROR;
    }
    return DECODE_STATUS.OK;
  }
  return DECODE_STATUS.FAILED;
}

export function resolveTodayBoxFromRaw(todayRaw, todayUnit) {
  if (!todayRaw || isUntrustedBoxDecode(todayRaw)) return 0;
  const todayBox = parseBoxNum(todayRaw, todayUnit);
  if (todayBox > 0 && !isUntrustedBoxDecode(String(todayBox))) return todayBox;
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
