/**
 * 电影互动榜 UI：在线人数、直播间评分、评分气泡、弹幕球、LiveAssistant 轮询。
 * 与票房状态机隔离。
 */

import { createMovieWordCloud } from "./movie-word-cloud.js";
import {
  createMovieScoreBubbleLayer,
  SCORE_BUBBLE_DURATION_MS,
  SCORE_BUBBLE_MAX_VISIBLE,
} from "./movie-score-bubble.js";
import {
  createMovieInteractionService,
  createMovieInteractionPoller,
  DEFAULT_MOVIE_INTERACTION_BASE,
} from "./movie-interaction-service.js";

function $(id) {
  return document.getElementById(id);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatClock(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatViewerCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return "--";
  if (n >= 10000) {
    const wan = n / 10000;
    const text = wan >= 100 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, "");
    return `${text}万`;
  }
  return String(Math.round(n));
}

function formatScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(Math.trunc(n));
  const body = abs.toLocaleString("en-US");
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return "0";
}

function scoreTone(score) {
  const n = Number(score) || 0;
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "zero";
}

function cssEscapeAttr(value) {
  const text = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(text);
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isInteractionDemoEnabled() {
  try {
    return new URLSearchParams(location.search).get("interactionDemo") === "1";
  } catch {
    return false;
  }
}

function resolveInteractionBaseUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get("interactionApi");
    if (fromQuery) return fromQuery.replace(/\/+$/, "");
  } catch {
    /* ignore */
  }
  return DEFAULT_MOVIE_INTERACTION_BASE;
}

const DEMO_SCORE_PRESETS = [28000, 2400, 1200, -300, 8600, 150, -1200, 42000, 980, -50];

const DEMO_DANMAKU = [
  { nickname: "小明", content: "哪吒好评" },
  { nickname: "阿杰", content: "这部电影不错" },
  { nickname: "小雨", content: "刚从电影院回来感觉太震撼了" },
  { nickname: "老王", content: "八仙怎么样" },
  { nickname: "小白", content: "星际迷行挺好看" },
  { nickname: "阿强", content: "特效太炸了" },
  { nickname: "婷婷", content: "支持国产" },
  { nickname: "大伟", content: "差评有点闷" },
];

export function createMovieInteractionUi(options = {}) {
  const clockEl = $("ix-clock");
  const viewerEl = $("ix-viewer-count");
  const cloudRoot = $("ix-word-cloud");
  const offlineEl = ensureOfflineBadge();

  /** @type {Map<string, number>} */
  const scores = new Map();
  /** @type {Array<{ movieId: string, name: string, rank: number }>} */
  let catalog = [];
  let viewerCount = null;
  let clockTimer = null;
  let demoTimer = null;
  let demoSeq = 0;
  let destroyed = false;
  let bridgeOnline = null;

  const wordCloud = createMovieWordCloud(cloudRoot);
  const bubbleLayer = createMovieScoreBubbleLayer({
    layer: $("score-bubble-layer"),
    maxVisible: SCORE_BUBBLE_MAX_VISIBLE,
    durationMs: SCORE_BUBBLE_DURATION_MS,
  });

  const service =
    options.service ||
    createMovieInteractionService({
      baseUrl: options.baseUrl || resolveInteractionBaseUrl(),
    });

  const poller =
    options.poller ||
    createMovieInteractionPoller({
      service,
      scoresIntervalMs: options.scoresIntervalMs,
      eventsIntervalMs: options.eventsIntervalMs,
      onScores: (movies) => applyRemoteScores(movies),
      onEvents: (events) => applyRemoteEvents(events),
      onStatus: ({ online, message }) => setBridgeStatus(online, message),
    });

  function ensureOfflineBadge() {
    let el = $("ix-interaction-offline");
    if (el) return el;
    const headerLeft = document.querySelector(".ix-header__left");
    if (!headerLeft) return null;
    el = document.createElement("span");
    el.id = "ix-interaction-offline";
    el.className = "ix-offline is-hidden";
    el.textContent = "互动服务离线";
    headerLeft.appendChild(el);
    return el;
  }

  function setBridgeStatus(online, message) {
    bridgeOnline = online;
    if (!offlineEl) return;
    if (online === false) {
      offlineEl.textContent = message || "互动服务离线";
      offlineEl.classList.remove("is-hidden");
    } else {
      offlineEl.classList.add("is-hidden");
    }
  }

  function tickClock() {
    if (clockEl) clockEl.textContent = formatClock(new Date());
  }

  function setViewerCount(count) {
    viewerCount = count;
    if (viewerEl) viewerEl.textContent = formatViewerCount(count);
  }

  function findScoreEl(movieId) {
    const card = document.querySelector(`.race-card[data-movie-id="${cssEscapeAttr(String(movieId))}"]`);
    return card?.querySelector?.("[data-live-score]") || null;
  }

  function paintScore(movieId, score, { pulse = false } = {}) {
    const el = findScoreEl(movieId);
    if (!el) return;
    const n = Number(score) || 0;
    el.textContent = formatScore(n);
    el.dataset.tone = scoreTone(n);
    if (pulse) {
      el.classList.remove("is-pulse");
      void el.offsetWidth;
      el.classList.add("is-pulse");
    }
  }

  function setMovieScore(movieId, score, options = {}) {
    const id = String(movieId || "");
    if (!id) return;
    const n = Number(score);
    scores.set(id, Number.isFinite(n) ? Math.trunc(n) : 0);
    paintScore(id, scores.get(id), { pulse: options.pulse === true });
  }

  function getMovieScore(movieId) {
    return scores.get(String(movieId)) || 0;
  }

  function matchCatalogMovie(movieId, movieName) {
    const id = String(movieId || "").trim();
    if (id) {
      const byId = catalog.find((m) => m.movieId === id);
      if (byId) return byId;
    }
    const name = String(movieName || "")
      .replace(/《|》/g, "")
      .trim();
    if (!name) return null;
    return (
      catalog.find((m) => m.name === name) ||
      catalog.find((m) => m.name.includes(name) || name.includes(m.name)) ||
      null
    );
  }

  function updateMovieCatalog(movies) {
    catalog = (movies || []).map((m) => ({
      movieId: String(m.movieId),
      name: String(m.name || ""),
      rank: Number(m.rank) || 0,
    }));
    if (isInteractionDemoEnabled()) {
      for (const m of catalog) {
        if (!scores.has(m.movieId) || scores.get(m.movieId) === 0) {
          const idx = Math.max(0, (Number(m.rank) || 1) - 1);
          scores.set(m.movieId, DEMO_SCORE_PRESETS[idx % DEMO_SCORE_PRESETS.length]);
        }
      }
    } else {
      for (const m of catalog) {
        if (!scores.has(m.movieId)) scores.set(m.movieId, 0);
      }
      // 真实 TOP10 变化时同步给 LiveAssistant（签名去重；失败不影响票房）
      if (catalog.length) {
        void service.publishCatalog(catalog).catch(() => {});
      }
    }
    for (const m of catalog) {
      paintScore(m.movieId, scores.get(m.movieId) || 0);
    }
  }

  function applyRemoteScores(movies) {
    if (isInteractionDemoEnabled()) return;
    for (const item of movies || []) {
      const matched = matchCatalogMovie(item.movieId, item.movieName || item.name);
      const id = matched?.movieId || String(item.movieId || "");
      if (!id) continue;
      const score = Number(item.score);
      if (!Number.isFinite(score)) continue;
      const prev = scores.get(id);
      setMovieScore(id, score, { pulse: prev != null && prev !== Math.trunc(score) });
    }
  }

  function showMovieScoreBubble(payload = {}) {
    const movieId = String(payload.movieId || "");
    const matched = matchCatalogMovie(movieId, payload.movieName);
    const resolvedId = matched?.movieId || movieId;
    const scoreDelta = Number(payload.scoreDelta) || 0;
    let totalScore = payload.totalScore;
    if (!Number.isFinite(Number(totalScore)) && resolvedId) {
      totalScore = (scores.get(resolvedId) || 0) + scoreDelta;
    }
    if (resolvedId && Number.isFinite(Number(totalScore))) {
      setMovieScore(resolvedId, totalScore, { pulse: true });
    }

    return bubbleLayer.showMovieScoreBubble({
      ...payload,
      movieId: resolvedId,
      movieName: payload.movieName || matched?.name || "",
      scoreDelta,
      totalScore,
    });
  }

  function addDanmaku(payload) {
    return wordCloud.addDanmaku(payload || {});
  }

  function applyRemoteEvents(events) {
    if (isInteractionDemoEnabled()) return;
    for (const evt of events || []) {
      const type = String(evt?.type || "").toLowerCase();
      if (type === "movie_score" || type === "score") {
        showMovieScoreBubble({
          eventId: evt.eventId,
          nickname: evt.nickname,
          movieId: evt.movieId,
          movieName: evt.movieName,
          action: evt.action,
          scoreDelta: evt.scoreDelta,
          totalScore: evt.totalScore,
        });
        continue;
      }
      if (type === "danmaku" || type === "comment") {
        addDanmaku({
          msgId: evt.msgId || evt.eventId,
          userId: evt.userId,
          nickname: evt.nickname,
          content: evt.content,
          createdAt: evt.createdAt,
        });
      }
    }
  }

  function seedDemoScores() {
    catalog.forEach((m, index) => {
      const score = DEMO_SCORE_PRESETS[index % DEMO_SCORE_PRESETS.length];
      setMovieScore(m.movieId, score);
    });
  }

  function runDemoTick() {
    if (destroyed || !isInteractionDemoEnabled()) return;
    if (!catalog.length) return;

    const movie = catalog[Math.floor(Math.random() * catalog.length)];
    const dm = DEMO_DANMAKU[demoSeq % DEMO_DANMAKU.length];
    addDanmaku({
      msgId: `demo-dm-${Date.now()}-${demoSeq}`,
      userId: `u-${demoSeq}`,
      nickname: dm.nickname,
      content: dm.content,
      createdAt: Date.now(),
    });

    if (demoSeq % 2 === 0) {
      const deltas = [300, -1000, 500, -200, 1200, -80];
      const scoreDelta = deltas[demoSeq % deltas.length];
      showMovieScoreBubble({
        eventId: `demo-score-${Date.now()}-${demoSeq}`,
        nickname: dm.nickname,
        movieId: movie.movieId,
        movieName: movie.name,
        action: scoreDelta > 0 ? "好评" : "差评",
        scoreDelta,
        totalScore: (scores.get(movie.movieId) || 0) + scoreDelta,
      });
    }

    if (demoSeq % 5 === 0) {
      const base = 80000 + Math.floor(Math.random() * 60000);
      setViewerCount(base + Math.floor(Math.random() * 5000));
    }

    demoSeq += 1;
  }

  function startDemoMode() {
    if (!isInteractionDemoEnabled()) return;
    document.body.classList.add("is-interaction-demo");
    setViewerCount(123000);
    seedDemoScores();
    // 视觉自检：预置 24 条模拟弹幕，便于观察球面旋转（仅 interactionDemo）
    for (let i = 0; i < 24; i += 1) {
      const dm = DEMO_DANMAKU[i % DEMO_DANMAKU.length];
      addDanmaku({
        msgId: `demo-boot-${i}`,
        nickname: dm.nickname,
        content: dm.content,
        createdAt: Date.now(),
      });
    }
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = window.setInterval(runDemoTick, 2800);
  }

  function start() {
    tickClock();
    clockTimer = window.setInterval(tickClock, 1000);
    if (viewerCount == null) setViewerCount(null);
    if (isInteractionDemoEnabled()) {
      startDemoMode();
      return;
    }
    // 生产模式：独立轮询 LiveAssistant，不影响票房刷新
    poller.start();
  }

  function destroy() {
    destroyed = true;
    if (clockTimer) clearInterval(clockTimer);
    if (demoTimer) clearInterval(demoTimer);
    poller.stop();
    bubbleLayer.clear();
    wordCloud.destroy();
  }

  const api = {
    setViewerCount,
    updateMovieCatalog,
    setMovieScore,
    getMovieScore,
    addDanmaku,
    showMovieScoreBubble,
    applyRemoteScores,
    applyRemoteEvents,
    setBridgeStatus,
    start,
    destroy,
    isDemo: isInteractionDemoEnabled,
    formatScore,
    SCORE_BUBBLE_DURATION_MS,
    SCORE_BUBBLE_MAX_VISIBLE,
    service,
    poller,
    getBridgeOnline: () => bridgeOnline,
  };

  if (typeof window !== "undefined") {
    window.__movieInteraction = api;
  }

  return api;
}

export {
  formatClock,
  formatViewerCount,
  formatScore,
  scoreTone,
  isInteractionDemoEnabled,
  SCORE_BUBBLE_DURATION_MS,
  SCORE_BUBBLE_MAX_VISIBLE,
};
