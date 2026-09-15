/**
 * Box Pipeline V2
 *
 * 猫眼 → decode → Store → Renderer
 *
 * 规则：
 * - 单循环 5000ms；上一轮未结束则 skip
 * - 整轮完成（font mapping + decode + validate）后才 commit
 * - mapping 按 fontIdentity 缓存，不因 poll 过期作废
 * - 中间态禁止进入 UI
 */

import {
  fetchDashboard,
  decodeDashboardFields,
  isUntrustedBoxDecode,
  isEncodedBoxHtml,
  parseBoxNum,
  decodeBoxHtmlLoose,
  DECODE_STATUS,
  tryPublishDashboardSession,
} from "./maoyan-api.js";
import {
  createDashboardSession,
  prepareSessionFont,
  buildSessionPuaMap,
  tryPublishSession,
  sessionFontIdentity,
} from "./dashboard-session.js";
import { isMapVerified, normalizeFontIdentity, getMapForKeyLoose } from "./font-registry.js";
import {
  parseRate,
  validateNationCrossCheck,
} from "./dashboard-rank.js";
import { boxStore } from "./box-store.js";
import { formatWanForDisplay } from "./box-display.js";

/** V2 生产主链固定 5s；不受旧设置 4s/8s/10s 影响 */
export const BOX_POLL_MS = 5000;
const DEFAULT_POLL_MS = BOX_POLL_MS;

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/** VERIFIED 或 INFERRED 且有映射表即可进入 V2 decode */
export function isMapReadyForV2(contentKey) {
  const key = String(contentKey || "").trim();
  if (!key) return false;
  if (isMapVerified(key)) return true;
  const map = getMapForKeyLoose(key);
  return Boolean(map && map.size > 0);
}

/**
 * 统一解码结果。失败绝不伪装 valueWan=0。
 */
export function makeDecodeResult({
  ok,
  valueWan = null,
  text = "",
  unit = "万",
  fontKey = "",
  reason = "",
}) {
  if (!ok) {
    return {
      ok: false,
      valueWan: null,
      text: "",
      unit: unit === "亿" ? "亿" : "万",
      fontKey: String(fontKey || ""),
      reason: String(reason || "decode_failed"),
    };
  }
  const n = Number(valueWan);
  if (!Number.isFinite(n) || n <= 0 || isUntrustedBoxDecode(String(text || n))) {
    return {
      ok: false,
      valueWan: null,
      text: "",
      unit: unit === "亿" ? "亿" : "万",
      fontKey: String(fontKey || ""),
      reason: "invalid_value",
    };
  }
  return {
    ok: true,
    valueWan: n,
    text: String(text || n),
    unit: unit === "亿" ? "亿" : "万",
    fontKey: String(fontKey || ""),
    reason: String(reason || "verified"),
  };
}

export function decodeMovieToResult(movie, fontKey) {
  const key = fontKey || movie?.fontContentKey || movie?.fontMappingVersion || "";
  if (movie?.decodeStatus === DECODE_STATUS.OK && Number(movie.todayBox) > 0) {
    const text = String(movie.todayBoxText || movie.todayBox);
    if (!isUntrustedBoxDecode(text)) {
      return makeDecodeResult({
        ok: true,
        valueWan: movie.todayBox,
        text,
        unit: movie.todayUnit || "万",
        fontKey: key,
        reason: "verified",
      });
    }
  }
  if (movie?.decodeKeepPrevious) {
    return makeDecodeResult({ ok: false, fontKey: key, reason: "keep_previous_not_fresh" });
  }
  if (movie?.decodeStatus === DECODE_STATUS.ENCODED) {
    return makeDecodeResult({ ok: false, fontKey: key, reason: "map_not_ready" });
  }
  if (movie?.decodeStatus === DECODE_STATUS.DECODE_ERROR) {
    return makeDecodeResult({ ok: false, fontKey: key, reason: "decode_error" });
  }
  return makeDecodeResult({ ok: false, fontKey: key, reason: "unavailable" });
}

/**
 * 明文票房：无 fontStyle / 非 PUA 时直接 parseBoxNum。
 * 例如 boxSplitUnit.num = "143.82"
 */
export function tryPlainBoxDecode(entity, fontKey = "") {
  const html = String(entity?.todayBoxHtml || entity?.boxSplitUnit?.num || "").trim();
  if (!html || html === "--" || html === "-") {
    return makeDecodeResult({ ok: false, fontKey, reason: "no_plain_text" });
  }
  if (isEncodedBoxHtml(html)) {
    return makeDecodeResult({ ok: false, fontKey, reason: "encoded_needs_map" });
  }
  const text = html.replace(/<[^>]+>/g, "").replace(/,/g, "").trim();
  if (!text || text === "--" || isUntrustedBoxDecode(text)) {
    return makeDecodeResult({ ok: false, fontKey, reason: "invalid_plain_text" });
  }
  const unit = entity?.todayUnit || entity?.boxSplitUnit?.unit || "万";
  const valueWan = parseBoxNum(text, unit);
  return makeDecodeResult({
    ok: true,
    valueWan,
    text,
    unit,
    fontKey,
    reason: "plain",
  });
}

/** PUA 验证解码优先；失败再尝试 loose(INFERRED) / 明文。 */
export function resolveEntityBoxDecode(entity, fontKey = "") {
  const key = fontKey || entity?.fontContentKey || entity?.fontMappingVersion || "";
  const verified = decodeMovieToResult(entity, key);
  if (verified.ok) return verified;

  const html = String(entity?.todayBoxHtml || entity?.boxSplitUnit?.num || "").trim();
  if (html && isEncodedBoxHtml(html) && key && isMapReadyForV2(key)) {
    const unit = entity?.todayUnit || entity?.boxSplitUnit?.unit || "万";
    const wan = decodeBoxHtmlLoose(html, unit, key);
    if (wan > 0) {
      return makeDecodeResult({
        ok: true,
        valueWan: wan,
        text: String(wan),
        unit,
        fontKey: key,
        reason: isMapVerified(key) ? "verified" : "inferred",
      });
    }
    return makeDecodeResult({ ok: false, fontKey: key, reason: "map_decode_failed" });
  }

  if (
    verified.reason === "map_not_ready" ||
    verified.reason === "decode_error" ||
    entity?.decodeStatus === DECODE_STATUS.ENCODED ||
    entity?.decodeStatus === DECODE_STATUS.DECODE_ERROR
  ) {
    if (isEncodedBoxHtml(html)) return verified;
  }
  const plain = tryPlainBoxDecode(entity, key);
  if (plain.ok) return plain;
  return verified.reason !== "unavailable" ? verified : plain;
}

function buildCandidateFromDecoded(decoded, session, fontKey) {
  const movies = (decoded.movies || []).map((m) => ({
    movieId: String(m.movieId),
    name: m.name || "",
    // rank 唯一来源：dashboard-rank.js（禁止 V2 按 realtime 再排）
    rank: Number(m.rank) || 0,
    originalRank: Number(m.originalRank) || Number(m.rank) || 0,
    box: resolveEntityBoxDecode(m, fontKey),
    boxRate: m.boxRate || "",
    showCountRate: m.showCountRate || "",
    avgShowView: m.avgShowView || "",
    avgSeatView: m.avgSeatView || "",
    sumBoxDesc: m.sumBoxDesc || "",
    sumBoxNum: m.sumBoxNum || 0,
    showCountDesc: m.showCountDesc || "",
    viewCountDesc: m.viewCountDesc || "",
    poster: m.poster || m.image || "",
    trailer: m.trailer || "",
    raw: m,
    detail: {},
  }));

  const nation = decoded.nation
    ? {
        box: resolveEntityBoxDecode(decoded.nation, fontKey),
        showCount: decoded.nation.showCountDesc || "",
        views: decoded.nation.viewCountDesc || "",
        showCountDesc: decoded.nation.showCountDesc || "",
        viewCountDesc: decoded.nation.viewCountDesc || "",
        seatLabel: decoded.nation.seatLabel || "",
        seatValue: decoded.nation.seatValue || "",
        raw: decoded.nation,
      }
    : null;

  return {
    responseId: session.responseId,
    businessDate: session.businessDate || String(decoded.calendar?.today || "").slice(0, 10),
    fontKey,
    rankSource: "dashboard-rank",
    mapConfidence: fontKey && isMapVerified(fontKey) ? "verified" : fontKey ? "inferred" : "none",
    movies,
    nation,
    calendar: decoded.calendar,
    updateTimestamp: decoded.updateTimestamp,
    updateTimeText: decoded.updateTimeText,
    createdAt: Date.now(),
    parsed: decoded,
  };
}

/**
 * @deprecated V2 禁止按 realtime box 二次排序；保留空操作以兼容旧测试引用。
 * 排名唯一真相来源：dashboard-rank.js
 */
export function rerankCandidateByTrustedBox(candidate) {
  return candidate;
}

/**
 * INFERRED 单片交叉验证。VERIFIED 不走本函数门槛。
 *
 * A. movieWan 不得明显大于 nationWan
 * B. realtime 不得明显大于累计总票房
 * C. 与 boxRate × nation 交叉校验
 */
export function validateInferredMovieBox({
  movieWan,
  nationWan,
  boxRate,
  sumBoxNum,
  originalRank,
  fontKey,
} = {}) {
  const wan = Number(movieWan);
  const nation = Number(nationWan) || 0;
  const sum = Number(sumBoxNum) || 0;
  const rate = parseRate(boxRate);
  let expectedByRateWan = null;

  if (!Number.isFinite(wan) || wan <= 0) {
    return {
      ok: false,
      reason: "inferred_invalid_value",
      expectedByRateWan: null,
      movieWan: wan,
      nationWan: nation,
      boxRate: rate,
      sumBoxNum: sum,
      originalRank: Number(originalRank) || 0,
      fontKey: String(fontKey || ""),
    };
  }

  if (nation > 0 && wan > nation * 1.02) {
    return {
      ok: false,
      reason: "inferred_movie_gt_nation",
      expectedByRateWan: rate > 0 && nation > 0 ? (nation * rate) / 100 : null,
      movieWan: wan,
      nationWan: nation,
      boxRate: rate,
      sumBoxNum: sum,
      originalRank: Number(originalRank) || 0,
      fontKey: String(fontKey || ""),
    };
  }

  if (sum > 0 && wan > sum * 1.01) {
    return {
      ok: false,
      reason: "inferred_movie_gt_sum",
      expectedByRateWan: rate > 0 && nation > 0 ? (nation * rate) / 100 : null,
      movieWan: wan,
      nationWan: nation,
      boxRate: rate,
      sumBoxNum: sum,
      originalRank: Number(originalRank) || 0,
      fontKey: String(fontKey || ""),
    };
  }

  if (nation > 0 && rate > 0) {
    expectedByRateWan = (nation * rate) / 100;
    const tolerance = Math.max(5, expectedByRateWan * 0.15);
    if (Math.abs(wan - expectedByRateWan) > tolerance) {
      return {
        ok: false,
        reason: "inferred_box_rate_mismatch",
        expectedByRateWan,
        movieWan: wan,
        nationWan: nation,
        boxRate: rate,
        sumBoxNum: sum,
        originalRank: Number(originalRank) || 0,
        fontKey: String(fontKey || ""),
      };
    }
  }

  return {
    ok: true,
    reason: "ok",
    expectedByRateWan,
    movieWan: wan,
    nationWan: nation,
    boxRate: rate,
    sumBoxNum: sum,
    originalRank: Number(originalRank) || 0,
    fontKey: String(fontKey || ""),
  };
}

/**
 * INFERRED snapshot 整轮交叉验证。
 * 任一片或 nation 为 inferred 时强制校验；失败 → 整轮不发布。
 */
export function validateInferredCrossCheck(candidate) {
  const movies = candidate?.movies || [];
  const nationBox = candidate?.nation?.box;
  const nationWan = nationBox?.ok ? Number(nationBox.valueWan) || 0 : 0;
  const nationInferred = nationBox?.reason === "inferred";
  const hasInferredMovie = movies.some((m) => m?.box?.reason === "inferred");
  const needsCheck = hasInferredMovie || nationInferred;

  const movieReports = movies.map((m) => {
    const decodedWan = m?.box?.ok ? Number(m.box.valueWan) : null;
    const decodeReason = m?.box?.reason || "decode_failed";
    const base = {
      movieId: String(m.movieId || ""),
      name: m.name || "",
      rank: Number(m.rank) || 0,
      originalRank: Number(m.originalRank) || Number(m.rank) || 0,
      sumBoxNum: Number(m.sumBoxNum) || 0,
      boxRate: m.boxRate || "",
      decodedWan,
      decodeReason,
      expectedByRateWan: null,
      crossCheckOk: true,
      crossCheckReason: "skipped_verified",
    };

    if (!m?.box?.ok) {
      return {
        ...base,
        crossCheckOk: false,
        crossCheckReason: "decode_not_ok",
      };
    }

    // VERIFIED / plain：不强制 boxRate 门槛；仍记录 expected 便于日志
    if (decodeReason !== "inferred") {
      const rate = parseRate(m.boxRate);
      if (nationWan > 0 && rate > 0) {
        base.expectedByRateWan = (nationWan * rate) / 100;
      }
      return base;
    }

    const check = validateInferredMovieBox({
      movieWan: decodedWan,
      nationWan,
      boxRate: m.boxRate,
      sumBoxNum: m.sumBoxNum,
      originalRank: m.originalRank,
      fontKey: candidate?.fontKey,
    });
    return {
      ...base,
      expectedByRateWan: check.expectedByRateWan,
      crossCheckOk: check.ok,
      crossCheckReason: check.reason,
    };
  });

  if (!needsCheck) {
    return {
      ok: true,
      reason: "ok",
      nationWan,
      movieReports,
    };
  }

  const failedMovies = movieReports.filter((r) => !r.crossCheckOk);
  if (failedMovies.length) {
    return {
      ok: false,
      reason: "inferred_crosscheck_failed",
      detail: failedMovies[0].crossCheckReason,
      nationWan,
      movieReports,
      failedMovieIds: failedMovies.map((r) => r.movieId),
    };
  }

  // D. TOP5 整体：sum(movieWan) <= nation * 1.05
  const decodedOk = movies.filter((m) => m?.box?.ok && Number(m.box.valueWan) > 0);
  const moviesSumWan = decodedOk.reduce((sum, m) => sum + Number(m.box.valueWan), 0);
  if (nationWan > 0 && moviesSumWan > nationWan * 1.05) {
    return {
      ok: false,
      reason: "inferred_crosscheck_failed",
      detail: "inferred_top5_sum_gt_nation",
      nationWan,
      movieReports,
      failedMovieIds: [],
    };
  }

  // 有 boxRate 的影片，大多数应与 movieWan/nationWan 对应
  const withRate = decodedOk.filter((m) => parseRate(m.boxRate) > 0 && nationWan > 0);
  if (withRate.length >= 2) {
    let matchCount = 0;
    for (const m of withRate) {
      const expected = (nationWan * parseRate(m.boxRate)) / 100;
      const tolerance = Math.max(5, expected * 0.15);
      if (Math.abs(Number(m.box.valueWan) - expected) <= tolerance) matchCount += 1;
    }
    if (matchCount / withRate.length < 0.6) {
      return {
        ok: false,
        reason: "inferred_crosscheck_failed",
        detail: "inferred_rate_majority_mismatch",
        nationWan,
        movieReports,
        failedMovieIds: [],
      };
    }
  }

  // nation 也是 INFERRED：复用 validateNationCrossCheck，必要时用 TOP5+boxRate 反推
  if (nationInferred && nationWan > 0) {
    const top1 = [...decodedOk].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0))[0];
    const cross = validateNationCrossCheck(nationWan, {
      top1BoxWan: Number(top1?.box?.valueWan) || 0,
      top1BoxRate: parseRate(top1?.boxRate),
      moviesSumWan,
    });
    if (!cross.ok) {
      // 尝试用有 boxRate 的影片反推 nation 范围，看解码 nation 是否落在合理区间
      const implied = [];
      for (const m of withRate) {
        const rate = parseRate(m.boxRate);
        const wan = Number(m.box.valueWan);
        if (rate > 0 && wan > 0) implied.push((wan / rate) * 100);
      }
      if (implied.length) {
        const minImplied = Math.min(...implied) * 0.85;
        const maxImplied = Math.max(...implied) * 1.15;
        if (nationWan < minImplied || nationWan > maxImplied) {
          return {
            ok: false,
            reason: "inferred_crosscheck_failed",
            detail: "inferred_nation_mismatch",
            nationWan,
            movieReports,
            failedMovieIds: [],
            nationReasons: cross.reasons,
          };
        }
      } else {
        return {
          ok: false,
          reason: "inferred_crosscheck_failed",
          detail: "inferred_nation_mismatch",
          nationWan,
          movieReports,
          failedMovieIds: [],
          nationReasons: cross.reasons,
        };
      }
    }
  }

  // nation 缺失但影片是 inferred：若多片有 boxRate，要求互相能推出一致 nation
  if (!nationWan && hasInferredMovie && withRate.length >= 2) {
    const implied = withRate.map((m) => (Number(m.box.valueWan) / parseRate(m.boxRate)) * 100);
    const minI = Math.min(...implied);
    const maxI = Math.max(...implied);
    if (maxI > minI * 1.25) {
      return {
        ok: false,
        reason: "inferred_crosscheck_failed",
        detail: "inferred_nation_unresolvable",
        nationWan: 0,
        movieReports,
        failedMovieIds: [],
      };
    }
  }

  return {
    ok: true,
    reason: "ok",
    nationWan,
    movieReports,
  };
}

/**
 * 原子门控：本轮展示影片必须全部有可信 current box；
 * 已发布 TOP N 后，临时少片不得缩榜。
 * INFERRED 必须通过业务交叉验证。
 */
export function validateCandidate(candidate, store = boxStore) {
  const movies = candidate?.movies || [];
  const moviesTotal = movies.length;
  const failedMovieIds = movies
    .filter((m) => !(m?.box?.ok && Number(m.box.valueWan) > 0))
    .map((m) => String(m.movieId));
  const moviesDecoded = moviesTotal - failedMovieIds.length;

  if (!moviesTotal) {
    return {
      ok: false,
      reason: "no_movies",
      moviesTotal: 0,
      moviesDecoded: 0,
      failedMovieIds: [],
    };
  }

  if (moviesDecoded !== moviesTotal) {
    return {
      ok: false,
      reason: "partial_box_decode",
      moviesTotal,
      moviesDecoded,
      failedMovieIds,
    };
  }

  const published = store?.getLastPublished?.();
  const publishedCount = Array.isArray(published?.movies) ? published.movies.length : 0;
  if (publishedCount > 0 && moviesTotal < publishedCount) {
    return {
      ok: false,
      reason: "partial_movie_list",
      moviesTotal,
      moviesDecoded,
      failedMovieIds: [],
      publishedCount,
    };
  }

  const inferredGate = validateInferredCrossCheck(candidate);
  if (!inferredGate.ok) {
    return {
      ok: false,
      reason: inferredGate.reason || "inferred_crosscheck_failed",
      detail: inferredGate.detail || "",
      moviesTotal,
      moviesDecoded,
      failedMovieIds: inferredGate.failedMovieIds || [],
      nationWan: inferredGate.nationWan,
      movieReports: inferredGate.movieReports,
    };
  }

  return {
    ok: true,
    reason: "ok",
    moviesTotal,
    moviesDecoded,
    failedMovieIds: [],
    nationWan: inferredGate.nationWan,
    movieReports: inferredGate.movieReports,
  };
}

/**
 * 将 Store 电影记录投影为 Renderer 可用的 movie 对象（明文票房）。
 */
export function projectStoreMovie(storeMovie) {
  if (!storeMovie) return null;
  // invariant：曾有有效票房则不得投影成 0/--
  const amount =
    Number(storeMovie.displayBoxWan) > 0
      ? Number(storeMovie.displayBoxWan)
      : Number(storeMovie.lastValidBoxWan) > 0
        ? Number(storeMovie.lastValidBoxWan)
        : 0;
  const { valueText, unit } = formatWanForDisplay(amount);
  const raw = storeMovie.raw || {};
  return {
    ...raw,
    ...storeMovie,
    movieId: storeMovie.movieId,
    name: storeMovie.name,
    rank: storeMovie.rank,
    todayBox: amount,
    todayBoxText: amount > 0 ? valueText : "",
    todayUnit: unit,
    todayBoxHtml: "",
    decodeStatus: amount > 0 ? DECODE_STATUS.OK : DECODE_STATUS.FAILED,
    decodeVerified: amount > 0,
    decodeKeepPrevious: false,
    boxRate: storeMovie.boxRate || raw.boxRate || "",
    showCountRate: storeMovie.showCountRate || raw.showCountRate || "",
    avgShowView: storeMovie.avgShowView || raw.avgShowView || "",
    avgSeatView: storeMovie.avgSeatView || raw.avgSeatView || "",
    sumBoxDesc: storeMovie.sumBoxDesc || raw.sumBoxDesc || "",
    displayBoxWan: amount,
    lastValidBoxWan: storeMovie.lastValidBoxWan,
  };
}

export function projectStoreNation(storeNation) {
  if (!storeNation) return null;
  const amount =
    Number(storeNation.displayBoxWan) > 0
      ? Number(storeNation.displayBoxWan)
      : Number(storeNation.lastValidBoxWan) > 0
        ? Number(storeNation.lastValidBoxWan)
        : 0;
  const { valueText, unit } = formatWanForDisplay(amount);
  return {
    todayBox: amount,
    todayBoxText: amount > 0 ? valueText : "",
    todayUnit: unit,
    todayBoxHtml: "",
    decodeStatus: amount > 0 ? DECODE_STATUS.OK : DECODE_STATUS.FAILED,
    decodeVerified: amount > 0,
    showCountDesc: storeNation.showCount || storeNation.showCountDesc || "",
    viewCountDesc: storeNation.views || storeNation.viewCountDesc || "",
    seatLabel: storeNation.seatLabel || "场均人次",
    seatValue: storeNation.seatValue || "",
    displayBoxWan: amount,
    lastValidBoxWan: storeNation.lastValidBoxWan,
  };
}

export function projectSnapshotForRender(snapshot) {
  if (!snapshot) return null;
  return {
    businessDate: snapshot.businessDate,
    movies: (snapshot.movies || []).map(projectStoreMovie),
    nation: projectStoreNation(snapshot.nation),
    champion: snapshot.champion ? projectStoreMovie(snapshot.champion) : null,
    calendar: { today: snapshot.businessDate },
    hasData: snapshot.hasData,
    publishedAt: snapshot.publishedAt,
  };
}

/**
 * @param {{
 *   store?: ReturnType<typeof import('./box-store.js').createBoxStore>,
 *   fetchDashboardFn?: typeof fetchDashboard,
 *   onPublish?: (projected: object, meta: object) => void,
 *   getApiBase?: () => string,
 *   getTopCount?: () => number,
 *   pollIntervalMs?: number,
 * }} options
 */
export function createBoxPipeline(options = {}) {
  const store = options.store || boxStore;
  const fetchFn = options.fetchDashboardFn || fetchDashboard;
  const onPublish = typeof options.onPublish === "function" ? options.onPublish : null;

  // 生产主链固定 5000ms；options 仅测试可覆盖
  let pollIntervalMs =
    Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : BOX_POLL_MS;
  let timer = null;
  let inFlight = false;
  let pollId = 0;
  let stopped = true;
  const lockPollMs = options.lockPollMs !== false;

  /**
   * 执行一轮完整 pipeline。返回状态对象。
   */
  async function runOnce(context = {}) {
    if (inFlight) {
      console.log("[BOX_V2]", { pollId, publish: false, rejectReason: "overlap_skip" });
      return { ok: false, reason: "overlap_skip", skipped: true };
    }

    inFlight = true;
    const thisPoll = ++pollId;
    const t0 = nowMs();
    let fetchMs = 0;
    let mapMs = 0;
    let decodeMs = 0;
    let fontKey = "";
    let businessDate = "";
    let moviesTotal = 0;
    let moviesDecoded = 0;

    try {
      const apiBase = context.apiBase || options.getApiBase?.() || "";
      const topCount = context.topCount || options.getTopCount?.() || 5;

      const raw = await fetchFn(apiBase, "", { topCount });
      fetchMs = Math.round(nowMs() - t0);

      const session = createDashboardSession(raw, topCount);
      businessDate = session.businessDate;
      moviesTotal = session.parsed?.movies?.length || 0;

      if (!moviesTotal) {
        console.log("[BOX_V2]", {
          pollId: thisPoll,
          businessDate,
          fontKey: "",
          fetchMs,
          mapMs: 0,
          decodeMs: 0,
          moviesTotal: 0,
          moviesDecoded: 0,
          publish: false,
          rejectReason: "no_movies",
        });
        return { ok: false, reason: "no_movies" };
      }

      // 字体身份 + mapping（按 fontIdentity 缓存；不因 poll 作废）
      const tMap = nowMs();
      let contentKey = "";
      if (session.fontStyle) {
        try {
          await prepareSessionFont(session);
          contentKey = session.fontContentKey || session.fontUrlKey || "";
          fontKey = normalizeFontIdentity(contentKey) || contentKey;

          // 已有可用 mapping（VERIFIED/INFERRED）→ 直接复用，不重建
          if (!isMapReadyForV2(contentKey)) {
            const built = await buildSessionPuaMap(session);
            contentKey = built?.contentKey || session.fontContentKey || contentKey;
            fontKey = normalizeFontIdentity(contentKey) || contentKey;
          } else {
            session.fontContentKey = contentKey;
            session.parsed.fontContentKey = contentKey;
          }

          // 发布门控：允许 stale response 仍复用 mapping；只尝试 publish
          const pub = tryPublishSession(session);
          if (pub.ok) {
            tryPublishDashboardSession({
              responseId: session.responseId,
              contentKey: session.fontContentKey || contentKey,
              businessDate: session.businessDate,
              fontStyle: session.fontStyle,
            });
          } else if (pub.reason === "stale_response" && isMapReadyForV2(contentKey)) {
            tryPublishDashboardSession({
              responseId: session.responseId,
              contentKey,
              businessDate: session.businessDate,
              fontStyle: session.fontStyle,
            });
          }

          // 硬门控：无可用 mapping 绝不能进入 decode/publish
          if (!isMapReadyForV2(contentKey)) {
            mapMs = Math.round(nowMs() - tMap);
            console.log("[BOX_V2]", {
              pollId: thisPoll,
              businessDate,
              fontKey,
              fetchMs,
              mapMs,
              decodeMs: 0,
              moviesTotal,
              moviesDecoded: 0,
              publish: false,
              rejectReason: "map_not_ready",
            });
            return { ok: false, reason: "map_not_ready", fontKey };
          }
        } catch (err) {
          mapMs = Math.round(nowMs() - tMap);
          console.warn("[BOX_V2] font/map error", err);
          console.log("[BOX_V2]", {
            pollId: thisPoll,
            businessDate,
            fontKey,
            fetchMs,
            mapMs,
            decodeMs: 0,
            moviesTotal,
            moviesDecoded: 0,
            publish: false,
            rejectReason: "font_error",
          });
          return { ok: false, reason: "font_error", error: err };
        }
      }
      mapMs = Math.round(nowMs() - tMap);
      contentKey = session.fontContentKey || contentKey;
      fontKey = normalizeFontIdentity(contentKey) || contentKey || sessionFontIdentity(session);

      // decode（整轮完成后才进 Store）
      const tDec = nowMs();
      const decoded = contentKey
        ? decodeDashboardFields(session.parsed, contentKey, {
            movies: session.parsed.movies,
            crossCheckMovies: session.parsed.movies,
          })
        : session.parsed;
      decodeMs = Math.round(nowMs() - tDec);

      let candidate = buildCandidateFromDecoded(decoded, session, fontKey);
      moviesDecoded = candidate.movies.filter((m) => m.box?.ok).length;

      const gate = validateCandidate(candidate, store);
      if (!gate.ok) {
        console.log("[BOX_V2]", {
          pollId: thisPoll,
          businessDate,
          fontKey,
          rankSource: candidate.rankSource || "dashboard-rank",
          mapConfidence: candidate.mapConfidence || "",
          nationWan: gate.nationWan ?? candidate.nation?.box?.valueWan ?? null,
          fetchMs,
          mapMs,
          decodeMs,
          moviesTotal: gate.moviesTotal ?? moviesTotal,
          moviesDecoded: gate.moviesDecoded ?? moviesDecoded,
          failedMovieIds: gate.failedMovieIds || [],
          movies: gate.movieReports || [],
          publish: false,
          rejectReason: gate.reason,
          rejectDetail: gate.detail || "",
        });
        return {
          ok: false,
          reason: gate.reason,
          candidate,
          moviesDecoded: gate.moviesDecoded ?? moviesDecoded,
          failedMovieIds: gate.failedMovieIds || [],
        };
      }

      // rank 已由 dashboard-rank.js 确定；禁止按 realtime 二次排序
      const committed = store.commit(candidate);
      const inferredLog = validateInferredCrossCheck(candidate);
      console.log("[BOX_V2]", {
        pollId: thisPoll,
        businessDate,
        fontKey,
        rankSource: candidate.rankSource || "dashboard-rank",
        mapConfidence: candidate.mapConfidence || "",
        nationWan: inferredLog.nationWan ?? candidate.nation?.box?.valueWan ?? null,
        fetchMs,
        mapMs,
        decodeMs,
        moviesTotal,
        moviesDecoded,
        movies: inferredLog.movieReports || [],
        publish: committed.ok,
        rejectReason: committed.ok ? "" : committed.reason,
      });

      if (committed.ok && onPublish) {
        const projected = projectSnapshotForRender(committed.snapshot);
        onPublish(projected, {
          pollId: thisPoll,
          fontKey,
          rises: committed.rises,
          candidate,
          parsed: decoded,
        });
      }

      return {
        ok: committed.ok,
        reason: committed.reason,
        snapshot: committed.snapshot,
        rises: committed.rises,
        moviesDecoded,
        pollId: thisPoll,
      };
    } catch (err) {
      console.warn("[BOX_V2] poll error", err);
      console.log("[BOX_V2]", {
        pollId: thisPoll,
        businessDate,
        fontKey,
        fetchMs,
        mapMs,
        decodeMs,
        moviesTotal,
        moviesDecoded,
        publish: false,
        rejectReason: "fetch_error",
      });
      return { ok: false, reason: "fetch_error", error: err };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!stopped && timer) return;
    stopped = false;
    void runOnce();
    timer = setInterval(() => {
      void runOnce();
    }, pollIntervalMs);
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setPollIntervalMs(ms) {
    // 生产默认锁定 5000ms，避免旧设置 4000/8000/10000 污染 V2
    const next = lockPollMs
      ? BOX_POLL_MS
      : Math.max(1000, Math.min(60000, Number(ms) || BOX_POLL_MS));
    pollIntervalMs = next;
    if (!stopped) {
      stop();
      stopped = false;
      timer = setInterval(() => {
        void runOnce();
      }, pollIntervalMs);
    }
  }

  function isInFlight() {
    return inFlight;
  }

  return {
    runOnce,
    start,
    stop,
    setPollIntervalMs,
    isInFlight,
    get pollIntervalMs() {
      return pollIntervalMs;
    },
    get pollId() {
      return pollId;
    },
    store,
  };
}

/** 纯函数测试用：走与生产相同的 validate → commit（不再按 realtime 重排） */
export function simulateBoxRounds(rounds, store = boxStore) {
  const results = [];
  for (const round of rounds) {
    const candidate = {
      responseId: round.responseId || results.length + 1,
      businessDate: round.businessDate || "2026-09-15",
      fontKey: round.fontKey || "fontA",
      rankSource: "dashboard-rank",
      mapConfidence: round.mapConfidence || "verified",
      movies: (round.movies || []).map((m, i) => ({
        movieId: String(m.movieId || i + 1),
        name: m.name || `M${i + 1}`,
        rank: m.rank || i + 1,
        originalRank: m.originalRank || m.rank || i + 1,
        box:
          m.box === null || m.decodeFail
            ? makeDecodeResult({ ok: false, reason: m.reason || "decode_fail" })
            : makeDecodeResult({
                ok: true,
                valueWan: m.box,
                text: String(m.box),
                unit: "万",
                fontKey: round.fontKey || "fontA",
                reason: m.reason || "verified",
              }),
        boxRate: m.boxRate || "",
        showCountRate: m.showCountRate || "",
        avgShowView: m.avgShowView || "",
        sumBoxDesc: m.sumBoxDesc || "",
        sumBoxNum: m.sumBoxNum || 0,
      })),
      nation: round.nation
        ? {
            box:
              round.nation.box == null || round.nation.decodeFail
                ? makeDecodeResult({ ok: false, reason: "decode_fail" })
                : makeDecodeResult({
                    ok: true,
                    valueWan: round.nation.box,
                    text: String(round.nation.box),
                    reason: round.nation.reason || "verified",
                  }),
            showCount: round.nation.showCount || "",
            views: round.nation.views || "",
          }
        : null,
      createdAt: Date.now(),
    };

    const gate = validateCandidate(candidate, store);
    if (!gate.ok) {
      results.push({
        committed: {
          ok: false,
          reason: gate.reason,
          rises: [],
          snapshot: store.getLastPublished(),
          moviesTotal: gate.moviesTotal,
          moviesDecoded: gate.moviesDecoded,
          failedMovieIds: gate.failedMovieIds,
        },
        snapshot: store.getSnapshot(),
        rises: [],
        gate,
      });
      continue;
    }

    const committed = store.commit(candidate);
    results.push({
      committed,
      snapshot: store.getSnapshot(),
      rises: committed.rises || [],
      gate,
    });
  }
  return results;
}

export { DEFAULT_POLL_MS, parseBoxNum };
