/** 后台 full enrich 调度（可单测） */

export const FULL_ENRICH_FAILURE_BACKOFF_MS = [30000, 60000, 120000, 300000];
export const FULL_ENRICH_GLOBAL_TIMEOUT_MS = 120000;

export function createEnrichScheduleState() {
  return {
    lastFullEnrich: 0,
    lastFullEnrichAttempt: 0,
    enrichFailureCount: 0,
    enrichingBackground: false,
    pollCount: 0,
  };
}

export function getFullEnrichRetryDelayMs(failureCount) {
  const idx = Math.min(
    Math.max(failureCount, 1) - 1,
    FULL_ENRICH_FAILURE_BACKOFF_MS.length - 1,
  );
  return FULL_ENRICH_FAILURE_BACKOFF_MS[idx];
}

export function shouldScheduleFullEnrich(now, state, fullIntervalMs = 60000) {
  if (state.enrichingBackground) return false;
  if (state.pollCount === 1) return true;

  const lastAttempt = state.lastFullEnrichAttempt || 0;
  const sinceAttempt = now - lastAttempt;
  if (sinceAttempt < 0) return false;

  if (state.enrichFailureCount > 0) {
    return sinceAttempt >= getFullEnrichRetryDelayMs(state.enrichFailureCount);
  }

  return sinceAttempt >= fullIntervalMs;
}

export function markFullEnrichAttempt(state, now = Date.now()) {
  state.lastFullEnrichAttempt = now;
}

export function markFullEnrichSuccess(state, now = Date.now()) {
  state.lastFullEnrich = now;
  state.enrichFailureCount = 0;
}

export function markFullEnrichFailure(state) {
  state.enrichFailureCount = (state.enrichFailureCount || 0) + 1;
}

export function resetEnrichScheduleState(state) {
  state.lastFullEnrich = 0;
  state.lastFullEnrichAttempt = 0;
  state.enrichFailureCount = 0;
}

/**
 * 轻量模拟器：复用真实 shouldSchedule 逻辑，便于 timeout / 失败退避测试。
 */
export function createEnrichScheduleSimulator(options = {}) {
  const state = createEnrichScheduleState();
  const fullIntervalMs = options.fullIntervalMs ?? 60000;
  let fullEnrichCount = 0;
  let maxConcurrentFullEnrich = 0;
  let concurrentFullEnrich = 0;
  const inflight = [];

  async function onPoll(now) {
    state.pollCount += 1;
    if (!shouldScheduleFullEnrich(now, state, fullIntervalMs)) {
      return null;
    }

    markFullEnrichAttempt(state, now);
    state.enrichingBackground = true;
    fullEnrichCount += 1;
    concurrentFullEnrich += 1;
    maxConcurrentFullEnrich = Math.max(maxConcurrentFullEnrich, concurrentFullEnrich);

    const controller = new AbortController();
    const timeoutMs = options.globalTimeoutMs ?? FULL_ENRICH_GLOBAL_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const task = (async () => {
      try {
        const result = await options.runEnrich?.({ state, now, signal: controller.signal });
        if (result?.failed) {
          markFullEnrichFailure(state);
        } else {
          markFullEnrichSuccess(state, now);
        }
      } catch {
        markFullEnrichFailure(state);
      } finally {
        clearTimeout(timeoutId);
        concurrentFullEnrich -= 1;
        state.enrichingBackground = false;
      }
    })();

    inflight.push(task);
    return task;
  }

  async function waitSettled() {
    await Promise.all(inflight);
  }

  return {
    state,
    onPoll,
    waitSettled,
    getStats: () => ({
      fullEnrichCount,
      maxConcurrentFullEnrich,
      enrichingBackground: state.enrichingBackground,
    }),
  };
}
