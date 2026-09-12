import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME_CANDIDATES = [
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function resolveChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

const mockMovies = [
  {
    movieId: 1,
    rank: 1,
    name: "欢迎来龙餐馆",
    todayBox: 1455.07,
    todayUnit: "万",
    todayBoxText: "1455.07",
    boxRate: "24.7%",
    showCountRate: "25.7%",
    avgSeatView: "2.7%",
    mainlandBox: "￥21亿3908.11万",
    hmtBox: "￥1280.5万",
    overseasBox: "￥320.0万",
    endDate: "2026-10-12",
    remainingDays: "29",
    dynamicForecast: "2426.91万",
    dynamicTrend: "up",
    yesterdayTotal: "1074.85万",
    dailyIncrease: "1455.07万",
    hourSpeedText: "181.31万",
    yesterdaySamePeriodText: "508.62万",
    yesterdayHourSpeedText: "76.50万",
    totalViews: "5887.90万",
    totalForecast: "￥22亿3640.20万",
    totalTrend: "up",
    dailyTable: [
      {
        label: "今日",
        box: "1455.07万",
        forecast: "2487.60万",
        boxRate: "24.7%",
        showCountRate: "25.7%",
        avgSeatView: "2.7%",
      },
      {
        label: "明日",
        box: "79.83万",
        forecast: "1915.50万",
        boxRate: "9.5%",
        showCountRate: "26.3%",
        avgSeatView: "0.1%",
      },
      {
        label: "后天",
        box: "6.35万",
        forecast: "632.10万",
        boxRate: "1.8%",
        showCountRate: "27.8%",
        avgSeatView: "<0.1%",
      },
    ],
  },
  {
    movieId: 2,
    rank: 2,
    name: "八仙",
    todayBox: 980.22,
    todayUnit: "万",
    boxRate: "16.7%",
    showCountRate: "18.2%",
    avgSeatView: "1.9%",
    mainlandBox: "￥3亿210.40万",
    endDate: "2026-09-28",
    remainingDays: "15",
    dynamicForecast: "1520.10万",
    dynamicTrend: "up",
    yesterdayTotal: "860.12万",
    dailyIncrease: "980.22万",
    hourSpeedText: "112.40万",
    yesterdaySamePeriodText: "401.20万",
    yesterdayHourSpeedText: "58.30万",
    totalViews: "980.50万",
    totalForecast: "￥3亿880.00万",
    dailyTable: [
      { label: "今日", box: "980.22万", forecast: "1520.10万", boxRate: "16.7%", showCountRate: "18.2%", avgSeatView: "1.9%" },
      { label: "明日", box: "45.10万", forecast: "980.00万", boxRate: "6.2%", showCountRate: "17.8%", avgSeatView: "0.2%" },
      { label: "后天", box: "3.20万", forecast: "410.00万", boxRate: "1.1%", showCountRate: "17.5%", avgSeatView: "<0.1%" },
    ],
  },
  {
    movieId: 3,
    rank: 3,
    name: "奥德赛",
    todayBox: 720.55,
    todayUnit: "万",
    boxRate: "12.3%",
    showCountRate: "14.5%",
    avgSeatView: "1.4%",
    mainlandBox: "￥1亿120.88万",
    endDate: "2026-10-02",
    remainingDays: "19",
    dynamicForecast: "990.40万",
    dynamicTrend: "down",
    yesterdayTotal: "701.20万",
    dailyIncrease: "720.55万",
    hourSpeedText: "88.10万",
    yesterdaySamePeriodText: "355.00万",
    yesterdayHourSpeedText: "61.20万",
    totalViews: "420.30万",
    totalForecast: "￥1亿460.00万",
    dailyTable: [
      { label: "今日", box: "720.55万", forecast: "990.40万", boxRate: "12.3%", showCountRate: "14.5%", avgSeatView: "1.4%" },
      { label: "明日", box: "28.00万", forecast: "720.00万", boxRate: "4.1%", showCountRate: "14.2%", avgSeatView: "0.1%" },
      { label: "后天", box: "2.10万", forecast: "280.00万", boxRate: "0.8%", showCountRate: "13.9%", avgSeatView: "<0.1%" },
    ],
  },
];

for (let i = 4; i <= 10; i++) {
  mockMovies.push({
    movieId: i,
    rank: i,
    name: `影片样例${i}`,
    todayBox: Math.max(40, 520 - i * 45),
    todayUnit: "万",
    boxRate: `${(10 - i * 0.7).toFixed(1)}%`,
    showCountRate: `${(12 - i * 0.5).toFixed(1)}%`,
    avgSeatView: `${Math.max(0.2, 1.8 - i * 0.12).toFixed(1)}%`,
    mainlandBox: `￥${(i * 0.3).toFixed(2)}亿`,
    endDate: "2026-10-20",
    remainingDays: String(30 + i),
    dynamicForecast: `${(600 - i * 40).toFixed(2)}万`,
    yesterdayTotal: `${(400 - i * 20).toFixed(2)}万`,
    dailyIncrease: `${Math.max(40, 520 - i * 45).toFixed(2)}万`,
    hourSpeedText: `${(70 - i * 4).toFixed(2)}万`,
    yesterdaySamePeriodText: `${(200 - i * 10).toFixed(2)}万`,
    yesterdayHourSpeedText: `${(40 - i * 2).toFixed(2)}万`,
    totalViews: `${(100 + i * 12).toFixed(2)}万`,
    totalForecast: `￥${(i * 0.45).toFixed(2)}亿`,
    dailyTable: [
      {
        label: "今日",
        box: `${Math.max(40, 520 - i * 45).toFixed(2)}万`,
        forecast: `${(600 - i * 40).toFixed(2)}万`,
        boxRate: `${(10 - i * 0.7).toFixed(1)}%`,
        showCountRate: `${(12 - i * 0.5).toFixed(1)}%`,
        avgSeatView: `${Math.max(0.2, 1.8 - i * 0.12).toFixed(1)}%`,
      },
      {
        label: "明日",
        box: `${(20 - i).toFixed(2)}万`,
        forecast: `${(400 - i * 25).toFixed(2)}万`,
        boxRate: `${Math.max(0.5, 5 - i * 0.3).toFixed(1)}%`,
        showCountRate: `${(12 - i * 0.4).toFixed(1)}%`,
        avgSeatView: "0.1%",
      },
      {
        label: "后天",
        box: `${Math.max(1, 8 - i * 0.4).toFixed(2)}万`,
        forecast: `${(180 - i * 10).toFixed(2)}万`,
        boxRate: `${Math.max(0.2, 1.5 - i * 0.1).toFixed(1)}%`,
        showCountRate: `${(12 - i * 0.3).toFixed(1)}%`,
        avgSeatView: "<0.1%",
      },
    ],
  });
}

const mockNation = {
  todayBoxHtml: "",
  todayBox: 5868.94,
  todayUnit: "万",
  showCountDesc: "33.0万",
  viewCountDesc: "128.4万",
};

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
  const chromePath = resolveChrome();
  const { server, baseUrl } = await startStaticServer(__dirname);
  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
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

    await page.goto(`${baseUrl}/index.html?preview=1`);
    await page.waitForFunction(() => Boolean(window.__racePreview));

    await page.evaluate(
      ({ movies, nation }) => {
        const { renderList, updateNation, setStatus } = window.__racePreview;
        renderList(movies);
        updateNation(nation, {
          updateTimeText: "2026-09-12 16:42:38",
          calendar: { today: "2026-09-12" },
        });
        setStatus("ok", "");
      },
      { movies: mockMovies, nation: mockNation }
    );

    await page.waitForTimeout(800);
    const out = path.join(__dirname, "preview-race-1080x1920.png");
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
