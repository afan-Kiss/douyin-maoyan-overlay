/**
 * 简化票房状态：每影片/大盘只保留 lastValidBox + displayBox。
 * 气泡仅由「本轮有效值 vs 上一轮有效值」计算，不读 DOM / displayCache。
 */
export const BUBBLE_SKIP = {
  NO_ELEMENT: "no_element",
  NO_TRUSTED_VALUE: "no_trusted_value",
  FIRST_BASELINE: "first_baseline",
  DUPLICATE_AMOUNT: "duplicate_amount",
  NON_POSITIVE_DELTA: "non_positive_delta",
  REJECTED_LOWER: "rejected_lower",
  SETTINGS_OFF: "settings_off",
};

const boxStates = new Map();
const skipLog = [];
const MAX_SKIP_LOG = 200;

function logSkip(key, reason, detail = {}) {
  skipLog.push({ at: Date.now(), key, reason, ...detail });
  if (skipLog.length > MAX_SKIP_LOG) skipLog.shift();
}

export function getBubbleSkipLog() {
  return skipLog.slice();
}

export function clearBoxStates() {
  boxStates.clear();
}

/** @deprecated 兼容旧名 */
export function clearBubbleSamples() {
  clearBoxStates();
}

export function getBoxState(key) {
  const id = String(key || "");
  const cur = boxStates.get(id);
  if (cur) return { lastValidBox: cur.lastValidBox, displayBox: cur.displayBox };
  return { lastValidBox: 0, displayBox: 0 };
}

/** @deprecated 兼容旧测试读取 */
export function getBubbleSample(key) {
  const st = getBoxState(key);
  if (!(st.lastValidBox > 0)) return undefined;
  return {
    amount: st.lastValidBox,
    baseline: st.lastValidBox,
    observedAmount: st.displayBox,
  };
}

export function isValidBoxAmount(value) {
  if (value == null) return false;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) return false;
  return true;
}

function nearlyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.0000005;
}

/**
 * 摄入本轮有效票房。current 无效时不改 lastValidBox，继续返回旧 displayBox。
 * @returns {{ lastValidBox:number, displayBox:number, delta:number, action:string }}
 */
export function ingestBoxSample(key, currentValidBox) {
  const id = String(key || "");
  const prev = boxStates.get(id) || { lastValidBox: 0, displayBox: 0 };

  if (!isValidBoxAmount(currentValidBox)) {
    logSkip(id, BUBBLE_SKIP.NO_TRUSTED_VALUE, { currentValidBox });
    return {
      lastValidBox: prev.lastValidBox,
      displayBox: prev.displayBox > 0 ? prev.displayBox : prev.lastValidBox,
      delta: 0,
      action: "invalid",
    };
  }

  const current = Number(currentValidBox);

  if (!(prev.lastValidBox > 0)) {
    const next = { lastValidBox: current, displayBox: current };
    boxStates.set(id, next);
    logSkip(id, BUBBLE_SKIP.FIRST_BASELINE, { amount: current });
    return { ...next, delta: 0, action: "first" };
  }

  if (nearlyEqual(current, prev.lastValidBox)) {
    const next = { lastValidBox: prev.lastValidBox, displayBox: prev.lastValidBox };
    boxStates.set(id, next);
    logSkip(id, BUBBLE_SKIP.DUPLICATE_AMOUNT, { amount: current });
    return { ...next, delta: 0, action: "same" };
  }

  if (current < prev.lastValidBox) {
    logSkip(id, BUBBLE_SKIP.REJECTED_LOWER, {
      amount: current,
      lastValidBox: prev.lastValidBox,
    });
    return {
      lastValidBox: prev.lastValidBox,
      displayBox: prev.lastValidBox,
      delta: 0,
      action: "drop",
    };
  }

  const delta = current - prev.lastValidBox;
  if (!(delta > 0)) {
    logSkip(id, BUBBLE_SKIP.NON_POSITIVE_DELTA, { amount: current, delta });
    return {
      lastValidBox: prev.lastValidBox,
      displayBox: prev.lastValidBox,
      delta: 0,
      action: "same",
    };
  }

  const next = { lastValidBox: current, displayBox: current };
  boxStates.set(id, next);
  return { ...next, delta, action: "rise" };
}

/** 兼容旧名：仅在 amount 有效时摄入；不再做复杂 high-water/tick */
export function submitBubbleSample({ key, el, amount, bubbleEnabled = true }) {
  if (bubbleEnabled === false) {
    return { action: "skip", reason: BUBBLE_SKIP.SETTINGS_OFF, delta: 0 };
  }
  if (!el) {
    return { action: "skip", reason: BUBBLE_SKIP.NO_ELEMENT, delta: 0 };
  }
  const result = ingestBoxSample(key, amount);
  if (result.action === "rise" && result.delta > 0) {
    return { action: "pulse", delta: result.delta, amount: result.displayBox };
  }
  if (result.action === "first") {
    return { action: "baseline", reason: BUBBLE_SKIP.FIRST_BASELINE, delta: 0 };
  }
  if (result.action === "drop") {
    return { action: "skip", reason: BUBBLE_SKIP.REJECTED_LOWER, delta: 0 };
  }
  return { action: "skip", reason: BUBBLE_SKIP.DUPLICATE_AMOUNT, delta: 0 };
}

/** 已停用：不再 3 秒 tick / 暂无变化 */
export function tickBubbleSamples() {
  /* no-op */
}

export function registerBubbleAnchor() {
  /* no-op：无 idle bubble */
}

export function isIdleBubbleAnchor() {
  return false;
}

/** 兼容旧代码读取：空 Map，避免依赖样本结构 */
export const bubbleSamples = {
  get() {
    return undefined;
  },
  set() {},
  delete() {},
  clear() {
    clearBoxStates();
  },
  get size() {
    return boxStates.size;
  },
  [Symbol.iterator]() {
    return boxStates[Symbol.iterator]();
  },
};
