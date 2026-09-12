import {
  normalizeMovieName,
  buildTrailerPlaylist,
  resolveTrailerFallback,
  resolveTop1Trailer,
  getMovieMediaCatalog,
} from "./data/movie-media.js";

const FADE_OUT_MS = 200;
const FADE_IN_MS = 300;

let videoEl = null;
let frameEl = null;
let headerNowEl = null;
let overlayTitleEl = null;
let overlayTaglineEl = null;
let overlayReleaseEl = null;
let emptyEl = null;
let emptyTitleEl = null;
let postersEl = null;
let playlist = [];
let currentIndex = 0;
let switching = false;
let failStreak = 0;
let timers = new Map();
let boundHandlers = null;
let initialized = false;
let lastTop1Key = "";
let playingMediaKey = "";
let currentVideoSrc = "";
let generation = 0;

function $(id) {
  return document.getElementById(id);
}

function itemMediaKey(item) {
  return item?.mediaKey || normalizeMovieName(item?.title);
}

function clearTimers() {
  timers.forEach((timerId) => clearTimeout(timerId));
  timers.clear();
}

function schedule(fn, ms) {
  const gen = generation;
  const id = setTimeout(() => {
    timers.delete(id);
    if (gen !== generation) return;
    fn();
  }, ms);
  timers.set(id, gen);
  return id;
}

function isCurrentGeneration(gen = generation) {
  return gen === generation;
}

function clearFramePoster() {
  if (!frameEl) return;
  frameEl.style.backgroundImage = "";
}

function setFramePoster(poster) {
  if (!frameEl || !poster) return;
  frameEl.style.backgroundImage = `url("${poster}")`;
  frameEl.style.backgroundSize = "cover";
  frameEl.style.backgroundPosition = "center";
}

function updatePlayingInfo() {
  const item = playlist[currentIndex];
  if (!item) return;

  const title = item.title || "";
  const wrapped = title ? `《${title}》` : "";
  const indexText = playlist.length > 1 ? ` ${currentIndex + 1}/${playlist.length}` : "";

  if (headerNowEl) {
    headerNowEl.textContent = wrapped ? `正在播放：${wrapped}${indexText}` : "正在播放：--";
  }
  if (overlayTitleEl) overlayTitleEl.textContent = wrapped || "《--》";
  if (overlayTaglineEl) overlayTaglineEl.textContent = item.tagline || "";
  if (overlayReleaseEl) overlayReleaseEl.textContent = item.release || "正在热映";
}

function showNoTrailer(message = "暂无可播放预告") {
  generation += 1;
  clearTimers();
  switching = false;
  failStreak = 0;
  playlist = [];
  playingMediaKey = "";
  currentVideoSrc = "";

  frameEl?.classList.add("trailer-section__main--empty");
  if (emptyEl) emptyEl.hidden = false;
  if (emptyTitleEl) emptyTitleEl.textContent = message;
  clearFramePoster();
  if (videoEl) {
    videoEl.hidden = true;
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.removeAttribute("poster");
    videoEl.load();
  }
  if (postersEl) postersEl.replaceChildren();
  if (headerNowEl) headerNowEl.textContent = "正在播放：--";
  if (overlayTitleEl) overlayTitleEl.textContent = "《--》";
  if (overlayTaglineEl) overlayTaglineEl.textContent = "";
  if (overlayReleaseEl) overlayReleaseEl.textContent = "";
  fadeVideo(false);
}

function hideEmpty() {
  frameEl?.classList.remove("trailer-section__main--empty");
  if (emptyEl) emptyEl.hidden = true;
  if (videoEl) videoEl.hidden = false;
}

function fadeVideo(visible) {
  if (!videoEl) return;
  videoEl.classList.toggle("trailer-section__video--visible", visible);
  videoEl.classList.toggle("trailer-section__video--hidden", !visible);
}

function tryPlay(gen = generation) {
  if (!isCurrentGeneration(gen) || !videoEl || videoEl.hidden) return;
  const ret = videoEl.play();
  if (ret && typeof ret.catch === "function") {
    ret.catch(() => {
      schedule(() => {
        if (!isCurrentGeneration(gen)) return;
        videoEl.play().catch(() => advanceOnError("autoplay blocked", gen));
      }, 400);
    });
  }
}

function loadCurrent(fromSwitch, gen = generation) {
  if (!isCurrentGeneration(gen)) return;

  if (!playlist.length) {
    showNoTrailer();
    return;
  }

  const item = playlist[currentIndex];
  if (!item?.src) {
    showNoTrailer();
    return;
  }

  if (!fromSwitch && item.src === currentVideoSrc && playingMediaKey === itemMediaKey(item)) {
    hideEmpty();
    updatePlayingInfo();
    if (videoEl && !videoEl.paused && videoEl.readyState >= 2) {
      fadeVideo(true);
    }
    return;
  }

  hideEmpty();
  updatePlayingInfo();
  setFramePoster(item.cover);
  if (videoEl && item.cover) videoEl.poster = item.cover;

  if (fromSwitch) {
    switching = true;
    fadeVideo(false);
    schedule(() => {
      if (!isCurrentGeneration(gen)) return;
      currentVideoSrc = item.src;
      videoEl.src = item.src;
      videoEl.load();
    }, FADE_OUT_MS);
    return;
  }

  currentVideoSrc = item.src;
  videoEl.src = item.src;
  videoEl.load();
}

function switchToIndex(index, animate, gen = generation) {
  if (!isCurrentGeneration(gen)) return;

  if (!playlist.length) {
    showNoTrailer();
    return;
  }

  const safeIndex = ((index % playlist.length) + playlist.length) % playlist.length;
  const item = playlist[safeIndex];
  const key = itemMediaKey(item);

  if (!animate && key === playingMediaKey && item.src === currentVideoSrc) {
    updatePlayingInfo();
    return;
  }

  playingMediaKey = key;
  currentIndex = safeIndex;
  loadCurrent(animate, gen);
}

function advanceOnError(reason, gen = generation) {
  if (!isCurrentGeneration(gen)) return;
  if (reason) console.warn("[trailer]", reason);
  failStreak += 1;
  if (!playlist.length || failStreak >= playlist.length) {
    showNoTrailer("预告片均不可用");
    return;
  }
  switchToIndex(currentIndex + 1, true, gen);
}

function onCanPlay() {
  const gen = generation;
  if (!isCurrentGeneration(gen) || !videoEl?.src) return;
  failStreak = 0;
  switching = false;
  hideEmpty();
  fadeVideo(true);
  schedule(() => tryPlay(gen), FADE_IN_MS);
}

function onEnded() {
  const gen = generation;
  if (!isCurrentGeneration(gen) || switching || !playlist.length) return;
  fadeVideo(false);
  schedule(() => {
    if (!isCurrentGeneration(gen)) return;
    if (playlist.length === 1) {
      videoEl.currentTime = 0;
      fadeVideo(true);
      tryPlay(gen);
      return;
    }
    switchToIndex(currentIndex + 1, true, gen);
  }, FADE_OUT_MS);
}

function onError() {
  const gen = generation;
  if (!isCurrentGeneration(gen)) return;
  const item = playlist[currentIndex];
  advanceOnError(`load failed: ${item?.title || "unknown"} (${item?.src || ""})`, gen);
}

function bindVideoEvents() {
  if (!videoEl || boundHandlers) return;
  boundHandlers = { canplay: onCanPlay, ended: onEnded, error: onError };
  videoEl.addEventListener("canplay", boundHandlers.canplay);
  videoEl.addEventListener("ended", boundHandlers.ended);
  videoEl.addEventListener("error", boundHandlers.error);
}

function unbindVideoEvents() {
  if (!videoEl || !boundHandlers) return;
  videoEl.removeEventListener("canplay", boundHandlers.canplay);
  videoEl.removeEventListener("ended", boundHandlers.ended);
  videoEl.removeEventListener("error", boundHandlers.error);
  boundHandlers = null;
}

function startPlayback(movies, chartPlaylist, animate, catalog) {
  const gen = generation;
  const top1Item = resolveTop1Trailer(movies, catalog);
  const target = top1Item || resolveTrailerFallback(movies, catalog);

  if (!target) {
    showNoTrailer();
    return;
  }

  playlist = chartPlaylist.length ? chartPlaylist : [target];
  const idx = playlist.findIndex((p) => itemMediaKey(p) === itemMediaKey(target));
  switchToIndex(idx >= 0 ? idx : 0, animate, gen);
}

export function initTrailerPlayer() {
  if (initialized) return;
  initialized = true;

  videoEl = $("trailer-video");
  frameEl = $("trailer-frame");
  headerNowEl = $("trailer-now");
  overlayTitleEl = $("trailer-overlay-title");
  overlayTaglineEl = $("trailer-overlay-tagline");
  overlayReleaseEl = $("trailer-overlay-release");
  emptyEl = $("trailer-empty");
  emptyTitleEl = $("trailer-empty-title");
  postersEl = $("trailer-posters");

  if (!videoEl) return;

  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.controls = false;
  videoEl.setAttribute("playsinline", "");
  videoEl.setAttribute("webkit-playsinline", "");
  bindVideoEvents();
  showNoTrailer();
}

export function syncTrailerWithRanking(movies, catalog = getMovieMediaCatalog()) {
  if (!initialized) return;

  generation += 1;
  const gen = generation;
  clearTimers();
  switching = false;

  const sorted = [...(movies || [])].sort((a, b) => a.rank - b.rank);
  const top1 = sorted.find((m) => m.rank === 1);
  const newTop1Key = top1?.mediaKey || normalizeMovieName(top1?.name) || "";
  const chartPlaylist = buildTrailerPlaylist(sorted, catalog);

  if (!chartPlaylist.length) {
    showNoTrailer();
    lastTop1Key = newTop1Key;
    return;
  }

  const top1Changed = Boolean(lastTop1Key && newTop1Key && newTop1Key !== lastTop1Key);
  const firstLoad = Boolean(newTop1Key && !lastTop1Key && !playingMediaKey);

  if (firstLoad || top1Changed) {
    lastTop1Key = newTop1Key;
    startPlayback(sorted, chartPlaylist, true, catalog);
    return;
  }

  if (newTop1Key) lastTop1Key = newTop1Key;

  const prevKey = playingMediaKey;
  playlist = chartPlaylist;

  const stillInChart = prevKey && playlist.some((p) => itemMediaKey(p) === prevKey);

  if (!prevKey) {
    startPlayback(sorted, chartPlaylist, false, catalog);
    return;
  }

  if (!stillInChart) {
    startPlayback(sorted, chartPlaylist, true, catalog);
    return;
  }

  const idx = playlist.findIndex((p) => itemMediaKey(p) === prevKey);
  if (idx >= 0) currentIndex = idx;
  updatePlayingInfo();
}

export function destroyTrailerPlayer() {
  generation += 1;
  clearTimers();
  unbindVideoEvents();
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
  }
  clearFramePoster();
  if (postersEl) postersEl.replaceChildren();
  playlist = [];
  initialized = false;
  switching = false;
  failStreak = 0;
  lastTop1Key = "";
  playingMediaKey = "";
  currentVideoSrc = "";
}

/** @deprecated 使用 syncTrailerWithRanking */
export function syncTrailerWithMovie(movie) {
  syncTrailerWithRanking(movie ? [movie] : []);
}
