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
    rank: Number(m.rank) || 0,
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
 * 仅在全部展示影片票房可信解码后重排；部分失败时绝不改 rank。
 */
export function rerankCandidateByTrustedBox(candidate) {
  const movies = candidate?.movies || [];
  if (!movies.length || !movies.every((m) => m?.box?.ok && Number(m.box.valueWan) > 0)) {
    return candidate;
  }
  const sorted = [...movies].sort((a, b) => {
    const diff = Number(b.box.valueWan) - Number(a.box.valueWan);
    if (diff !== 0) return diff;
    return (Number(a.rank) || 0) - (Number(b.rank) || 0);
  });
  return {
    ...candidate,
    movies: sorted.map((m, i) => ({ ...m, rank: i + 1 })),
  };
}

/**
 * 原子门控：本轮展示影片必须全部有可信 current box；
 * 已发布 TOP N 后，临时少片不得缩榜。
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

  return {
    ok: true,
    reason: "ok",
    moviesTotal,
    moviesDecoded,
    failedMovieIds: [],
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
          fetchMs,
          mapMs,
          decodeMs,
          moviesTotal: gate.moviesTotal ?? moviesTotal,
          moviesDecoded: gate.moviesDecoded ?? moviesDecoded,
          failedMovieIds: gate.failedMovieIds || [],
          publish: false,
          rejectReason: gate.reason,
        });
        return {
          ok: false,
          reason: gate.reason,
          candidate,
          moviesDecoded: gate.moviesDecoded ?? moviesDecoded,
          failedMovieIds: gate.failedMovieIds || [],
        };
      }

      // 仅完整可信快照才允许重排；票房/排名/冠军同属一轮
      candidate = rerankCandidateByTrustedBox(candidate);

      const committed = store.commit(candidate);
      console.log("[BOX_V2]", {
        pollId: thisPoll,
        businessDate,
        fontKey,
        fetchMs,
        mapMs,
        decodeMs,
        moviesTotal,
        moviesDecoded,
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

/** 纯函数测试用：走与生产相同的 validate → rerank → commit */
export function simulateBoxRounds(rounds, store = boxStore) {
  const results = [];
  for (const round of rounds) {
    let candidate = {
      responseId: round.responseId || results.length + 1,
      businessDate: round.businessDate || "2026-09-15",
      fontKey: round.fontKey || "fontA",
      movies: (round.movies || []).map((m, i) => ({
        movieId: String(m.movieId || i + 1),
        name: m.name || `M${i + 1}`,
        rank: m.rank || i + 1,
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
                    reason: "verified",
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

    candidate = rerankCandidateByTrustedBox(candidate);
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
