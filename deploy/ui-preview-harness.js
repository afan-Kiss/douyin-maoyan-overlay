/**
 * Shared preview harness for final layout / bubble coordinate captures.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");

const CHROME_CANDIDATES = [
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

function mockMovies(count = 10) {
  const names = [
    "哪吒之魔童闹海",
    "功夫女足",
    "欢迎来龙餐馆",
    "八仙",
    "蒸死比尔：血色全传",
    "奥德赛",
    "空枪",
    "测试缺海报甲",
    "测试缺海报乙",
    "测试缺海报丙",
  ];
  return Array.from({ length: count }, (_, i) => {
    const rank = i + 1;
    const todayBox = rank === 1 ? 852.22 : Number((312.4 + rank * 41.2).toFixed(2));
    return {
      movieId: 2000 + rank,
      rank,
      name: names[i] || `测试电影第${rank}名`,
      todayBox,
      todayUnit: "万",
      todayBoxText: rank === 1 ? "852.22" : todayBox.toFixed(2),
      displayBoxWan: todayBox,
      boxRate: `${(27.4 - rank * 1.2).toFixed(1)}%`,
      showCountRate: `${(26.0 - rank * 0.9).toFixed(1)}%`,
      avgShowView: `${Math.max(8, 35 - rank * 2)}`,
      sumBoxDesc: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
      poster: "",
    };
  });
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let filePath;
      if (urlPath.startsWith("/data/poster-cache/")) {
        filePath = path.normalize(path.join(ROOT, urlPath.slice(1)));
      } else {
        filePath = path.normalize(path.join(UI_DIR, urlPath === "/" ? "index.html" : urlPath));
      }
      const allowedRoot = urlPath.startsWith("/data/poster-cache/") ? ROOT : UI_DIR;
      if (!filePath.startsWith(allowedRoot)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function launchBrowser() {
  const chromePath = resolveChrome();
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (chromePath) return chromium.launch({ ...launchOpts, executablePath: chromePath });
  try {
    return await chromium.launch(launchOpts);
  } catch (error) {
    console.log(`SKIP: Chrome not found (${error.message || error})`);
    process.exit(2);
  }
}

async function openPreview(page, baseUrl, { liveOutput = false, width, height } = {}) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.overlay = {
      getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
      getOverlaySettings: async () => ({
        bubble: { enabled: true, minDelta: 0.001, fontSize: 26, durationMs: 3000, floatHeight: 48 },
        fonts: {},
      }),
      onSettingsChanged: () => () => {},
      getApiStatus: async () => ({ ready: false }),
      ensureApi: async () => ({ ready: false }),
      isLoggedIn: async () => false,
      getSessionStatus: async () => ({ detailApiReady: false, identityCookieExists: false }),
      startLogin: async () => {},
      onApiReady: () => () => {},
      resolvePosters: async () => [],
    };
  });
  const qs = liveOutput ? "preview=1&liveOutput=1" : "preview=1";
  await page.goto(`${baseUrl}/index.html?${qs}`);
  await page.waitForFunction(() => Boolean(window.__racePreview));
  await page.waitForTimeout(120);
}

async function paintMovies(page, movies) {
  await page.evaluate(({ movies }) => {
    const api = window.__racePreview;
    api.renderList(movies);
    api.updateNation(
      {
        todayBox: 2092.2,
        todayUnit: "万",
        todayBoxText: "2092.2",
        viewCountDesc: "999.9万",
        showCountDesc: "99999",
        seatValue: "5.6%",
      },
      { updateTimeText: "2026-09-18 12:00:00", calendar: { today: "2026-09-18" } },
    );
    api.setStatus("ok", "");
    for (const movie of movies) {
      window.__movieInteraction?.setMovieScore?.(movie.movieId, movie.rank === 1 ? 1280 : 100 * movie.rank);
    }
  }, { movies });
  await page.waitForTimeout(200);
}

async function diagnoseBubble(page, { kind, movieId }) {
  return page.evaluate(({ kind, movieId }) => {
    const card = document.querySelector(`.race-card[data-movie-id="${CSS.escape(String(movieId))}"]`);
    const layer = document.getElementById("global-bubble-layer");
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
    const layerRect = layer?.getBoundingClientRect();
    const localW = layer?.offsetWidth || 0;
    const localH = layer?.offsetHeight || 0;
    const scaleX = localW / (layerRect?.width || localW || 1);
    const scaleY = localH / (layerRect?.height || localH || 1);
    const toLocal = (rect) => ({
      left: (rect.left - layerRect.left) * scaleX,
      top: (rect.top - layerRect.top) * scaleY,
      right: (rect.right - layerRect.left) * scaleX,
      bottom: (rect.bottom - layerRect.top) * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
      centerX: ((rect.left + rect.right) / 2 - layerRect.left) * scaleX,
      centerY: ((rect.top + rect.bottom) / 2 - layerRect.top) * scaleY,
    });

    let bubble;
    let anchor;
    let anchorColumn;
    if (kind === "box") {
      anchorColumn = "dailyBox";
      anchor = card?.querySelector('[data-metric="dailyBox"]');
      bubble = layer?.querySelector(`.race-card__delta-float[data-movie-id="${CSS.escape(String(movieId))}"]`);
    } else {
      anchorColumn = "liveScore";
      anchor = card?.querySelector("[data-live-score]");
      bubble = [...(layer?.querySelectorAll(".score-bubble") || [])].find(
        (el) => el.dataset.anchorMovieId === String(movieId),
      );
    }
    if (!card || !layer || !anchor || !bubble) {
      return {
        ok: false,
        reason: "missing-dom",
        viewportScale: scale,
        anchorMovieId: String(movieId),
        anchorRank: Number(card?.dataset?.rank) || 0,
        anchorColumn,
      };
    }
    const anchorRect = toLocal(anchor.getBoundingClientRect());
    const bubbleRect = toLocal(bubble.getBoundingClientRect());
    const dx = bubbleRect.centerX - anchorRect.centerX;
    const dy = bubbleRect.centerY - anchorRect.centerY;
    return {
      ok: true,
      viewportScale: scale,
      layerRect: {
        left: layerRect.left,
        top: layerRect.top,
        width: layerRect.width,
        height: layerRect.height,
        localWidth: localW,
        localHeight: localH,
      },
      anchorRect,
      bubbleRect,
      anchorMovieId: String(movieId),
      anchorRank: Number(card.dataset.rank) || 0,
      anchorColumn,
      dx,
      dy,
      absDx: Math.abs(dx),
    };
  }, { kind, movieId });
}

module.exports = {
  ROOT,
  UI_DIR,
  mockMovies,
  startStaticServer,
  launchBrowser,
  openPreview,
  paintMovies,
  diagnoseBubble,
};
