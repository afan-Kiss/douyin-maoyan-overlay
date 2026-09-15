/**
 * BoxStore — 票房唯一真相来源。
 * UI / 气泡只读本 Store，禁止再维护 displayCache / lastGood / prevValues。
 */

import { riseEngine } from "./rise-engine.js";

function nearlyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.0000005;
}

function isPositiveWan(n) {
  return Number.isFinite(n) && n > 0;
}

function emptyNation() {
  return {
    displayBoxWan: 0,
    lastValidBoxWan: 0,
    showCount: "",
    views: "",
    seatLabel: "",
    seatValue: "",
    lastAcceptedAt: 0,
  };
}

function emptyMovie(id, meta = {}) {
  return {
    movieId: String(id || ""),
    name: meta.name || "",
    rank: meta.rank || 0,
    displayBoxWan: 0,
    lastValidBoxWan: 0,
    boxRate: "",
    showCountRate: "",
    avgShowView: "",
    avgSeatView: "",
    sumBoxDesc: "",
    sumBoxNum: 0,
    showCountDesc: "",
    viewCountDesc: "",
    poster: meta.poster || "",
    trailer: meta.trailer || "",
    detail: {},
    lastAcceptedAt: 0,
    raw: null,
  };
}

function mergeNonEmpty(target, patch, fields) {
  const out = { ...target };
  if (!patch) return out;
  for (const f of fields) {
    if (!(f in patch) && patch[f] === undefined) continue;
    const v = patch[f];
    if (v == null) continue;
    if (typeof v === "string") {
      const text = v.trim();
      if (!text || text === "--" || text === "-") continue;
    }
    if (Array.isArray(v) && !v.length) continue;
    out[f] = v;
  }
  return out;
}

const DASHBOARD_FIELDS = [
  "boxRate",
  "showCountRate",
  "avgShowView",
  "avgSeatView",
  "sumBoxDesc",
  "sumBoxNum",
  "showCountDesc",
  "viewCountDesc",
  "poster",
  "trailer",
];

const DETAIL_KEYS = [
  "dynamicForecast",
  "endDate",
  "releaseDate",
  "releaseInfo",
  "hourSpeed",
  "hourSpeedText",
  "yesterdayTotal",
  "yesterdaySamePeriodText",
  "yesterdayHourSpeedText",
  "totalViews",
  "hmtBox",
  "overseasBox",
  "sumSplitBoxDesc",
  "splitBoxRate",
  "dailyTable",
  "boxShow",
  "mainlandBox",
  "mainlandBoxText",
];

export function createBoxStore(options = {}) {
  const engine = options.riseEngine || riseEngine;

  let businessDate = "";
  /** @type {Map<string, object>} */
  const movies = new Map();
  let nation = emptyNation();
  /** @type {object|null} */
  let lastPublished = null;
  /** @type {((snap: object) => void)[]} */
  const changeListeners = [];

  function emitChange(snap) {
    for (const fn of changeListeners) {
      try {
        fn(snap);
      } catch (err) {
        console.warn("[BOX_V2] change listener error", err);
      }
    }
  }

  function onChange(fn) {
    changeListeners.push(fn);
    return () => {
      const i = changeListeners.indexOf(fn);
      if (i >= 0) changeListeners.splice(i, 1);
    };
  }

  function onRise(fn) {
    return engine.onRise(fn);
  }

  function resetBaselines() {
    for (const [id, m] of movies) {
      movies.set(id, { ...m, displayBoxWan: 0, lastValidBoxWan: 0, lastAcceptedAt: 0 });
    }
    nation = { ...nation, displayBoxWan: 0, lastValidBoxWan: 0, lastAcceptedAt: 0 };
  }

  /**
   * @returns {{ action: string, oldWan: number, newWan: number, deltaWan: number }}
   */
  function applyBoxToEntity(prev, valueWan) {
    const oldWan = Number(prev.lastValidBoxWan) || 0;
    if (!isPositiveWan(valueWan)) {
      return { entity: prev, action: "invalid", oldWan, newWan: 0, deltaWan: 0 };
    }
    const current = Number(valueWan);
    if (!(oldWan > 0)) {
      return {
        entity: {
          ...prev,
          displayBoxWan: current,
          lastValidBoxWan: current,
          lastAcceptedAt: Date.now(),
        },
        action: "first",
        oldWan: 0,
        newWan: current,
        deltaWan: 0,
      };
    }
    if (nearlyEqual(current, oldWan)) {
      return {
        entity: { ...prev, displayBoxWan: oldWan, lastValidBoxWan: oldWan },
        action: "same",
        oldWan,
        newWan: oldWan,
        deltaWan: 0,
      };
    }
    if (current < oldWan) {
      return {
        entity: { ...prev, displayBoxWan: oldWan, lastValidBoxWan: oldWan },
        action: "drop",
        oldWan,
        newWan: current,
        deltaWan: 0,
      };
    }
    const deltaWan = current - oldWan;
    return {
      entity: {
        ...prev,
        displayBoxWan: current,
        lastValidBoxWan: current,
        lastAcceptedAt: Date.now(),
      },
      action: "rise",
      oldWan,
      newWan: current,
      deltaWan,
    };
  }

  /**
   * 原子提交 CandidateSnapshot。
   */
  function commit(candidate) {
    if (!candidate || !Array.isArray(candidate.movies)) {
      return { ok: false, reason: "empty_candidate", rises: [], snapshot: lastPublished };
    }

    const nextDate = String(candidate.businessDate || "").slice(0, 10);
    if (nextDate && businessDate && nextDate !== businessDate) {
      resetBaselines();
    }
    if (nextDate) businessDate = nextDate;

    const decodedMovies = candidate.movies.filter(
      (m) => m?.box?.ok && isPositiveWan(m.box.valueWan),
    );
    const nationOk = candidate.nation?.box?.ok && isPositiveWan(candidate.nation.box.valueWan);

    if (!decodedMovies.length && !nationOk && lastPublished) {
      return { ok: false, reason: "no_decoded_box", rises: [], snapshot: lastPublished };
    }

    // 排名必须来自本轮已成功解码的票房；若一个都解不出来则拒绝（上面已处理）
    // 有解码成功时：用 candidate 的官方 rank（已在 pipeline 用可信 todayBox 排序）

    const rises = [];
    const keepIds = new Set();

    for (const m of candidate.movies) {
      const id = String(m.movieId);
      keepIds.add(id);
      const prev = movies.get(id) || emptyMovie(id, m);

      let next = {
        ...prev,
        movieId: id,
        name: m.name || prev.name,
        rank: Number(m.rank) || prev.rank,
        raw: m.raw || prev.raw,
      };
      next = mergeNonEmpty(next, m, DASHBOARD_FIELDS);

      if (m.detail && typeof m.detail === "object") {
        next.detail = mergeNonEmpty(prev.detail || {}, m.detail, DETAIL_KEYS);
        next = mergeNonEmpty(next, m.detail, DETAIL_KEYS);
      }

      if (m.box?.ok && isPositiveWan(m.box.valueWan)) {
        const applied = applyBoxToEntity(next, m.box.valueWan);
        next = applied.entity;
        if (applied.action === "rise" && applied.deltaWan > 0) {
          const evt = engine.onAcceptedBox(id, applied.oldWan, applied.newWan, {
            name: next.name,
            kind: "movie",
          });
          if (evt) rises.push(evt);
        }
      } else {
        // 解码失败：票房字段完全不更新
        next.displayBoxWan = prev.displayBoxWan;
        next.lastValidBoxWan = prev.lastValidBoxWan;
        next.lastAcceptedAt = prev.lastAcceptedAt;
      }

      movies.set(id, next);
    }

    for (const [id, m] of movies) {
      if (!keepIds.has(id)) {
        movies.set(id, { ...m, rank: 0 });
      }
    }

    if (candidate.nation) {
      const n = candidate.nation;
      let nextNation = mergeNonEmpty(nation, n, [
        "seatLabel",
        "seatValue",
        "showCountDesc",
        "viewCountDesc",
      ]);
      if (n.showCountDesc) nextNation.showCount = n.showCountDesc;
      if (n.viewCountDesc) nextNation.views = n.viewCountDesc;
      if (n.showCount) nextNation.showCount = n.showCount;
      if (n.views) nextNation.views = n.views;

      if (n.box?.ok && isPositiveWan(n.box.valueWan)) {
        const applied = applyBoxToEntity(nextNation, n.box.valueWan);
        nextNation = applied.entity;
        if (applied.action === "rise" && applied.deltaWan > 0) {
          const evt = engine.onAcceptedBox("__nation__", applied.oldWan, applied.newWan, {
            name: "今日大盘",
            kind: "nation",
          });
          if (evt) rises.push(evt);
        }
      } else {
        nextNation.displayBoxWan = nation.displayBoxWan;
        nextNation.lastValidBoxWan = nation.lastValidBoxWan;
        nextNation.lastAcceptedAt = nation.lastAcceptedAt;
      }
      nation = nextNation;
    }

    const snapshot = getSnapshot();
    lastPublished = snapshot;
    emitChange(snapshot);
    return { ok: true, reason: "published", rises, snapshot };
  }

  function mergeDetail(movieId, detail) {
    const id = String(movieId || "");
    const prev = movies.get(id);
    if (!prev || !detail) return;
    const mergedDetail = mergeNonEmpty(prev.detail || {}, detail, DETAIL_KEYS);
    const fieldPatch = mergeNonEmpty({}, detail, DETAIL_KEYS);
    movies.set(id, { ...prev, ...fieldPatch, detail: mergedDetail });
    const snapshot = getSnapshot();
    lastPublished = snapshot;
    emitChange(snapshot);
  }

  function moviesByRank() {
    return [...movies.values()].filter((m) => m.rank > 0).sort((a, b) => a.rank - b.rank);
  }

  function getMovie(movieId) {
    return movies.get(String(movieId || "")) || null;
  }

  function getChampion() {
    return moviesByRank()[0] || null;
  }

  function getSnapshot() {
    const list = moviesByRank();
    return {
      businessDate,
      movies: list,
      moviesMap: new Map(movies),
      nation: { ...nation },
      champion: list[0] || null,
      hasData: list.some((m) => m.displayBoxWan > 0) || nation.displayBoxWan > 0,
      publishedAt: Date.now(),
    };
  }

  function getLastPublished() {
    return lastPublished;
  }

  function clear() {
    movies.clear();
    nation = emptyNation();
    businessDate = "";
    lastPublished = null;
  }

  return {
    commit,
    mergeDetail,
    getSnapshot,
    getLastPublished,
    getMovie,
    getChampion,
    moviesByRank,
    onRise,
    onChange,
    resetBaselines,
    clear,
    get businessDate() {
      return businessDate;
    },
  };
}

export const boxStore = createBoxStore();
