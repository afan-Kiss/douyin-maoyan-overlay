import { animateNumber, setEncodedBox } from "./number-anim.js";
import { decodeBoxFromHtml } from "./maoyan-api.js";
import { DEFAULT_POSTER } from "./data/movie-media.js";

const DELTA_SHOW_MS = 2800;
const RANK_HINT_MS = 4000;
const RANK_SCROLL_SEC_PER_ROW = 3.2;

let isFirstRender = true;
let rankStructureKey = "";

const prevState = {
  movies: new Map(),
  ranks: new Map(),
  nationBox: 0,
  nationHtml: "",
  nationViews: "",
  nationAvg: "",
};

function $(sel, root = document) {
  return root.querySelector(sel);
}

function isEmpty(val) {
  if (val == null) return true;
  const t = String(val).trim();
  return !t || t === "--" || t === "-";
}

export function getMovieAmount(movie) {
  if (movie?.todayBox > 0) return movie.todayBox;
  if (movie?.todayBoxHtml) return decodeBoxFromHtml(movie.todayBoxHtml, movie.todayUnit);
  return 0;
}

function formatPct(val) {
  if (isEmpty(val)) return "--";
  const s = String(val).trim();
  return s.includes("%") ? s : `${s}%`;
}

function formatDelta(delta, unit = "万") {
  if (!Number.isFinite(delta) || delta <= 0) return "";
  if (unit === "亿" || delta >= 10000) return `+${(delta / 10000).toFixed(2)}亿`;
  if (delta >= 100) return `+${delta.toFixed(1)}${unit}`;
  if (delta >= 1) return `+${delta.toFixed(1)}${unit}`;
  return `+${delta.toFixed(2)}${unit}`;
}

function parseNumFromDesc(desc) {
  if (isEmpty(desc)) return NaN;
  const s = String(desc).replace(/,/g, "").trim();
  const m = s.match(/([\d.]+)/);
  if (!m) return NaN;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return NaN;
  if (s.includes("亿")) n *= 100000000;
  else if (s.includes("万")) n *= 10000;
  return n;
}

function formatAvgViews(avg) {
  if (!Number.isFinite(avg) || avg <= 0) return "--";
  if (avg >= 10000) return `${(avg / 10000).toFixed(1)}万`;
  return avg >= 100 ? avg.toFixed(0) : avg.toFixed(1);
}

function computeNationAvg(nation) {
  const views = parseNumFromDesc(nation?.viewCountDesc);
  const shows = parseNumFromDesc(nation?.showCountDesc);
  if (!Number.isFinite(views) || !Number.isFinite(shows) || shows <= 0) return "--";
  return formatAvgViews(views / shows);
}

function showDeltaBadge(container, delta, unit) {
  if (!container || !Number.isFinite(delta) || delta <= 0) return;
  let badge = container.querySelector(".delta-tag");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "delta-tag";
    container.appendChild(badge);
  }
  badge.textContent = `${formatDelta(delta, unit)} ↑`;
  badge.classList.remove("delta-tag--fade");
  requestAnimationFrame(() => badge.classList.add("delta-tag--show"));
  clearTimeout(badge._hideTimer);
  badge._hideTimer = setTimeout(() => badge.classList.add("delta-tag--fade"), DELTA_SHOW_MS);
}

function showRankHint(rankEl, diff) {
  if (!rankEl || !diff) return;
  let hint = rankEl.querySelector(".rank-hint");
  if (!hint) {
    hint = document.createElement("span");
    hint.className = "rank-hint";
    rankEl.appendChild(hint);
  }
  hint.textContent = diff > 0 ? `↑${diff}` : `↓${Math.abs(diff)}`;
  hint.className = `rank-hint rank-hint--${diff > 0 ? "up" : "down"} rank-hint--show`;
  clearTimeout(hint._hideTimer);
  hint._hideTimer = setTimeout(() => hint.classList.remove("rank-hint--show"), RANK_HINT_MS);
}

function setDeltaEl(el, text) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("has-rise", Boolean(text));
}

function updatePosterHero(card, heroEl, movie) {
  if (!heroEl || !card) return;

  const movieName = movie?.name || "";
  const poster = movie?.moviePoster || movie?.posterUrl || movie?.poster || DEFAULT_POSTER;
  const bg = heroEl.querySelector(".podium-card__hero-bg");
  if (!bg) return;

  const applyPoster = (url) => {
    bg.replaceChildren();
    bg.style.backgroundImage = `url("${url}")`;
    bg.style.backgroundSize = "cover";
    bg.style.backgroundPosition = "center";
    card.classList.add("podium-card--has-poster");
    heroEl.classList.add("podium-card__hero--with-poster");
    heroEl.classList.remove("podium-card__hero--no-poster");
  };

  const showFallback = () => {
    card.classList.remove("podium-card--has-poster");
    heroEl.classList.add("podium-card__hero--no-poster");
    heroEl.classList.remove("podium-card__hero--with-poster");
    bg.style.backgroundImage = "";
    bg.replaceChildren();
    const initial = movieName.replace(/《|》/g, "").charAt(0) || "?";
    const fallback = document.createElement("div");
    fallback.className = "podium-card__hero-fallback";
    fallback.innerHTML = `<span class="podium-card__hero-initial">${initial}</span>`;
    bg.appendChild(fallback);
  };

  const currentPoster = bg.dataset.posterSrc || "";
  if (currentPoster === poster && card.classList.contains("podium-card--has-poster")) {
    return;
  }

  const probe = new Image();
  probe.onload = () => {
    bg.dataset.posterSrc = poster;
    applyPoster(poster);
  };
  probe.onerror = () => {
    if (poster !== DEFAULT_POSTER) {
      console.warn(`[MovieMedia] poster not found: ${movieName}`);
      const fallbackProbe = new Image();
      fallbackProbe.onload = () => {
        bg.dataset.posterSrc = DEFAULT_POSTER;
        applyPoster(DEFAULT_POSTER);
      };
      fallbackProbe.onerror = () => {
        bg.dataset.posterSrc = "";
        showFallback();
      };
      fallbackProbe.src = DEFAULT_POSTER;
    } else {
      bg.dataset.posterSrc = "";
      showFallback();
    }
  };
  probe.src = poster;
}

function ensurePodiumCard(rank) {
  const slot = $(`.podium__slot[data-rank="${rank}"]`);
  if (!slot) return null;

  let card = slot.querySelector(".podium-card");
  if (!card) {
    card = document.createElement("article");
    card.className = `podium-card podium-card--r${rank}`;
    card.innerHTML = `
      <div class="podium-card__badge">
        <span class="podium-card__crown"></span>
        <span class="podium-card__rank-label"></span>
      </div>
      <div class="podium-card__hero podium-card__hero--no-poster">
        <div class="podium-card__hero-bg"></div>
        <div class="podium-card__hero-overlay"></div>
      </div>
      <div class="podium-card__body">
        <h3 class="podium-card__name"></h3>
        <div class="podium-card__box-label">实时票房</div>
        <div class="podium-card__box">
          <span class="podium-card__box-val mtsi-font"></span>
          <span class="podium-card__box-unit">万</span>
        </div>
        <div class="podium-card__delta"></div>
        <div class="podium-card__stats"></div>
        <div class="podium-card__forecast"></div>
      </div>
    `;
    slot.appendChild(card);
  }
  return card;
}

function updatePodiumCard(movie, isFirst) {
  const rank = movie.rank;
  const card = ensurePodiumCard(rank);
  if (!card) return;

  const key = String(movie.movieId);
  const prev = prevState.movies.get(key) || { amount: 0 };
  const amount = getMovieAmount(movie);
  const unit = movie.todayUnit || "万";

  const rankLabel = card.querySelector(".podium-card__rank-label");
  const heroEl = card.querySelector(".podium-card__hero");
  const nameEl = card.querySelector(".podium-card__name");
  const boxVal = card.querySelector(".podium-card__box-val");
  const boxUnit = card.querySelector(".podium-card__box-unit");
  const boxWrap = card.querySelector(".podium-card__box");
  const deltaEl = card.querySelector(".podium-card__delta");
  const statsEl = card.querySelector(".podium-card__stats");
  const forecastEl = card.querySelector(".podium-card__forecast");

  if (rankLabel) rankLabel.textContent = `TOP ${rank}`;
  updatePosterHero(card, heroEl, movie);
  if (nameEl) nameEl.textContent = movie.name || "--";

  if (movie.todayBoxHtml && boxVal) {
    if (prev.html !== movie.todayBoxHtml) setEncodedBox(boxVal, movie.todayBoxHtml, boxUnit, unit);
  } else if (boxVal) {
    animateNumber(boxVal, prev.amount, amount, {
      skipAnim: isFirst,
      formatter: (v) => (v > 0 ? v.toFixed(2) : "--"),
    });
    if (boxUnit) boxUnit.textContent = unit;
  }

  const delta = !isFirst && amount > prev.amount && prev.amount > 0 ? amount - prev.amount : 0;
  const deltaText = delta > 0 ? `${formatDelta(delta, unit)} ↑` : "";
  if (deltaEl) {
    deltaEl.textContent = deltaText;
    deltaEl.classList.toggle("has-rise", delta > 0);
  }
  if (delta > 0) showDeltaBadge(boxWrap, delta, unit);

  const statItems = [
    { label: "票房占比", value: formatPct(movie.boxRate) },
    { label: "排片占比", value: formatPct(movie.showCountRate) },
    { label: "上座率", value: formatPct(movie.avgSeatView) },
  ];
  if (statsEl) {
    statsEl.innerHTML = statItems
      .map(
        (s) =>
          `<div class="podium-card__stat"><span class="podium-card__stat-label">${s.label}</span><span class="podium-card__stat-value">${s.value}</span></div>`
      )
      .join("");
  }

  const forecast = movie.dynamicForecast || movie.totalForecast;
  if (forecastEl) {
    forecastEl.textContent = isEmpty(forecast) ? "" : `预测票房 ${String(forecast).replace(/^¥/, "")}`;
  }

  const badge = card.querySelector(".podium-card__badge");
  const prevRank = prevState.ranks.get(key);
  if (!isFirst && prevRank && prevRank !== movie.rank) {
    showRankHint(badge, prevRank - movie.rank);
  }

  prevState.movies.set(key, { amount, html: movie.todayBoxHtml });
  prevState.ranks.set(key, movie.rank);
}

function updateOverview(nation, parsed, isUpdating) {
  const statusHint = $("#status-hint");
  if (statusHint) {
    statusHint.hidden = !isUpdating;
    statusHint.textContent = isUpdating ? "数据更新中…" : "";
  }

  if (!nation) return;

  const nationVal = $("#nation-value");
  const nationUnit = $("#nation-unit");
  const nationDelta = $("#nation-delta");
  const viewsEl = $("#nation-views");
  const avgEl = $("#nation-avg");

  const unit = nation.todayUnit || "万";
  const amount = nation.todayBox > 0
    ? nation.todayBox
    : decodeBoxFromHtml(nation.todayBoxHtml, unit);
  const prevAmount = prevState.nationBox;
  const prevHtml = prevState.nationHtml;

  if (nation?.todayBoxHtml && nationVal) {
    if (prevHtml !== nation.todayBoxHtml) {
      setEncodedBox(nationVal, nation.todayBoxHtml, nationUnit, unit);
      if (!isFirstRender && amount > prevAmount && prevAmount > 0) {
        setDeltaEl(nationDelta, formatDelta(amount - prevAmount, unit));
      }
      prevState.nationHtml = nation.todayBoxHtml;
    }
  } else if (nationVal) {
    animateNumber(nationVal, prevAmount, amount, {
      skipAnim: isFirstRender,
      formatter: (v) => (v > 0 ? v.toFixed(1) : "--"),
    });
    if (nationUnit) nationUnit.textContent = unit;
    if (!isFirstRender && amount > prevAmount && prevAmount > 0) {
      setDeltaEl(nationDelta, formatDelta(amount - prevAmount, unit));
    }
  }
  prevState.nationBox = amount;

  const viewsText = nation.viewCountDesc || "--";
  const avgText = computeNationAvg(nation);
  if (viewsEl) viewsEl.textContent = viewsText;
  if (avgEl) avgEl.textContent = avgText === "--" ? "--" : `${avgText}`;

  prevState.nationViews = viewsText;
  prevState.nationAvg = avgText;
}

function buildRankRow(movie) {
  const row = document.createElement("div");
  row.className = "rank-row glass-panel";
  row.dataset.movieId = String(movie.movieId);
  row.innerHTML = `
    <span class="rank-row__num"></span>
    <span class="rank-row__name"></span>
    <span class="rank-row__box"><span class="rank-row__box-val mtsi-font"></span><span class="rank-row__box-unit">万</span></span>
    <span class="rank-row__round"></span>
  `;
  return row;
}

function ensureRankRow(movie, index, list) {
  if (!list) return null;

  const key = String(movie.movieId);
  let row = list.querySelector(`[data-movie-id="${key}"]`);
  if (!row) {
    row = buildRankRow(movie);
    const ref = list.children[index];
    if (ref) list.insertBefore(row, ref);
    else list.appendChild(row);
  } else if (list.children[index] !== row) {
    list.insertBefore(row, list.children[index] || null);
  }
  return row;
}

function updateRankRow(row, movie, isFirst) {
  const key = String(movie.movieId);
  const prev = prevState.movies.get(key) || { amount: 0 };
  const amount = getMovieAmount(movie);
  const unit = movie.todayUnit || "万";

  const rankNum = row.querySelector(".rank-row__num");
  const nameEl = row.querySelector(".rank-row__name");
  const boxVal = row.querySelector(".rank-row__box-val");
  const boxUnit = row.querySelector(".rank-row__box-unit");
  const roundEl = row.querySelector(".rank-row__round");
  const boxWrap = row.querySelector(".rank-row__box");

  if (rankNum) rankNum.textContent = String(movie.rank);
  if (nameEl) nameEl.textContent = movie.name || "--";

  if (movie.todayBoxHtml && boxVal) {
    if (prev.html !== movie.todayBoxHtml) setEncodedBox(boxVal, movie.todayBoxHtml, boxUnit, unit);
  } else if (boxVal) {
    animateNumber(boxVal, prev.amount, amount, {
      skipAnim: isFirst,
      formatter: (v) => (v > 0 ? v.toFixed(2) : "--"),
    });
    if (boxUnit) boxUnit.textContent = unit;
  }

  const delta = !isFirst && amount > prev.amount && prev.amount > 0 ? amount - prev.amount : 0;
  if (roundEl) {
    roundEl.textContent = delta > 0 ? formatDelta(delta, unit) : "";
    roundEl.classList.toggle("has-rise", delta > 0);
  }
  if (delta > 0 && boxWrap) showDeltaBadge(boxWrap, delta, unit);

  const prevRank = prevState.ranks.get(key);
  if (!isFirst && prevRank && prevRank !== movie.rank) {
    showRankHint(rankNum, prevRank - movie.rank);
  }

  prevState.movies.set(key, { amount, html: movie.todayBoxHtml });
  prevState.ranks.set(key, movie.rank);
}

function getRestMovies(movies) {
  return (movies || [])
    .filter((m) => m.rank >= 4 && m.rank <= 10)
    .sort((a, b) => a.rank - b.rank);
}

function getRankStructureKey(movies) {
  return getRestMovies(movies).map((m) => String(m.movieId)).join("|");
}

function syncRankClone(list, clone) {
  if (!list || !clone) return;

  const rows = [...list.children];
  while (clone.children.length < rows.length) {
    clone.appendChild(rows[clone.children.length].cloneNode(true));
  }
  while (clone.children.length > rows.length) {
    clone.lastChild.remove();
  }

  rows.forEach((row, index) => {
    const copy = clone.children[index];
    if (copy.dataset.movieId !== row.dataset.movieId) {
      clone.replaceChild(row.cloneNode(true), copy);
      return;
    }
    const numEl = copy.querySelector(".rank-row__num");
    const nameEl = copy.querySelector(".rank-row__name");
    const boxValEl = copy.querySelector(".rank-row__box-val");
    const boxUnitEl = copy.querySelector(".rank-row__box-unit");
    if (numEl) numEl.textContent = row.querySelector(".rank-row__num")?.textContent || "";
    if (nameEl) nameEl.textContent = row.querySelector(".rank-row__name")?.textContent || "";
    if (boxValEl) boxValEl.textContent = row.querySelector(".rank-row__box-val")?.textContent || "";
    if (boxUnitEl) boxUnitEl.textContent = row.querySelector(".rank-row__box-unit")?.textContent || "";
    const round = row.querySelector(".rank-row__round");
    const roundCopy = copy.querySelector(".rank-row__round");
    if (round && roundCopy) {
      roundCopy.textContent = round.textContent;
      roundCopy.className = round.className;
    }
  });
}

function rebuildRankClone(list, track) {
  let clone = track.querySelector(".ranking-section__list--clone");
  if (!clone) {
    clone = document.createElement("div");
    clone.className = "ranking-section__list ranking-section__list--clone";
    clone.setAttribute("aria-hidden", "true");
    track.appendChild(clone);
  }
  clone.replaceChildren();
  [...list.children].forEach((row) => clone.appendChild(row.cloneNode(true)));
  return clone;
}

function updateRankingRows(movies, isFirst) {
  const track = $("#ranking-track");
  const list = $("#ranking-list");
  if (!track || !list) return;

  const rest = getRestMovies(movies);
  const structureKey = getRankStructureKey(movies);
  const structureChanged = structureKey !== rankStructureKey;
  rankStructureKey = structureKey;

  if (!rest.length) {
    list.replaceChildren();
    track.querySelector(".ranking-section__list--clone")?.remove();
    track.classList.remove("ranking-section__track--scroll");
    track.style.removeProperty("--rank-scroll-duration");
    return;
  }

  const activeIds = new Set();
  rest.forEach((movie, index) => {
    const key = String(movie.movieId);
    activeIds.add(key);
    const row = ensureRankRow(movie, index, list);
    if (row) updateRankRow(row, movie, isFirst);
  });

  [...list.children].forEach((row) => {
    const id = row.dataset.movieId;
    if (!activeIds.has(id)) {
      row.remove();
      prevState.movies.delete(id);
      prevState.ranks.delete(id);
    }
  });

  const viewport = $("#ranking-viewport");
  const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rank-row-h")) || 76;
  const gap = 8;
  const visibleRows = viewport
    ? Math.max(1, Math.floor((viewport.clientHeight + gap) / (rowH + gap)))
    : 4;
  const shouldScroll = rest.length > visibleRows;

  if (!shouldScroll) {
    track.querySelector(".ranking-section__list--clone")?.remove();
    track.classList.remove("ranking-section__track--scroll");
    track.style.removeProperty("--rank-scroll-duration");
    return;
  }

  let clone = track.querySelector(".ranking-section__list--clone");
  if (structureChanged || !clone) {
    clone = rebuildRankClone(list, track);
  } else {
    syncRankClone(list, clone);
  }

  track.style.setProperty("--rank-scroll-duration", `${Math.max(rest.length * RANK_SCROLL_SEC_PER_ROW, 12)}s`);
  track.classList.add("ranking-section__track--scroll");
}

function clearPodiumSlot(rank) {
  const slot = $(`.podium__slot[data-rank="${rank}"]`);
  if (slot) slot.replaceChildren();
}

export function renderDashboard(movies, nation, parsed, options = {}) {
  const list = movies || [];
  const isFirst = isFirstRender;
  const isUpdating = Boolean(options.isUpdating);

  updateOverview(nation, parsed, isUpdating);

  for (const rank of [1, 2, 3]) {
    const movie = list.find((m) => m.rank === rank);
    if (movie) updatePodiumCard(movie, isFirst);
    else clearPodiumSlot(rank);
  }

  updateRankingRows(list, isFirst);

  if (isFirstRender && list.length) isFirstRender = false;
}

export function resetDashboardState() {
  isFirstRender = true;
  rankStructureKey = "";
  prevState.movies.clear();
  prevState.ranks.clear();
  prevState.nationBox = 0;
  prevState.nationHtml = "";
  prevState.nationViews = "";
  prevState.nationAvg = "";
}
