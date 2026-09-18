/**
 * 缺失海报解析：缓存优先，远程搜索限流，不阻塞榜单渲染。
 * 浏览器上下文由 poster-search 使用独立 context，不碰猫眼登录 Profile。
 */
const fs = require("fs");
const path = require("path");

const CACHE_DIR_NAME = path.join("data", "poster-cache");
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

function cachePaths(root) {
  const dir = path.join(root, CACHE_DIR_NAME);
  return { dir, indexPath: path.join(dir, INDEX_NAME) };
}

function readIndex(root) {
  const { indexPath } = cachePaths(root);
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    return data && typeof data === "object" ? data : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeIndex(root, index) {
  const { dir, indexPath } = cachePaths(root);
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
  if (ratio < 0.55 || ratio > 0.8) return false;
  return true;
}

function extOf(type) {
  if (type === "png") return "png";
  if (type === "webp") return "webp";
  return "jpg";
}

function entryUiPath(fileName) {
  return `../data/poster-cache/${fileName}`;
}

function hitFromEntry(entry, root) {
  if (!entry || entry.status !== "ok" || !entry.localPath) return null;
  const abs = path.isAbsolute(entry.localPath)
    ? entry.localPath
    : path.join(root, entry.localPath);
  if (!fs.existsSync(abs)) return null;
  const fileName = path.basename(abs);
  return {
    ...entry,
    status: "ok",
    localPath: abs,
    uiPath: entry.uiPath || entryUiPath(fileName),
    fromCache: true,
  };
}

async function resolveMissingPosters(movies, options = {}) {
  const run = chain.then(() => resolveInner(movies, options));
  chain = run.catch(() => {});
  return run;
}

async function resolveInner(movies, options = {}) {
  const root = options.root || path.join(__dirname, "..");
  const list = Array.isArray(movies) ? movies.slice(0, 10) : [];
  const index = readIndex(root);
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
    const hit = hitFromEntry(cached, root);
    if (hit) {
      results.push({ ...hit, movieId, movieName, cacheKey: key });
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
      });
      continue;
    }
    if (remoteStopped) {
      results.push({ movieId, movieName, status: "skipped", reason: "round-stopped", cacheKey: key });
      continue;
    }
    if (remoteStarted && MAX_CONCURRENCY < 1) {
      results.push({ movieId, movieName, status: "skipped", reason: "concurrency", cacheKey: key });
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
      markFail(index, key, movie, code, root);
      results.push({ movieId, movieName, status: "fail", reason: code, cacheKey: key });
      if (stop) remoteStopped = true;
      continue;
    }
    if (!found || found.stopped) {
      const code = found?.code || "NETWORK";
      markFail(index, key, movie, code, root);
      results.push({ movieId, movieName, status: "fail", reason: code, cacheKey: key });
      remoteStopped = true;
      continue;
    }
    if (!found.buffer || !isAcceptablePoster(found)) {
      markFail(index, key, movie, found?.reason || "quality", root);
      results.push({
        movieId,
        movieName,
        status: "fallback",
        reason: found?.reason || "quality",
        cacheKey: key,
      });
      continue;
    }
    const saved = savePoster(root, movie, key, found);
    index.entries[key] = saved.entry;
    writeIndex(root, index);
    results.push({ ...saved.public, movieId, movieName, cacheKey: key, fromCache: false });
    remoteStarted = false;
  }

  if (remoteStopped) writeIndex(root, index);
  return results;
}

function markFail(index, key, movie, reason, root) {
  index.entries[key] = {
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    status: "fail",
    reason: String(reason || "fail"),
    failUntil: Date.now() + FAIL_COOLDOWN_MS,
    resolvedAt: new Date().toISOString(),
  };
  writeIndex(root, index);
}

function savePoster(root, movie, key, found) {
  const { dir } = cachePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  const ext = extOf(found.type);
  const fileName = `${safeFileBase(movie, key)}.${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, found.buffer);
  const entry = {
    movieId: String(movie?.movieId || ""),
    movieName: String(movie?.movieName || movie?.name || ""),
    localPath: path.relative(root, abs).replace(/\\/g, "/"),
    uiPath: entryUiPath(fileName),
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
      uiPath: entry.uiPath,
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
  readImageSize,
  normalizeMovieName,
  cacheKey,
  FAIL_COOLDOWN_MS,
  cachePaths,
};
