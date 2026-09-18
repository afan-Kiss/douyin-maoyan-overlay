/**
 * 电影评分成功气泡（独立于票房上涨气泡）。
 */

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

export function createMovieScoreBubbleLayer(options = {}) {
  const layer =
    options.layer ||
    (typeof document !== "undefined" ? document.getElementById("score-bubble-layer") : null);
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

    const el = document.createElement("div");
    el.className = "score-bubble";
    el.dataset.eventId = eventId;
    el.dataset.tone = toneOf(payload.scoreDelta);
    const nick = String(payload.nickname || "观众");
    const movieName = String(payload.movieName || payload.movieId || "");
    const delta = formatDelta(payload.scoreDelta);
    el.innerHTML = `<span class="score-bubble__nick">${nick}</span><span class="score-bubble__arrow">→</span><span class="score-bubble__movie">${movieName}</span><span class="score-bubble__delta">${delta}分</span>`;
    layer.appendChild(el);

    const layerRect = layer.getBoundingClientRect();
    const offsetIndex = active.size;
    let top = 120;
    let left = 640;
    const rowRect = card?.getBoundingClientRect();
    if (rowRect) {
      top = rowRect.top - layerRect.top + 8 + (offsetIndex % 3) * 28;
      left = rowRect.right - layerRect.left - 280 - (offsetIndex % 2) * 36;
    }
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${Math.max(16, Math.min(left, 780))}px`;

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
