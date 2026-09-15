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
  parseBoxNum,
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
import { isMapVerified, normalizeFontIdentity } from "./font-registry.js";
import { boxStore } from "./box-store.js";
import { formatWanForDisplay } from "./box-display.js";

const DEFAULT_POLL_MS = 5000;

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
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

function buildCandidateFromDecoded(decoded, session, fontKey) {
  const movies = (decoded.movies || []).map((m) => ({
    movieId: String(m.movieId),
    name: m.name || "",
    rank: Number(m.rank) || 0,
    box: decodeMovieToResult(m, fontKey),
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
        box: decodeMovieToResult(decoded.nation, fontKey),
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

function validateCandidate(candidate) {
  if (!candidate?.movies?.length) return { ok: false, reason: "no_movies" };
  const decodedCount = candidate.movies.filter((m) => m.box?.ok).length;
  // 首次也必须等到有效解码；中间态禁止进入 UI
  if (decodedCount === 0 && !candidate.nation?.box?.ok) {
    return { ok: false, reason: "no_decoded_box", decodedCount };
  }
  // TOP1：本轮解码失败时，仅当 Store 已有该片 lastValid 才允许发布（冠军用旧有效值，绝不继承上一冠军数字）
  const hasPublished = Boolean(boxStore.getLastPublished()?.hasData);
  const top1 = candidate.movies.find((m) => m.rank === 1) || candidate.movies[0];
  if (hasPublished && top1 && !top1.box?.ok) {
    const prev = boxStore.getMovie(top1.movieId);
    if (!(prev?.lastValidBoxWan > 0)) {
      return { ok: false, reason: "top1_decode_failed", decodedCount };
    }
  }
  return { ok: true, reason: "ok", decodedCount };
}

/**
 * 将 Store 电影记录投影为 Renderer 可用的 movie 对象（明文票房）。
 */
export function projectStoreMovie(storeMovie) {
  if (!storeMovie) return null;
  const amount = Number(storeMovie.displayBoxWan) || 0;
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
  const amount = Number(storeNation.displayBoxWan) || 0;
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

  let pollIntervalMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : DEFAULT_POLL_MS;
  let timer = null;
  let inFlight = false;
  let pollId = 0;
  let stopped = true;

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

          // 已有 verified mapping → 直接复用，不重建
          if (!isMapVerified(contentKey)) {
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
              contentKey: session.fontContentKey,
              businessDate: session.businessDate,
              fontStyle: session.fontStyle,
            });
          } else if (pub.reason === "stale_response" && isMapVerified(contentKey)) {
            // mapping 已就绪：继续 decode，不因 response 门控丢掉本轮
            tryPublishDashboardSession({
              responseId: session.responseId,
              contentKey,
              businessDate: session.businessDate,
              fontStyle: session.fontStyle,
            });
          } else if (!isMapVerified(contentKey)) {
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
              rejectReason: pub.reason || "map_not_ready",
            });
            // mapping 未就绪：不 publish，UI 保持旧值
            return { ok: false, reason: pub.reason || "map_not_ready", fontKey };
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

      const candidate = buildCandidateFromDecoded(decoded, session, fontKey);
      moviesDecoded = candidate.movies.filter((m) => m.box?.ok).length;

      const gate = validateCandidate(candidate);
      if (!gate.ok) {
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
          rejectReason: gate.reason,
        });
        return { ok: false, reason: gate.reason, candidate, moviesDecoded };
      }

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
    const next = Math.max(1000, Math.min(60000, Number(ms) || DEFAULT_POLL_MS));
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

/** 纯函数测试用：在无 DOM/网络时跑 Store 规则 */
export function simulateBoxRounds(rounds, store = boxStore) {
  const results = [];
  for (const round of rounds) {
    const candidate = {
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
                reason: "verified",
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
    const committed = store.commit(candidate);
    results.push({
      committed,
      snapshot: store.getSnapshot(),
      rises: committed.rises || [],
    });
  }
  return results;
}

export { DEFAULT_POLL_MS, parseBoxNum };
