/**
 * 气泡样本：按业务日期 + movieId + 票房口径绑定；记录未显示原因。
 */
export const BUBBLE_SKIP = {
  NO_ELEMENT: "no_element",
  NO_TRUSTED_VALUE: "no_trusted_value",
  FIRST_BASELINE: "first_baseline",
  DUPLICATE_AMOUNT: "duplicate_amount",
  NON_POSITIVE_DELTA: "non_positive_delta",
  REJECTED_LOWER: "rejected_lower",
  UNREASONABLE_DELTA: "unreasonable_delta",
  BASELINE_RESET: "baseline_reset",
  SETTINGS_OFF: "settings_off",
  DOM_REPLACED: "dom_replaced",
  ANIMATION_ACTIVE: "animation_active",
  DECODE_NOT_VERIFIED: "decode_not_verified",
};

const samples = new Map();
const skipLog = [];
const MAX_SKIP_LOG = 200;

function logSkip(key, reason, detail = {}) {
  skipLog.push({ at: Date.now(), key, reason, ...detail });
  if (skipLog.length > MAX_SKIP_LOG) skipLog.shift();
}

export function getBubbleSkipLog() {
  return skipLog.slice();
}

export function getBubbleSample(key) {
  return samples.get(key);
}

export function clearBubbleSamples() {
  samples.clear();
}

/** 无数值时仍注册 DOM，让 3s tick 能播「暂无变化」 */
export function registerBubbleAnchor(key, el) {
  if (!key || !el) return;
  const existing = samples.get(key);
  if (existing) {
    existing.el = el;
    return;
  }
  samples.set(key, {
    el,
    amount: 0,
    baseline: 0,
    observedAmount: 0,
    lastTriggeredAmount: 0,
    lastBoxHtml: "",
    idleOnly: true,
  });
}

export function isIdleBubbleAnchor(key) {
  return Boolean(samples.get(key)?.idleOnly);
}

function sampleKey(movieId, businessDate, scope = "movie") {
  const day = String(businessDate || "").slice(0, 10);
  return `${scope}:${movieId || "__nation__"}:${day}`;
}

export function submitBubbleSample({
  key,
  el,
  amount,
  businessDate = "",
  movieId = "",
  scope = "movie",
  contentKey = "",
  decodeVerified = false,
  responseId = 0,
  resetBaseline = false,
  isReasonableDelta,
  bubbleEnabled = true,
  isVisible = () => false,
  lastTriggeredAmount = 0,
  previousAmount = 0,
}) {
  const id = key || sampleKey(movieId, businessDate, scope);
  if (!el) {
    logSkip(id, BUBBLE_SKIP.NO_ELEMENT, { amount, responseId });
    return { action: "skip", reason: BUBBLE_SKIP.NO_ELEMENT };
  }
  if (!bubbleEnabled) {
    logSkip(id, BUBBLE_SKIP.SETTINGS_OFF, { amount });
    return { action: "skip", reason: BUBBLE_SKIP.SETTINGS_OFF };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    logSkip(id, BUBBLE_SKIP.NO_TRUSTED_VALUE, { amount, decodeVerified });
    const sample = samples.get(id);
    if (sample) sample.el = el;
    return { action: "skip", reason: BUBBLE_SKIP.NO_TRUSTED_VALUE };
  }

  const idleSample = samples.get(id);
  if (idleSample?.idleOnly) {
    idleSample.idleOnly = false;
    idleSample.el = el;
    idleSample.observedAmount = amount;
    idleSample.lastTriggeredAmount = 0;
    idleSample.businessDate = businessDate;
    idleSample.movieId = movieId;
    idleSample.contentKey = contentKey;
    idleSample.lastResponseId = responseId;
    idleSample.verifiedAt = Date.now();
    // 高水位：低于已有 previousAmount 的读数抛弃，基线锁在更高值
    if (previousAmount > 0 && amount < previousAmount) {
      idleSample.amount = previousAmount;
      idleSample.baseline = previousAmount;
      logSkip(id, BUBBLE_SKIP.REJECTED_LOWER, {
        amount,
        highWater: previousAmount,
        responseId,
        fromIdle: true,
      });
      return {
        action: "baseline",
        reason: BUBBLE_SKIP.REJECTED_LOWER,
        delta: 0,
        highWater: previousAmount,
      };
    }
    const baseline = previousAmount > 0 ? previousAmount : amount;
    idleSample.amount = amount;
    idleSample.baseline = baseline;
    if (amount > baseline) {
      const delta = amount - baseline;
      if (typeof isReasonableDelta !== "function" || isReasonableDelta(baseline, amount, delta)) {
        idleSample.baseline = amount;
        logSkip(id, BUBBLE_SKIP.FIRST_BASELINE, { amount, responseId, fromIdle: true, delta });
        return { action: "pulse", delta, amount, previousBaseline: baseline };
      }
      idleSample.baseline = amount;
      logSkip(id, BUBBLE_SKIP.UNREASONABLE_DELTA, { amount, delta, responseId, fromIdle: true });
      return { action: "baseline", reason: BUBBLE_SKIP.UNREASONABLE_DELTA, delta };
    }
    logSkip(id, BUBBLE_SKIP.FIRST_BASELINE, { amount, responseId, fromIdle: true });
    return { action: "baseline", reason: BUBBLE_SKIP.FIRST_BASELINE, delta: 0 };
  }
  if (!decodeVerified) {
    logSkip(id, BUBBLE_SKIP.DECODE_NOT_VERIFIED, { amount, contentKey, responseId });
    const sample = samples.get(id);
    if (sample) {
      sample.el = el;
      sample.pendingAmount = amount;
      sample.pendingContentKey = contentKey;
    }
    return { action: "skip", reason: BUBBLE_SKIP.DECODE_NOT_VERIFIED };
  }

  let sample = samples.get(id);
  if (!sample) {
    // 高水位：首样本低于 previousAmount 时锁在更高值，不播假涨幅
    if (previousAmount > 0 && amount < previousAmount) {
      samples.set(id, {
        el,
        amount: previousAmount,
        baseline: previousAmount,
        observedAmount: amount,
        lastTriggeredAmount: 0,
        lastBoxHtml: "",
        businessDate,
        movieId,
        contentKey,
        lastResponseId: responseId,
        verifiedAt: Date.now(),
      });
      logSkip(id, BUBBLE_SKIP.REJECTED_LOWER, {
        amount,
        highWater: previousAmount,
        responseId,
      });
      return {
        action: "baseline",
        reason: BUBBLE_SKIP.REJECTED_LOWER,
        delta: 0,
        highWater: previousAmount,
      };
    }
    const baseline = previousAmount > 0 ? previousAmount : amount;
    samples.set(id, {
      el,
      amount,
      baseline,
      observedAmount: amount,
      lastTriggeredAmount: 0,
      lastBoxHtml: "",
      businessDate,
      movieId,
      contentKey,
      lastResponseId: responseId,
      verifiedAt: Date.now(),
    });
    if (amount > baseline) {
      const delta = amount - baseline;
      if (typeof isReasonableDelta !== "function" || isReasonableDelta(baseline, amount, delta)) {
        sample = samples.get(id);
        sample.baseline = amount;
        logSkip(id, BUBBLE_SKIP.FIRST_BASELINE, { amount, responseId, delta });
        return { action: "pulse", delta, amount, previousBaseline: baseline };
      }
      sample = samples.get(id);
      sample.baseline = amount;
      logSkip(id, BUBBLE_SKIP.UNREASONABLE_DELTA, { amount, delta, responseId });
      return { action: "baseline", reason: BUBBLE_SKIP.UNREASONABLE_DELTA, delta };
    }
    logSkip(id, BUBBLE_SKIP.FIRST_BASELINE, { amount, responseId });
    return { action: "baseline", reason: BUBBLE_SKIP.FIRST_BASELINE, delta: 0 };
  }

  if (!sample.el?.isConnected) {
    logSkip(id, BUBBLE_SKIP.DOM_REPLACED, { amount });
    sample.el = el;
  } else {
    sample.el = el;
  }

  if (resetBaseline) {
    sample.amount = amount;
    sample.baseline = amount;
    sample.lastTriggeredAmount = 0;
    sample.contentKey = contentKey;
    sample.lastResponseId = responseId;
    logSkip(id, BUBBLE_SKIP.BASELINE_RESET, { amount, responseId });
    return { action: "reset", reason: BUBBLE_SKIP.BASELINE_RESET };
  }

  sample.observedAmount = amount;
  sample.lastResponseId = responseId;

  const highWater = Math.max(Number(sample.amount) || 0, Number(sample.baseline) || 0);
  if (Math.abs(amount - highWater) < 0.000001) {
    logSkip(id, BUBBLE_SKIP.DUPLICATE_AMOUNT, { amount, responseId });
    return { action: "skip", reason: BUBBLE_SKIP.DUPLICATE_AMOUNT };
  }

  // 高水位：低于上次已采纳读数则抛弃，不拉低 baseline / amount
  if (amount < highWater) {
    logSkip(id, BUBBLE_SKIP.REJECTED_LOWER, {
      amount,
      highWater,
      responseId,
    });
    return {
      action: "skip",
      reason: BUBBLE_SKIP.REJECTED_LOWER,
      delta: amount - highWater,
      highWater,
    };
  }

  const previousBaseline = sample.baseline;
  const delta =
    (Math.round(amount * 1000000) - Math.round(previousBaseline * 1000000)) / 1000000;

  if (delta <= 0) {
    logSkip(id, BUBBLE_SKIP.NON_POSITIVE_DELTA, { amount, delta, responseId });
    return { action: "skip", reason: BUBBLE_SKIP.NON_POSITIVE_DELTA, delta };
  }

  // 不合理过大：采纳为新高水位但不播涨幅，避免假 +N 万，也避免 baseline 卡住
  if (typeof isReasonableDelta === "function" && !isReasonableDelta(previousBaseline, amount, delta)) {
    sample.amount = amount;
    sample.baseline = amount;
    sample.contentKey = contentKey;
    logSkip(id, BUBBLE_SKIP.UNREASONABLE_DELTA, { amount, delta, responseId });
    return { action: "baseline", reason: BUBBLE_SKIP.UNREASONABLE_DELTA, delta };
  }

  if (typeof isVisible === "function" && isVisible(id) && lastTriggeredAmount === amount) {
    logSkip(id, BUBBLE_SKIP.ANIMATION_ACTIVE, { amount, responseId });
    return { action: "skip", reason: BUBBLE_SKIP.ANIMATION_ACTIVE, delta };
  }

  sample.amount = amount;
  sample.baseline = amount;
  sample.contentKey = contentKey;
  return { action: "pulse", delta, amount, previousBaseline };
}

export function tickBubbleSamples({
  isReasonableDelta,
  bubbleEnabled = true,
  isVisible,
  onPulse,
  onNoChange,
}) {
  for (const [key, sample] of samples) {
    // DOM 轮询重建时先跳过本帧，等 observeBubble 重新绑定 el，不能删样本
    if (!sample.el?.isConnected) {
      continue;
    }
    if (!bubbleEnabled) {
      sample.baseline = sample.amount;
      sample.visibleUntil = 0;
      sample.el.classList.remove("is-visible", "is-animating", "is-idle", "is-rise");
      sample.el.textContent = "";
      continue;
    }
    if (isVisible(key)) continue;
    // idle / 无涨幅：不创建「暂无变化」临时气泡；只有真实上涨才 pulse
    if (sample.idleOnly) continue;
    const delta =
      (Math.round(sample.amount * 1000000) - Math.round(sample.baseline * 1000000)) / 1000000;
    if (delta > 0 && isReasonableDelta(sample.baseline, sample.amount, delta)) {
      onPulse(sample.el, delta, key);
      sample.baseline = sample.amount;
      sample.lastTriggeredAmount = sample.amount;
    } else if (delta > 0) {
      // 不合理正增量：静默抬齐 baseline，绝不因偏低读数拉低高水位
      sample.baseline = sample.amount;
    }
    // delta==0 / 无变化：不调用 onNoChange，避免每 3 秒刷「暂无变化」导致永久可见
  }
}

export { samples as bubbleSamples };
