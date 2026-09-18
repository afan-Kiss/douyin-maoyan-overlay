/**
 * 缺失海报解析：缓存优先，Google 失败后再 Bing。
 * 按 provider 记录失败冷却；只有两边都失败才整体 fallback。
 * 必须由调用方传入可写 cacheDir（Electron userData），禁止猜 asar 路径。
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const INDEX_NAME = "poster-cache.json";
const FAIL_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_CONCURRENCY = 1;

let chain = Promise.resolve();

function normalizeMovieName(name) {
  return String(name || "")
    .replace(/《|》/g, "")
    .replace(/[\s\u00A0\u3000]+/g, "")
    .replace(/[：:·•]/g, "")
    .replace(/[（）()【】\[\]]/g, "")
    .replace(/[，,。.!！?？;；]/g, "")
    .trim()
    .toLowerCase();
}

function requireCacheDir(options = {}) {
  const raw = options.cacheDir || options.cacheRoot;
  if (!raw) {
    throw new Error("poster-resolver requires options.cacheDir (writable userData path)");
  }
  const cacheDir = path.resolve(String(raw));
  if (/app\.asar([\\/]|$)/i.test(cacheDir)) {
    throw new Error(`poster-resolver cacheDir must not be inside app.asar: ${cacheDir}`);
  }
  return cacheDir;
}

function cachePaths(cacheDir) {
  return { dir: cacheDir, indexPath: path.join(cacheDir, INDEX_NAME) };
}

function toFileUrl(absPath) {
  return pathToFileURL(absPath).href;
}

function readIndex(cacheDir) {
  const { indexPath } = cachePaths(cacheDir);
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    return data && typeof data === "object" ? data : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeIndex(cacheDir, index) {
  const { dir, indexPath } = cachePaths(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

function cacheKey(movie) {
  const id = String(movie?.movieId || "").trim();
  if (id) return `id:${id}`;
  const name = normalizeMovieName(movie?.movieName || movie?.name || "");
  return name ? `name:${name}` : "";
}

function safeFileBase(movie, key) {
  const id = String(movie?.movieId || "").trim();
  const raw = id || key.replace(/^name:/, "") || "poster";
  return raw.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80) || "poster";
}

function readImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { gif: true, width: 0, height: 0, type: "gif" };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      type: "png",
    };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          type: "jpeg",
        };
      }
      if (!len || len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        type: "webp",
      };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        type: "webp",
      };
    }
  }
  return null;
}

function isAcceptablePoster(info) {
  if (!info || info.gif) return false;
  const width = Number(info.width);
  const height = Number(info.height);
  if (!(width >= 250 && height >= 350)) return false;
  const ratio = width / height;
  // 竖版海报；排除横版剧照
  if (ratio < 0.55 || ratio > 0.8) return false;
  return true;
}

function isBannedCandidateUrl(url) {
  const text = String(url || "").toLowerCase();
  return /gstatic|googleusercontent|google\.com|ggpht|favicon|logo|sprite|qrcode|qr_|avatar|profile|headshot|icon[_-]?|\.gif(\?|$)/i.test(
    text,
  );
}

function extOf(type) {
  if (type === "png") return "png";
  if (type === "webp") return "webp";
  return "jpg";
}

function resolveAbsPath(entry, cacheDir) {
  if (!entry?.localPath) return "";
  if (path.isAbsolute(entry.localPath)) return entry.localPath;
  return path.join(cacheDir, entry.localPath);
}

function hitFromEntry(entry, cacheDir) {
  if (!entry || entry.status !== "ok" || !entry.localPath) return null;
  const abs = resolveAbsPath(entry, cacheDir);
  if (!abs || !fs.existsSync(abs)) return null;
  const fileUrl = entry.fileUrl && String(entry.fileUrl).startsWith("file:")
    ? entry.fileUrl
    : toFileUrl(abs);
  return {
    ...entry,
    status: "ok",
    localPath: abs,
    fileUrl,
    uiPath: fileUrl,
    fromCache: true,
    provider: entry.provider === "bing" ? "bing" : "google",
    posterSource: `${entry.provider === "bing" ? "bing" : "google"}-cache`,
  };
}

function normalizeFailReason(code) {
  try {
    return require("./poster-search").mapReason(code);
  } catch {
    const lower = String(code || "network_error").toLowerCase();
    return lower || "network_error";
  }
}

function isChromeMissingReason(reason) {
  return normalizeFailReason(reason) === "chrome_missing";
}

function chromeAvailableNow() {
  try {
    const { findChrome } = require("./poster-search");
    return Boolean(findChrome());
  } catch {
    return false;
  }
}

/**
 * 仅清除 status=fail 的冷却条目；成功海报缓存不动。
 * @returns {{ cleared: number, keys: string[] }}
 */
function clearPosterFailureCooldown(movieIdOrOptions, maybeOptions) {
  let movieId = "";
  let options = {};
  if (movieIdOrOptions && typeof movieIdOrOptions === "object" && !Array.isArray(movieIdOrOptions)) {
    options = movieIdOrOptions;
    movieId = String(options.movieId || "").trim();
  } else {
    movieId = String(movieIdOrOptions || "").trim();
    options = maybeOptions || {};
  }
  const movieName = String(options.movieName || "").trim();
  const cacheDir = requireCacheDir(options);
  const index = readIndex(cacheDir);
  index.entries = index.entries || {};
  const cleared = [];
  for (const [key, entry] of Object.entries(index.entries)) {
    if (!entry || (entry.status !== "fail" && entry.status !== "partial")) continue;
    if (movieId || movieName) {
      const idMatch = Boolean(movieId) && (String(entry.movieId || "") === movieId || key === `id:${movieId}`);
      const nameMatch = Boolean(movieName) && normalizeMovieName(entry.movieName) === normalizeMovieName(movieName);
      if (!idMatch && !nameMatch) continue;
    }
    delete index.entries[key];
    cleared.push(key);
  }
  if (cleared.length) writeIndex(cacheDir, index);
  return { cleared: cleared.length, keys: cleared, cacheDir };
}

function shouldBypassFailCooldown(cached) {
  if (!cached || cached.status !== "fail") return false;
  if (!(Number(cached.failUntil) > Date.now())) return true;
  // chrome_missing 是本机配置问题：Chrome 已可用则立即重试，不吃 30 分钟冷却
  if (isChromeMissingReason(cached.reason) && chromeAvailableNow()) return true;
  return false;
}

async function resolveMissingPosters(movies, options = {}) {
  const run = chain.then(() => resolveInner(movies, options));
  chain = run.catch(() => {});
  return run;
}

function sourceTag(provider, fromCache) {
  const name = provider === "bing" ? "bing" : "google";
  return fromCache ? `${name}-cache` : `${name}-new`;
}

function emitPosterLog(fields) {
  const { logPosterSearch } = require("./poster-search");
  const cacheHit = fields.cacheHit === true ? "true" : fields.cacheHit === false ? "false" : "";
  logPosterSearch({
    movieId: fields.movieId || "",
    movieName: fields.movieName || "",
    movie: fields.movieName || "",
    provider: fields.provider || "",
    query: fields.query || "",
    candidateCount: fields.candidateCount === undefined || fields.candidateCount === null ? "" : fields.candidateCount,
    reason: fields.reason || "",
    selectedWidth: fields.selectedWidth || "",
    selectedHeight: fields.selectedHeight || "",
    cacheHit,
  });
}

function selectProviders(options) {
  const google =
    options.searchImpl ||
    ((name, opts) => require("./poster-search").searchOfficialPoster(name, opts));
  let bing = null;
  if (Object.prototype.hasOwnProperty.call(options, "bingSearchImpl")) {
    bing = typeof options.bingSearchImpl === "function" ? options.bingSearchImpl : null;
  } else if (!options.searchImpl) {
    bing = (name, opts) => require("./poster-search-bing").searchBingPoster(name, opts);
  }
  return { google, bing };
}

function isLegacyFail(cached) {
  return Boolean(cached && cached.status === "fail" && !cached.googleFailUntil && !cached.bingFailUntil);
}

function isProviderCooling(cached, provider, now = Date.now()) {
  if (!cached) return false;
  const until = Number(provider === "bing" ? cached.bingFailUntil : cached.googleFailUntil);
  const reason = provider === "bing" ? cached.bingReason : cached.googleReason;
  if (until > now) {
    if (normalizeFailReason(reason) === "chrome_missing" && chromeAvailableNow()) return false;
    return true;
  }
  if (isLegacyFail(cached) && Number(cached.failUntil) > now) {
    if (shouldBypassFailCooldown(cached)) return false;
    return true;
  }
  return false;
}

function hardStopReason(reason) {
  const normalized = normalizeFailReason(reason);
  return normalized === "captcha" || normalized === "403" || normalized === "network_error";
}

async function attemptProvider(searchFn, movieName, movieId, options) {
  let found;
  try {
    found = await searchFn(movieName, { signal: options.signal, movieId });
  } catch (error) {
    return {
      ok: false,
      reason: normalizeFailReason(error?.code || error?.message),
      code: String(error?.code || ""),
    };
  }
  if (!found || found.stopped) {
    return {
      ok: false,
      reason: normalizeFailReason(found?.code || found?.reason || "network_error"),
      hardStop: Boolean(found?.stopped),
    };
  }
  if (found.query && movieName && !String(found.query).includes(movieName)) {
    return { ok: false, reason: "query-mismatch" };
  }
  if (found.sourceUrl && isBannedCandidateUrl(found.sourceUrl)) {
    return { ok: false, reason: "banned-url" };
  }
  if (!found.buffer || !isAcceptablePoster(found)) {
    return { ok: false, reason: normalizeFailReason(found.reason || "quality_rejected") };
  }
  return { ok: true, found };
}

function rememberProviderFail(index, key, movie, provider, reason) {
  const prev =
    index.entries[key] && index.entries[key].status !== "ok"
      ? { ...index.entries[key] }
      : {
          movieId: String(movie?.movieId || ""),
          movieName: String(movie?.movieName || movie?.name || ""),
        };
  const until = Date.now() + FAIL_COOLDOWN_MS;
  const normalized = normalizeFailReason(reason);
  if (provider === "bing") {
    prev.bingFailUntil = until;
    prev.bingReason = normalized;
  } else {
    prev.googleFailUntil = until;
    prev.googleReason = normalized;
  }
  prev.reason = normalized;
  if (prev.status !== "ok") prev.status = "partial";
  prev.resolvedAt = new Date().toISOString();
  index.entries[key] = prev;
  return prev;
}

function labelAttempt(attempt) {
  if (!attempt) return "not_called";
  if (attempt.ok) return "success";
  if (attempt.skipped) return attempt.reason || "not_called";
  return attempt.reason || "network_error";
}

function baseResult(movieId, movieName, key, cacheDir, extra) {
  return {
    movieId,
    movieName,
    cacheKey: key,
    cacheDir,
    cacheHit: false,
    posterSource: "fallback",
    provider: "",
    finalProvider: "",
    googleResult: "not_called",
    bingResult: "not_called",
    ...extra,
  };
}

async function resolveInner(movies, options = {}) {
  const cacheDir = requireCacheDir(options);
  if (options.posterRetry || options.clearFailCooldown) {
    clearPosterFailureCooldown({
      cacheDir,
      movieId: options.clearMovieId || "",
      movieName: options.clearMovieName || "",
    });
  }
  const list = Array.isArray(movies) ? movies.slice(0, 10) : [];
  const index = readIndex(cacheDir);
  index.entries = index.entries || {};
  const results = [];
  let remoteStopped = false;
  let skipGoogleRound = false;
  let skipBingRound = false;
  let googleRoundReason = "";
  let bingRoundReason = "";
  const { google: googleSearch, bing: bingSearch } = selectProviders(options);
  const bingAvailable = typeof bingSearch === "function";
  void MAX_CONCURRENCY;

  for (const movie of list) {
    const key = cacheKey(movie);
    const movieId = String(movie?.movieId || "");
    const movieName = String(movie?.movieName || movie?.name || "");
    if (!key) {
      results.push({ movieId, movieName, status: "skip", reason: "no-key" });
      continue;
    }
    const cached = index.entries[key];
    const hit = hitFromEntry(cached, cacheDir);
    if (hit) {
      emitPosterLog({
        movieId,
        movieName,
        provider: hit.provider,
        cacheHit: true,
        candidateCount: 0,
        selectedWidth: hit.width,
        selectedHeight: hit.height,
      });
      results.push({
        ...hit,
        movieId,
        movieName,
        cacheKey: key,
        cacheDir,
        cacheHit: true,
        googleResult: "cache",
        bingResult: "not_called",
        finalProvider: hit.provider,
      });
      continue;
    }
    const now = Date.now();
    const googleCooling = isProviderCooling(cached, "google", now);
    const bingCooling = isProviderCooling(cached, "bing", now);
    const bothCooling = googleCooling && (bingCooling || !bingAvailable);
    const legacyBlocked =
      isLegacyFail(cached) && Number(cached.failUntil) > now && !shouldBypassFailCooldown(cached);
    if (legacyBlocked || (bothCooling && cached && cached.status !== "ok")) {
      const reason = normalizeFailReason(cached?.reason || cached?.googleReason || cached?.bingReason || "cooldown");
      emitPosterLog({
        movieId,
        movieName,
        provider: "",
        cacheHit: false,
        reason,
        candidateCount: 0,
      });
      results.push(
        baseResult(movieId, movieName, key, cacheDir, {
          status: "cooldown",
          failUntil: cached.failUntil || cached.googleFailUntil || cached.bingFailUntil,
          reason,
          googleResult: googleCooling || legacyBlocked ? "cooldown" : "not_called",
          bingResult: !bingAvailable || bingCooling || legacyBlocked ? "cooldown" : "not_called",
        }),
      );
      continue;
    }
    if (remoteStopped) {
      results.push(
        baseResult(movieId, movieName, key, cacheDir, {
          status: "skipped",
          reason: "round-stopped",
        }),
      );
      continue;
    }

    let googleAttempt = { ok: false, skipped: true, reason: "not_called" };
    let bingAttempt = { ok: false, skipped: true, reason: "not_called" };
    const runGoogle = !googleCooling && !skipGoogleRound;
    if (runGoogle) {
      googleAttempt = await attemptProvider(googleSearch, movieName, movieId, options);
      if (!googleAttempt.ok) {
        rememberProviderFail(index, key, movie, "google", googleAttempt.reason);
        writeIndex(cacheDir, index);
        emitPosterLog({
          movieId,
          movieName,
          provider: "google",
          cacheHit: false,
          reason: googleAttempt.reason,
          query: googleAttempt.found?.query || "",
          candidateCount: googleAttempt.found?.candidateCount || 0,
        });
        if (googleAttempt.reason === "captcha" || googleAttempt.reason === "403") {
          skipGoogleRound = true;
          googleRoundReason = googleAttempt.reason;
        }
        if (
          !bingAvailable &&
          (googleAttempt.hardStop || (googleAttempt.code && hardStopReason(googleAttempt.reason)))
        ) {
          remoteStopped = true;
        }
      }
    } else {
      googleAttempt = {
        ok: false,
        skipped: true,
        reason: googleCooling ? "cooldown" : googleRoundReason || "skipped",
      };
    }

    if (googleAttempt.ok) {
      const row = commitPoster(index, cacheDir, movie, key, googleAttempt.found, "google");
      row.googleResult = "success";
      row.bingResult = "not_called";
      emitPosterLog({
        movieId,
        movieName,
        provider: "google",
        cacheHit: false,
        query: googleAttempt.found.query,
        candidateCount: googleAttempt.found.candidateCount,
        selectedWidth: googleAttempt.found.width,
        selectedHeight: googleAttempt.found.height,
      });
      results.push(row);
      continue;
    }

    const runBing = bingAvailable && !bingCooling && !skipBingRound;
    if (runBing) {
      bingAttempt = await attemptProvider(bingSearch, movieName, movieId, options);
      if (!bingAttempt.ok) {
        rememberProviderFail(index, key, movie, "bing", bingAttempt.reason);
        writeIndex(cacheDir, index);
        emitPosterLog({
          movieId,
          movieName,
          provider: "bing",
          cacheHit: false,
          reason: bingAttempt.reason,
          query: bingAttempt.found?.query || "",
          candidateCount: bingAttempt.found?.candidateCount || 0,
        });
        if (bingAttempt.reason === "captcha" || bingAttempt.reason === "403") {
          skipBingRound = true;
          bingRoundReason = bingAttempt.reason;
        }
      }
    } else if (!bingAvailable) {
      bingAttempt = { ok: false, skipped: true, reason: "not_called" };
    } else {
      bingAttempt = {
        ok: false,
        skipped: true,
        reason: bingCooling ? "cooldown" : bingRoundReason || "skipped",
      };
    }

    if (bingAttempt.ok) {
      const row = commitPoster(index, cacheDir, movie, key, bingAttempt.found, "bing");
      row.googleResult = labelAttempt(googleAttempt);
      row.bingResult = "success";
      emitPosterLog({
        movieId,
        movieName,
        provider: "bing",
        cacheHit: false,
        query: bingAttempt.found.query,
        candidateCount: bingAttempt.found.candidateCount,
        selectedWidth: bingAttempt.found.width,
        selectedHeight: bingAttempt.found.height,
      });
      results.push(row);
      continue;
    }

    const finalReason = !bingAttempt.skipped ? bingAttempt.reason : googleAttempt.reason;
    markFail(index, key, movie, finalReason, cacheDir);
    const thrown = Boolean(googleAttempt.code) || Boolean(bingAttempt.code);
    let resultStatus = "fallback";
    if (!bingAvailable && (thrown || googleAttempt.hardStop)) resultStatus = "fail";
    if (bingAvailable && skipGoogleRound && skipBingRound) remoteStopped = true;
    emitPosterLog({
      movieId,
      movieName,
      provider: bingAvailable && !bingAttempt.skipped ? "bing" : "google",
      cacheHit: false,
      reason: normalizeFailReason(finalReason),
      candidateCount: 0,
    });
    results.push(
      baseResult(movieId, movieName, key, cacheDir, {
        status: resultStatus,
        reason: normalizeFailReason(finalReason),
        googleResult: labelAttempt(googleAttempt),
        bingResult: bingAvailable ? labelAttempt(bingAttempt) : "not_called",
      }),
    );
  }

  return results;
}

function markFail(index, key, movie, reason, cacheDir) {
  const prev = index.entries[key] || {};
  const normalized = normalizeFailReason(reason);
  const until = Date.now() + FAIL_COOLDOWN_MS;
  const entry = {
    movieId: String(movie?.movieId || prev.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || prev.movieName || ""),
    status: "fail",
    reason: normalized,
    failUntil: until,
    resolvedAt: new Date().toISOString(),
    googleFailUntil: prev.googleFailUntil || 0,
    bingFailUntil: prev.bingFailUntil || 0,
    googleReason: prev.googleReason || "",
    bingReason: prev.bingReason || "",
  };
  if (!entry.googleFailUntil && !entry.bingFailUntil) {
    entry.googleFailUntil = until;
    entry.googleReason = normalized;
  }
  if (!entry.googleFailUntil) delete entry.googleFailUntil;
  if (!entry.bingFailUntil) delete entry.bingFailUntil;
  if (!entry.googleReason) delete entry.googleReason;
  if (!entry.bingReason) delete entry.bingReason;
  index.entries[key] = entry;
  writeIndex(cacheDir, index);
}

function savePoster(cacheDir, movie, key, found) {
  const { dir } = cachePaths(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const provider = found.provider === "bing" ? "bing" : "google";
  const ext = extOf(found.type);
  const fileName = `${safeFileBase(movie, key)}.${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, found.buffer);
  const fileUrl = toFileUrl(abs);
  const createdAt = new Date().toISOString();
  const entry = {
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    provider,
    localPath: abs,
    fileUrl,
    sourceUrl: String(found.sourceUrl || ""),
    createdAt,
    resolvedAt: createdAt,
    status: "ok",
    width: found.width,
    height: found.height,
  };
  return {
    entry,
    public: {
      status: "ok",
      localPath: abs,
      fileUrl,
      uiPath: fileUrl,
      sourceUrl: entry.sourceUrl,
      resolvedAt: entry.resolvedAt,
      createdAt,
      width: found.width,
      height: found.height,
      provider,
      posterSource: sourceTag(provider, false),
    },
  };
}

function commitPoster(index, cacheDir, movie, key, found, provider) {
  const saved = savePoster(cacheDir, movie, key, { ...found, provider });
  const prev = index.entries[key] || {};
  const entry = { ...saved.entry };
  if (prev.googleFailUntil) entry.googleFailUntil = prev.googleFailUntil;
  if (prev.googleReason) entry.googleReason = prev.googleReason;
  if (prev.bingFailUntil) entry.bingFailUntil = prev.bingFailUntil;
  if (prev.bingReason) entry.bingReason = prev.bingReason;
  index.entries[key] = entry;
  writeIndex(cacheDir, index);
  return {
    ...saved.public,
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    cacheKey: key,
    fromCache: false,
    cacheHit: false,
    cacheDir,
    provider: saved.public.provider,
    posterSource: saved.public.posterSource,
    finalProvider: saved.public.provider,
  };
}

module.exports = {
  resolveMissingPosters,
  clearPosterFailureCooldown,
  isAcceptablePoster,
  isBannedCandidateUrl,
  readImageSize,
  normalizeMovieName,
  cacheKey,
  FAIL_COOLDOWN_MS,
  cachePaths,
  requireCacheDir,
  toFileUrl,
  normalizeFailReason,
  shouldBypassFailCooldown,
};
