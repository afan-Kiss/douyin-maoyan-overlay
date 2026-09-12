import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME_PATH = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const mockMovies = [
  {
    movieId: 1,
    rank: 1,
    name: "欢迎来龙餐馆",
    todayBox: 405.85,
    todayUnit: "万",
    boxRate: "20.5",
    showCountRate: "28.2",
    avgSeatView: "0.8",
    dynamicForecast: "1032.40 万",
  },
  { movieId: 2, rank: 2, name: "八仙", todayBox: 295.41, todayUnit: "万" },
  { movieId: 3, rank: 3, name: "奥德赛", todayBox: 282.32, todayUnit: "万" },
  { movieId: 4, rank: 4, name: "空枪", todayBox: 254.78, todayUnit: "万" },
  { movieId: 5, rank: 5, name: "功夫女足", todayBox: 251.22, todayUnit: "万" },
  { movieId: 6, rank: 6, name: "无名之辈", todayBox: 188.36, todayUnit: "万" },
  { movieId: 7, rank: 7, name: "深海奇缘", todayBox: 155.56, todayUnit: "万" },
  { movieId: 8, rank: 8, name: "星际归途", todayBox: 98.2, todayUnit: "万" },
  { movieId: 9, rank: 9, name: "火线救援", todayBox: 86.4, todayUnit: "万" },
  { movieId: 10, rank: 10, name: "春日物语", todayBox: 72.8, todayUnit: "万" },
];

const mockNation = { todayBox: 1973.17, todayUnit: "万" };
const mockParsed = { updateTimeText: "15:49:46" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const { server, baseUrl } = await startStaticServer(__dirname);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
        getOverlaySettings: async () => null,
        onSettingsChanged: () => () => {},
        getApiStatus: async () => ({ ready: false }),
        ensureApi: async () => ({ ready: false }),
        isLoggedIn: async () => true,
        startLogin: async () => {},
        onApiReady: () => () => {},
      };
    });

    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector("#top-card");

    await page.evaluate(
      async ({ movies, nation, parsed }) => {
        const { renderDashboard } = await import("./dashboard-view.js");
        const { applyMediaToMovies, loadMovieMedia } = await import("./data/movie-media.js");
        const { initTrailerPlayer, syncTrailerWithRanking } = await import("./trailer-player.js");
        const catalog = await loadMovieMedia();
        initTrailerPlayer();
        const enriched = applyMediaToMovies(movies, catalog);
        renderDashboard(enriched, nation, parsed);
        syncTrailerWithRanking(enriched);
      },
      { movies: mockMovies, nation: mockNation, parsed: mockParsed }
    );

    await page.waitForTimeout(1200);
    const out = path.join(__dirname, "preview-1080x1920.png");
    await page.screenshot({ path: out, fullPage: false });
    console.log("Screenshot saved:", out);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
