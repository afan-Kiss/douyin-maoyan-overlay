import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME_PATH = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const titles = [];

    page.on("console", (msg) => {
      if (msg.type() === "warning" && String(msg.text()).includes("[trailer]")) {
        titles.push(`warn:${msg.text()}`);
      }
    });

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

    await page.goto(`${baseUrl}/index.html`);

    await page.evaluate(async () => {
      const { applyMediaToMovie, getMovieMediaCatalog } = await import("./data/movie-media.js");
      const { renderDashboard } = await import("./dashboard-view.js");
      const { initTrailerPlayer, syncTrailerWithRanking } = await import("./trailer-player.js");
      const catalog = getMovieMediaCatalog();
      const names = [
        "欢迎来龙餐馆",
        "功夫女足",
        "八仙",
        "奥德赛",
        "空枪",
        "去你的岛",
        "蜘蛛侠：崭新之日",
        "痴迷",
        "年会不能停2！",
        "汪汪队立大功大电影3",
      ];
      const movies = names.map((name, i) =>
        applyMediaToMovie(
          { movieId: i + 1, rank: i + 1, name, todayBox: 1000 - i * 50, todayUnit: "万" },
          catalog
        )
      );
      initTrailerPlayer();
      renderDashboard(movies, { todayBox: 1973, todayUnit: "万" }, {});
      syncTrailerWithRanking(movies, catalog);
    });

    await page.waitForSelector("#trailer-video:not(.trailer-section__video--hidden)");

    const readNow = () => page.locator("#trailer-now").textContent();

    await page.waitForFunction(() => {
      const v = document.getElementById("trailer-video");
      return v && !v.paused && v.readyState >= 3;
    }, null, { timeout: 15000 });

    const first = await readNow();
    titles.push(`play1:${first}`);

    await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      v.currentTime = Math.max(0, v.duration - 0.05);
    });
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      v.dispatchEvent(new Event("ended"));
    });
    await page.waitForTimeout(1500);
    titles.push(`play2:${await readNow()}`);

    await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      v.dispatchEvent(new Event("ended"));
    });
    await page.waitForTimeout(1500);
    titles.push(`play3:${await readNow()}`);

    await page.evaluate(() => {
      const v = document.getElementById("trailer-video");
      v.dispatchEvent(new Event("ended"));
    });
    await page.waitForTimeout(1500);
    titles.push(`play4:${await readNow()}`);

    const hasControls = await page.evaluate(() => !document.getElementById("trailer-video").controls);
    const muted = await page.evaluate(() => document.getElementById("trailer-video").muted);
    const emptyHidden = await page.evaluate(() => document.getElementById("trailer-empty").hidden);

    console.log(JSON.stringify({ titles, hasControls, muted, emptyHidden }, null, 2));

    const ok =
      titles.some((t) => t.includes("欢迎来龙餐馆")) &&
      titles.some((t) => t.includes("功夫女足")) &&
      titles.some((t) => t.includes("八仙")) &&
      hasControls &&
      muted &&
      emptyHidden;

    if (!ok) process.exit(1);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
