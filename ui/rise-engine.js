/**
 * RiseEngine — 仅由 Store 接受有效票房后触发。
 * 无 tick / 无 DOM 采样 / 无「暂无变化」。
 */

export function formatRiseText(deltaWan) {
  if (!Number.isFinite(deltaWan) || deltaWan <= 0) return "";
  const sign = "+";
  const cents = Math.round(Math.abs(deltaWan) * 1000000);
  if (!cents) return "";
  if (cents >= 10000000000) return `${sign}${Number((cents / 10000000000).toFixed(10))}亿`;
  if (cents >= 1000000) return `${sign}${Number((cents / 1000000).toFixed(6))}万`;
  return `${sign}${Number((cents / 100).toFixed(2))}元`;
}

export function formatRiseTextWithArrow(deltaWan) {
  const text = formatRiseText(deltaWan);
  return text ? `${text} ↑` : "";
}

/**
 * @param {{ onRise?: (evt: object) => void, minDelta?: number }} options
 */
export function createRiseEngine(options = {}) {
  const minDelta = Number(options.minDelta) > 0 ? Number(options.minDelta) : 0.001;
  /** @type {((evt: object) => void)[]} */
  const listeners = [];
  if (typeof options.onRise === "function") listeners.push(options.onRise);

  function onRise(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /**
   * Store 接受票房后调用。oldValue<=0 或 newValue<=oldValue → 忽略。
   */
  function onAcceptedBox(movieId, oldValue, newValue, meta = {}) {
    const oldWan = Number(oldValue) || 0;
    const newWan = Number(newValue) || 0;
    if (!(oldWan > 0)) return null;
    if (!(newWan > oldWan)) return null;
    const deltaWan = newWan - oldWan;
    if (!(deltaWan >= minDelta)) return null;

    const evt = {
      movieId: String(movieId || ""),
      name: meta.name || "",
      deltaWan,
      oldWan,
      newWan,
      at: Date.now(),
      kind: meta.kind || "movie",
    };

    console.log("[BOX_RISE]", {
      movieId: evt.movieId,
      name: evt.name,
      oldWan: evt.oldWan,
      newWan: evt.newWan,
      deltaWan: evt.deltaWan,
    });

    for (const fn of listeners) {
      try {
        fn(evt);
      } catch (err) {
        console.warn("[BOX_RISE] listener error", err);
      }
    }
    return evt;
  }

  return { onAcceptedBox, onRise, formatRiseText, formatRiseTextWithArrow };
}

export const riseEngine = createRiseEngine();
