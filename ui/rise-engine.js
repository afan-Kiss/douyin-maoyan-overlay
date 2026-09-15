/**
 * RiseEngine — 仅由 Store 接受有效票房后触发。
 * 无 tick / 无 DOM 采样 / 无「暂无变化」。
 */

/** 去掉末尾无意义的 0（1.0→1，1.20→1.2） */
function formatFixedTrim(n, maxDecimals) {
  let s = Number(n).toFixed(maxDecimals);
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

/**
 * 气泡增量格式化（输入单位：元）。
 * <1000 → +xxx元
 * <10000 → +x.x千元
 * <100000 → +x.xx万
 * ≥100000 → +x.x万
 */
export function formatRiseDelta(deltaYuan) {
  if (!Number.isFinite(deltaYuan) || deltaYuan <= 0) return "";
  const y = Math.round(Math.abs(deltaYuan));
  if (y < 1000) {
    return `+${y}元`;
  }
  if (y < 10000) {
    return `+${formatFixedTrim(y / 1000, 1)}千元`;
  }
  if (y < 100000) {
    return `+${formatFixedTrim(y / 10000, 2)}万`;
  }
  return `+${formatFixedTrim(y / 10000, 1)}万`;
}

/**
 * 气泡展示：内部 delta 单位是「万」，换算成元后走 formatRiseDelta。
 */
export function formatRiseText(deltaWan) {
  if (!Number.isFinite(deltaWan) || deltaWan <= 0) return "";
  return formatRiseDelta(deltaWan * 10000);
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
   * 约定：调用方已在 entity 上写入 displayBoxWan=newValue（commit 后的新值）。
   */
  function onAcceptedBox(movieId, oldValue, newValue, meta = {}) {
    const oldWan = Number(oldValue) || 0;
    const newWan = Number(newValue) || 0;
    if (!(oldWan > 0)) return null;
    if (!(newWan > oldWan)) return null;
    const deltaWan = Number((newWan - oldWan).toFixed(4));
    if (!(deltaWan >= minDelta)) return null;

    const deltaYuan = Math.round(deltaWan * 10000);
    const displayAfterCommit = Number(
      meta.displayAfterCommit != null ? meta.displayAfterCommit : newWan,
    );

    const evt = {
      movieId: String(movieId || ""),
      name: meta.name || "",
      deltaWan,
      deltaYuan,
      oldWan,
      newWan,
      displayAfterCommit,
      at: Date.now(),
      kind: meta.kind || "movie",
    };

    console.log("[BOX_RISE]", {
      movie: evt.name || evt.movieId,
      oldBoxWan: evt.oldWan,
      newBoxWan: evt.newWan,
      deltaWan: evt.deltaWan,
      deltaYuan: evt.deltaYuan,
      displayAfterCommit: evt.displayAfterCommit,
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

  return {
    onAcceptedBox,
    onRise,
    formatRiseDelta,
    formatRiseText,
    formatRiseTextWithArrow,
  };
}

export const riseEngine = createRiseEngine();
