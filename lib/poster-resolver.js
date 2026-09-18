/**
 * 缺失海报解析：缓存优先，远程搜索限流，不阻塞榜单渲染。
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
  };
}

async function resolveMissingPosters(movies, options = {}) {
  const run = chain.then(() => resolveInner(movies, options));
  chain = run.catch(() => {});
  return run;
}

async function resolveInner(movies, options = {}) {
  const cacheDir = requireCacheDir(options);
  const list = Array.isArray(movies) ? movies.slice(0, 10) : [];
  const index = readIndex(cacheDir);
  index.entries = index.entries || {};
  const results = [];
  let remoteStopped = false;
  let remoteStarted = false;
  const searchImpl = options.searchImpl || null;

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
      results.push({ ...hit, movieId, movieName, cacheKey: key, cacheDir });
      continue;
    }
    if (cached && cached.status === "fail" && Number(cached.failUntil) > Date.now()) {
      results.push({
        movieId,
        movieName,
        status: "cooldown",
        cacheKey: key,
        failUntil: cached.failUntil,
        reason: cached.reason || "cooldown",
        cacheDir,
      });
      continue;
    }
    if (remoteStopped) {
      results.push({
        movieId,
        movieName,
        status: "skipped",
        reason: "round-stopped",
        cacheKey: key,
        cacheDir,
      });
      continue;
    }
    if (remoteStarted && MAX_CONCURRENCY < 1) {
      results.push({
        movieId,
        movieName,
        status: "skipped",
        reason: "concurrency",
        cacheKey: key,
        cacheDir,
      });
      continue;
    }
    remoteStarted = true;
    let found = null;
    try {
      const search = searchImpl || require("./poster-search").searchOfficialPoster;
      found = await search(movieName, { signal: options.signal });
    } catch (error) {
      const code = error?.code || "NETWORK";
      const stop = code === "CAPTCHA" || code === "FORBIDDEN" || code === "NETWORK";
      markFail(index, key, movie, code, cacheDir);
      results.push({ movieId, movieName, status: "fail", reason: code, cacheKey: key, cacheDir });
      if (stop) remoteStopped = true;
      continue;
    }
    if (!found || found.stopped) {
      const code = found?.code || "NETWORK";
      markFail(index, key, movie, code, cacheDir);
      results.push({ movieId, movieName, status: "fail", reason: code, cacheKey: key, cacheDir });
      remoteStopped = true;
      continue;
    }
    if (found.query && movieName && !String(found.query).includes(movieName)) {
      markFail(index, key, movie, "query-mismatch", cacheDir);
      results.push({
        movieId,
        movieName,
        status: "fallback",
        reason: "query-mismatch",
        cacheKey: key,
        cacheDir,
      });
      continue;
    }
    if (found.sourceUrl && isBannedCandidateUrl(found.sourceUrl)) {
      markFail(index, key, movie, "banned-url", cacheDir);
      results.push({
        movieId,
        movieName,
        status: "fallback",
        reason: "banned-url",
        cacheKey: key,
        cacheDir,
      });
      continue;
    }
    if (!found.buffer || !isAcceptablePoster(found)) {
      markFail(index, key, movie, found?.reason || "quality", cacheDir);
      results.push({
        movieId,
        movieName,
        status: "fallback",
        reason: found?.reason || "quality",
        cacheKey: key,
        cacheDir,
      });
      continue;
    }
    const saved = savePoster(cacheDir, movie, key, found);
    index.entries[key] = saved.entry;
    writeIndex(cacheDir, index);
    results.push({
      ...saved.public,
      movieId,
      movieName,
      cacheKey: key,
      fromCache: false,
      cacheDir,
    });
    remoteStarted = false;
  }

  if (remoteStopped) writeIndex(cacheDir, index);
  return results;
}

function markFail(index, key, movie, reason, cacheDir) {
  index.entries[key] = {
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    status: "fail",
    reason: String(reason || "fail"),
    failUntil: Date.now() + FAIL_COOLDOWN_MS,
    resolvedAt: new Date().toISOString(),
  };
  writeIndex(cacheDir, index);
}

function savePoster(cacheDir, movie, key, found) {
  const { dir } = cachePaths(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const ext = extOf(found.type);
  const fileName = `${safeFileBase(movie, key)}.${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, found.buffer);
  const fileUrl = toFileUrl(abs);
  const entry = {
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    localPath: abs,
    fileUrl,
    sourceUrl: String(found.sourceUrl || ""),
    resolvedAt: new Date().toISOString(),
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
      width: found.width,
      height: found.height,
    },
  };
}

module.exports = {
  resolveMissingPosters,
  isAcceptablePoster,
  isBannedCandidateUrl,
  readImageSize,
  normalizeMovieName,
  cacheKey,
  FAIL_COOLDOWN_MS,
  cachePaths,
  requireCacheDir,
  toFileUrl,
};
