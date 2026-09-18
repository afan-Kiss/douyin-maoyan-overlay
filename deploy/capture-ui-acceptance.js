/**
 * 1080×1920 验收截图：整体 / TOP1 票房气泡 / TOP5 评分气泡 / 无海报 / 词云
 * node deploy/capture-ui-acceptance.js
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
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const NAMES = [
  "哪吒之魔童闹海",
  "封神第二部：战火西岐",
  "抓娃娃",
  "默杀",
  "云边有个小卖部",
  "异人之下",
  "志愿军：存亡之战",
  "解密",
  "刺猬",
  "浴火之路",
];

function movies() {
  return NAMES.map((name, i) => {
    const rank = i + 1;
    const todayBox = rank === 1 ? 852.22 : 120 + rank * 37.5;
    return {
      movieId: 7000 + rank,
      rank,
      name,
      todayBox,
      todayBoxText: todayBox.toFixed(2),
      displayBoxWan: todayBox,
      todayUnit: "万",
      boxRate: `${(22 - rank * 1.1).toFixed(1)}%`,
      showCountRate: `${(25 - rank).toFixed(1)}%`,
      // 第4名故意坏链，验收 onerror → fallback
      posterUrl: rank === 4 ? "assets/__missing_poster__.png" : undefined,
    };
  });
}

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) {
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

function resolveChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

async function freezeBubbles(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".global-bubble-layer .is-visible, .score-bubble").forEach((el) => {
      el.style.animation = "none";
      el.style.opacity = "1";
      el.style.visibility = "visible";
    });
  });
}

async function main() {
  const chromePath = resolveChrome();
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const { server, baseUrl } = await startStaticServer(UI_DIR);

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
        getOverlaySettings: async () => ({
          bubble: { enabled: true, minDelta: 0.001, fontSize: 26, durationMs: 8000, floatHeight: 44 },
          fonts: {},
        }),
        onSettingsChanged: () => () => {},
        getApiStatus: async () => ({ ready: false }),
        ensureApi: async () => ({ ready: false }),
        isLoggedIn: async () => false,
        getSessionStatus: async () => ({ detailApiReady: false, identityCookieExists: false }),
        startLogin: async () => {},
        onApiReady: () => () => {},
      };
    });
    await page.goto(`${baseUrl}/index.html?preview=1`);
    await page.waitForFunction(() => Boolean(window.__racePreview && window.__movieInteraction));

    await page.evaluate((list) => {
      const { renderList, setStatus } = window.__racePreview;
      renderList(list);
      setStatus("ok", "");
    }, movies());
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(UI_DIR, "1080x1920-top5.png") });

    await page.evaluate(() => {
      const card = document.querySelector('.race-card[data-rank="1"]');
      const bubble = card?.querySelector(".race-card__delta-float");
      window.__racePreview.pulseInlineDelta(bubble, 1413 / 10000, "shot-top1", { movieId: card?.dataset.movieId });
    });
    await page.waitForTimeout(350);
    await freezeBubbles(page);
    const top1 = await page.evaluate(() => {
      const bubble = document.querySelector("#global-bubble-layer .race-card__delta-float.is-visible");
      const board = document.querySelector(".ix-board")?.getBoundingClientRect();
      const br = bubble?.getBoundingClientRect();
      return {
        text: bubble?.textContent || "",
        inGlobal: Boolean(bubble),
        bubbleTop: br?.top,
        boardTop: board?.top,
        aboveBoard: br && board ? br.top < board.top + 8 : false,
        fullyAboveClip: br ? br.top >= 0 && br.bottom > 0 : false,
      };
    });
    console.log("TOP1 bubble:", top1);
    await page.screenshot({ path: path.join(UI_DIR, "bubble-top1-1413.png") });

    await page.evaluate(() => {
      document.querySelectorAll("#global-bubble-layer .race-card__delta-float").forEach((el) => el.remove());
      const card = document.querySelector('.race-card[data-rank="5"]');
      window.__movieInteraction.showMovieScoreBubble({
        eventId: "shot-score-5",
        nickname: "观众甲",
        movieId: card?.dataset.movieId,
        movieName: "云边有个小卖部",
        scoreDelta: 300,
      });
    });
    await page.waitForTimeout(250);
    await freezeBubbles(page);
    const score = await page.evaluate(() => {
      const el = document.querySelector("#global-bubble-layer .score-bubble");
      const r = el?.getBoundingClientRect();
      return { text: el?.textContent || "", top: r?.top, bottom: r?.bottom, clipped: r ? r.top < 0 || r.bottom > 1920 : true };
    });
    console.log("TOP5 score bubble:", score);
    await page.screenshot({ path: path.join(UI_DIR, "bubble-top5-score.png") });

    await page.evaluate(() => {
      document.querySelectorAll("#global-bubble-layer .score-bubble").forEach((el) => el.remove());
      // 强制坏链触发 onerror → fallback（验收用）
      const img = document.querySelector('.race-card[data-rank="4"] .race-row__poster');
      if (img) {
        img.dataset.posterFallbackApplied = "";
        img.src = "assets/__missing_poster__.png";
      }
    });
    await page.waitForTimeout(400);
    const poster = await page.evaluate(() => {
      const img = document.querySelector('.race-card[data-rank="4"] .race-row__poster');
      return { src: img?.getAttribute("src") || "", fallback: img?.classList.contains("race-row__poster--fallback") };
    });
    console.log("poster fallback:", poster);
    await page.screenshot({ path: path.join(UI_DIR, "poster-fallback.png") });

    await page.evaluate(() => {
      for (let i = 0; i < 20; i += 1) {
        window.__movieInteraction.addDanmaku({
          msgId: `cloud-${i}`,
          nickname: `观众${i + 1}`,
          content: ["好看", "好评", "泪目", "推荐", "差评", "精彩", "必看", "一般"][i % 8],
        });
      }
    });
    await page.waitForTimeout(400);
    const cloud = await page.evaluate(() => document.querySelectorAll(".ix-cloud__item").length);
    console.log("cloud items:", cloud);
    await page.screenshot({ path: path.join(UI_DIR, "word-cloud-20.png") });
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
