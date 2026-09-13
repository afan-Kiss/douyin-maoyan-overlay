/** 后台 full enrich 调度（可单测） */

export const FULL_ENRICH_FAILURE_BACKOFF_MS = [30000, 60000, 120000, 300000];
export const FULL_ENRICH_GLOBAL_TIMEOUT_MS = 120000;

export const FATAL_ENRICH_ERROR_CODES = new Set([
  "login_required",
  "upstream_401",
  "upstream_403",
  "sig_capture_failed",
]);

export const ENRICH_DETAIL_API_LABELS = new Set([
  "预测票房",
  "日期票房",
  "全球票房",
  "下映时间",
]);

export function isFatalEnrichError(error) {
  const code = String(error?.code || "");
  if (FATAL_ENRICH_ERROR_CODES.has(code)) return true;
  if (error?.action === "login" || error?.action === "refresh") return true;
  if (/sig_capture|upstream_40[13]|signature|refresh/i.test(code)) return true;
  const detail = String(error?.detail || "");
  return /签名|refresh|sig_capture/i.test(detail);
}

function groupEnrichErrorsByMovie(errors) {
  const map = new Map();
  for (const error of errors || []) {
    if (!error?.movieId) continue;
    const key = String(error.movieId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(error);
  }
  return map;
}

function movieDetailFullyFailed(movieErrors) {
  if (!movieErrors?.length) return false;
  if (movieErrors.some(isFatalEnrichError)) return true;
  const failedLabels = new Set(
    movieErrors.map((error) => error.label).filter((label) => ENRICH_DETAIL_API_LABELS.has(label)),
  );
  return failedLabels.size >= ENRICH_DETAIL_API_LABELS.size;
}

/** enrich resolve 后根据 lastEnrichErrors 判断是否应记为 full enrich 失败 */
export function shouldMarkFullEnrichFailure(errors, topCount = 5) {
  if (!errors?.length) return false;
  if (errors.some(isFatalEnrichError)) return true;

  const byMovie = groupEnrichErrorsByMovie(errors);
  const fullyFailedCount = [...byMovie.values()].filter(movieDetailFullyFailed).length;
  return fullyFailedCount >= topCount;
}

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

export function resetEnrichScheduleState(state, options = {}) {
  state.lastFullEnrich = 0;
  state.lastFullEnrichAttempt = 0;
  state.enrichFailureCount = 0;
  if (options.clearInflight) {
    state.enrichingBackground = false;
  }
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
        const errors = result?.errors || [];
        if (result?.failed || shouldMarkFullEnrichFailure(errors, options.topCount ?? 5)) {
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
