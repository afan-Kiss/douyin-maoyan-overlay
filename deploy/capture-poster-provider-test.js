/**
 * TOP7-TOP10 海报备用验收截图。
 * node deploy/capture-poster-provider-test.js
 */
const fs = require("fs");
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

const OUT = path.join(UI_DIR, "_captures", "poster-provider-test.png");
const CAPTURE_DIR = path.join(UI_DIR, "_captures", "provider-test");

const TARGETS = [
  { rank: 7, movieId: "top7-kill-bill", movieName: "杀死比尔：血色全传" },
  { rank: 8, movieId: "top8-stay", movieName: "我想留在你身边" },
  { rank: 9, movieId: "top9-midang", movieName: "密档" },
  { rank: 10, movieId: "top10-deathzone", movieName: "死亡禁区实录" },
];

function posterCacheCandidates() {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  const names = ["douyin-maoyan-overlay", "MaoyanOverlay", "maoyan-overlay"];
  const found = [];
  for (const root of roots) {
    for (const name of names) {
      const dir = path.join(root, name, "poster-cache");
      if (fs.existsSync(dir)) found.push(dir);
    }
  }
  if (!found.length && process.env.APPDATA) {
    const dir = path.join(process.env.APPDATA, "douyin-maoyan-overlay", "poster-cache");
    fs.mkdirSync(dir, { recursive: true });
    found.push(dir);
  }
  return found;
}

function clearNamedFailures(cacheDir) {
  for (const movie of TARGETS) {
    if (movie.rank < 9) continue;
    const cleared = clearPosterFailureCooldown({ cacheDir, movieName: movie.movieName });
    console.log(`cleared fail cache movie=${movie.movieName} count=${cleared.cleared} dir=${cacheDir}`);
  }
}

async function resolveTargets(cacheDir) {
  const results = [];
  for (const movie of TARGETS) {
    const rows = await resolveMissingPosters([{ movieId: movie.movieId, movieName: movie.movieName }], {
      cacheDir,
      posterRetry: true,
    });
    const row = rows[0] || {};
    results.push({
      rank: movie.rank,
      movieId: movie.movieId,
      movieName: movie.movieName,
      googleResult: row.googleResult || "",
      bingResult: row.bingResult || "",
      finalProvider: row.finalProvider || row.provider || "",
      posterSource: row.posterSource || "fallback",
      reason: row.reason || "",
      status: row.status || "",
      fileUrl: row.fileUrl || "",
      localPath: row.localPath || "",
    });
  }
  return results;
}

function copyForPreview(results) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const posterMap = new Map();
  for (const row of results) {
    if (!row.localPath || !fs.existsSync(row.localPath)) continue;
    const dest = path.join(CAPTURE_DIR, `${row.movieId}${path.extname(row.localPath) || ".jpg"}`);
    fs.copyFileSync(row.localPath, dest);
    posterMap.set(row.movieId, `./_captures/provider-test/${path.basename(dest)}`);
  }
  return posterMap;
}

async function capture(results, posterMap) {
  const { server, baseUrl } = await startStaticServer();
  const browser = await launchBrowser();
  try {
    const movies = mockMovies(10).map((movie, index) => {
      const rank = index + 1;
      const hit = TARGETS.find((item) => item.rank === rank);
      if (!hit) return movie;
      const src = posterMap.get(hit.movieId) || "";
      return {
        ...movie,
        movieId: hit.movieId,
        name: hit.movieName,
        moviePoster: src,
        posterUrl: src,
        poster: src,
      };
    });
    const page = await browser.newPage();
    await openPreview(page, baseUrl, { width: 1080, height: 1920, liveOutput: true });
    await paintMovies(page, movies);
    await page.evaluate((rows) => {
      for (const row of rows) {
        const card = document.querySelector(`.race-card[data-movie-id="${row.movieId}"]`);
        if (!card || row.posterSource !== "fallback") continue;
        const film = card.querySelector(".race-row__film");
        if (!film) continue;
        film.style.position = "relative";
        const label = document.createElement("div");
        label.textContent = `fallback:${row.googleResult || "-"}/${row.bingResult || row.reason || "unknown"}`;
        label.setAttribute("data-poster-fallback-reason", label.textContent);
        label.style.cssText =
          "position:absolute;left:0;right:0;bottom:0;z-index:6;background:rgba(0,0,0,.78);color:#fff;font-size:14px;line-height:1.3;padding:2px 4px;";
        film.appendChild(label);
      }
    }, results);
    await page.waitForTimeout(500);
    await page.screenshot({ path: OUT, fullPage: false });
    await page.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

async function main() {
  const caches = posterCacheCandidates();
  const cacheDir = caches[0];
  console.log("cacheDir:", cacheDir);
  for (const dir of caches) clearNamedFailures(dir);
  const results = await resolveTargets(cacheDir);
  console.log("\n=== TOP7-TOP10 ===");
  for (const row of results) {
    console.log(
      [
        row.movieName,
        `google:${row.googleResult || "-"}`,
        `bing:${row.bingResult || "-"}`,
        `final:${row.posterSource}`,
        `provider:${row.finalProvider || "-"}`,
        row.reason ? `reason:${row.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    console.log("---");
  }
  const posterMap = copyForPreview(results);
  await capture(results, posterMap);
  console.log("screenshot:", OUT);
  console.log("PASS capture-poster-provider-test");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
