import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".jpg": "image/jpeg" };

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

const mockMovies = [
  { movieId: 1, rank: 1, name: "欢迎来龙餐馆", todayBox: 1079.36, todayUnit: "万", boxRate: "50.8", showCountRate: "28.2", avgSeatView: "13.1", dynamicForecast: "23.51亿" },
  { movieId: 2, rank: 2, name: "功夫女足", todayBox: 312.4, todayUnit: "万", boxRate: "14.7", showCountRate: "18.5", avgSeatView: "9.2" },
  { movieId: 3, rank: 3, name: "八仙", todayBox: 212.4, todayUnit: "万", boxRate: "10.0", showCountRate: "15.1", avgSeatView: "8.4" },
  { movieId: 4, rank: 4, name: "奥德赛", todayBox: 188.2, todayUnit: "万", boxRate: "8.8", showCountRate: "12.3", avgSeatView: "7.1" },
  { movieId: 5, rank: 5, name: "城市边缘3", todayBox: 155.6, todayUnit: "万", boxRate: "7.3", showCountRate: "10.2", avgSeatView: "6.5" },
  { movieId: 6, rank: 6, name: "重庆漫长", todayBox: 132.1, todayUnit: "万", boxRate: "6.2", showCountRate: "9.1", avgSeatView: "5.8" },
  { movieId: 7, rank: 7, name: "天罡之日", todayBox: 118.5, todayUnit: "万", boxRate: "5.6", showCountRate: "8.4", avgSeatView: "5.2" },
  { movieId: 8, rank: 8, name: "深海迷航", todayBox: 98.2, todayUnit: "万", boxRate: "4.6", showCountRate: "7.2", avgSeatView: "4.8" },
  { movieId: 9, rank: 9, name: "星际归途", todayBox: 86.4, todayUnit: "万", boxRate: "4.1", showCountRate: "6.5", avgSeatView: "4.2" },
  { movieId: 10, rank: 10, name: "春日物语", todayBox: 72.8, todayUnit: "万", boxRate: "3.4", showCountRate: "5.8", avgSeatView: "3.9" },
];

const VIEWPORTS = [
  { name: "1080x1920", width: 1080, height: 1920 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "800x900", width: 800, height: 900 },
];

async function main() {
  const { server, url } = await serve(__dirname);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const results = [];

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({ apiBase: "", pollIntervalMs: 60000, topCount: 5 }),
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
    await page.evaluate(async ({ movies }) => {
      const { renderDashboard } = await import("./dashboard-view.js");
      renderDashboard(movies, {
        todayBox: 2126.8,
        todayUnit: "万",
        viewCountDesc: "33.0万",
        showCountDesc: "6880",
      }, { updateTimeText: "2026-09-11 18:14:32" });
    }, { movies: mockMovies });
    await page.waitForTimeout(500);

    const metrics = await page.evaluate(() => {
      const canvas = document.getElementById("viewport");
      const canvasRect = canvas.getBoundingClientRect();
      const footer = document.querySelector(".live-footer");
      const footerRect = footer?.getBoundingClientRect();
      const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
      const podiumR1 = document.querySelector(".podium-card--r1");
      const rankScroll = document.getElementById("ranking-track")?.classList.contains("ranking-section__track--scroll");
      return {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        canvasW: canvasRect.width,
        canvasH: canvasRect.height,
        canvasTop: canvasRect.top,
        canvasBottom: canvasRect.bottom,
        scale,
        podiumR1Height: podiumR1?.offsetHeight,
        rankRows: document.querySelectorAll(".rank-row").length,
        rankScroll,
        footerVisible: footerRect ? footerRect.bottom <= window.innerHeight && footerRect.top >= 0 : false,
        footerInCanvas: footer ? footer.offsetTop + footer.offsetHeight <= 1920 : false,
        hasPreviewStage: !!document.querySelector(".preview-stage"),
      };
    });

    const out = path.join(__dirname, `preview-${vp.name}.png`);
    await page.screenshot({ path: out });
    results.push({ viewport: vp.name, out, metrics });
    await page.close();
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
