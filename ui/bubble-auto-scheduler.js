/**
 * 直播动态气泡调度器（纯 UI）。
 * 不写票房、不碰 Store / RiseEngine / 排名 / 刷新逻辑。
 */

export const AUTO_BUBBLE_INTERVAL_MS = 5000;
export const AUTO_BUBBLE_MOVIE_COOLDOWN_MS = 10000;

/**
 * 加权随机金额（元）：
 * 70% 100～2000，25% 2000～6000，5% 6000～9000
 */
export function pickWeightedRandomYuan(rng = Math.random) {
  const r = Number(rng());
  let min;
  let max;
  if (r < 0.7) {
    min = 100;
    max = 2000;
  } else if (r < 0.95) {
    min = 2000;
    max = 6000;
  } else {
    min = 6000;
    max = 9000;
  }
  const span = max - min;
  return Math.round(min + Number(rng()) * span);
}

/** 随机气泡配色：金色或蓝色 */
export function pickRandomBubbleTone(rng = Math.random) {
  return Number(rng()) < 0.5 ? "gold" : "blue";
}

/**
 * @param {{
 *   getTopMovieIds: () => string[],
 *   playRandomBubble: (opts: { movieId: string, amountYuan: number, tone: string }) => boolean,
 *   getNow?: () => number,
 *   intervalMs?: number,
 *   cooldownMs?: number,
 *   rng?: () => number,
 * }} deps
 */
export function createBubbleAutoScheduler(deps) {
  const getTopMovieIds = deps.getTopMovieIds;
  const playRandomBubble = deps.playRandomBubble;
  let getNow = deps.getNow || (() => Date.now());
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : AUTO_BUBBLE_INTERVAL_MS;
  const cooldownMs =
    Number(deps.cooldownMs) > 0 ? Number(deps.cooldownMs) : AUTO_BUBBLE_MOVIE_COOLDOWN_MS;
  const rng = deps.rng || Math.random;

  /** @type {Map<string, number>} movieId → lastBubbleMovieTime */
  const lastBubbleMovieTime = new Map();
  let timerId = null;
  let realRisePending = false;
  let started = false;

  function setNowProvider(fn) {
    if (typeof fn === "function") getNow = fn;
  }

  function markRealRise() {
    realRisePending = true;
  }

  function consumeRealRiseFlag() {
    if (!realRisePending) return false;
    realRisePending = false;
    return true;
  }

  function peekRealRiseFlag() {
    return realRisePending;
  }

  function pickEligibleMovieId(ids) {
    const now = getNow();
    const eligible = (ids || []).filter((id) => {
      const key = String(id || "");
      if (!key) return false;
      const last = lastBubbleMovieTime.get(key) || 0;
      return now - last >= cooldownMs;
    });
    if (!eligible.length) return "";
    const idx = Math.floor(Number(rng()) * eligible.length);
    return eligible[Math.min(eligible.length - 1, Math.max(0, idx))];
  }

  function tick() {
    // 本周期内已有真实 RiseEvent：真实优先，禁止随机
    if (consumeRealRiseFlag()) {
      console.log("[BUBBLE_AUTO] type=skip_random reason=real_rise_priority");
      return { played: false, reason: "real_rise_priority" };
    }

    const ids = (getTopMovieIds() || []).map((id) => String(id)).filter(Boolean).slice(0, 5);
    if (!ids.length) {
      return { played: false, reason: "no_movies" };
    }

    const movieId = pickEligibleMovieId(ids);
    if (!movieId) {
      return { played: false, reason: "all_cooldown" };
    }

    const amountYuan = pickWeightedRandomYuan(rng);
    const tone = pickRandomBubbleTone(rng);
    const ok = Boolean(
      playRandomBubble({
        movieId,
        amountYuan,
        tone,
      }),
    );
    if (ok) {
      lastBubbleMovieTime.set(movieId, getNow());
      console.log(
        `[BUBBLE_AUTO] type=random movieId=${movieId} amount=${amountYuan}`,
      );
      return { played: true, type: "random", movieId, amountYuan, tone };
    }
    return { played: false, reason: "play_failed", movieId, amountYuan };
  }

  function start() {
    if (started) return false;
    started = true;
    timerId = setInterval(() => {
      try {
        tick();
      } catch (err) {
        console.warn("[BUBBLE_AUTO] tick error", err);
      }
    }, intervalMs);
    return true;
  }

  function stop() {
    if (timerId != null) {
      clearInterval(timerId);
      timerId = null;
    }
    started = false;
    realRisePending = false;
  }

  function isRunning() {
    return started && timerId != null;
  }

  function getLastBubbleMovieTime(movieId) {
    return lastBubbleMovieTime.get(String(movieId || "")) || 0;
  }

  function getState() {
    return {
      started,
      running: isRunning(),
      realRisePending,
      lastBubbleMovieTime: Object.fromEntries(lastBubbleMovieTime),
      intervalMs,
      cooldownMs,
    };
  }

  return {
    start,
    stop,
    tick,
    markRealRise,
    consumeRealRiseFlag,
    peekRealRiseFlag,
    pickEligibleMovieId,
    getLastBubbleMovieTime,
    getState,
    isRunning,
    setNowProvider,
  };
}
