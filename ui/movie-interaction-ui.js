/**
 * 电影互动榜 UI：在线人数、直播间评分、评分气泡、演示模式。
 * 与票房状态机隔离；LiveAssistant 后续直接调用导出 API。
 */

import { createMovieWordCloud } from "./movie-word-cloud.js";

export const SCORE_BUBBLE_DURATION_MS = 10000;
export const SCORE_BUBBLE_MAX_VISIBLE = 7;

function cssEscapeAttr(value) {
  const text = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(text);
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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

function isInteractionDemoEnabled() {
  try {
    return new URLSearchParams(location.search).get("interactionDemo") === "1";
  } catch {
    return false;
  }
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
  const bubbleLayer = $("score-bubble-layer");

  /** @type {Map<string, number>} */
  const scores = new Map();
  /** @type {Array<{ movieId: string, name: string, rank: number }>} */
  let catalog = [];
  let viewerCount = null;
  let clockTimer = null;
  let demoTimer = null;
  let demoSeq = 0;
  let destroyed = false;

  const wordCloud = createMovieWordCloud(cloudRoot);

  /** @type {Array<object>} */
  const bubbleQueue = [];
  /** @type {Map<string, { el: HTMLElement, timer: number }>} */
  const activeBubbles = new Map();

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

  function paintScore(movieId, score) {
    const el = findScoreEl(movieId);
    if (!el) return;
    const n = Number(score) || 0;
    el.textContent = formatScore(n);
    el.dataset.tone = scoreTone(n);
    el.classList.remove("is-pulse");
    void el.offsetWidth;
    el.classList.add("is-pulse");
  }

  function setMovieScore(movieId, score) {
    const id = String(movieId || "");
    if (!id) return;
    const n = Number(score);
    scores.set(id, Number.isFinite(n) ? Math.trunc(n) : 0);
    paintScore(id, scores.get(id));
  }

  function getMovieScore(movieId) {
    return scores.get(String(movieId)) || 0;
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
    }
    for (const m of catalog) {
      paintScore(m.movieId, scores.get(m.movieId) || 0);
    }
  }

  function addDanmaku(payload) {
    return wordCloud.addDanmaku(payload || {});
  }

  function placeBubble(payload) {
    if (!bubbleLayer) return null;
    const eventId = String(payload.eventId || `score-${++demoSeq}`);
    if (activeBubbles.has(eventId)) return activeBubbles.get(eventId).el;

    const card = document.querySelector(
      `.race-card[data-movie-id="${cssEscapeAttr(String(payload.movieId))}"]`,
    );
    const el = document.createElement("div");
    el.className = "score-bubble";
    el.dataset.eventId = eventId;
    el.dataset.tone = scoreTone(payload.scoreDelta);
    const delta = formatScore(payload.scoreDelta);
    const nick = String(payload.nickname || "观众");
    const movieName = String(payload.movieName || payload.movieId || "");
    el.innerHTML = `<span class="score-bubble__nick">${nick}</span><span class="score-bubble__arrow">→</span><span class="score-bubble__movie">${movieName}</span><span class="score-bubble__delta">${delta}分</span>`;

    bubbleLayer.appendChild(el);

    const rowRect = card?.getBoundingClientRect();
    const stage = document.querySelector(".stage")?.getBoundingClientRect();
    const layerRect = bubbleLayer.getBoundingClientRect();
    const offsetIndex = activeBubbles.size;
    let top = 120;
    let left = 640;
    if (rowRect && stage) {
      top = rowRect.top - layerRect.top + 8 + (offsetIndex % 3) * 28;
      left = rowRect.right - layerRect.left - 280 - (offsetIndex % 2) * 36;
    }
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${Math.max(16, Math.min(left, 780))}px`;

    const timer = window.setTimeout(() => {
      el.classList.add("is-leaving");
      window.setTimeout(() => {
        el.remove();
        activeBubbles.delete(eventId);
        flushBubbleQueue();
      }, 320);
    }, SCORE_BUBBLE_DURATION_MS);

    activeBubbles.set(eventId, { el, timer });
    return el;
  }

  function flushBubbleQueue() {
    while (bubbleQueue.length && activeBubbles.size < SCORE_BUBBLE_MAX_VISIBLE) {
      const next = bubbleQueue.shift();
      placeBubble(next);
    }
  }

  function showMovieScoreBubble(payload = {}) {
    const eventId = String(payload.eventId || `score-${Date.now()}-${++demoSeq}`);
    const movieId = String(payload.movieId || "");
    const scoreDelta = Number(payload.scoreDelta) || 0;
    let totalScore = payload.totalScore;
    if (!Number.isFinite(Number(totalScore)) && movieId) {
      totalScore = (scores.get(movieId) || 0) + scoreDelta;
    }
    if (movieId && Number.isFinite(Number(totalScore))) {
      setMovieScore(movieId, totalScore);
    }

    const full = {
      ...payload,
      eventId,
      movieId,
      scoreDelta,
      totalScore,
      movieName: payload.movieName || catalog.find((m) => m.movieId === movieId)?.name || "",
    };

    if (activeBubbles.size >= SCORE_BUBBLE_MAX_VISIBLE) {
      bubbleQueue.push(full);
      return { queued: true, eventId };
    }
    placeBubble(full);
    return { queued: false, eventId };
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
    // 立即灌几条弹幕，方便截图验收
    for (let i = 0; i < 8; i += 1) {
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
    }
  }

  function destroy() {
    destroyed = true;
    if (clockTimer) clearInterval(clockTimer);
    if (demoTimer) clearInterval(demoTimer);
    for (const { timer, el } of activeBubbles.values()) {
      clearTimeout(timer);
      el.remove();
    }
    activeBubbles.clear();
    wordCloud.destroy();
  }

  const api = {
    setViewerCount,
    updateMovieCatalog,
    setMovieScore,
    getMovieScore,
    addDanmaku,
    showMovieScoreBubble,
    start,
    destroy,
    isDemo: isInteractionDemoEnabled,
    formatScore,
    SCORE_BUBBLE_DURATION_MS,
    SCORE_BUBBLE_MAX_VISIBLE,
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
};
