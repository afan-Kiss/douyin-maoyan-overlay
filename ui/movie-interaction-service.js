/**
 * LiveAssistant 电影互动数据服务层。
 * 仅负责 HTTP；不碰票房状态机。
 */

export const DEFAULT_MOVIE_INTERACTION_BASE =
  "http://127.0.0.1:5088/diangexitong/api/movie-interaction";

export const CURSOR_STORAGE_KEY = "movie_interaction_cursor";
export const STREAM_EPOCH_STORAGE_KEY = "movie_interaction_stream_epoch";

const LOG_TAG = "[MOVIE_UI_API]";
const LOG_COOLDOWN_MS = 8000;

/** @type {Map<string, number>} */
const lastLogAt = new Map();

function canLog(key) {
  const now = Date.now();
  const prev = lastLogAt.get(key) || 0;
  if (now - prev < LOG_COOLDOWN_MS) return false;
  lastLogAt.set(key, now);
  return true;
}

function logApi(level, key, payload) {
  if (!canLog(key)) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(LOG_TAG, payload);
}

function joinUrl(base, path, query) {
  const root = String(base || DEFAULT_MOVIE_INTERACTION_BASE).replace(/\/+$/, "");
  const suffix = String(path || "").replace(/^\/+/, "");
  const url = new URL(`${root}/${suffix}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export function readEventCursor(storage = globalThis.localStorage) {
  try {
    const raw = String(storage?.getItem?.(CURSOR_STORAGE_KEY) || "").trim();
    if (!raw) return "";
    // 生产 cursor 为数字 seq；兼容历史字符串
    if (/^\d+$/.test(raw)) return raw;
    return raw;
  } catch {
    return "";
  }
}

export function writeEventCursor(cursor, storage = globalThis.localStorage) {
  const value = cursor == null || cursor === "" ? "" : String(cursor).trim();
  try {
    if (!value) storage?.removeItem?.(CURSOR_STORAGE_KEY);
    else storage?.setItem?.(CURSOR_STORAGE_KEY, value);
  } catch {
    /* ignore quota / private mode */
  }
  return value;
}

export function readStreamEpoch(storage = globalThis.localStorage) {
  try {
    return String(storage?.getItem?.(STREAM_EPOCH_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function writeStreamEpoch(epoch, storage = globalThis.localStorage) {
  const value = epoch == null ? "" : String(epoch).trim();
  try {
    if (!value) storage?.removeItem?.(STREAM_EPOCH_STORAGE_KEY);
    else storage?.setItem?.(STREAM_EPOCH_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}

export function commitEventCursor(cursor, storage = globalThis.localStorage) {
  return writeEventCursor(cursor, storage);
}

/** movieId + movieName + rank + normalized aliases 签名，用于避免无脑 POST */
export function buildCatalogSignature(movies) {
  const list = (movies || [])
    .map((m) => {
      const movieId = String(m.movieId ?? m.id ?? "").trim();
      const movieName = String(m.movieName ?? m.name ?? "").trim();
      const aliases = normalizeAliases(m.aliases, movieName)
        .slice()
        .sort((a, b) => a.localeCompare(b, "zh"));
      return {
        movieId,
        movieName,
        rank: Number(m.rank) || 0,
        aliases,
      };
    })
    .filter((m) => m.movieId)
    .sort((a, b) => a.rank - b.rank || a.movieId.localeCompare(b.movieId));
  return list
    .map((m) => `${m.movieId}|${m.movieName}|${m.rank}|${m.aliases.join(",")}`)
    .join(";");
}

export function normalizeAliases(aliases, movieName = "") {
  const title = String(movieName || "").trim();
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(aliases) ? aliases : []) {
    const alias = String(raw || "").trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    if (title && alias.toLowerCase() === title.toLowerCase()) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * 仅使用调用方明确给出的 aliases（或本地 media 目录匹配到的维护别名）。
 * 不自动猜简称、不做模糊生成。
 */
export function toCatalogPayload(movies, mediaCatalog = null) {
  const catalog = Array.isArray(mediaCatalog) ? mediaCatalog : null;
  return (movies || [])
    .map((m, index) => {
      const movieId = String(m.movieId ?? m.id ?? "").trim();
      const movieName = String(m.movieName ?? m.name ?? "").trim();
      let aliases = Array.isArray(m.aliases) ? [...m.aliases] : [];
      if ((!aliases.length || catalog) && catalog?.length && movieName) {
        const media =
          catalog.find(
            (item) => String(item?.name || "").trim().toLowerCase() === movieName.toLowerCase(),
          ) || null;
        if (media?.aliases?.length) {
          aliases = [...aliases, ...media.aliases];
        }
      }
      return {
        movieId,
        movieName,
        aliases: normalizeAliases(aliases, movieName),
        rank: Number(m.rank) || index + 1,
      };
    })
    .filter((m) => m.movieId);
}

/** 好看/不好看人数：非法值 → 0，禁止负数 */
export function normalizeUserCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** 标准化 /scores 单条电影记录 */
export function normalizeScoreMovie(raw) {
  if (!raw || typeof raw !== "object") return null;
  const movieId = String(raw.movieId ?? raw.id ?? "").trim();
  if (!movieId) return null;
  const scoreNum = Number(raw.score);
  return {
    movieId,
    movieName: String(raw.movieName ?? raw.name ?? "").trim(),
    score: Number.isFinite(scoreNum) ? scoreNum : 0,
    goodUserCount: normalizeUserCount(raw.goodUserCount),
    badUserCount: normalizeUserCount(raw.badUserCount),
  };
}

export function normalizeScoreMovies(list) {
  return (Array.isArray(list) ? list : []).map(normalizeScoreMovie).filter(Boolean);
}

/**
 * 将 LiveAssistant / 扁平 mock 事件统一为 UI 消费结构。
 * 生产优先读 event.data。
 */
export function normalizeInteractionEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").toLowerCase();
  const data = raw.data && typeof raw.data === "object" ? raw.data : null;
  const src = data || raw;
  const seq = raw.seq ?? src.seq ?? null;
  const createdAt = raw.createdAt ?? src.createdAt ?? "";
  const platform = src.platform ?? raw.platform ?? "";
  const roomId = src.roomId ?? raw.roomId ?? "";

  if (type === "danmaku" || type === "comment") {
    const msgId = String(src.msgId || src.eventId || raw.msgId || raw.eventId || seq || "").trim();
    return {
      seq,
      type: "danmaku",
      msgId: msgId || `dm-${seq ?? Date.now()}`,
      userId: src.userId ?? raw.userId ?? "",
      nickname: src.nickname ?? raw.nickname ?? "观众",
      content: src.content ?? raw.content ?? "",
      createdAt,
      platform,
      roomId,
    };
  }

  if (type === "movie_score" || type === "score") {
    const eventId = String(src.eventId || raw.eventId || seq || "").trim();
    return {
      seq,
      type: "movie_score",
      eventId: eventId || `score-${seq ?? Date.now()}`,
      userId: src.userId ?? raw.userId ?? "",
      nickname: src.nickname ?? raw.nickname ?? "观众",
      movieId: String(src.movieId ?? raw.movieId ?? "").trim(),
      movieName: String(src.movieName ?? raw.movieName ?? "").trim(),
      action: src.action ?? raw.action ?? "",
      scoreDelta: Number(src.scoreDelta ?? raw.scoreDelta) || 0,
      totalScore: Number(src.totalScore ?? raw.totalScore),
      createdAt,
      platform,
      roomId,
    };
  }

  return null;
}

export function normalizeEventsResponse(data, fallbackAfter = "") {
  const rawEvents = Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data)
      ? data
      : [];
  const events = rawEvents.map(normalizeInteractionEvent).filter(Boolean);

  // 生产：服务器数字 cursor / 最大 seq
  let cursor = data?.cursor;
  if (cursor == null || cursor === "") {
    const seqs = events.map((e) => Number(e.seq)).filter((n) => Number.isFinite(n));
    if (seqs.length) cursor = Math.max(...seqs);
  }
  if (cursor == null || cursor === "") {
    cursor = fallbackAfter || "";
  }

  const serverMaxSeq =
    data?.serverMaxSeq != null && Number.isFinite(Number(data.serverMaxSeq))
      ? Number(data.serverMaxSeq)
      : null;
  const reset = data?.reset === true;
  const streamEpoch =
    data?.streamEpoch != null && String(data.streamEpoch).trim()
      ? String(data.streamEpoch).trim()
      : "";

  return {
    ok: data?.ok !== false,
    after: data?.after ?? fallbackAfter ?? 0,
    cursor,
    events,
    reset,
    serverMaxSeq,
    streamEpoch,
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.offline = res.status === 0 || res.status >= 500;
      throw err;
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      const err = new Error("parse_failed");
      err.cause = parseErr;
      err.parseFailed = true;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createMovieInteractionService(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_MOVIE_INTERACTION_BASE).replace(/\/+$/, "");
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  let online = null;
  let lastCatalogSignature = "";

  async function checkHealth() {
    const url = joinUrl(baseUrl, "health");
    try {
      const data = await requestJson(url, { timeoutMs });
      online = true;
      logApi("info", "health-ok", { ok: true, endpoint: "health" });
      return { ok: true, online: true, data };
    } catch (error) {
      online = false;
      logApi("warn", "health-fail", {
        ok: false,
        endpoint: "health",
        error: String(error?.message || error),
      });
      return { ok: false, online: false, error };
    }
  }

  async function fetchScores() {
    const url = joinUrl(baseUrl, "scores");
    try {
      const data = await requestJson(url, { timeoutMs });
      const rawList = Array.isArray(data?.movies)
        ? data.movies
        : Array.isArray(data)
          ? data
          : [];
      const movies = normalizeScoreMovies(rawList);
      online = true;
      logApi("info", "scores-ok", { ok: true, endpoint: "scores", count: movies.length });
      return { ok: true, online: true, movies };
    } catch (error) {
      if (error?.parseFailed) {
        logApi("error", "scores-parse", { ok: false, endpoint: "scores", error: "parse_failed" });
      } else {
        online = false;
        logApi("warn", "scores-fail", {
          ok: false,
          endpoint: "scores",
          offline: true,
          error: String(error?.message || error),
        });
      }
      return { ok: false, online: false, movies: [], error };
    }
  }

  async function fetchEvents(after) {
    let stored = after == null ? readEventCursor() : String(after ?? "").trim();
    const query = {};
    if (stored !== "") query.after = stored;
    const url = joinUrl(baseUrl, "events", query);
    try {
      const data = await requestJson(url, { timeoutMs });
      let normalized = normalizeEventsResponse(data, stored);
      let epochChanged = false;

      const prevEpoch = readStreamEpoch();
      if (
        prevEpoch &&
        normalized.streamEpoch &&
        prevEpoch !== normalized.streamEpoch
      ) {
        epochChanged = true;
        console.warn("MOVIE_EVENT_CURSOR_RESET", {
          reason: "stream_epoch_changed",
          oldEpoch: prevEpoch,
          newEpoch: normalized.streamEpoch,
          oldCursor: stored,
        });
        // 丢弃本批 events（可能是旧 cursor 对上新库的错位窗口）
        writeEventCursor("");
        writeStreamEpoch(normalized.streamEpoch);
        stored = "";
      }

      // 服务端流重置 / epoch 变更：清本地 cursor，再拉一次 from 0（防死循环只重试一次）
      if (normalized.reset || epochChanged) {
        if (normalized.reset && !epochChanged) {
          console.warn("MOVIE_EVENT_CURSOR_RESET", {
            after: stored || after,
            serverMaxSeq: normalized.serverMaxSeq,
            streamEpoch: normalized.streamEpoch,
          });
          writeEventCursor("");
          if (normalized.streamEpoch) writeStreamEpoch(normalized.streamEpoch);
          stored = "";
        }
        const retryUrl = joinUrl(baseUrl, "events", {});
        const retryData = await requestJson(retryUrl, { timeoutMs });
        normalized = normalizeEventsResponse(retryData, "0");
        // 若仍 reset，返回空，不要循环；epoch 再变也不二次重拉
        if (normalized.reset) {
          online = true;
          if (normalized.streamEpoch) writeStreamEpoch(normalized.streamEpoch);
          return {
            ok: true,
            online: true,
            events: [],
            cursor: "0",
            candidateCursor: "0",
            after: 0,
            reset: true,
            serverMaxSeq: normalized.serverMaxSeq,
            streamEpoch: normalized.streamEpoch,
          };
        }
        if (normalized.streamEpoch) writeStreamEpoch(normalized.streamEpoch);
      } else if (normalized.streamEpoch && !prevEpoch) {
        writeStreamEpoch(normalized.streamEpoch);
      }

      online = true;
      const candidateCursor =
        normalized.cursor == null || normalized.cursor === ""
          ? stored
          : String(normalized.cursor);
      logApi("info", "events-ok", {
        ok: true,
        endpoint: "events",
        count: normalized.events.length,
        after: stored || "0",
        candidateCursor,
        reset: Boolean(normalized.reset),
      });
      // 不在此处永久提交 cursor；由 poller 在 onEvents 成功后再 commit
      return {
        ok: true,
        online: true,
        events: normalized.events,
        cursor: candidateCursor,
        candidateCursor,
        after: normalized.after,
        reset: Boolean(normalized.reset),
        serverMaxSeq: normalized.serverMaxSeq,
        streamEpoch: normalized.streamEpoch,
      };
    } catch (error) {
      if (error?.parseFailed) {
        logApi("error", "events-parse", { ok: false, endpoint: "events", error: "parse_failed" });
      } else {
        online = false;
        logApi("warn", "events-fail", {
          ok: false,
          endpoint: "events",
          offline: true,
          error: String(error?.message || error),
        });
      }
      return { ok: false, online: false, events: [], cursor: stored, candidateCursor: stored, error };
    }
  }

  /**
   * POST /movies — 同步猫眼真实 TOP10 目录。
   * 相同签名跳过；失败不影响票房。
   */
  async function updateMovies(movies, mediaCatalog = null) {
    const payloadMovies = toCatalogPayload(movies, mediaCatalog);
    if (!payloadMovies.length) {
      return { ok: false, skipped: true, reason: "empty" };
    }
    const signature = buildCatalogSignature(payloadMovies);
    if (signature && signature === lastCatalogSignature) {
      logApi("info", "movies-skip", { ok: true, endpoint: "movies", skipped: true, reason: "unchanged" });
      return { ok: true, skipped: true, reason: "unchanged", signature };
    }

    const url = joinUrl(baseUrl, "movies");
    try {
      const data = await requestJson(url, {
        method: "POST",
        timeoutMs,
        body: { movies: payloadMovies },
      });
      lastCatalogSignature = signature;
      online = true;
      logApi("info", "movies-ok", {
        ok: true,
        endpoint: "movies",
        count: payloadMovies.length,
        signature,
      });
      return { ok: true, skipped: false, data, signature, movies: payloadMovies };
    } catch (error) {
      // 目录同步失败绝不能影响票房；仅记日志
      if (error?.parseFailed) {
        logApi("error", "movies-parse", { ok: false, endpoint: "movies", error: "parse_failed" });
      } else {
        online = false;
        logApi("warn", "movies-fail", {
          ok: false,
          endpoint: "movies",
          offline: true,
          error: String(error?.message || error),
        });
      }
      return { ok: false, skipped: false, error, signature };
    }
  }

  /** 别名：与 updateMovies 相同 */
  async function publishCatalog(movies, mediaCatalog = null) {
    return updateMovies(movies, mediaCatalog);
  }

  function getLastCatalogSignature() {
    return lastCatalogSignature;
  }

  function resetCatalogSignature() {
    lastCatalogSignature = "";
  }

  return {
    baseUrl,
    checkHealth,
    fetchScores,
    fetchEvents,
    updateMovies,
    publishCatalog,
    readEventCursor,
    writeEventCursor,
    commitEventCursor,
    buildCatalogSignature,
    getLastCatalogSignature,
    resetCatalogSignature,
    isOnline: () => online,
  };
}

export function createMovieInteractionPoller(deps = {}) {
  const service = deps.service || createMovieInteractionService(deps);
  const scoresIntervalMs = Number(deps.scoresIntervalMs) > 0 ? Number(deps.scoresIntervalMs) : 5000;
  const eventsIntervalMs = Number(deps.eventsIntervalMs) > 0 ? Number(deps.eventsIntervalMs) : 2000;
  const onScores = typeof deps.onScores === "function" ? deps.onScores : () => {};
  const onEvents = typeof deps.onEvents === "function" ? deps.onEvents : () => {};
  const onStatus = typeof deps.onStatus === "function" ? deps.onStatus : () => {};

  let scoresTimer = null;
  let eventsTimer = null;
  let scoresInFlight = false;
  let eventsInFlight = false;
  let stopped = true;
  let lastOnline = null;

  function setOnline(flag) {
    if (lastOnline === flag) return;
    lastOnline = flag;
    onStatus({ online: flag, message: flag ? "" : "互动服务离线" });
  }

  async function pollScores() {
    if (scoresInFlight) return;
    scoresInFlight = true;
    try {
      const result = await service.fetchScores();
      setOnline(Boolean(result.online));
      if (result.ok) onScores(result.movies || []);
    } finally {
      scoresInFlight = false;
    }
  }

  async function pollEvents() {
    // 允许手动调用（测试/补拉）；stopped 只阻止 interval 调度
    if (eventsInFlight) return;
    eventsInFlight = true;
    try {
      const result = await service.fetchEvents();
      setOnline(Boolean(result.online));
      if (!result.ok) return;
      const events = result.events || [];
      const candidate =
        result.candidateCursor != null ? result.candidateCursor : result.cursor;
      if (events.length) {
        await Promise.resolve(onEvents(events));
      }
      // 处理成功（含空事件）后再提交 cursor；onEvents 抛错则不推进
      if (candidate != null && candidate !== "") {
        const prev = service.readEventCursor();
        if (String(candidate) !== String(prev)) {
          (service.commitEventCursor || service.writeEventCursor)(candidate);
        }
      }
    } catch (err) {
      console.warn("[MOVIE_UI_API]", { ok: false, endpoint: "events", error: String(err?.message || err) });
    } finally {
      eventsInFlight = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void pollScores();
    void pollEvents();
    scoresTimer = setInterval(() => {
      if (!stopped) void pollScores();
    }, scoresIntervalMs);
    eventsTimer = setInterval(() => {
      if (!stopped) void pollEvents();
    }, eventsIntervalMs);
  }

  function stop() {
    stopped = true;
    if (scoresTimer) clearInterval(scoresTimer);
    if (eventsTimer) clearInterval(eventsTimer);
    scoresTimer = null;
    eventsTimer = null;
  }

  return {
    start,
    stop,
    pollScores,
    pollEvents,
    service,
    getOnline: () => lastOnline,
  };
}
