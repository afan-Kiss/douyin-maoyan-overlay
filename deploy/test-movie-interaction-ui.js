/**
 * 电影互动榜 UI / demo / 评分气泡回归
 * node deploy/test-movie-interaction-ui.js
 */
const assert = require("assert");
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
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) return res.writeHead(403).end();
      fs.readFile(filePath, (err, data) => {
        if (err) return res.writeHead(404).end();
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
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  const opts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (chromePath) return chromium.launch({ ...opts, executablePath: chromePath });
  try {
    return await chromium.launch(opts);
  } catch (error) {
    console.log(`SKIP: Chrome not found (${error.message || error})`);
    process.exit(2);
  }
}

function sampleMovies() {
  return Array.from({ length: 10 }, (_, i) => ({
    movieId: 2000 + i,
    rank: i + 1,
    name: `真实影片${i + 1}`,
    todayBox: 100 + i * 11,
    todayBoxText: String(100 + i * 11),
    displayBoxWan: 100 + i * 11,
    todayUnit: "万",
    boxRate: `${(20 - i).toFixed(1)}%`,
    showCountRate: `${(18 - i).toFixed(1)}%`,
  }));
}

async function main() {
  const { server, baseUrl } = await startStaticServer(UI_DIR);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    page.on("pageerror", (err) => console.error("PAGEERROR", err.message));
    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({
          apiBase: "http://127.0.0.1:8765",
          pollIntervalMs: 60000,
          topCount: 10,
        }),
        getOverlaySettings: async () => ({ bubble: { enabled: true, durationMs: 2000 } }),
        onSettingsChanged: () => () => {},
        getApiStatus: async () => ({ ready: false }),
        ensureApi: async () => ({ ready: false }),
        isLoggedIn: async () => true,
        getSessionStatus: async () => ({
          detailApiReady: true,
          identityCookieExists: true,
          sessionUsable: true,
        }),
        startLogin: async () => {},
        onApiReady: () => () => {},
      };
    });

    await page.goto(`${baseUrl}/index.html?preview=1`);
    await page.waitForFunction(() => Boolean(window.__racePreview), { timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.__movieInteraction), { timeout: 5000 });

    await page.evaluate((movies) => {
      window.__racePreview.renderList(movies);
      window.__racePreview.setStatus("ok", "");
    }, sampleMovies());

    const normal = await page.evaluate(() => {
      const demoItems = [...document.querySelectorAll(".ix-cloud__item")].map((el) => el.textContent);
      const scores = [...document.querySelectorAll("[data-live-score]")].map((el) =>
        el.textContent.trim(),
      );
      const goods = [...document.querySelectorAll("[data-good-user-count]")].map((el) =>
        el.textContent.trim(),
      );
      const bads = [...document.querySelectorAll("[data-bad-user-count]")].map((el) =>
        el.textContent.trim(),
      );
      return {
        title: document.querySelector(".ix-title")?.textContent?.trim(),
        cloudCount: demoItems.length,
        scoresAllZero: scores.every((s) => s === "0"),
        votesAllZero: goods.every((s) => s === "0") && bads.every((s) => s === "0"),
        body: document.body.innerText,
        duration: window.__movieInteraction.SCORE_BUBBLE_DURATION_MS,
        scroll: {
          docH: document.documentElement.scrollHeight,
          stageH: document.querySelector(".stage")?.scrollHeight || 0,
          stageClient: document.querySelector(".stage")?.clientHeight || 0,
        },
      };
    });

    assert.strictEqual(normal.title, "电影互动榜");
    assert.strictEqual(normal.cloudCount, 0, "正常模式不应有假弹幕");
    assert.ok(normal.scoresAllZero, "正常模式评分应为 0");
    assert.ok(normal.votesAllZero, "正式模式禁止生成假人数");
    assert.ok(!/好看推荐|不好看啊/.test(normal.body));
    assert.ok(/好看/.test(normal.body) && /不好看/.test(normal.body));
    assert.ok(/直播间评分/.test(normal.body));
    assert.ok(/互动方式/.test(normal.body));
    assert.ok(/1钻/.test(normal.body) && /10分/.test(normal.body));
    assert.ok(/3分钟/.test(normal.body));
    assert.ok(/好评/.test(normal.body) && /差评/.test(normal.body));
    assert.ok(/仅供娱乐/.test(normal.body));
    assert.strictEqual(normal.duration, 10000, "评分气泡应为 10 秒");
    assert.ok(normal.scroll.docH <= 1921, `scrollHeight=${normal.scroll.docH}`);
    assert.ok(normal.scroll.stageH <= normal.scroll.stageClient + 2, "stage 不应纵向滚动");

    await page.goto(`${baseUrl}/index.html?preview=1&interactionDemo=1`);
    await page.waitForFunction(() => Boolean(window.__racePreview && window.__movieInteraction), {
      timeout: 15000,
    });
    await page.clock.install();
    await page.evaluate((movies) => {
      window.__racePreview.renderList(movies);
      window.__racePreview.setStatus("ok", "");
      window.__movieInteraction.updateMovieCatalog(movies);
      movies.forEach((m, i) => {
        const presets = [28000, 2400, 1200, -300, 8600, 150, -1200, 42000, 980, -50];
        window.__movieInteraction.setMovieScore(m.movieId, presets[i]);
      });
      window.__movieInteraction.showMovieScoreBubble({
        eventId: "test-bubble-1",
        nickname: "张三",
        movieId: movies[0].movieId,
        movieName: movies[0].name,
        action: "好评",
        scoreDelta: 300,
        totalScore: 28300,
      });
    }, sampleMovies());

    await page.waitForTimeout(300);
    const demo = await page.evaluate(() => {
      const scores = [...document.querySelectorAll("[data-live-score]")].map((el) =>
        el.textContent.trim(),
      );
      const bubble = document.querySelector(".score-bubble");
      const cloudCount = document.querySelectorAll(".ix-cloud__item").length;
      const viewer = document.getElementById("ix-viewer-count")?.textContent || "";
      const goods = [...document.querySelectorAll("[data-good-user-count]")].map((el) =>
        el.textContent.trim(),
      );
      const bads = [...document.querySelectorAll("[data-bad-user-count]")].map((el) =>
        el.textContent.trim(),
      );
      return {
        scores,
        hasNonZero: scores.some((s) => s !== "0"),
        goods,
        bads,
        bubbleText: bubble?.textContent || "",
        cloudCount,
        viewer,
        isDemo: document.body.classList.contains("is-interaction-demo"),
      };
    });

    assert.ok(demo.isDemo, "demo class");
    assert.ok(demo.hasNonZero, "demo 模式应有非零评分");
    assert.ok(demo.goods.includes("328") && demo.bads.includes("42"), `demo TOP1 人数 ${demo.goods}/${demo.bads}`);
    assert.ok(demo.goods.includes("251") && demo.bads.includes("67"), "demo TOP2 人数");
    assert.ok(demo.cloudCount > 0, "demo 模式应有弹幕");
    assert.ok(/张三/.test(demo.bubbleText) && /300/.test(demo.bubbleText), "评分气泡文案");
    assert.ok(/万/.test(demo.viewer) || /\d/.test(demo.viewer), "在线人数");

    await page.clock.runFor(10000);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() =>
      Boolean(document.querySelector('.score-bubble[data-event-id="test-bubble-1"]')),
    );
    assert.strictEqual(after, false, "评分气泡 10 秒后应消失");

    console.log("PASS movie interaction ui");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
