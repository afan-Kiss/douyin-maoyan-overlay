/** @typedef {{ name: string, aliases?: string[], poster?: string, trailer?: string, trailerPoster?: string, tagline?: string, release?: string }} MovieMedia */

export const DEFAULT_POSTER = "assets/default-movie-poster.svg";

let mediaCache = null;
const warnedPosters = new Set();
const warnedTrailers = new Set();

export function getMovieMediaCatalog() {
  return mediaCache || [];
}

/**
 * 统一电影名规范化：仅用于精确/别名匹配，禁止模糊 includes。
 */
export function normalizeMovieName(name) {
  return String(name || "")
    .replace(/《|》/g, "")
    .replace(/[\s\u00A0\u3000]+/g, "")
    .replace(/[：:·•·]/g, "")
    .replace(/[（）()【】\[\]]/g, "")
    .replace(/[，,。.!！?？;；]/g, "")
    .trim()
    .toLowerCase();
}

export async function loadMovieMedia() {
  if (mediaCache) return mediaCache;
  try {
    const res = await fetch("data/movie-media.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    mediaCache = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("[MovieMedia] 配置加载失败:", err?.message || err);
    mediaCache = [];
  }
  return mediaCache;
}

/** @returns {MovieMedia | null} */
export function findMovieMedia(name, catalog = mediaCache || []) {
  const key = normalizeMovieName(name);
  if (!key || !catalog.length) return null;

  for (const item of catalog) {
    if (normalizeMovieName(item.name) === key) return item;
  }

  for (const item of catalog) {
    const aliases = item.aliases || [];
    if (aliases.some((alias) => normalizeMovieName(alias) === key)) return item;
  }

  return null;
}

/** 该片在配置中是否有自己的预告（按片名精确匹配，禁止借用其他片资源） */
export function hasOwnTrailer(movie, catalog = mediaCache || []) {
  const media = findMovieMedia(movie?.name, catalog);
  return Boolean(media?.trailer);
}

function resolveMediaPoster(media) {
  if (!media) return "";
  return media.poster || media.trailerPoster || "";
}

export function resolvePosterUrl(movie, catalog = mediaCache || []) {
  const media = findMovieMedia(movie?.name, catalog);
  const poster = resolveMediaPoster(media);
  if (poster) return poster;

  const movieName = movie?.name;
  if (movieName && !warnedPosters.has(movieName)) {
    warnedPosters.add(movieName);
    console.warn(`[MovieMedia] poster not found: ${movieName}`);
  }
  return DEFAULT_POSTER;
}

export function applyMediaToMovie(movie, catalog = mediaCache || []) {
  if (!movie) return movie;

  const media = findMovieMedia(movie.name, catalog);
  const mediaKey = normalizeMovieName(movie.name);

  const existingPoster = movie.moviePoster || movie.posterUrl || movie.poster || "";
  const poster =
    resolveMediaPoster(media) ||
    (existingPoster && !String(existingPoster).includes("default-movie-poster")
      ? existingPoster
      : "") ||
    DEFAULT_POSTER;
  if (!resolveMediaPoster(media) && !existingPoster && movie.name && !warnedPosters.has(movie.name)) {
    warnedPosters.add(movie.name);
    console.warn(`[MovieMedia] poster not found: ${movie.name}`);
  }

  const trailerSrc = media?.trailer || "";
  if (!trailerSrc && movie.name && !warnedTrailers.has(movie.name)) {
    warnedTrailers.add(movie.name);
    console.warn(`[MovieMedia] trailer not found: ${movie.name}`);
  }

  return {
    ...movie,
    mediaKey,
    moviePoster: poster,
    posterUrl: poster,
    trailerSrc,
    trailerPoster: media?.trailerPoster || media?.poster || DEFAULT_POSTER,
    trailerTagline: media?.tagline || "",
    trailerRelease: media?.release || "正在热映",
  };
}

export function applyMediaToMovies(movies, catalog = mediaCache || []) {
  return (movies || []).map((m) => applyMediaToMovie(m, catalog));
}

/**
 * 将榜单中的电影转为预告条目。
 * 必须：片名与 media 配置精确匹配，且该片拥有自己的 trailer。
 */
export function movieToTrailerItem(movie, catalog = getMovieMediaCatalog()) {
  if (!movie?.name) return null;

  const media = findMovieMedia(movie.name, catalog);
  if (!media?.trailer) return null;

  const title = String(movie.name).replace(/《|》/g, "").trim();
  if (!title) return null;

  const mediaKey = normalizeMovieName(movie.name);

  return {
    title,
    src: media.trailer,
    cover: media.trailerPoster || media.poster || DEFAULT_POSTER,
    tagline: media.tagline || "",
    release: media.release || "正在热映",
    mediaKey,
    rank: movie.rank,
  };
}

const TRAILER_RANK_LIMIT = 10;

function sortedChartMovies(movies) {
  return [...(movies || [])]
    .filter((m) => m.rank >= 1 && m.rank <= TRAILER_RANK_LIMIT)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * TOP1 → TOP2 → … → TOP10
 * 仅在当前榜单前十内、按排名顺序，找第一部拥有自己预告片的电影。
 */
export function resolveTrailerFallback(movies, catalog = getMovieMediaCatalog()) {
  for (const movie of sortedChartMovies(movies)) {
    const item = movieToTrailerItem(movie, catalog);
    if (item) return item;
  }
  return null;
}

/** 当前榜单 TOP1（若该片有自己预告则返回，否则 null） */
export function resolveTop1Trailer(movies, catalog = getMovieMediaCatalog()) {
  const top1 = sortedChartMovies(movies).find((m) => m.rank === 1);
  if (!top1) return null;
  return movieToTrailerItem(top1, catalog);
}

/**
 * 播放列表：当前榜单 TOP1–TOP10 内、且按片名匹配到自己预告的电影（按排名排序）。
 */
export function buildTrailerPlaylist(movies, catalog = getMovieMediaCatalog()) {
  return sortedChartMovies(movies)
    .map((m) => movieToTrailerItem(m, catalog))
    .filter(Boolean);
}

// 兼容旧引用
export const loadMovieCatalog = loadMovieMedia;
export const applyCatalogToMovies = applyMediaToMovies;
export const applyCatalogToMovie = applyMediaToMovie;
export const findCatalogEntry = findMovieMedia;
