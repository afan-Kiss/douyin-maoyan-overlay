/**
 * 电影评分成功气泡（独立于票房上涨气泡）。
 * 显示层统一挂到 #global-bubble-layer，避免被排行榜 overflow 裁切。
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

function resolveBubbleLayer(preferred) {
  if (preferred && preferred.isConnected) return preferred;
  if (typeof document === "undefined") return null;
  return (
    document.getElementById("global-bubble-layer") ||
    document.getElementById("score-bubble-layer")
  );
}

/**
 * 根据行位置与排名，把评分气泡放到不被裁切的位置。
 * TOP1~3 / TOP8~10 优先向上；底部空间不足时自动上移。
 */
function placeScoreBubble(el, layer, card, offsetIndex) {
  const layerRect = layer.getBoundingClientRect();
  const rank = Number(card?.dataset?.rank) || 5;
  const scoreEl = card?.querySelector("[data-live-score]") || card;
  const rowRect = scoreEl?.getBoundingClientRect?.() || card?.getBoundingClientRect?.();

  const bw = el.offsetWidth || 220;
  const bh = el.offsetHeight || 36;
  const margin = 6;
  const floatReserve = 48;

  let left = 640;
  let top = 120;

  if (rowRect) {
    // 锚定评分胶囊左侧上方
    left = rowRect.left - layerRect.left + rowRect.width * 0.15 - bw * 0.2;
    top = rowRect.top - layerRect.top - bh - 8 + (offsetIndex % 3) * 10;

    if (rank >= 1 && rank <= 3) {
      top = rowRect.top - layerRect.top - bh - 14;
      left = rowRect.left - layerRect.left + Math.max(0, rowRect.width - bw) * 0.5;
    } else if (rank >= 8) {
      top = rowRect.top - layerRect.top - bh - 10;
      left = rowRect.left - layerRect.left - 12 - (offsetIndex % 2) * 28;
    } else {
      top = rowRect.top - layerRect.top - bh - 6 + (offsetIndex % 3) * 12;
      left = rowRect.right - layerRect.left - bw - 8 - (offsetIndex % 2) * 24;
    }
  }

  // 底部行：若动画上浮后仍可能贴底，整体上移
  if (rank >= 8 && top + bh + floatReserve > layerRect.height - margin) {
    top = Math.max(margin, layerRect.height - bh - floatReserve - margin);
  }
  if (top < margin) top = margin;
  if (top + bh > layerRect.height - margin) {
    top = Math.max(margin, layerRect.height - bh - margin);
  }
  left = Math.max(margin, Math.min(left, layerRect.width - bw - margin));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
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

    const el = document.createElement("div");
    el.className = "score-bubble";
    el.dataset.eventId = eventId;
    el.dataset.tone = toneOf(payload.scoreDelta);
    const nick = String(payload.nickname || "观众");
    const movieName = String(payload.movieName || payload.movieId || "");
    const delta = formatDelta(payload.scoreDelta);
    el.innerHTML = `<span class="score-bubble__nick">${nick}</span><span class="score-bubble__arrow">→</span><span class="score-bubble__movie">${movieName}</span><span class="score-bubble__delta">${delta}分</span>`;
    layer.appendChild(el);

    // 先插入再量宽，保证定位准确
    placeScoreBubble(el, layer, card, active.size);

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
