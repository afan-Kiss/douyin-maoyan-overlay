import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  normalizeMovieName,
  findMovieMedia,
  applyMediaToMovie,
  resolveTrailerFallback,
  buildTrailerPlaylist,
} from "./data/movie-media.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.normalize(path.join(root, decodeURIComponent((req.url || "/").split("?")[0]) || "index.html"));
      if (!p.startsWith(root)) return res.writeHead(403).end();
      fs.readFile(p === root ? path.join(root, "index.html") : p, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/movie-media.json"), "utf-8"));

function makeMovie(rank, name, extra = {}) {
  return applyMediaToMovie({ movieId: rank, rank, name, todayBox: 100 + rank, todayUnit: "万", ...extra }, catalog);
}

const results = [];

function assert(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

async function main() {
  // 单元测试
  assert("normalize 《欢迎来龙餐馆》", normalizeMovieName("《欢迎来龙餐馆》") === normalizeMovieName("欢迎来龙餐馆"));
  assert("精确匹配", Boolean(findMovieMedia("八仙", catalog)));
  assert("别名不匹配其他片", findMovieMedia("欢迎来龙餐馆", catalog)?.name === "欢迎来龙餐馆");
  assert("无模糊串片", !findMovieMedia("欢迎", catalog));

  const top1 = makeMovie(1, "欢迎来龙餐馆");
  assert("TOP1 poster", top1.moviePoster.includes("posters/"));
  assert("TOP1 trailer", top1.trailerSrc.includes("welcome.mp4"));

  const fallback = resolveTrailerFallback([makeMovie(1, "不存在电影"), makeMovie(2, "八仙")], catalog);
  assert("TOP1无预告降级TOP2", fallback?.title === "八仙");

  const playlist = buildTrailerPlaylist([
    makeMovie(1, "欢迎来龙餐馆"),
    makeMovie(2, "功夫女足"),
    makeMovie(3, "八仙"),
  ], catalog);
  assert("playlist数量", playlist.length === 3);
  assert("playlist仅TOP10", playlist.every((p) => p.rank <= 10));

  const playlist10 = buildTrailerPlaylist(
    [
      makeMovie(1, "欢迎来龙餐馆"),
      makeMovie(2, "功夫女足"),
      makeMovie(3, "八仙"),
      makeMovie(4, "奥德赛"),
      makeMovie(5, "空枪"),
      makeMovie(6, "去你的岛"),
      makeMovie(7, "蜘蛛侠：崭新之日"),
      makeMovie(8, "痴迷"),
      makeMovie(9, "年会不能停2！"),
      makeMovie(10, "汪汪队立大功大电影3"),
    ],
    catalog
  );
  assert("TOP10 playlist数量", playlist10.length === 10);
  assert("TOP10 playlist顺序", playlist10[9]?.title?.includes("汪汪队"));

  const unmapped = applyMediaToMovie({ movieId: 99, rank: 4, name: "未配置测试片", todayBox: 1, todayUnit: "万" }, catalog);
  assert("未配置电影无预告", unmapped.trailerSrc === "");
  assert("未配置电影不借用他片预告", !buildTrailerPlaylist([unmapped], catalog).length);

  const { server, url } = await serve(__dirname);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

  await page.addInitScript(() => {
    window.overlay = {
      getConfig: async () => ({ apiBase: "", pollIntervalMs: 60000, topCount: 10 }),
      getOverlaySettings: async () => null,
      onSettingsChanged: () => () => {},
      getApiStatus: async () => ({ ready: false }),
      ensureApi: async () => ({ ready: false }),
      isLoggedIn: async () => true,
      startLogin: async () => {},
      onApiReady: () => () => {},
    };
  });

  await page.goto(`${url}/index.html`);

  const movies1 = [
    makeMovie(1, "欢迎来龙餐馆", { boxRate: "20.5", showCountRate: "28.2", avgSeatView: "0.8", dynamicForecast: "1032万" }),
    makeMovie(2, "八仙"),
    makeMovie(3, "奥德赛"),
    ...[4, 5, 6, 7, 8, 9, 10].map((r) => makeMovie(r, `电影${r}`)),
  ];

  await page.evaluate(async (movies) => {
    const { renderDashboard } = await import("./dashboard-view.js");
    const { initTrailerPlayer, syncTrailerWithRanking } = await import("./trailer-player.js");
    initTrailerPlayer();
    renderDashboard(movies, { todayBox: 1973, todayUnit: "万" }, {});
    syncTrailerWithRanking(movies);
  }, movies1);

  await page.waitForTimeout(800);

  const snap1 = await page.evaluate(() => ({
    top1Poster: document.querySelector(".podium-card--r1 .podium-card__hero-bg")?.style.backgroundImage || "",
    trailerTitle: document.getElementById("trailer-now")?.textContent || "",
    overlayTitle: document.getElementById("trailer-overlay-title")?.textContent || "",
    rankRows: document.querySelectorAll(".rank-row").length,
    videoSrc: document.getElementById("trailer-video")?.getAttribute("src") || "",
  }));

  assert("TOP1有海报背景", snap1.top1Poster.includes("welcome") || snap1.top1Poster.includes("default-movie-poster"));
  assert("预告标题匹配TOP1", snap1.trailerTitle.includes("欢迎来龙餐馆"));
  assert("overlay标题一致", snap1.overlayTitle.includes("欢迎来龙餐馆"));
  assert("排行榜至少4行", snap1.rankRows >= 4);
  assert("预告src含welcome", snap1.videoSrc.includes("welcome"));

  // TOP1切换
  const movies2 = movies1.map((m) => ({ ...m, rank: m.rank === 1 ? 2 : m.rank === 2 ? 1 : m.rank }));
  const swapped = movies2.map((m) => {
    if (m.name === "八仙") return { ...m, rank: 1 };
    if (m.name === "欢迎来龙餐馆") return { ...m, rank: 2 };
    return m;
  });

  await page.evaluate(async (movies) => {
    const { renderDashboard } = await import("./dashboard-view.js");
    const { syncTrailerWithRanking } = await import("./trailer-player.js");
    renderDashboard(movies, { todayBox: 1973, todayUnit: "万" }, {});
    syncTrailerWithRanking(movies);
  }, swapped);

  await page.waitForTimeout(1200);

  const snap2 = await page.evaluate(() => ({
    trailerTitle: document.getElementById("trailer-now")?.textContent || "",
    videoSrc: document.getElementById("trailer-video")?.getAttribute("src") || "",
  }));

  assert("TOP1切换后预告为八仙", snap2.trailerTitle.includes("八仙"));
  assert("预告src含baxian", snap2.videoSrc.includes("baxian"));

  // TOP1不变不重启
  const before = snap2.videoSrc;
  await page.evaluate(async (movies) => {
    const { syncTrailerWithRanking } = await import("./trailer-player.js");
    syncTrailerWithRanking(movies);
    syncTrailerWithRanking(movies);
  }, swapped);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById("trailer-video")?.getAttribute("src") || "");
  assert("TOP1未变不重启", before === after);

  await page.screenshot({ path: path.join(__dirname, "preview-1080x1920.png") });

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
