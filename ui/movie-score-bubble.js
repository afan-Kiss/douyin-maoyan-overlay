/**
 * 电影评分成功气泡（独立于票房上涨气泡）。
 * 显示层统一挂到 #global-bubble-layer，坐标与票房气泡共用 overlay-coordinate。
 */
import { computeBubblePosition, readViewportScale } from "./overlay-coordinate.js";

const SCORE_STACK_STEP = 38;

export const SCORE_BUBBLE_DURATION_MS = 10000;
export const SCORE_BUBBLE_MAX_VISIBLE = 5;

function cssEscapeAttr(value) {
  const text = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(text);
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatDelta(scoreDelta) {
  const n = Number(scoreDelta);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(Math.trunc(n)).toLocaleString("en-US");
  if (n > 0) return `+${abs}`;
  if (n < 0) return `-${abs}`;
  return "0";
}

function toneOf(scoreDelta) {
  const n = Number(scoreDelta) || 0;
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "zero";
}

function resolveBubbleLayer(preferred) {
  if (preferred && preferred.isConnected) return preferred;
  if (typeof document === "undefined") return null;
  return (
    document.getElementById("global-bubble-layer") ||
    document.getElementById("score-bubble-layer")
  );
}

function placeScoreBubble(el, layer, card, offsetIndex) {
  const scoreEl = card?.querySelector("[data-live-score]");
  if (!scoreEl) return false;
  const placed = computeBubblePosition(layer, scoreEl, el, {
    mode: "edge",
    gap: 10,
    margin: 8,
    stackIndex: offsetIndex,
    stackStep: SCORE_STACK_STEP,
  });
  el.style.top = `${placed.top}px`;
  el.style.left = `${placed.left}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.dataset.anchorMovieId = String(card.dataset.movieId || "");
  el.dataset.anchorRank = String(card.dataset.rank || "");
  el.dataset.anchorColumn = "liveScore";
  window.__bubblePlacement = {
    kind: "score",
    viewportScale: readViewportScale(),
    anchorMovieId: String(card.dataset.movieId || ""),
    anchorRank: Number(card.dataset.rank) || 0,
    anchorColumn: "liveScore",
    left: placed.left,
    top: placed.top,
    stackIndex: offsetIndex,
  };
  return true;
}

export function createMovieScoreBubbleLayer(options = {}) {
  const layer = resolveBubbleLayer(options.layer);
  const durationMs =
    Number(options.durationMs) > 0 ? Number(options.durationMs) : SCORE_BUBBLE_DURATION_MS;
  const maxVisible =
    Number(options.maxVisible) > 0 ? Number(options.maxVisible) : SCORE_BUBBLE_MAX_VISIBLE;

  /** @type {Array<object>} */
  const queue = [];
  /** @type {Map<string, { el: HTMLElement, timer: number }>} */
  const active = new Map();
  /** @type {Set<string>} */
  const seenIds = new Set();
  let seq = 0;

  function place(payload) {
    if (!layer) return null;
    const eventId = String(payload.eventId || `score-${Date.now()}-${++seq}`);
    if (active.has(eventId)) return active.get(eventId).el;

    const card = payload.movieId
      ? document.querySelector(`.race-card[data-movie-id="${cssEscapeAttr(String(payload.movieId))}"]`)
      : null;
    if (!card?.querySelector("[data-live-score]")) return null;

    const el = document.createElement("div");
    el.className = "score-bubble";
    el.dataset.eventId = eventId;
    el.dataset.tone = toneOf(payload.scoreDelta);
    const nick = String(payload.nickname || "观众");
    const movieName = String(payload.movieName || payload.movieId || "");
    const delta = formatDelta(payload.scoreDelta);
    el.innerHTML = `<span class="score-bubble__nick">${nick}</span><span class="score-bubble__arrow">→</span><span class="score-bubble__movie">${movieName}</span><span class="score-bubble__delta">${delta}分</span>`;
    layer.appendChild(el);
    const movieId = String(payload.movieId || "");
    let stackIndex = 0;
    for (const item of active.values()) {
      if (String(item.el?.dataset?.anchorMovieId || "") === movieId) stackIndex += 1;
    }
    if (!placeScoreBubble(el, layer, card, stackIndex)) {
      el.remove();
      return null;
    }

    const timer = window.setTimeout(() => {
      el.classList.add("is-leaving");
      window.setTimeout(() => {
        el.remove();
        active.delete(eventId);
        flush();
      }, 320);
    }, durationMs);

    active.set(eventId, { el, timer });
    return el;
  }

  function flush() {
    while (queue.length && active.size < maxVisible) {
      place(queue.shift());
    }
  }

  function showMovieScoreBubble(payload = {}) {
    const eventId = String(payload.eventId || `score-${Date.now()}-${++seq}`);
    if (seenIds.has(eventId)) return { queued: false, eventId, skipped: true, reason: "duplicate" };
    seenIds.add(eventId);
    if (seenIds.size > 500) {
      const first = seenIds.values().next().value;
      seenIds.delete(first);
    }

    const full = { ...payload, eventId };
    if (active.size >= maxVisible) {
      queue.push(full);
      return { queued: true, eventId };
    }
    place(full);
    return { queued: false, eventId };
  }

  function clear() {
    for (const { timer, el } of active.values()) {
      clearTimeout(timer);
      el.remove();
    }
    active.clear();
    queue.length = 0;
  }

  return {
    showMovieScoreBubble,
    clear,
    getActiveCount: () => active.size,
    getQueueLength: () => queue.length,
    SCORE_BUBBLE_DURATION_MS: durationMs,
    SCORE_BUBBLE_MAX_VISIBLE: maxVisible,
  };
}
