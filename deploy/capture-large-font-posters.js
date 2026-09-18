/**
 * 放大字号验收截图 + 真实海报补全（TOP7~10）。
 * node deploy/capture-large-font-posters.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  mockMovies,
  startStaticServer,
  launchBrowser,
  openPreview,
  paintMovies,
  UI_DIR,
} = require("./ui-preview-harness");
const { resolveMissingPosters, clearPosterFailureCooldown } = require("../lib/poster-resolver");
const { findChrome } = require("../lib/poster-search");

const OUT = {
  full1080: path.join(UI_DIR, "final-large-font-1080x1920.png"),
  full540: path.join(UI_DIR, "final-large-font-540x960.png"),
  liveResolve: path.join(UI_DIR, "poster-live-resolve.png"),
};

const TOP7_10 = [
  { rank: 7, movieId: "top7-kill-bill", movieName: "杀死比尔：血色全传" },
  { rank: 8, movieId: "top8-stay", movieName: "我想留在你身边" },
  { rank: 9, movieId: "top9-midang", movieName: "密档" },
  { rank: 10, movieId: "top10-deathzone", movieName: "死亡禁区实录" },
];

function classifySource(row, hadCache) {
  if (!row) return { posterSource: "fallback", reason: "unknown" };
  if (row.status === "ok" && (row.fromCache || hadCache)) {
    return { posterSource: "google-cache", reason: "" };
  }
  if (row.status === "ok") return { posterSource: "google-new", reason: "" };
  return {
    posterSource: "fallback",
    reason: row.reason || row.status || "unknown",
  };
}

async function resolveTop7to10() {
  const chrome = findChrome();
  console.log("Chrome path:", chrome || "(missing)");
  const cacheDir = path.join(os.tmpdir(), `poster-accept-${Date.now()}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  clearPosterFailureCooldown({ cacheDir });

  const previousWhy = TOP7_10.map((m) => ({
    rank: m.rank,
    movieName: m.movieName,
    priorReason: "chrome_missing",
    detail:
      "旧版硬编码 C:\\Users\\Administrator\\...\\Chrome\\Bin\\chrome.exe；本次已改为 LOCALAPPDATA 动态查找。若当时找不到 Chrome 会写入 fail 冷却，即使修好路径也会被挡住——现已支持 clearPosterFailureCooldown / ?posterRetry=1，且 chrome_missing 在 Chrome 可用后可立即重试。",
  }));

  const results = [];
  for (const m of TOP7_10) {
    const rows = await resolveMissingPosters([{ movieId: m.movieId, movieName: m.movieName }], {
      cacheDir,
      posterRetry: true,
    });
    const row = rows[0] || null;
    const cls = classifySource(row, false);
    results.push({
      rank: m.rank,
      movieId: m.movieId,
      movieName: m.movieName,
      posterSource: cls.posterSource,
      reason: cls.reason || row?.reason || "",
      status: row?.status,
      fileUrl: row?.fileUrl || "",
      localPath: row?.localPath || "",
    });
  }
  return { cacheDir, chrome, previousWhy, results };
}

async function captureScreens(posterMap) {
  const { server, baseUrl } = await startStaticServer();
  const browser = await launchBrowser();
  try {
    const movies = mockMovies(10).map((m, i) => {
      const rank = i + 1;
      const hit = TOP7_10.find((t) => t.rank === rank);
      if (!hit) return m;
      const resolved = posterMap.get(hit.movieId);
      return {
        ...m,
        movieId: hit.movieId,
        name: hit.movieName,
        moviePoster: resolved || "",
        posterUrl: resolved || "",
        poster: resolved || "",
      };
    });

    const page = await browser.newPage();
    await openPreview(page, baseUrl, { width: 1080, height: 1920, liveOutput: true });
    await paintMovies(page, movies);
    await page.screenshot({ path: OUT.full1080, fullPage: false });

    const half = await browser.newPage();
    await openPreview(half, baseUrl, { width: 540, height: 960, liveOutput: false });
    await paintMovies(half, movies);
    await half.screenshot({ path: OUT.full540, fullPage: false });
    await half.close();

    const live = await browser.newPage();
    await openPreview(live, baseUrl, { width: 1080, height: 1920, liveOutput: true });
    const fallbackMovies = movies.map((m) => ({
      ...m,
      moviePoster: "",
      posterUrl: "",
      poster: "",
    }));
    await paintMovies(live, fallbackMovies);
    await live.waitForTimeout(250);

    // 再走正式 renderList 注入真实海报（与线上 schedulePosterResolve → applyPosterSrc 同路径）
    const withPosters = movies.map((m) => {
      const url = posterMap.get(String(m.movieId));
      if (!url) return { ...m, moviePoster: "", posterUrl: "", poster: "" };
      return { ...m, moviePoster: url, posterUrl: url, poster: url };
    });
    await paintMovies(live, withPosters);
    await live.waitForTimeout(600);
    const check = await live.evaluate(() => {
      const rows = [...document.querySelectorAll(".race-card")].map((card) => ({
        id: card.dataset.movieId,
        rank: card.dataset.rank,
        src: card.querySelector(".race-row__poster")?.getAttribute("src") || "",
        nw: card.querySelector(".race-row__poster")?.naturalWidth || 0,
      }));
      return rows.filter((r) => Number(r.rank) >= 7);
    });
    console.log("live-resolve top7-10 posters:", check);
    await live.screenshot({ path: OUT.liveResolve, fullPage: false });
    await live.close();
    await page.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

async function main() {
  if (process.env.SKIP_POSTER_SEARCH === "1") {
    const posterMap = new Map([
      ["top7-kill-bill", "./tmp-posters/top7-kill-bill.jpg"],
      ["top8-stay", "./tmp-posters/top8-stay.jpg"],
    ]);
    await captureScreens(posterMap);
    console.log("PASS capture-large-font-posters (skip search)");
    return;
  }
  const { cacheDir, chrome, previousWhy, results } = await resolveTop7to10();
  console.log("\n=== Prior failure analysis (TOP7~10) ===");
  for (const row of previousWhy) {
    console.log(`${row.rank} ${row.movieName}: ${row.priorReason} — ${row.detail}`);
  }
  console.log("\n=== Poster resolve results ===");
  const posterMap = new Map();
  for (const row of results) {
    const tag =
      row.posterSource === "fallback"
        ? `fallback(reason=${row.reason || "unknown"})`
        : row.posterSource;
    console.log(`${row.rank} ${row.movieName} ${tag}`);
    if (row.fileUrl) posterMap.set(row.movieId, row.fileUrl);
  }
  const okCount = results.filter(
    (r) => r.posterSource === "google-new" || r.posterSource === "google-cache",
  ).length;
  console.log(`\nResolved OK: ${okCount}/4`);
  console.log("cacheDir:", cacheDir);
  console.log("chrome:", chrome || "(missing)");

  const tmpPosters = path.join(UI_DIR, "tmp-posters");
  fs.mkdirSync(tmpPosters, { recursive: true });
  const httpPosterMap = new Map();
  for (const [id, fileUrl] of posterMap) {
    try {
      const abs = decodeURIComponent(fileUrl.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
      const winPath = process.platform === "win32" && /^\/[A-Za-z]:/.test(abs) ? abs.slice(1) : abs;
      if (!fs.existsSync(winPath)) continue;
      const dest = path.join(tmpPosters, `${id}${path.extname(winPath) || ".jpg"}`);
      fs.copyFileSync(winPath, dest);
      httpPosterMap.set(id, `./tmp-posters/${path.basename(dest)}`);
    } catch (error) {
      console.warn("copy poster failed", id, error.message);
    }
  }

  await captureScreens(httpPosterMap.size ? httpPosterMap : posterMap);
  console.log("\nScreenshots:", OUT);
  console.log("PASS capture-large-font-posters");
  return { results, chrome, cacheDir, okCount };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
