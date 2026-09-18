/**
 * LiveAssistant 电影互动数据服务层。
 * 仅负责 HTTP；不碰票房状态机。
 */

export const DEFAULT_MOVIE_INTERACTION_BASE =
  "http://127.0.0.1:5088/diangexitong/api/movie-interaction";

export const CURSOR_STORAGE_KEY = "movie_interaction_cursor";

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
    return String(storage?.getItem?.(CURSOR_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function writeEventCursor(cursor, storage = globalThis.localStorage) {
  const value = String(cursor || "").trim();
  try {
    if (!value) storage?.removeItem?.(CURSOR_STORAGE_KEY);
    else storage?.setItem?.(CURSOR_STORAGE_KEY, value);
  } catch {
    /* ignore quota / private mode */
  }
  return value;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
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

  async function checkHealth() {
    const url = joinUrl(baseUrl, "health");
    try {
      const data = await fetchJson(url, { timeoutMs });
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
      const data = await fetchJson(url, { timeoutMs });
      const movies = Array.isArray(data?.movies)
        ? data.movies
        : Array.isArray(data)
          ? data
          : [];
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
    const cursor = after == null ? readEventCursor() : String(after || "");
    const url = joinUrl(baseUrl, "events", cursor ? { after: cursor } : undefined);
    try {
      const data = await fetchJson(url, { timeoutMs });
      const events = Array.isArray(data?.events)
        ? data.events
        : Array.isArray(data)
          ? data
          : [];
      const nextCursor =
        data?.nextCursor ??
        data?.cursor ??
        data?.after ??
        (events.length ? events[events.length - 1]?.eventId || events[events.length - 1]?.msgId : cursor) ??
        cursor;
      online = true;
      if (nextCursor && nextCursor !== cursor) writeEventCursor(nextCursor);
      logApi("info", "events-ok", {
        ok: true,
        endpoint: "events",
        count: events.length,
        after: cursor || "",
        nextCursor: nextCursor || "",
      });
      return { ok: true, online: true, events, cursor: nextCursor || cursor };
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
      return { ok: false, online: false, events: [], cursor, error };
    }
  }

  return {
    baseUrl,
    checkHealth,
    fetchScores,
    fetchEvents,
    readEventCursor,
    writeEventCursor,
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
    if (stopped || scoresInFlight) return;
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
    if (stopped || eventsInFlight) return;
    eventsInFlight = true;
    try {
      const result = await service.fetchEvents();
      setOnline(Boolean(result.online));
      if (result.ok && result.events?.length) onEvents(result.events);
    } finally {
      eventsInFlight = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void pollScores();
    void pollEvents();
    scoresTimer = setInterval(() => void pollScores(), scoresIntervalMs);
    eventsTimer = setInterval(() => void pollEvents(), eventsIntervalMs);
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
